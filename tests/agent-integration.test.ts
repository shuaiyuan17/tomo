import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Channel, IncomingMessage, OutgoingMessage, StreamingMessage, MessageHandler, CommandHandler } from "../src/channels/types.js";

// ---------------------------------------------------------------------------
// Mock SDK — queue-based approach avoids async-generator timing issues
// ---------------------------------------------------------------------------

/** Controls what the mock SDK returns for each user message */
let mockResponseFn: (text: string) => string = () => "mock response";

function createMockQuery(prompt: AsyncGenerator) {
  // Event queue + waiter for the consumer side
  const eventQueue: unknown[] = [];
  let waitResolve: (() => void) | null = null;
  let closed = false;

  // Background consumer: read from the prompt generator, push events to queue
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

        const response = mockResponseFn(text);

        // Emit stream event so onText callback fires → stream.update() gets called
        eventQueue.push({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: response } },
        });

        eventQueue.push({
          type: "assistant",
          message: { content: [{ text: response }] },
        });

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
    model: "claude-sonnet-4-6",
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
    groupSecret: null as string | null,
  },
}));

// Store the config path so activateGroup can read/write it
let configFilePath = "";

vi.mock("../src/config.js", () => ({
  config: mockConfig,
  get CONFIG_PATH() { return configFilePath; },
  TOMO_HOME: "/tmp/tomo-mock",
  RESTART_REASON_FILE: "/tmp/tomo-mock/.restart-reason",
}));

vi.mock("../src/workspace/index.js", () => ({
  buildSystemPrompt: () => "Test system prompt",
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator }) => createMockQuery(prompt)),
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

// ---------------------------------------------------------------------------
// MockChannel — tracks both send() and streaming deliveries
// ---------------------------------------------------------------------------

interface Delivery {
  chatId: string;
  text: string;
  photo?: string;
}

class MockChannel implements Channel {
  readonly name: string;
  private messageHandler: MessageHandler | null = null;
  private commandHandler: CommandHandler | null = null;
  /** Messages sent via channel.send() */
  sent: OutgoingMessage[] = [];
  /** All delivered messages (both streamed and sent) */
  delivered: Delivery[] = [];

  constructor(name: string) { this.name = name; }

  onMessage(handler: MessageHandler) { this.messageHandler = handler; }
  onCommand(handler: CommandHandler) { this.commandHandler = handler; }

  async send(msg: OutgoingMessage) {
    this.sent.push(msg);
    this.delivered.push({ chatId: msg.chatId, text: msg.text, photo: msg.photo });
  }

  createStreamingMessage(chatId: string, _replyTo?: string): StreamingMessage {
    let text = "";
    return {
      update: (t: string) => { text = t; },
      finish: async () => {
        if (text) this.delivered.push({ chatId, text });
      },
    };
  }

  startTyping(_chatId: string): () => void { return () => {}; }
  async start() {}
  async stop() {}

  // Test helpers
  async simulateMessage(msg: IncomingMessage) { await this.messageHandler?.(msg); }
  async simulateCommand(cmd: string, chatId: string, sender: string, args?: string) {
    await this.commandHandler?.(cmd, chatId, sender, args);
  }
  clearDelivered() { this.sent = []; this.delivered = []; }
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
});

// ===== Message queueing =====

describe("message queueing", () => {
  it("serializes concurrent messages to the same session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const order: number[] = [];
    let seq = 0;
    mockResponseFn = () => {
      order.push(++seq);
      return `reply-${seq}`;
    };

    // Fire two messages concurrently to same chatId
    const p1 = tg.simulateMessage(makeMsg({ chatId: "12345", text: "First" }));
    const p2 = tg.simulateMessage(makeMsg({ chatId: "12345", text: "Second" }));
    await Promise.all([p1, p2]);
    await drainQueue(agent);

    expect(tg.delivered).toHaveLength(2);
    // Messages should process in order (queue serialization)
    expect(order).toEqual([1, 2]);

    await agent.stop();
  });
});
