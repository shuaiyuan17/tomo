import { afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Channel, IncomingMessage, MessageReaction, OutgoingMessage, StreamingMessage, MessageHandler, CommandHandler, StopTypingOptions } from "../../src/channels/types.js";
import { splitOutboundMessageText } from "../../src/channels/text-utils.js";
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
      for (const part of splitOutboundMessageText(text)) {
        this.delivered.push({ chatId, text: part });
      }
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
      discardBlock: async () => { if (!canceled && !finished) text = ""; },
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
