import { afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Channel, IncomingMessage, MessageReaction, OutgoingMessage, MessageHandler, CommandHandler, StopTypingOptions } from "../../src/channels/types.js";
import { agentEnv, mockConfig, mockWorkspace, queryState, resetMockSdk } from "./agent-mocks.js";

// ---------------------------------------------------------------------------
// Shared Agent test harness: MockChannel, message/config helpers, and the
// per-test setup/teardown hooks. Import this AFTER registering the module
// mocks (see the header comment in agent-mocks.ts) — vi.mock calls are
// hoisted above imports, so a plain import order in the test file is fine.
// ---------------------------------------------------------------------------

// These resolve to the mocked modules registered by the importing test file.
export { Agent } from "../../src/agent.js";
export { SessionStore } from "../../src/sessions/store.js";
export * as sdkMock from "@anthropic-ai/claude-agent-sdk";
export { agentEnv, mockConfig, mockSdk, mockWorkspace, queryState } from "./agent-mocks.js";

import type { Agent as AgentType } from "../../src/agent.js";

// ---------------------------------------------------------------------------
// MockChannel — tracks both send() and streaming deliveries
// ---------------------------------------------------------------------------

export interface Delivery {
  chatId: string;
  text: string;
  photo?: string;
  sticker?: string;
}

export class MockChannel implements Channel {
  readonly name: string;
  private messageHandler: MessageHandler | null = null;
  private commandHandler: CommandHandler | null = null;
  /** Messages sent via channel.send() */
  sent: OutgoingMessage[] = [];
  /** All delivered messages (mirrors `sent`; kept for readability at call sites). */
  delivered: Delivery[] = [];
  typingStarts: string[] = [];
  typingStops: Array<{ chatId: string; options?: StopTypingOptions }> = [];
  renamed: Array<{ chatId: string; title: string }> = [];
  reacted: Array<{ chatId: string; messageId: string; reaction: MessageReaction; remove?: boolean }> = [];

  constructor(name: string) { this.name = name; }

  onMessage(handler: MessageHandler) { this.messageHandler = handler; }
  onCommand(handler: CommandHandler) { this.commandHandler = handler; }

  async send(msg: OutgoingMessage) {
    // A torn-down channel is a DEAD channel — imsg's rpc child is killed, and
    // grammy's connection is closed. Throwing is what a send into that window
    // really does, and it is what turns into `[delivery failed]` in the
    // transcript, so tests that assert delivery during the shutdown drain are
    // only meaningful if this refuses.
    if (this.tornDown) throw new Error(`channel ${this.name} is torn down`);
    this.sent.push(msg);
    this.delivered.push({ chatId: msg.chatId, text: msg.text, photo: msg.photo, sticker: msg.sticker });
  }

  async setChatTitle(chatId: string, title: string) {
    this.renamed.push({ chatId, title });
  }

  async reactToMessage(chatId: string, messageId: string, reaction: MessageReaction, remove?: boolean) {
    this.reacted.push({ chatId, messageId, reaction, remove });
  }

  startTyping(chatId: string) {
    this.typingStarts.push(chatId);
    return (options?: StopTypingOptions) => {
      this.typingStops.push({ chatId, options });
    };
  }
  /** Set by closeIngestion(); mirrors the real channels' ingestion gate. */
  stopped = false;
  /** Set by teardown(); past this point the channel cannot send. */
  tornDown = false;
  /** Messages parked mid-parse by `beginSlowMessage` (what quiesce waits on). */
  private inFlightParses = new Set<Promise<void>>();

  async start() {}

  closeIngestion(): void { this.stopped = true; }

  async quiesce(): Promise<void> {
    while (this.inFlightParses.size > 0) {
      await Promise.allSettled([...this.inFlightParses]);
    }
  }

  async teardown(): Promise<void> { this.tornDown = true; }

  async stop() {
    this.closeIngestion();
    await this.quiesce();
    await this.teardown();
  }

  // Test helpers

  /**
   * Deliver an inbound message, unless ingestion is closed — the real channels
   * refuse at exactly this point (telegram's `ingest` entry guard, imsg's
   * `handleWatchMessage` entry guard), and a mock that kept accepting would
   * hide the shutdown hole the agent's stop order exists to close.
   *
   * Returns whether the AGENT accepted custody (see MessageHandler), or false
   * when the entry guard declined it before the handler ever ran.
   */
  async simulateMessage(msg: IncomingMessage): Promise<boolean> {
    if (this.stopped) return false;
    return (await this.messageHandler?.(msg)) ?? false;
  }

  /**
   * Ingest a message and park it INSIDE the parse path — the state a real
   * channel is in when a row is mid-attachment-load or an update is
   * mid-download and shutdown lands.
   *
   * This is the case the entry guard cannot cover and `quiesce()` exists for.
   * The message is already past the guard, so a later refusal would lose it
   * outright; `quiesce()` must hold shutdown open until `release()` lets it
   * reach the batcher. A mock that could only refuse at the boundary never
   * exercises that path at all.
   *
   * `release()` resumes the parse; `accepted` resolves to the agent's answer.
   */
  beginSlowMessage(msg: IncomingMessage): { release: () => void; accepted: Promise<boolean> } {
    if (this.stopped) return { release: () => {}, accepted: Promise.resolve(false) };

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let settle!: (accepted: boolean) => void;
    const accepted = new Promise<boolean>((resolve) => { settle = resolve; });

    const parse: Promise<void> = (async () => {
      await gate;
      settle((await this.messageHandler?.(msg)) ?? false);
    })().finally(() => { this.inFlightParses.delete(parse); });
    this.inFlightParses.add(parse);

    return { release, accepted };
  }
  async simulateCommand(cmd: string, chatId: string, sender: string, args?: string, senderId?: string) {
    await this.commandHandler?.(cmd, chatId, sender, args, senderId);
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

export function resetConfig(overrides: Partial<typeof mockConfig> = {}) {
  Object.assign(mockConfig, {
    ...DEFAULT_CONFIG_VALUES,
    sessionsDir: join(agentEnv.tmpDir, "sessions"),
    sdkSessionsDir: join(agentEnv.tmpDir, "sdk-sessions"),
    workspaceDir: join(agentEnv.tmpDir, "workspace"),
    logsDir: join(agentEnv.tmpDir, "logs"),
    tomoHome: agentEnv.tmpDir,
    identities: [],
    channelAllowlists: {},
    sessionModelOverrides: {},
    groupSecret: null,
    ...overrides,
  });
  agentEnv.configFilePath = join(agentEnv.tmpDir, "config.json");
  agentEnv.configBackupPath = join(agentEnv.tmpDir, "config.json.bak");
  agentEnv.restartReasonFilePath = join(agentEnv.tmpDir, ".restart-reason");
}

export function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    chatId: "12345",
    senderName: "TestUser",
    text: "Hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Wait for the agent's internal message queues to drain (tasks may enqueue
 *  more work; SessionQueue.drain re-checks until settled). */
export async function drainQueue(agent: AgentType): Promise<void> {
  const queue = (agent as unknown as { sessionQueue: { drain(): Promise<void> } }).sessionQueue;
  await queue.drain();
}

export function peekPendingNotes(agent: AgentType, sessionKey: string): string[] {
  const queue = (agent as unknown as {
    pendingNotesQueue: { peekNotes(key: string): string[] };
  }).pendingNotesQueue;
  return queue.peekNotes(sessionKey);
}

export async function waitFor(assertion: () => void, timeoutMs = 250): Promise<void> {
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

export async function expectNoChangeFor(assertion: () => void, durationMs = 20): Promise<void> {
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

/** Register the per-test tmp dir + mock-state reset hooks. Call once at the
 *  top level of each Agent test file. */
export function installAgentTestHooks(): void {
  beforeEach(() => {
    agentEnv.tmpDir = join(tmpdir(), `tomo-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(agentEnv.tmpDir, { recursive: true });
    resetConfig();
    mockWorkspace.systemPrompt = "Test system prompt";
    resetMockSdk();
    queryState.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(agentEnv.tmpDir, { recursive: true, force: true });
  });
}
