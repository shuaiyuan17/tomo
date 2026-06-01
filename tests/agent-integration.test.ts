import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Channel, IncomingMessage, MessageReaction, OutgoingMessage, StreamingMessage, MessageHandler, CommandHandler, StopTypingOptions } from "../src/channels/types.js";

// ---------------------------------------------------------------------------
// Mock SDK — queue-based approach avoids async-generator timing issues
// ---------------------------------------------------------------------------

/** Controls what the mock SDK returns for each user message. Returning a
 *  string emits a single text block; returning an array emits one assistant
 *  event per element (each becomes its own text block, stitched into the
 *  same turn — the SDK only fires `result` once at the end). */
let mockResponseFn: (text: string) => string | string[] | Promise<string | string[]> = () => "mock response";
let mockEmitStreamDeltas = true;

/** Track in-flight mock queries so tests can assert no concurrency */
const queryState = {
  inFlight: 0,
  maxConcurrent: 0,
  reset() { this.inFlight = 0; this.maxConcurrent = 0; },
};

function createMockQuery(prompt: AsyncGenerator) {
  // Event queue + waiter for the consumer side
  const eventQueue: unknown[] = [];
  let waitResolve: (() => void) | null = null;
  let closed = false;

  // Background consumer: read from the prompt generator, push events to queue
  queryState.inFlight++;
  if (queryState.inFlight > queryState.maxConcurrent) {
    queryState.maxConcurrent = queryState.inFlight;
  }
  (async () => {
    try {
      for await (const userMsg of prompt) {
        if (closed) break;

        // Extract text from user message content blocks
        let text = "";
        const content = (userMsg as { message?: { content?: Array<{ type: string; text?: string }> } })
          ?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") text += block.text;
          }
        }

        const responseValue = await mockResponseFn(text);
        const blocks = Array.isArray(responseValue) ? responseValue : [responseValue];

        // For each block, emit a stream delta + an assistant event. This
        // mirrors how the real SDK reports multi-block turns: text deltas
        // arrive, then an `assistant` event consolidates the just-completed
        // block(s). Only one `result` fires at the end of the whole turn.
        for (const block of blocks) {
          if (mockEmitStreamDeltas) {
            eventQueue.push({
              type: "stream_event",
              event: { type: "content_block_delta", delta: { type: "text_delta", text: block } },
            });
          }
          eventQueue.push({
            type: "assistant",
            message: { content: [{ text: block }] },
          });
        }

        eventQueue.push({
          type: "result",
          subtype: "end_turn",
          session_id: "mock-sdk-session-123",
          total_cost_usd: 0.001,
          num_turns: 1,
          duration_ms: 100,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        });

        // Wake the consumer
        if (waitResolve) { const r = waitResolve; waitResolve = null; r(); }
      }
    } catch {
      // prompt generator closed
    } finally {
      queryState.inFlight--;
    }
  })();

  // Async iterable consumed by LiveSession.consumeEvents()
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          while (eventQueue.length === 0 && !closed) {
            await new Promise<void>((r) => { waitResolve = r; });
          }
          if (eventQueue.length > 0) {
            return { done: false, value: eventQueue.shift()! };
          }
          return { done: true, value: undefined };
        },
        async return() {
          closed = true;
          return { done: true as const, value: undefined };
        },
      };
    },
    close() {
      closed = true;
      if (waitResolve) { const r = waitResolve; waitResolve = null; r(); }
    },
    async getContextUsage() {
      return {
        totalTokens: 5000,
        maxTokens: 200000,
        percentage: 2.5,
        categories: [{ name: "conversation", tokens: 5000 }],
      };
    },
  };

  return iterable;
}

// ---------------------------------------------------------------------------
// Module mocks — declared before imports
// ---------------------------------------------------------------------------

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    telegramToken: "test-token",
    model: "claude-sonnet-4-6[1m]",
    workspaceDir: "",
    sessionsDir: "",
    historyLimit: 20,
    logsDir: "",
    tomoHome: "",
    continuity: false,
    city: null as string | null,
    identities: [] as Array<{ name: string; channels: Record<string, string>; replyPolicy: string }>,
    imessageUrl: "",
    imessagePassword: "",
    imessageWebhookPort: 3100,
    sessionModelOverrides: {} as Record<string, string>,
    channelAllowlists: {} as Record<string, string[]>,
    passiveGroups: {} as Record<string, string[]>,
    groupSecret: null as string | null,
    litellm: null as { mode: "anthropic-compatible" | "chatgpt-subscription"; baseUrl: string; apiKey: string } | null,
    lcm: {
      nudgeAtPct: 70,
      nudgeResetPct: 60,
      groupCompactStyle: "lcm" as "sdk" | "lcm",
    },
  },
}));

// Store the config path so activateGroup can read/write it
let configFilePath = "";
let configBackupPath = "";
let restartReasonFilePath = "";

vi.mock("../src/config.js", () => ({
  config: mockConfig,
  get CONFIG_PATH() { return configFilePath; },
  get CONFIG_BACKUP_PATH() { return configBackupPath; },
  TOMO_HOME: "/tmp/tomo-mock",
  get RESTART_REASON_FILE() { return restartReasonFilePath; },
}));

vi.mock("../src/workspace/index.js", () => ({
  buildSystemPrompt: () => "Test system prompt",
  PRIVATE_MEMORY_SUBDIR: "private",
  PRIVATE_MEMORY_DIR: "/tmp/tomo-mock/workspace/memory/private",
  MEMORY_DIR: "/tmp/tomo-mock/workspace/memory",
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator }) => createMockQuery(prompt)),
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ type: "sdk", name: opts.name, instance: {} })),
  tool: vi.fn((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name, description, inputSchema, handler,
  })),
}));

vi.mock("../src/logger.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import Agent after mocks
const { Agent } = await import("../src/agent.js");
const sdkMock = await import("@anthropic-ai/claude-agent-sdk");

// ---------------------------------------------------------------------------
// MockChannel — tracks both send() and streaming deliveries
// ---------------------------------------------------------------------------

interface Delivery {
  chatId: string;
  text: string;
  photo?: string;
  sticker?: string;
}

class MockChannel implements Channel {
  readonly name: string;
  private messageHandler: MessageHandler | null = null;
  private commandHandler: CommandHandler | null = null;
  /** Messages sent via channel.send() */
  sent: OutgoingMessage[] = [];
  /** All delivered messages (both streamed and sent) */
  delivered: Delivery[] = [];
  typingStarts: string[] = [];
  typingStops: Array<{ chatId: string; options?: StopTypingOptions }> = [];
  renamed: Array<{ chatId: string; title: string }> = [];
  reacted: Array<{ chatId: string; messageId: string; reaction: MessageReaction; remove?: boolean }> = [];

  constructor(name: string) { this.name = name; }

  onMessage(handler: MessageHandler) { this.messageHandler = handler; }
  onCommand(handler: CommandHandler) { this.commandHandler = handler; }

  async send(msg: OutgoingMessage) {
    this.sent.push(msg);
    this.delivered.push({ chatId: msg.chatId, text: msg.text, photo: msg.photo, sticker: msg.sticker });
  }

  async setChatTitle(chatId: string, title: string) {
    this.renamed.push({ chatId, title });
  }

  async reactToMessage(chatId: string, messageId: string, reaction: MessageReaction, remove?: boolean) {
    this.reacted.push({ chatId, messageId, reaction, remove });
  }

  createStreamingMessage(chatId: string, _replyTo?: string): StreamingMessage {
    // Mock mirrors the per-block streaming contract: update() sets the
    // current-block buffer, commitBlock() ships it as one delivery and
    // resets, finish() ships the trailing buffer.
    let text = "";
    let canceled = false;
    let finished = false;
    const NO_REPLY_RE = /^\s*NO_REPLY\s*$/i;
    const ship = () => {
      if (canceled || !text) return;
      if (NO_REPLY_RE.test(text)) { text = ""; return; }
      this.delivered.push({ chatId, text });
      text = "";
    };
    return {
      update: (t: string) => { if (!canceled && !finished) text = t; },
      commitBlock: async () => { if (!canceled && !finished) ship(); },
      finish: async () => { if (finished) return; finished = true; ship(); },
      cancel: async () => { canceled = true; text = ""; },
    };
  }

  startTyping(chatId: string) {
    this.typingStarts.push(chatId);
    return (options?: StopTypingOptions) => {
      this.typingStops.push({ chatId, options });
    };
  }
  async start() {}
  async stop() {}

  // Test helpers
  async simulateMessage(msg: IncomingMessage) { await this.messageHandler?.(msg); }
  async simulateCommand(cmd: string, chatId: string, sender: string, args?: string) {
    await this.commandHandler?.(cmd, chatId, sender, args);
  }
  clearDelivered() {
    this.sent = [];
    this.delivered = [];
    this.typingStarts = [];
    this.typingStops = [];
    this.renamed = [];
    this.reacted = [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_VALUES = { ...mockConfig };
let tmpDir: string;

function resetConfig(overrides: Partial<typeof mockConfig> = {}) {
  Object.assign(mockConfig, {
    ...DEFAULT_CONFIG_VALUES,
    sessionsDir: join(tmpDir, "sessions"),
    workspaceDir: join(tmpDir, "workspace"),
    logsDir: join(tmpDir, "logs"),
    tomoHome: tmpDir,
    identities: [],
    channelAllowlists: {},
    sessionModelOverrides: {},
    groupSecret: null,
    ...overrides,
  });
  configFilePath = join(tmpDir, "config.json");
  configBackupPath = join(tmpDir, "config.json.bak");
  restartReasonFilePath = join(tmpDir, ".restart-reason");
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    chatId: "12345",
    senderName: "TestUser",
    text: "Hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Wait for the agent's internal message queues to drain */
async function drainQueue(agent: InstanceType<typeof Agent>): Promise<void> {
  const queues = (agent as unknown as { messageQueues: Map<string, Promise<void>> }).messageQueues;
  for (const p of queues.values()) {
    await p;
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = join(tmpdir(), `tomo-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tmpDir, { recursive: true });
  resetConfig();
  mockResponseFn = () => "mock response";
  mockEmitStreamDeltas = true;
  queryState.reset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ===== DM message routing =====

describe("DM message routing", () => {
  it("routes DM and replies on the same channel", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "Hi there!";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].chatId).toBe("12345");
    expect(tg.delivered[0].text).toBe("Hi there!");

    await agent.stop();
  });

  it("creates separate sessions for different chatIds", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    let n = 0;
    mockResponseFn = () => `reply-${++n}`;

    await tg.simulateMessage(makeMsg({ chatId: "111", text: "A" }));
    await drainQueue(agent);
    await tg.simulateMessage(makeMsg({ chatId: "222", text: "B" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(2);
    expect(tg.delivered[0].chatId).toBe("111");
    expect(tg.delivered[1].chatId).toBe("222");

    await agent.stop();
  });

  it("reacts to the latest inbound message in a DM session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "NO_REPLY";

    await tg.simulateMessage(makeMsg({ id: "41", chatId: "12345", text: "First" }));
    await drainQueue(agent);
    await tg.simulateMessage(makeMsg({ id: "42", chatId: "12345", text: "Second" }));
    await drainQueue(agent);

    const result = await agent.reactToLatestMessage("telegram:12345", "like");

    expect(result.ok).toBe(true);
    expect(tg.reacted).toEqual([{ chatId: "12345", messageId: "42", reaction: "like", remove: false }]);

    await agent.stop();
  });

  it("reacts to the last active channel for an identity session", async () => {
    resetConfig({
      identities: [
        { name: "shuai", channels: { telegram: "12345", imessage: "+15551234567" }, replyPolicy: "last-active" },
      ],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    mockResponseFn = () => "NO_REPLY";

    await tg.simulateMessage(makeMsg({ id: "11", chatId: "12345", text: "From Telegram" }));
    await drainQueue(agent);
    await im.simulateMessage(makeMsg({ id: "im-22", chatId: "+15551234567", text: "From iMessage" }));
    await drainQueue(agent);

    const result = await agent.reactToLatestMessage("shuai", "love", true);

    expect(result.ok).toBe(true);
    expect(tg.reacted).toHaveLength(0);
    expect(im.reacted).toEqual([{ chatId: "+15551234567", messageId: "im-22", reaction: "love", remove: true }]);

    await agent.stop();
  });

  it("reports an error when there is no latest message to react to", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const result = await agent.reactToLatestMessage("telegram:12345", "like");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown target|no latest inbound message/i);
    expect(tg.reacted).toHaveLength(0);

    await agent.stop();
  });
});

// ===== Allowlist =====

describe("allowlist enforcement", () => {
  it("blocks messages from unknown senders", async () => {
    resetConfig({ channelAllowlists: { telegram: ["999"] } });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(0);

    await agent.stop();
  });

  it("allows whitelisted senders", async () => {
    resetConfig({ channelAllowlists: { telegram: ["12345"] } });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  });
});

// ===== Group chat =====

describe("group chat handling", () => {
  it("ignores group messages when not mentioned", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({
      chatId: "-100123",
      text: "Hey everyone",
      isGroup: true,
      isMentioned: false,
    }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(0);

    await agent.stop();
  });

  it("responds to group messages when mentioned", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "Group reply!";

    await tg.simulateMessage(makeMsg({
      chatId: "-100123",
      text: "@tomo what's up",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    // Should have at least the user reply (may also have context injection response)
    const replies = tg.delivered.filter(m => m.chatId === "-100123");
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  });

  it("uses channel:chatId session key for groups even with identity", async () => {
    resetConfig({
      identities: [{ name: "alice", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
      // No explicit allowlist — identity alone should NOT enable allowlist enforcement
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "reply";

    // DM → uses dm:alice session
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "DM" }));
    await drainQueue(agent);

    const dmReplies = tg.delivered.filter(m => m.chatId === "12345");
    expect(dmReplies.length).toBeGreaterThanOrEqual(1);

    tg.clearDelivered();

    // Group → uses telegram:-100999 (separate session, NOT dm:alice)
    await tg.simulateMessage(makeMsg({
      chatId: "-100999",
      text: "@tomo hi",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    // The group should get a reply (streamed or via error-retry direct send)
    const groupDelivered = tg.delivered.filter(m => m.chatId === "-100999");
    expect(groupDelivered.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  });

  it("activates group via secret phrase", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      channels: { telegram: { token: "test", allowlist: ["12345"] } },
    }));

    resetConfig({
      channelAllowlists: { telegram: ["12345"] },
      groupSecret: "tomo-secret-123",
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({
      chatId: "-100group",
      text: "tomo-secret-123",
      isGroup: true,
      isMentioned: false,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    const activation = tg.sent.find(m => m.text?.includes("activated"));
    expect(activation).toBeDefined();
    expect(activation!.chatId).toBe("-100group");

    await agent.stop();
  });

  it("renames a group chat and updates the session catalog title", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "Group reply!";

    await tg.simulateMessage(makeMsg({
      chatId: "-100123",
      text: "@tomo hi",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
      chatTitle: "Old Title",
    }));
    await drainQueue(agent);

    const result = await agent.renameGroupChat("telegram:-100123", "New Title");

    expect(result.ok).toBe(true);
    expect(tg.renamed).toEqual([{ chatId: "-100123", title: "New Title" }]);
    expect(agent.listSessionCatalog().groups).toContainEqual({
      key: "telegram:-100123",
      title: "New Title",
    });

    await agent.stop();
  });

  it("rejects group rename for non-group targets", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    const result = await agent.renameGroupChat("telegram:12345", "Nope");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a group/i);
    expect(tg.renamed).toHaveLength(0);

    await agent.stop();
  });
});

// ===== Identity multi-channel routing =====

describe("identity multi-channel routing", () => {
  it("unifies sessions under dm: key", async () => {
    resetConfig({
      identities: [
        { name: "shuai", channels: { telegram: "12345", imessage: "+15551234567" }, replyPolicy: "last-active" },
      ],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    let n = 0;
    mockResponseFn = () => `reply-${++n}`;

    // Telegram message
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "From Telegram" }));
    await drainQueue(agent);

    // iMessage message — same identity, last-active should route here
    await im.simulateMessage(makeMsg({ chatId: "+15551234567", text: "From iMessage" }));
    await drainQueue(agent);

    expect(tg.delivered.length).toBeGreaterThanOrEqual(1);
    expect(tg.delivered[0].chatId).toBe("12345");

    expect(im.delivered.length).toBeGreaterThanOrEqual(1);
    expect(im.delivered[0].chatId).toBe("+15551234567");

    await agent.stop();
  });

  it("routes reply to fixed channel when policy is set", async () => {
    resetConfig({
      identities: [
        { name: "shuai", channels: { telegram: "12345", imessage: "+15551234567" }, replyPolicy: "telegram" },
      ],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    mockResponseFn = () => "Fixed channel reply";

    // Message arrives from iMessage, but policy routes reply to telegram
    await im.simulateMessage(makeMsg({ chatId: "+15551234567", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered.length).toBeGreaterThanOrEqual(1);
    expect(tg.delivered[0].chatId).toBe("12345");
    expect(im.delivered).toHaveLength(0);

    await agent.stop();
  });
});

// ===== Cron delivery =====

describe("cron message delivery", () => {
  it("delivers cron response to channel: session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "Time to stretch!";

    // Establish session first
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleCronMessage("Stretch reminder", "telegram:12345");

    // Cron uses channel.send(), not streaming
    expect(tg.sent.length).toBeGreaterThanOrEqual(1);
    expect(tg.sent[0].chatId).toBe("12345");
    expect(tg.sent[0].text).toBe("Time to stretch!");

    await agent.stop();
  });

  it("delivers cron response to dm: session via identity", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "Daily briefing";

    // Establish session
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleCronMessage("Morning briefing", "dm:shuai");

    expect(tg.sent.length).toBeGreaterThanOrEqual(1);
    expect(tg.sent[0].chatId).toBe("12345");

    await agent.stop();
  });

  it("suppresses NO_REPLY in cron", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "NO_REPLY";

    // Establish session
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleCronMessage("Check something", "telegram:12345");

    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });
});

// ===== Continuity delivery =====

describe("continuity delivery", () => {
  it("delivers to first DM session", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "Good morning!";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleContinuity("System: Free time.");

    // Continuity uses channel.send()
    expect(tg.sent.length).toBeGreaterThanOrEqual(1);
    expect(tg.sent[0].chatId).toBe("12345");

    await agent.stop();
  });

  it("falls back to channel: session when no identity", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "Continuity thought";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleContinuity("System: Free time.");

    expect(tg.sent.length).toBeGreaterThanOrEqual(1);
    expect(tg.sent[0].chatId).toBe("12345");

    await agent.stop();
  });

  it("skips group-only sessions", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "Should not arrive";

    // Only a group session exists (negative chatId)
    await tg.simulateMessage(makeMsg({
      chatId: "-100group",
      text: "@tomo hi",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleContinuity("System: Free time.");

    // No DM session → nothing delivered
    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("suppresses NO_REPLY in continuity", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "NO_REPLY";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleContinuity("System: Free time.");

    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });
});

// ===== sendNotification =====

describe("sendNotification", () => {
  it("sends to dm: session reply target", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.sendNotification("Tomo v0.4.0 is available!");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Tomo v0.4.0 is available!");
    expect(tg.sent[0].chatId).toBe("12345");

    await agent.stop();
  });

  it("falls back to non-group channel: session without identity", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.sendNotification("Update available");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].chatId).toBe("12345");

    await agent.stop();
  });

  it("skips group sessions in fallback", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // Only a group session
    await tg.simulateMessage(makeMsg({
      chatId: "-100group",
      text: "@tomo hi",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.sendNotification("Update available");

    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("no-ops when no sessions exist", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await agent.sendNotification("Update available");

    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });
});

// ===== NO_REPLY suppression =====

describe("NO_REPLY suppression", () => {
  it("suppresses NO_REPLY for regular DM messages", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "NO_REPLY";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(0);

    await agent.stop();
  });

  it("clears iMessage group typing when the model returns NO_REPLY", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockResponseFn = () => "NO_REPLY";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;+;group123", text: "side chatter", isGroup: true }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(0);
    expect(im.typingStarts).toEqual(["iMessage;+;group123"]);
    expect(im.typingStops).toEqual([
      { chatId: "iMessage;+;group123", options: { clear: true } },
    ]);

    await agent.stop();
  });

  it("delivers normal responses via streaming", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "A real answer";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toBe("A real answer");

    await agent.stop();
  });

  it("delivers SDK assistant text even when no stream delta arrives", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockEmitStreamDeltas = false;
    mockResponseFn = () => "There's an issue with the selected model (claude-sonnet-4-7). It may not exist or you may not have access to it. Run --model to pick a different model.";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toContain("selected model");
    expect(tg.delivered[0].text).toContain("claude-sonnet-4-7");

    await agent.stop();
  });
});

// ===== Commands =====

describe("chat commands", () => {
  it("/new resets the session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await tg.simulateCommand("new", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("New session");

    await agent.stop();
  });

  it("/status shows session info", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await tg.simulateCommand("status", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Session:");
    expect(tg.sent[0].text).toContain("Model:");

    await agent.stop();
  });

  it("passes LiteLLM gateway env to the Claude Agent SDK child", async () => {
    resetConfig({
      litellm: {
        mode: "anthropic-compatible",
        baseUrl: "http://localhost:4000",
        apiKey: "sk-litellm-test",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as {
      options?: { env?: Record<string, string | undefined> };
    };
    expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:4000");
    expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBe("sk-litellm-test");

    await agent.stop();
  });

  it("routes a chatgpt-subscription gateway when the model is a LiteLLM model", async () => {
    resetConfig({
      model: "chatgpt/gpt-5.5",
      litellm: {
        mode: "chatgpt-subscription",
        baseUrl: "http://localhost:4000",
        apiKey: "sk-litellm-test",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as {
      options?: { env?: Record<string, string | undefined> };
    };
    expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:4000");
    expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBe("sk-litellm-test");

    await agent.stop();
  });

  it("bypasses a chatgpt-subscription gateway for a Claude-model session", async () => {
    const oldBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://localhost:4000";
    let agent: InstanceType<typeof Agent> | null = null;
    try {
      resetConfig({
        // Gateway only serves chatgpt/*, but this session resolves to a Claude model
        // (default config.model) — it must hit Anthropic directly, not the proxy.
        model: "claude-sonnet-4-6[1m]",
        litellm: {
          mode: "chatgpt-subscription",
          baseUrl: "http://localhost:4000",
          apiKey: "sk-litellm-test",
        },
      });
      agent = new Agent();
      const tg = new MockChannel("telegram");
      agent.addChannel(tg);

      await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
      await drainQueue(agent);

      const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
      const lastCall = calls[calls.length - 1]?.[0] as {
        options?: { env?: Record<string, string | undefined> };
      };
      expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
    } finally {
      if (oldBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = oldBaseUrl;
      }
      await agent?.stop();
    }
  });

  it("routes back through the ChatGPT gateway after switching from a Claude model", async () => {
    resetConfig({
      model: "chatgpt/gpt-5.5",
      litellm: {
        mode: "chatgpt-subscription",
        baseUrl: "http://localhost:4000",
        apiKey: "sk-litellm-test",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "ChatGPT turn" }));
    await drainQueue(agent);

    await tg.simulateCommand("model", "12345", "TestUser", "opus-1m");
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Claude turn" }));
    await drainQueue(agent);

    let calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    let lastCall = calls[calls.length - 1]?.[0] as {
      options?: { env?: Record<string, string | undefined>; model?: string };
    };
    expect(lastCall.options?.model).toBe("claude-opus-4-8[1m]");
    expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBeUndefined();

    await tg.simulateCommand("model", "12345", "TestUser", "chatgpt/gpt-5.5");
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Back to ChatGPT" }));
    await drainQueue(agent);

    calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    lastCall = calls[calls.length - 1]?.[0] as {
      options?: { env?: Record<string, string | undefined>; model?: string; resume?: string };
    };
    expect(lastCall.options?.model).toBe("chatgpt/gpt-5.5");
    expect(lastCall.options?.resume).toBe("mock-sdk-session-123");
    expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:4000");
    expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBe("sk-litellm-test");

    await agent.stop();
  });

  it("surfaces the resolved Claude model in the system prompt", async () => {
    resetConfig({ model: "sonnet" });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as { options?: { systemPrompt?: string } };
    expect(lastCall.options?.systemPrompt).toContain("# RUNTIME — Current Model");
    // alias "sonnet" must be resolved to its concrete id, not echoed raw
    expect(lastCall.options?.systemPrompt).toContain("claude-sonnet-4-6");

    await agent.stop();
  });

  it("surfaces a LiteLLM gateway model in the system prompt", async () => {
    resetConfig({
      model: "chatgpt/gpt-5.5",
      litellm: {
        mode: "chatgpt-subscription",
        baseUrl: "http://localhost:4000",
        apiKey: "sk-litellm-test",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as { options?: { systemPrompt?: string } };
    expect(lastCall.options?.systemPrompt).toContain("chatgpt/gpt-5.5");

    await agent.stop();
  });

  it("/status shows LiteLLM gateway mode", async () => {
    resetConfig({
      litellm: {
        mode: "chatgpt-subscription",
        baseUrl: "http://localhost:4000",
        apiKey: "sk-litellm-test",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await tg.simulateCommand("status", "12345", "TestUser");

    expect(tg.sent[0].text).toContain("Gateway: LiteLLM (ChatGPT subscription)");

    await agent.stop();
  });

  it("/model persists a session override to config", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "sonnet-1m");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Switched to claude-sonnet-4-6[1m]");

    const cfg = JSON.parse(readFileSync(configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides?.["telegram:12345"]).toBe("claude-sonnet-4-6[1m]");
    expect(mockConfig.sessionModelOverrides["telegram:12345"]).toBe("claude-sonnet-4-6[1m]");

    const backup = JSON.parse(readFileSync(configBackupPath, "utf-8")) as { model?: string };
    expect(backup.model).toBe("claude-haiku-4-5");

    await agent.stop();
  });

  it("/model keeps the active SDK session so provider switches preserve continuity", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    const store = (agent as unknown as { sessions: { getSdkSessionId(key: string): string | undefined } }).sessions;
    expect(store.getSdkSessionId("telegram:12345")).toBe("mock-sdk-session-123");

    await tg.simulateCommand("model", "12345", "TestUser", "opus-1m");

    expect(tg.sent.at(-1)?.text).toBe("Switched to claude-opus-4-8[1m]");
    expect(store.getSdkSessionId("telegram:12345")).toBe("mock-sdk-session-123");

    await agent.stop();
  });

  it("/model accepts known full model IDs", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "claude-opus-4-8[1m]");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Switched to claude-opus-4-8[1m]");

    const cfg = JSON.parse(readFileSync(configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides?.["telegram:12345"]).toBe("claude-opus-4-8[1m]");

    await agent.stop();
  });

  it("/model accepts LiteLLM provider/model names when a gateway is configured", async () => {
    resetConfig({
      litellm: {
        mode: "chatgpt-subscription",
        baseUrl: "http://localhost:4000",
        apiKey: "sk-litellm-test",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "chatgpt/gpt-5.5");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Switched to chatgpt/gpt-5.5");

    const cfg = JSON.parse(readFileSync(configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides?.["telegram:12345"]).toBe("chatgpt/gpt-5.5");

    await agent.stop();
  });

  it("/model rejects non-chatgpt provider models in ChatGPT subscription mode", async () => {
    resetConfig({
      litellm: {
        mode: "chatgpt-subscription",
        baseUrl: "http://localhost:4000",
        apiKey: "sk-litellm-test",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "openrouter/openai/gpt-4o-mini");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("only routes chatgpt/* models");

    const cfg = JSON.parse(readFileSync(configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides).toBeUndefined();

    await agent.stop();
  });

  it("/model rejects LiteLLM provider/model names without a gateway and does not write config", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "chatgpt/gpt-5.5");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("needs a LiteLLM gateway");

    const cfg = JSON.parse(readFileSync(configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides).toBeUndefined();

    await agent.stop();
  });

  it("/model rejects unknown model names without writing config", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }, null, 2) + "\n");

    await tg.simulateCommand("model", "12345", "TestUser", "claude-sonnet-4.7");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Unknown model");

    const cfg = JSON.parse(readFileSync(configFilePath, "utf-8")) as {
      sessionModelOverrides?: Record<string, string>;
    };
    expect(cfg.sessionModelOverrides).toBeUndefined();

    await agent.stop();
  });

  it("/restore restores config.json from config.json.bak", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(configFilePath, JSON.stringify({ model: "bad-model" }, null, 2) + "\n");
    writeFileSync(configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand("restore", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Restored config.json");

    const restored = JSON.parse(readFileSync(configFilePath, "utf-8")) as { model?: string };
    expect(restored.model).toBe("claude-sonnet-4-6");
    expect(readFileSync(restartReasonFilePath, "utf-8")).toContain("Restored");

    await agent.stop();
  });

  it("/restore locks out follow-up commands during restart", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(configFilePath, JSON.stringify({ model: "bad-model" }, null, 2) + "\n");
    writeFileSync(configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand("restore", "12345", "TestUser");
    await tg.simulateCommand("restore", "12345", "TestUser");
    await tg.simulateCommand("new", "12345", "TestUser");

    expect(tg.sent).toHaveLength(3);
    expect(tg.sent[0].text).toContain("Restored config.json");
    expect(tg.sent[1].text).toContain("Restore is already in progress");
    expect(tg.sent[2].text).toContain("Restore is already in progress");

    await agent.stop();
  });

  it("drops normal messages during restore restart", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    writeFileSync(configFilePath, JSON.stringify({ model: "bad-model" }, null, 2) + "\n");
    writeFileSync(configBackupPath, JSON.stringify({ model: "claude-sonnet-4-6" }, null, 2) + "\n");

    await tg.simulateCommand("restore", "12345", "TestUser");
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "hello?" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0].text).toContain("Restored config.json");

    await agent.stop();
  });

  it("/restore reports when no config backup exists", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("restore", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("No config backup found");

    await agent.stop();
  });
});

// ===== Message queueing =====

describe("message queueing", () => {
  it("coalesces concurrent DM messages into one turn", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const turnTexts: string[] = [];
    mockResponseFn = (text) => {
      turnTexts.push(text);
      return `reply-${turnTexts.length}`;
    };

    // Fire two messages concurrently — both land in the batch before the
    // first task gets to run, so they coalesce into a single SDK turn.
    const p1 = tg.simulateMessage(makeMsg({ chatId: "12345", text: "First" }));
    const p2 = tg.simulateMessage(makeMsg({ chatId: "12345", text: "Second" }));
    await Promise.all([p1, p2]);
    await drainQueue(agent);

    expect(turnTexts).toHaveLength(1);
    expect(turnTexts[0]).toContain("First");
    expect(turnTexts[0]).toContain("Second");
    expect(turnTexts[0]).toContain("User sent 2 messages in quick succession");
    expect(tg.delivered).toHaveLength(1);
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("coalesces DMs that arrive while a turn is in flight", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const turnTexts: string[] = [];
    let release: (() => void) | null = null;
    const firstTurnGate = new Promise<void>((r) => { release = r; });

    mockResponseFn = async (text) => {
      turnTexts.push(text);
      if (turnTexts.length === 1) await firstTurnGate;
      return `reply-${turnTexts.length}`;
    };

    // Turn 1 starts and blocks
    const p1 = tg.simulateMessage(makeMsg({ chatId: "12345", text: "help me to xyz" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(turnTexts).toHaveLength(1);
    expect(turnTexts[0]).toContain("help me to xyz");
    expect(turnTexts[0]).not.toContain("quick succession");

    // Two more messages pile up behind it
    const p2 = tg.simulateMessage(makeMsg({ chatId: "12345", text: "wait" }));
    const p3 = tg.simulateMessage(makeMsg({ chatId: "12345", text: "actually nevermind" }));

    // Release turn 1; turns 2+3 should fire as a single coalesced turn
    release!();
    await Promise.all([p1, p2, p3]);
    await drainQueue(agent);

    expect(turnTexts).toHaveLength(2);
    expect(turnTexts[1]).toContain("User sent 2 messages in quick succession");
    expect(turnTexts[1]).toContain("wait");
    expect(turnTexts[1]).toContain("actually nevermind");
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("does not coalesce mention-required groups", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const turnTexts: string[] = [];
    mockResponseFn = (text) => {
      turnTexts.push(text);
      return "reply";
    };

    // Telegram groups are mention-required by default; coalescing would lose
    // per-message mention filtering, so each mention runs as its own turn.
    const p1 = tg.simulateMessage(makeMsg({ chatId: "-100", text: "msg one", isGroup: true, isMentioned: true }));
    const p2 = tg.simulateMessage(makeMsg({ chatId: "-100", text: "msg two", isGroup: true, isMentioned: true }));
    await Promise.all([p1, p2]);
    await drainQueue(agent);

    expect(turnTexts).toHaveLength(2);
    expect(turnTexts.some((t) => t.includes("quick succession"))).toBe(false);

    await agent.stop();
  });

  it("regression: channel-side serialization does not block coalescing", async () => {
    // Models the grammy / iMessage pattern where a channel processes updates
    // sequentially, awaiting each handler before the next webhook is read.
    // Before the fix, awaiting enqueueMessage's returned promise would block
    // the next message until the SDK turn fully completed — defeating the
    // queue and preventing any pile-up. enqueueMessage is now fire-and-forget,
    // so a serial channel loop can still feed messages into the batch.
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const turnTexts: string[] = [];
    let release: (() => void) | null = null;
    const firstTurnGate = new Promise<void>((r) => { release = r; });

    mockResponseFn = async (text) => {
      turnTexts.push(text);
      if (turnTexts.length === 1) await firstTurnGate;
      return `reply-${turnTexts.length}`;
    };

    // Serial channel-side dispatch: await each handler before the next.
    // With the bug, msg2/msg3 would never be queued until msg1's SDK done.
    const channelLoop = (async () => {
      await tg.simulateMessage(makeMsg({ chatId: "12345", text: "msg one" }));
      await tg.simulateMessage(makeMsg({ chatId: "12345", text: "msg two" }));
      await tg.simulateMessage(makeMsg({ chatId: "12345", text: "msg three" }));
    })();

    await new Promise((r) => setTimeout(r, 30));
    // Turn 1 in flight; msg2 + msg3 should already be queued (not blocked
    // behind the SDK call).
    expect(turnTexts).toHaveLength(1);
    expect(turnTexts[0]).toContain("msg one");

    release!();
    await channelLoop;
    await drainQueue(agent);

    // msg2 + msg3 coalesce into one turn
    expect(turnTexts).toHaveLength(2);
    expect(turnTexts[1]).toContain("quick succession");
    expect(turnTexts[1]).toContain("msg two");
    expect(turnTexts[1]).toContain("msg three");

    await agent.stop();
  });

  it("coalesces passive group messages with sender prefixes", async () => {
    const agent = new Agent();
    // iMessage groups are always passive — every message reaches Tomo, so
    // batching is safe and just reduces turn count.
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    const turnTexts: string[] = [];
    mockResponseFn = (text) => {
      turnTexts.push(text);
      return "reply";
    };

    const p1 = im.simulateMessage(makeMsg({ chatId: "g;+;abc", text: "hey tomo", senderName: "Alice", isGroup: true }));
    const p2 = im.simulateMessage(makeMsg({ chatId: "g;+;abc", text: "what time is it", senderName: "Bob", isGroup: true }));
    const p3 = im.simulateMessage(makeMsg({ chatId: "g;+;abc", text: "nvm google said 3pm", senderName: "Bob", isGroup: true }));
    await Promise.all([p1, p2, p3]);
    await drainQueue(agent);

    expect(turnTexts).toHaveLength(1);
    expect(turnTexts[0]).toContain("messages arrived from this group");
    expect(turnTexts[0]).toContain("Alice: hey tomo");
    expect(turnTexts[0]).toContain("Bob: what time is it");
    expect(turnTexts[0]).toContain("Bob: nvm google said 3pm");
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });
});

// ===== Message isolation across ingress paths =====
//
// Regression test for v0.3.8 mutex fix: user messages, cron triggers, and
// continuity heartbeats must all route through the same per-session FIFO
// queue. Previously only user messages were queued, which let concurrent
// cron/heartbeat ingress stomp on an in-flight user turn's currentRequest
// slot inside LiveSession.

/** Drain queues repeatedly — tasks may enqueue more work */
async function drainAllSessions(agent: InstanceType<typeof Agent>): Promise<void> {
  const queues = (agent as unknown as { messageQueues: Map<string, Promise<void>> }).messageQueues;
  for (let i = 0; i < 5; i++) {
    const all = Array.from(queues.values());
    if (all.length === 0) break;
    await Promise.all(all);
  }
}

describe("ingress isolation", () => {
  it("serializes a cron trigger while a user message is in flight", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const order: string[] = [];
    let release: (() => void) | null = null;
    const userGate = new Promise<void>((r) => { release = r; });

    mockResponseFn = async (text) => {
      if (text.includes("FROM_USER")) {
        order.push("user-start");
        await userGate;
        order.push("user-end");
        return "user-reply";
      }
      if (text.includes("FROM_CRON")) {
        order.push("cron-run");
        return "cron-reply";
      }
      return "misc";
    };

    const userP = tg.simulateMessage(makeMsg({ chatId: "12345", text: "FROM_USER" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["user-start"]);

    const cronP = agent.handleCronMessage("FROM_CRON", "telegram:12345");
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["user-start"]);

    release!();
    await Promise.all([userP, cronP]);
    await drainAllSessions(agent);

    expect(order).toEqual(["user-start", "user-end", "cron-run"]);
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("serializes a continuity heartbeat while a user message is in flight", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // Seed the dm:shuai session so findFirstDmSession() resolves
    mockResponseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "seed" }));
    await drainAllSessions(agent);
    tg.clearDelivered();

    const order: string[] = [];
    let release: (() => void) | null = null;
    const userGate = new Promise<void>((r) => { release = r; });

    mockResponseFn = async (text) => {
      if (text.includes("FROM_USER")) {
        order.push("user-start");
        await userGate;
        order.push("user-end");
        return "user-reply";
      }
      if (text.includes("Free time")) {
        order.push("continuity-run");
        return "continuity-reply";
      }
      return "misc";
    };

    const userP = tg.simulateMessage(makeMsg({ chatId: "12345", text: "FROM_USER" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["user-start"]);

    const contP = agent.handleContinuity("System: Free time.");
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["user-start"]);

    release!();
    await Promise.all([userP, contP]);
    await drainAllSessions(agent);

    expect(order.slice(0, 2)).toEqual(["user-start", "user-end"]);
    expect(order).toContain("continuity-run");
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("serializes a user message while cron is in flight", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const order: string[] = [];
    let release: (() => void) | null = null;
    const cronGate = new Promise<void>((r) => { release = r; });

    mockResponseFn = async (text) => {
      if (text.includes("SLOW_CRON")) {
        order.push("cron-start");
        await cronGate;
        order.push("cron-end");
        return "cron-reply";
      }
      if (text.includes("USER_AFTER")) {
        order.push("user-run");
        return "user-reply";
      }
      return "misc";
    };

    // Establish the session so cron can resolve reply target
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "seed" }));
    await drainAllSessions(agent);
    tg.clearDelivered();

    const cronP = agent.handleCronMessage("SLOW_CRON", "telegram:12345");
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["cron-start"]);

    const userP = tg.simulateMessage(makeMsg({ chatId: "12345", text: "USER_AFTER" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["cron-start"]);

    release!();
    await Promise.all([cronP, userP]);
    await drainAllSessions(agent);

    expect(order).toEqual(["cron-start", "cron-end", "user-run"]);
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("does not run two queries concurrently for the same session under mixed load", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    let seq = 0;
    mockResponseFn = async () => {
      seq++;
      await new Promise((r) => setTimeout(r, 5));
      return `r-${seq}`;
    };

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "seed" }));
    await drainAllSessions(agent);

    // Fire all three ingress paths in rapid succession
    const a = tg.simulateMessage(makeMsg({ chatId: "12345", text: "user-a" }));
    const b = agent.handleCronMessage("cron-b", "dm:shuai");
    const c = agent.handleContinuity("System: Free time c.");
    const d = tg.simulateMessage(makeMsg({ chatId: "12345", text: "user-d" }));

    await Promise.all([a, b, c, d]);
    await drainAllSessions(agent);

    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });
});

// ===== Per-block streaming delivery (iMessage + Telegram) =====

describe("per-block streaming delivery", () => {
  it("iMessage ships a single-block response as one message", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockResponseFn = () => "single block reply";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "hi" }));
    await drainQueue(agent);

    // One block → one delivery, no merging or duplication
    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("single block reply");

    await agent.stop();
  });

  it("iMessage ships each text block separately on multi-block turns", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // Three text blocks in a single turn (e.g. text → tool → text → tool → text).
    // Without per-block ship, only the last block would survive the streaming
    // buffer reset; with it, every block lands as its own message.
    mockResponseFn = () => ["first block", "second block", "third block"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(3);
    expect(im.delivered.map((d) => d.text)).toEqual(["first block", "second block", "third block"]);

    await agent.stop();
  });

  it("Telegram ships each text block as its own streamed message", async () => {
    // Telegram now matches iMessage in shape: each block becomes its own
    // sendMessage. Edit-in-place still applies *within* a block as deltas
    // arrive; commitBlock seals it before the next block starts.
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => ["alpha", "beta", "gamma"];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(3);
    expect(tg.delivered.map((d) => d.text)).toEqual(["alpha", "beta", "gamma"]);

    await agent.stop();
  });

  it("suppresses NO_REPLY when it is the entire response", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockResponseFn = () => "NO_REPLY";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "noise" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(0);

    await agent.stop();
  });

  it("drops a NO_REPLY block but ships the others around it", async () => {
    // Mid-turn NO_REPLY (e.g. a tool-only block whose text resolved to bare
    // NO_REPLY) is suppressed by both channels' streaming guards.
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockResponseFn = () => ["before", "NO_REPLY", "after"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(2);
    expect(im.delivered.map((d) => d.text)).toEqual(["before", "after"]);

    await agent.stop();
  });

  it("drops empty blocks but ships the non-empty ones", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    // Whitespace-only blocks (e.g. a tool-only assistant event with no text)
    // should not surface as empty iMessages.
    mockResponseFn = () => ["   ", "real content", ""];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("real content");

    await agent.stop();
  });

  it("regression: a throwing commitBlock does not kill the live session", async () => {
    // onBlockComplete fires inside the SDK event loop. If commitBlock throws
    // (e.g. transient BlueBubbles HTTP error), the error must not propagate
    // into LiveSession.consumeEvents — that would mark the session dead and
    // trip runWithRetry's "session error" branch, double-firing the turn.
    const agent = new Agent();
    const im = new MockChannel("imessage");

    // Override commitBlock to throw on the first call only. The test verifies
    // the turn still resolves cleanly, the response is captured, and the
    // session isn't restarted (would manifest as queryState.maxConcurrent > 1
    // or duplicate deliveries).
    let firstCall = true;
    const origCreate = im.createStreamingMessage.bind(im);
    im.createStreamingMessage = (chatId: string, replyTo?: string) => {
      const stream = origCreate(chatId, replyTo);
      const realCommit = stream.commitBlock.bind(stream);
      stream.commitBlock = async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("transient BlueBubbles HTTP error");
        }
        return realCommit();
      };
      return stream;
    };
    agent.addChannel(im);

    mockResponseFn = () => ["block-a", "block-b"];

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    // Block A's commit threw → no delivery for A. Block B succeeds.
    // (We don't assert on A specifically — just that the turn didn't double-fire.)
    expect(queryState.maxConcurrent).toBe(1);
    // Exactly one block delivered (block-b). Block-a was lost to the thrown
    // commitBlock, but the run completed instead of restarting.
    expect(im.delivered).toHaveLength(1);
    expect(im.delivered[0].text).toBe("block-b");

    await agent.stop();
  });

  it("ships STICKER tags as sticker sends without leaking the tag into text", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => "here you go STICKER:CAACAgQAAxkBAAE123";

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "send sticker" }));
    await drainQueue(agent);

    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "here you go", photo: undefined, sticker: undefined },
      { chatId: "12345", text: "", photo: undefined, sticker: "CAACAgQAAxkBAAE123" },
    ]);

    await agent.stop();
  });
});
