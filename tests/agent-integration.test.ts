import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Channel, IncomingMessage, MessageReaction, OutgoingMessage, StreamingMessage, MessageHandler, CommandHandler, StopTypingOptions } from "../src/channels/types.js";
import { PetStore } from "../src/mcp/pet-store.js";

// ---------------------------------------------------------------------------
// Mock SDK — queue-based approach avoids async-generator timing issues
// ---------------------------------------------------------------------------

type MockTextBlock = { type: "text"; text: string };
type MockThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
  /** Test hook: simulate a thinking block whose stream delta is text-shaped. */
  streamAsTextDelta?: boolean;
};
type MockResponseBlock = string | MockTextBlock | MockThinkingBlock;
type MockResponse = string | MockResponseBlock[];

/** Controls what the mock SDK returns for each user message. Returning a
 *  string emits a single text block; returning an array emits one assistant
 *  event per element (each becomes its own block, stitched into the same turn
 *  — the SDK only fires `result` once at the end). */
let mockResponseFn: (text: string) => MockResponse | Promise<MockResponse> = () => "mock response";
let mockEmitStreamDeltas = true;
let mockUserContents: Array<Array<{ type: string; text?: string }>> = [];
/** When true, the mock pulls one extra pending user message mid-turn and
 *  echoes it back as a `user` event before the turn's result — simulating the
 *  CLI injecting a steered message at a tool boundary. Tests MUST guarantee
 *  the steered message is already pending before the turn unblocks; a
 *  timed-out race here would otherwise swallow a later message. */
let mockSteerEcho = false;

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
          mockUserContents.push(content);
          for (const block of content) {
            if (block.type === "text") text += block.text;
          }
        }

        const responseValue = await mockResponseFn(text);
        let blocks = Array.isArray(responseValue) ? [...responseValue] : [responseValue];

        if (mockSteerEcho) {
          const extra = await Promise.race([
            prompt.next() as Promise<IteratorResult<unknown>>,
            new Promise<null>((r) => setTimeout(() => r(null), 25)),
          ]);
          if (extra && !extra.done) {
            const extraContent = (extra.value as { message?: { content?: Array<{ type: string; text?: string }> } })
              ?.message?.content ?? [];
            mockUserContents.push(extraContent);
            eventQueue.push({ type: "user", isReplay: true, message: { content: extraContent } });
            let extraText = "";
            for (const b of extraContent) {
              if (b.type === "text") extraText += b.text ?? "";
            }
            const extraResp = await mockResponseFn(extraText);
            blocks = blocks.concat(Array.isArray(extraResp) ? extraResp : [extraResp]);
          }
        }

        // For each block, emit stream events + an assistant event. This
        // mirrors how the real SDK reports multi-block turns: text deltas
        // arrive, then an `assistant` event consolidates the just-completed
        // block(s). Only one `result` fires at the end of the whole turn.
        for (const block of blocks) {
          const rawBlock: MockTextBlock | MockThinkingBlock =
            typeof block === "string" ? { type: "text", text: block } : block;
          const assistantBlock = rawBlock.type === "thinking"
            ? { type: rawBlock.type, thinking: rawBlock.thinking, signature: rawBlock.signature }
            : rawBlock;

          if (mockEmitStreamDeltas) {
            eventQueue.push({
              type: "stream_event",
              event: {
                type: "content_block_start",
                index: 0,
                content_block: assistantBlock,
              },
            });
            eventQueue.push({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                index: 0,
                delta: rawBlock.type === "text"
                  ? { type: "text_delta", text: rawBlock.text }
                  : rawBlock.streamAsTextDelta
                    ? { type: "text_delta", text: rawBlock.thinking }
                    : { type: "thinking_delta", thinking: rawBlock.thinking },
              },
            });
            eventQueue.push({
              type: "stream_event",
              event: { type: "content_block_stop", index: 0 },
            });
          }
          eventQueue.push({
            type: "assistant",
            message: { content: [assistantBlock] },
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
    auth: {
      method: "subscription" as "subscription" | "api-key",
      apiKey: null as string | null,
      apiKeySource: null as "environment" | "config" | null,
      error: null as string | null,
    },
    telegramToken: "test-token",
    model: "claude-sonnet-4-6[1m]",
    workspaceDir: "",
    sessionsDir: "",
    historyLimit: 20,
    logsDir: "",
    tomoHome: "",
    continuity: false,
    continuityScript: null,
    city: null as string | null,
    identities: [] as Array<{ name: string; channels: Record<string, string>; replyPolicy: string }>,
    imessageUrl: "",
    imessagePassword: "",
    imessageWebhookPort: 3100,
    imessageInboundSettleMs: 0,
    imessageInboundMaxSettleMs: 0,
    imessageTypingStartDelayMs: 1200,
    imessagePassiveTypingStartDelayMs: 4000,
    sessionModelOverrides: {} as Record<string, string>,
    channelAllowlists: {} as Record<string, string[]>,
    passiveGroups: {} as Record<string, string[]>,
    groupSecret: null as string | null,
    steering: true,
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
const { SessionStore } = await import("../src/sessions/store.js");
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
  /** Raw streaming update calls before a block is committed. */
  streamUpdates: Delivery[] = [];
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
      update: (t: string) => {
        if (!canceled && !finished) {
          text = t;
          this.streamUpdates.push({ chatId, text: t });
        }
      },
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
  async simulateCommand(cmd: string, chatId: string, sender: string, args?: string, senderId?: string) {
    await this.commandHandler?.(cmd, chatId, sender, args, senderId);
  }
  clearDelivered() {
    this.sent = [];
    this.delivered = [];
    this.streamUpdates = [];
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

async function waitFor(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1));
    }
  }
  if (lastError) throw lastError;
  assertion();
}

async function expectNoChangeFor(assertion: () => void, durationMs = 20): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() <= deadline) {
    assertion();
    await new Promise((r) => setTimeout(r, 1));
  }
  assertion();
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
  mockSteerEcho = false;
  mockUserContents = [];
  queryState.reset();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("send_message direct mode", () => {
  it("parses MEDIA/STICKER tags into ordered attachment sends", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const imagePath = join(tmpDir, "photo with spaces.jpg");
    writeFileSync(imagePath, "fake image");

    const result = await agent.sendToSession(
      "telegram:12345",
      `here you go MEDIA:"${imagePath}" STICKER:CAACAgQAAxkBAAE123`,
    );

    expect(result).toEqual({ ok: true });
    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "here you go", photo: undefined, sticker: undefined },
      { chatId: "12345", text: "", photo: imagePath, sticker: undefined },
      { chatId: "12345", text: "", photo: undefined, sticker: "CAACAgQAAxkBAAE123" },
    ]);

    await agent.stop();
  });

  it("preserves verbatim direct text when there are no attachment tags", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const text = "  keep surrounding whitespace\n";

    const result = await agent.sendToSession("telegram:12345", text);

    expect(result).toEqual({ ok: true });
    expect(tg.delivered).toEqual([
      { chatId: "12345", text, photo: undefined, sticker: undefined },
    ]);
    const messages = new SessionStore(mockConfig.sessionsDir, 20).get("telegram:12345").messages;
    expect(messages).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: `[proactive] ${text}`,
      channel: "telegram",
    });
    expect((agent as unknown as { pendingNotes: Map<string, string[]> }).pendingNotes.get("telegram:12345")).toEqual([
      `[System: Tomo from another session sent the following message to this conversation earlier: "${text}"]`,
    ]);

    await agent.stop();
  });

  it("attributes a summoned-group send to the summoning dm session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      router: { summonGroup(ch: string, chatId: string, identity: string): void };
      sessions: { get(key: string): { messages: Array<{ content: string }> } };
      pendingNotes: Map<string, string[]>;
    };
    internals.router.summonGroup("telegram", "-987", "Alice");

    const result = await agent.sendToSession("telegram:-987", "hello group", "dm:alice");

    expect(result).toEqual({ ok: true });
    expect(internals.sessions.get("telegram:-987").messages.at(-1)?.content)
      .toBe("[via dm:alice (summoned)] hello group");
    expect(internals.pendingNotes.get("telegram:-987")).toEqual([
      `[System: Tomo from alice's main session (dm:alice), summoned into this group at the time, sent the following message here: "hello group"]`,
    ]);

    await agent.stop();
  });

  it("keeps neutral attribution when the caller is not the summoning session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      router: { summonGroup(ch: string, chatId: string, identity: string): void };
      sessions: { get(key: string): { messages: Array<{ content: string }> } };
      pendingNotes: Map<string, string[]>;
    };
    internals.router.summonGroup("telegram", "-987", "Alice");

    // Bob's own session direct-sends into Alice's summoned group
    const result = await agent.sendToSession("telegram:-987", "hi from bob", "telegram:222");

    expect(result).toEqual({ ok: true });
    expect(internals.sessions.get("telegram:-987").messages.at(-1)?.content)
      .toBe("[proactive] hi from bob");
    expect(internals.pendingNotes.get("telegram:-987")).toEqual([
      `[System: Tomo from another session sent the following message to this conversation earlier: "hi from bob"]`,
    ]);

    await agent.stop();
  });

  it("caps pending notes at 15 per session, keeping the most recent", async () => {
    const agent = new Agent();
    const internals = agent as unknown as {
      queuePendingNote(key: string, note: string): void;
      pendingNotes: Map<string, string[]>;
    };

    for (let i = 0; i < 20; i++) internals.queuePendingNote("telegram:-987", `note-${i}`);

    const notes = internals.pendingNotes.get("telegram:-987");
    expect(notes).toHaveLength(15);
    expect(notes?.[0]).toBe("note-5");
    expect(notes?.at(-1)).toBe("note-19");

    await agent.stop();
  });

  it("restores pending direct-send context after a restart and drains it once", async () => {
    const firstAgent = new Agent();
    const tg = new MockChannel("telegram");
    firstAgent.addChannel(tg);

    await firstAgent.sendToSession("telegram:12345", "survive restart", "dm:alice");
    await firstAgent.stop();

    const secondAgent = new Agent();
    const internals = secondAgent as unknown as {
      drainPendingNotes(key: string): string;
    };
    expect(internals.drainPendingNotes("telegram:12345")).toContain(
      'Tomo from another session sent the following message to this conversation earlier: "survive restart"',
    );
    await secondAgent.stop();

    const thirdAgent = new Agent();
    const thirdInternals = thirdAgent as unknown as {
      drainPendingNotes(key: string): string;
    };
    expect(thirdInternals.drainPendingNotes("telegram:12345")).toBe("");
    await thirdAgent.stop();
  });

  it("reports success after delivery when local persistence fails", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const sessions = (agent as unknown as { sessions: SessionStore }).sessions;
    vi.spyOn(sessions, "append").mockImplementation(() => {
      throw new Error("disk full");
    });
    vi.spyOn(sessions, "setPendingNotes").mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await agent.sendToSession("telegram:12345", "delivered once", "dm:alice");

    expect(result).toEqual({ ok: true });
    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "delivered once", photo: undefined, sticker: undefined },
    ]);
    await agent.stop();
  });
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
    // Participants persist via the metadata stub even before an SDK session id
    // is captured for the group.
    expect(agent.listSessionCatalog().groups).toContainEqual({
      key: "telegram:-100123",
      title: "New Title",
      participants: ["Alice"],
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

  it("queues cron failures into the next turn as bounded operational context", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      runWithRetry: (...args: unknown[]) => Promise<string>;
    };
    const originalRunWithRetry = internals.runWithRetry.bind(agent);
    internals.runWithRetry = vi.fn().mockRejectedValueOnce(
      new Error("You've hit your session limit · resets 3:10pm (America/Los_Angeles)"),
    ) as unknown as typeof internals.runWithRetry;

    await agent.handleCronMessage("Check something", "telegram:12345");

    expect(tg.sent[0].text).toBe(
      "[error] cron failed: You've hit your session limit · resets 3:10pm (America/Los_Angeles)",
    );

    internals.runWithRetry = originalRunWithRetry;
    const prompts: string[] = [];
    mockResponseFn = (text) => {
      prompts.push(text);
      return "recovered";
    };

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "are you back?" }));
    await drainQueue(agent);

    expect(prompts[0]).toContain("Recent Tomo errors before this turn");
    expect(prompts[0]).toContain("[error] cron failed: You've hit your session limit");

    await agent.stop();
  });

  it("treats successful SDK session-limit text as an error and briefs the next turn", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const prompts: string[] = [];

    mockResponseFn = (text) => {
      prompts.push(text);
      return prompts.length === 1
        ? "You've hit your session limit · resets 3:10pm (America/Los_Angeles)"
        : "recovered";
    };

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "first try" }));
    await drainQueue(agent);

    expect(tg.delivered.map((d) => d.text)).toEqual([
      "[error] You've hit your session limit · resets 3:10pm (America/Los_Angeles)",
    ]);

    tg.clearDelivered();
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "second try" }));
    await drainQueue(agent);

    expect(prompts[1]).toContain("Recent Tomo errors before this turn");
    expect(prompts[1]).toContain("[error] You've hit your session limit");
    expect(tg.delivered.map((d) => d.text)).toEqual(["recovered"]);

    await agent.stop();
  });

  it("caps pending error notes before injecting them into a prompt", async () => {
    const agent = new Agent();
    const internals = agent as unknown as {
      queuePendingErrorNote: (sessionKey: string, visibleError: string) => void;
      drainPendingNotes: (sessionKey: string) => string;
    };

    for (let i = 0; i < 10; i++) {
      internals.queuePendingErrorNote("telegram:12345", `[error] err-${i} ${"x".repeat(450)}`);
    }

    const drained = internals.drainPendingNotes("telegram:12345");
    const bulletCount = drained.match(/\n- /g)?.length ?? 0;

    expect(bulletCount).toBeLessThanOrEqual(3);
    expect(drained.length).toBeLessThan(1500);
    expect(drained).not.toContain("err-0");
    expect(drained).toContain("err-9");

    await agent.stop();
  });

  it("suppresses typing for silent housekeeping cron turns", async () => {
    resetConfig({ imessagePassiveTypingStartDelayMs: 0 });
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockResponseFn = () => "NO_REPLY";

    await agent.handleCronMessage(
      "System: An LCM rollup is due. After the rollup finishes, reply NO_REPLY.",
      "imessage:iMessage;+;group123",
      { showTyping: false },
    );

    expect(im.sent).toHaveLength(0);
    expect(im.typingStarts).toEqual([]);
    expect(im.typingStops).toEqual([]);

    await agent.stop();
  });

  it("never delivers LCM housekeeping output to a group", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    const responses = [
      "LCM compact completed, but I forgot to reply NO_REPLY",
      "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    ];
    mockResponseFn = () => responses.shift()!;

    await agent.handleCronMessage(
      "System: An LCM rollup is due. After the rollup finishes, reply NO_REPLY.",
      "imessage:iMessage;+;group123",
      { showTyping: false, suppressDelivery: true },
    );
    await agent.handleCronMessage(
      "System: Another LCM rollup is due. After the rollup finishes, reply NO_REPLY.",
      "imessage:iMessage;+;group123",
      { showTyping: false, suppressDelivery: true },
    );

    expect(im.sent).toHaveLength(0);
    expect(im.typingStarts).toEqual([]);
    expect(im.typingStops).toEqual([]);

    await agent.stop();
  });

  it("never delivers thrown cron errors to a group", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      runWithRetry: (...args: unknown[]) => Promise<string>;
    };
    internals.runWithRetry = vi.fn().mockRejectedValueOnce(
      new Error("Failed to authenticate. API Error: 401 Invalid authentication credentials"),
    ) as unknown as typeof internals.runWithRetry;

    await agent.handleCronMessage("Scheduled group task", "telegram:-100123");

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

  it("does not show iMessage group typing when a quick passive turn returns NO_REPLY", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockResponseFn = () => "NO_REPLY";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;+;group123", text: "side chatter", isGroup: true }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(0);
    expect(im.typingStarts).toEqual([]);
    expect(im.typingStops).toEqual([]);

    await agent.stop();
  });

  it("delays iMessage typing and clears it when a slow passive turn returns NO_REPLY", async () => {
    vi.useFakeTimers();
    resetConfig({ imessagePassiveTypingStartDelayMs: 100 });

    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockResponseFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return "NO_REPLY";
    };

    await im.simulateMessage(makeMsg({ chatId: "iMessage;+;group123", text: "side chatter", isGroup: true }));
    const drained = drainQueue(agent);

    await vi.advanceTimersByTimeAsync(99);
    expect(im.typingStarts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(im.typingStarts).toEqual(["iMessage;+;group123"]);

    await vi.advanceTimersByTimeAsync(50);
    await drained;

    expect(im.delivered).toHaveLength(0);
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

  it("asks the SDK to omit adaptive thinking display for Claude models", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hello" }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as {
      options?: { thinking?: { type: string; display?: string } };
    };
    expect(lastCall.options?.thinking).toEqual({ type: "adaptive", display: "omitted" });

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
  it("/login runs a two-step owner-DM flow and schedules restart after verification", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const fakeLogin = {
      start: vi.fn(async () => ({ url: "https://claude.com/login?state=test", reused: false })),
      complete: vi.fn(async () => {}),
      cancel: vi.fn(() => false),
      stop: vi.fn(),
    };
    const internals = agent as unknown as {
      commands: { claudeLogin: typeof fakeLogin };
    };
    internals.commands.claudeLogin = fakeLogin;

    await tg.simulateCommand("login", "12345", "Shuai", undefined, "12345");

    expect(fakeLogin.start).toHaveBeenCalledWith("shuai");
    expect(tg.sent[0].text).toContain("https://claude.com/login?state=test");
    expect(tg.sent[0].text).toContain("/login <code>");

    await tg.simulateCommand("login", "12345", "Shuai", "secret-code#test", "12345");

    expect(fakeLogin.complete).toHaveBeenCalledWith("shuai", "secret-code#test");
    expect(tg.sent[1].text).toBe("Claude login verified. Restarting Tomo...");
    expect(readFileSync(restartReasonFilePath, "utf-8")).toContain("Claude login refreshed");

    await agent.stop();
  });

  it("/login rejects groups without starting auth or creating a session", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const fakeLogin = {
      start: vi.fn(),
      complete: vi.fn(),
      cancel: vi.fn(),
      stop: vi.fn(),
    };
    const internals = agent as unknown as {
      commands: { claudeLogin: typeof fakeLogin };
      sessions: InstanceType<typeof SessionStore>;
    };
    internals.commands.claudeLogin = fakeLogin;

    await tg.simulateCommand("login", "-100123", "Shuai", undefined, "12345");

    expect(fakeLogin.start).not.toHaveBeenCalled();
    expect(tg.sent[0].text).toContain("private DM");
    expect(internals.sessions.listActiveEntries()).toHaveLength(0);

    await agent.stop();
  });

  it("/login rejects a private sender who is not a configured owner", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const fakeLogin = {
      start: vi.fn(),
      complete: vi.fn(),
      cancel: vi.fn(),
      stop: vi.fn(),
    };
    const internals = agent as unknown as {
      commands: { claudeLogin: typeof fakeLogin };
    };
    internals.commands.claudeLogin = fakeLogin;

    await tg.simulateCommand("login", "99999", "Other", undefined, "99999");

    expect(fakeLogin.start).not.toHaveBeenCalled();
    expect(tg.sent[0].text).toContain("configured owner");

    await agent.stop();
  });

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

  it("/pet reports when Tomo has no pet", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("pet", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Tomo doesn't have a pet yet. Ask Tomo to hatch one!");

    await agent.stop();
  });

  it("/pet shows the current pet status", async () => {
    const store = new PetStore(join(tmpDir, "data", "pet.json"));
    const pet = store.create("Mochi", "star fox");
    pet.stage = "baby";
    pet.hunger = 82;
    pet.happiness = 74;
    pet.energy = 61;
    pet.health = 95;
    pet.affection = 12;
    pet.care_mistakes = 1;
    store.save(pet);

    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateCommand("pet", "12345", "TestUser");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("🐾 Mochi the star fox");
    expect(tg.sent[0].text).toContain("Stage: baby");
    expect(tg.sent[0].text).toContain("Mood: happy");
    expect(tg.sent[0].text).toContain("Hunger: 82/100 · Happiness: 74/100");
    expect(tg.sent[0].text).toContain("Energy: 61/100 · Health: 95/100");
    expect(tg.sent[0].text).toContain("Bond: 7 · Care mistakes: 1");

    await agent.stop();
  });

  it("passes LiteLLM gateway env to the Claude Agent SDK child", async () => {
    resetConfig({
      auth: {
        method: "api-key",
        apiKey: "sk-anthropic-direct",
        apiKeySource: "config",
        error: null,
      },
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

  it("does not forward a parent Anthropic API key to a gateway without its own key", async () => {
    const oldApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-anthropic-parent";
    let agent: InstanceType<typeof Agent> | null = null;
    try {
      resetConfig({
        auth: {
          method: "api-key",
          apiKey: "sk-anthropic-parent",
          apiKeySource: "environment",
          error: null,
        },
        litellm: {
          mode: "anthropic-compatible",
          baseUrl: "http://localhost:4000",
          apiKey: "",
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
      expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:4000");
      expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (oldApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = oldApiKey;
      }
      await agent?.stop();
    }
  });

  it("passes a configured Anthropic API key to direct Claude sessions", async () => {
    resetConfig({
      auth: {
        method: "api-key",
        apiKey: "sk-anthropic-test",
        apiKeySource: "config",
        error: null,
      },
      lcm: {
        ...mockConfig.lcm,
        groupCompactStyle: "sdk",
      },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({
      chatId: "-100123",
      text: "Hi",
      isGroup: true,
      isMentioned: true,
    }));
    await drainQueue(agent);

    const calls = (sdkMock.query as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as {
      options?: { env?: Record<string, string | undefined> };
    };
    expect(lastCall.options?.env?.ANTHROPIC_API_KEY).toBe("sk-anthropic-test");
    expect(lastCall.options?.env?.ANTHROPIC_BASE_URL).toBeUndefined();

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
  it("settles split iMessage text and media fragments before starting a turn", async () => {
    vi.useFakeTimers();
    resetConfig({ imessageInboundSettleMs: 1500, imessageInboundMaxSettleMs: 5000 });

    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    const turnTexts: string[] = [];
    mockResponseFn = (text) => {
      turnTexts.push(text);
      return "reply";
    };

    const chatId = "iMessage;-;+15551234567";
    await im.simulateMessage(makeMsg({
      id: "im-text",
      chatId,
      text: "what do you think?",
    }));

    await vi.advanceTimersByTimeAsync(1000);
    await im.simulateMessage(makeMsg({
      id: "im-image",
      chatId,
      text: "[Sent an image]",
      images: [{ data: Buffer.from("image").toString("base64"), mediaType: "image/jpeg" }],
    }));

    await vi.advanceTimersByTimeAsync(1499);
    expect(turnTexts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await drainQueue(agent);

    expect(turnTexts).toHaveLength(1);
    expect(turnTexts[0]).toContain("User sent 2 messages in quick succession");
    expect(turnTexts[0]).toContain("what do you think?");
    expect(turnTexts[0]).toContain("[Sent an image]");
    expect(mockUserContents[0].some((block) => block.type === "image")).toBe(true);
    expect(im.delivered).toHaveLength(1);

    await agent.stop();
  });

  it("caps continuously extended iMessage settle windows", async () => {
    vi.useFakeTimers();
    resetConfig({ imessageInboundSettleMs: 1500, imessageInboundMaxSettleMs: 2500 });

    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    const turnTexts: string[] = [];
    mockResponseFn = (text) => {
      turnTexts.push(text);
      return "reply";
    };

    const chatId = "iMessage;-;+15551234567";
    await im.simulateMessage(makeMsg({ id: "im-1", chatId, text: "first" }));
    await vi.advanceTimersByTimeAsync(1000);
    await im.simulateMessage(makeMsg({ id: "im-2", chatId, text: "second" }));
    await vi.advanceTimersByTimeAsync(1000);
    await im.simulateMessage(makeMsg({ id: "im-3", chatId, text: "third" }));

    await vi.advanceTimersByTimeAsync(499);
    expect(turnTexts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await drainQueue(agent);

    expect(turnTexts).toHaveLength(1);
    expect(turnTexts[0]).toContain("User sent 3 messages in quick succession");
    expect(turnTexts[0]).toContain("first");
    expect(turnTexts[0]).toContain("second");
    expect(turnTexts[0]).toContain("third");

    await agent.stop();
  });

  it("coalesces concurrent DM messages into one turn when steering is disabled", async () => {
    resetConfig({ steering: false });
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

  it("coalesces DMs that arrive while a turn is in flight when steering is disabled", async () => {
    resetConfig({ steering: false });
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
    await waitFor(() => expect(turnTexts).toHaveLength(1));
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

  it("regression: channel-side serialization does not block coalescing when steering is disabled", async () => {
    // Models the grammy / iMessage pattern where a channel processes updates
    // sequentially, awaiting each handler before the next webhook is read.
    // Before the fix, awaiting enqueueMessage's returned promise would block
    // the next message until the SDK turn fully completed — defeating the
    // queue and preventing any pile-up. enqueueMessage is now fire-and-forget,
    // so a serial channel loop can still feed messages into the batch.
    resetConfig({ steering: false });
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
    let channelLoopDone = false;
    const channelLoop = (async () => {
      await tg.simulateMessage(makeMsg({ chatId: "12345", text: "msg one" }));
      await tg.simulateMessage(makeMsg({ chatId: "12345", text: "msg two" }));
      await tg.simulateMessage(makeMsg({ chatId: "12345", text: "msg three" }));
      channelLoopDone = true;
    })();

    await waitFor(() => expect(turnTexts).toHaveLength(1));
    await waitFor(() => expect(channelLoopDone).toBe(true));
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

  it("coalesces passive group messages with sender prefixes when steering is disabled", async () => {
    resetConfig({ steering: false });
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
    await waitFor(() => expect(order).toEqual(["user-start"]));
    expect(order).toEqual(["user-start"]);

    const cronP = agent.handleCronMessage("FROM_CRON", "telegram:12345");
    await expectNoChangeFor(() => expect(order).toEqual(["user-start"]));

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
    await waitFor(() => expect(order).toEqual(["user-start"]));
    expect(order).toEqual(["user-start"]);

    const contP = agent.handleContinuity("System: Free time.");
    await expectNoChangeFor(() => expect(order).toEqual(["user-start"]));

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
    await waitFor(() => expect(order).toEqual(["cron-start"]));
    expect(order).toEqual(["cron-start"]);

    const userP = tg.simulateMessage(makeMsg({ chatId: "12345", text: "USER_AFTER" }));
    await expectNoChangeFor(() => expect(order).toEqual(["cron-start"]));

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

  it("does not stream text-shaped deltas from thinking blocks", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockResponseFn = () => [
      { type: "thinking", thinking: "private reasoning that must not be sent", streamAsTextDelta: true },
      "public answer",
    ];

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "go" }));
    await drainQueue(agent);

    expect(tg.streamUpdates.map((d) => d.text)).toEqual(["public answer"]);
    expect(tg.delivered.map((d) => d.text)).toEqual(["public answer"]);

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

  it("preserves the sdk session link when stopping during an in-flight turn", async () => {
    resetConfig({
      identities: [{ name: "Shuai", channels: { imessage: "+15551112222" }, replyPolicy: "last-active" }],
    });
    const store = new SessionStore(mockConfig.sessionsDir, 20);
    store.setSdkSessionId("dm:shuai", "old-session-id");
    store.setReplyTarget("dm:shuai", { channelName: "imessage", chatId: "+15551112222" });

    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    let release: (() => void) | undefined;
    mockResponseFn = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return "late reply";
    };

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "restart now" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));

    await agent.stop();
    release?.();

    const after = new SessionStore(mockConfig.sessionsDir, 20).getEntry("dm:shuai");
    expect(after?.sdkSessionId).toBe("old-session-id");
    expect(after?.unlinkedAt).toBeNull();
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

// ===== Steering (config.steering) =====
//
// With steering enabled, a message that arrives while a turn is in flight is
// injected into the live session via LiveSession.steer() instead of waiting
// in the per-session queue. Two outcomes exist: the CLI merges it into the
// in-flight turn (echoed back as a `user` event, one combined result), or it
// misses the turn's tool boundaries and runs as its own follow-up turn.

type SteerableSession = {
  isBusy(): boolean;
  pendingSteers: unknown[];
};

function getLiveSession(agent: InstanceType<typeof Agent>, key: string): SteerableSession {
  const sessions = (agent as unknown as { liveSessions: Map<string, SteerableSession> }).liveSessions;
  return sessions.get(key)!;
}

describe("steering", () => {
  it("dedupes concurrent live-session creation during steered retry storms", async () => {
    resetConfig({ steering: true });
    const agent = new Agent();
    const internals = agent as unknown as {
      getOrCreateLiveSession: (key: string) => Promise<unknown>;
      mcpOAuthManager: {
        buildServersWithAuth: (...args: unknown[]) => Promise<unknown>;
      };
    };

    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
    const originalBuild = internals.mcpOAuthManager.buildServersWithAuth.bind(internals.mcpOAuthManager);
    let buildCalls = 0;
    internals.mcpOAuthManager.buildServersWithAuth = vi.fn(async (...args: unknown[]) => {
      buildCalls++;
      await buildGate;
      return originalBuild(...args);
    });

    const p1 = internals.getOrCreateLiveSession("telegram:12345");
    await waitFor(() => expect(buildCalls).toBe(1));

    const p2 = internals.getOrCreateLiveSession("telegram:12345");
    const p3 = internals.getOrCreateLiveSession("telegram:12345");
    await expectNoChangeFor(() => expect(buildCalls).toBe(1));

    releaseBuild!();
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);

    expect(s2).toBe(s1);
    expect(s3).toBe(s1);
    expect(buildCalls).toBe(1);
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("steers a mid-turn message by default instead of queueing it (follow-up turn outcome)", async () => {
    resetConfig();
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });

    mockResponseFn = async (text) => {
      if (text.includes("FIRST")) {
        order.push("first-start");
        await gate;
        order.push("first-end");
        return "reply one";
      }
      if (text.includes("SECOND")) {
        order.push("second-run");
        return "reply two";
      }
      return "misc";
    };

    await tg.simulateMessage(makeMsg({ text: "FIRST" }));
    await waitFor(() => expect(order).toEqual(["first-start"]));

    await tg.simulateMessage(makeMsg({ text: "SECOND" }));

    // The steered message is injected while the first turn is still gated —
    // it does NOT wait in the per-session queue.
    await waitFor(() => expect(getLiveSession(agent, "telegram:12345").pendingSteers).toHaveLength(1));
    expect(order).toEqual(["first-start"]);

    release!();
    await waitFor(() => {
      const texts = tg.delivered.map((d) => d.text);
      expect(texts).toContain("reply one");
      expect(texts).toContain("reply two");
    });

    expect(order).toEqual(["first-start", "first-end", "second-run"]);
    // The steered message ran as its own turn — no coalescing banner.
    expect(tg.delivered.map((d) => d.text).join("\n")).not.toContain("quick succession");
    expect(tg.delivered.some((d) => d.text.startsWith("[error]"))).toBe(false);
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("delivers a merged steered message once, through the owning turn's stream", async () => {
    resetConfig({ steering: true });
    mockSteerEcho = true;
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });

    mockResponseFn = async (text) => {
      if (text.includes("FIRST")) {
        await gate;
        return "reply one";
      }
      if (text.includes("SECOND")) return "reply two";
      return "misc";
    };

    await tg.simulateMessage(makeMsg({ text: "FIRST" }));
    await waitFor(() => expect(getLiveSession(agent, "telegram:12345").isBusy()).toBe(true));

    await tg.simulateMessage(makeMsg({ text: "SECOND" }));
    await waitFor(() => expect(getLiveSession(agent, "telegram:12345").pendingSteers).toHaveLength(1));

    release!();
    await waitFor(() => {
      const texts = tg.delivered.map((d) => d.text);
      expect(texts).toContain("reply one");
      expect(texts).toContain("reply two");
    });

    // Both replies came from the SAME turn; the steered request resolved as
    // merged and must not deliver anything extra (no duplicate, no error).
    await expectNoChangeFor(() => {
      expect(tg.delivered.filter((d) => d.text === "reply two")).toHaveLength(1);
      expect(tg.delivered.some((d) => d.text.startsWith("[error]"))).toBe(false);
    });
    expect(getLiveSession(agent, "telegram:12345").isBusy()).toBe(false);
    expect(queryState.maxConcurrent).toBe(1);

    await agent.stop();
  });

  it("keeps queueing mid-turn messages when steering is disabled", async () => {
    resetConfig({ steering: false });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });

    mockResponseFn = async (text) => {
      if (text.includes("FIRST")) {
        order.push("first-start");
        await gate;
        order.push("first-end");
        return "reply one";
      }
      order.push("second-run");
      return "reply two";
    };

    await tg.simulateMessage(makeMsg({ text: "FIRST" }));
    await waitFor(() => expect(order).toEqual(["first-start"]));

    await tg.simulateMessage(makeMsg({ text: "SECOND" }));
    await expectNoChangeFor(() => expect(order).toEqual(["first-start"]));
    expect(getLiveSession(agent, "telegram:12345").pendingSteers).toHaveLength(0);

    release!();
    await drainAllSessions(agent);

    expect(order).toEqual(["first-start", "first-end", "second-run"]);
    await agent.stop();
  });
});
