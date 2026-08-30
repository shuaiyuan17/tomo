import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock state + module factories for the Agent integration suites.
//
// This module must not (transitively) import anything from src/ at runtime:
// the vi.mock factories in each test file load it with a dynamic import, and
// a src import here would win the race against the module mocks.
//
// Each test file registers the module mocks itself (vi.mock is per-file):
//
//   vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
//   vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
//   vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
//   vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
//
// Vitest isolates test files, so this state is fresh per file; the
// installAgentTestHooks() beforeEach (see agent-harness.ts) resets it per test.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mock SDK — queue-based approach avoids async-generator timing issues
// ---------------------------------------------------------------------------

type MockTextBlock = { type: "text"; text: string };
export type MockThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
  /** Test hook: simulate a thinking block whose stream delta is text-shaped. */
  streamAsTextDelta?: boolean;
};
export type MockToolUseBlock = {
  type: "tool_use";
  id?: string;
  name: string;
  input?: Record<string, unknown>;
};
type MockResponseBlock = string | MockTextBlock | MockThinkingBlock | MockToolUseBlock;
export type MockResponse = string | MockResponseBlock[];

export interface MockQueryController {
  pushTaskNotificationTurn(response: MockResponse, notification?: string): void;
}

/** Mutable per-file mock-SDK state. Tests write these fields directly. */
export const mockSdk = {
  /** Controls what the mock SDK returns for each user message. Returning a
   *  string emits a single text block; returning an array emits one assistant
   *  event per element (each becomes its own block, stitched into the same turn
   *  — the SDK only fires `result` once at the end). */
  responseFn: (() => "mock response") as (text: string) => MockResponse | Promise<MockResponse>,
  emitStreamDeltas: true,
  userContents: [] as Array<Array<{ type: string; text?: string }>>,
  /** When true, the mock pulls one extra pending user message mid-turn and
   *  echoes it back as a `user` event before the turn's result — simulating the
   *  CLI injecting a steered message at a tool boundary. Tests MUST guarantee
   *  the steered message is already pending before the turn unblocks; a
   *  timed-out race here would otherwise swallow a later message. */
  steerEcho: false,
  /** Context usage reported by the mock SDK's getContextUsage() after each turn. */
  contextUsage: { totalTokens: 5000, maxTokens: 200000 },
  /** When set, the next query created fails its event stream with this error
   *  message (one-shot) — simulates SDK session errors like "No conversation
   *  found" that trip runWithRetry's reset-and-retry branch. */
  failNextQuery: null as string | null,
  /** Merged into the next turn's `result` event (one-shot) — e.g.
   *  `{ subtype: "error_max_turns", is_error: true, errors: [...] }` to
   *  simulate the CLI ending a turn on an error result. */
  nextResult: null as Record<string, unknown> | null,
  queryControllers: [] as MockQueryController[],
  mcpServerSets: [] as Array<Record<string, unknown>>,
  /** Every prompt the mock received, tagged with the session it ran on
   *  (from options.env.TOMO_SESSION_KEY). Lets a test assert WHICH session a
   *  turn ran on without depending on that turn delivering anything — which
   *  suppressed turns (continuity, restart notice) deliberately do not. */
  promptsBySession: [] as Array<{ sessionKey: string; text: string }>,
  /** Options each live session was built with, keyed by session. Lets a test
   *  reach the SDK `hooks` the harness installed — see
   *  tests/summon-private-memory-hook.test.ts. */
  optionsBySession: [] as Array<{ sessionKey: string; options: Record<string, unknown> }>,
};

export function resetMockSdk(): void {
  mockSdk.responseFn = () => "mock response";
  mockSdk.emitStreamDeltas = true;
  mockSdk.userContents = [];
  mockSdk.steerEcho = false;
  mockSdk.contextUsage = { totalTokens: 5000, maxTokens: 200000 };
  mockSdk.failNextQuery = null;
  mockSdk.nextResult = null;
  mockSdk.queryControllers = [];
  mockSdk.mcpServerSets = [];
  mockSdk.promptsBySession = [];
  mockSdk.optionsBySession = [];
}

/** Track in-flight mock queries so tests can assert no concurrency */
export const queryState = {
  inFlight: 0,
  maxConcurrent: 0,
  reset() { this.inFlight = 0; this.maxConcurrent = 0; },
};

function responseBlocks(responseValue: MockResponse): MockResponseBlock[] {
  return Array.isArray(responseValue) ? [...responseValue] : [responseValue];
}

function enqueueAssistantTurnEvents(
  eventQueue: unknown[],
  blocks: MockResponseBlock[],
  wakeConsumer: () => void,
): void {
  // For each block, emit stream events + an assistant event. This mirrors how
  // the real SDK reports multi-block turns: text deltas arrive, then an
  // `assistant` event consolidates the just-completed block(s). Only one
  // `result` fires at the end of the whole turn.
  for (const block of blocks) {
    const rawBlock: MockTextBlock | MockThinkingBlock | MockToolUseBlock =
      typeof block === "string" ? { type: "text", text: block } : block;
    const assistantBlock = rawBlock.type === "thinking"
      ? { type: rawBlock.type, thinking: rawBlock.thinking, signature: rawBlock.signature }
      : rawBlock;

    // Tool-use blocks carry no text/thinking deltas to stream — the SDK
    // reports them via partial_json input deltas we don't need to simulate
    // here; the block just arrives whole in its `assistant` event, same as
    // the real tool_use content our code only inspects post-hoc.
    if (mockSdk.emitStreamDeltas && rawBlock.type !== "tool_use") {
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

  const resultOverride = mockSdk.nextResult;
  mockSdk.nextResult = null;
  eventQueue.push({
    type: "result",
    subtype: "success",
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
    ...(resultOverride ?? {}),
  });

  wakeConsumer();
}

function createMockQuery(prompt: AsyncGenerator, sessionKey = "") {
  // One-shot failure injection: this query's event stream throws instead of
  // producing events.
  const failWith = mockSdk.failNextQuery;
  mockSdk.failNextQuery = null;

  // Event queue + waiter for the consumer side
  const eventQueue: unknown[] = [];
  let waitResolve: (() => void) | null = null;
  let closed = false;
  const wakeConsumer = () => {
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r();
    }
  };

  mockSdk.queryControllers.push({
    pushTaskNotificationTurn(response, notification = "<task-notification>background task complete</task-notification>") {
      eventQueue.push({
        type: "user",
        message: { content: [{ type: "text", text: notification }] },
      });
      enqueueAssistantTurnEvents(eventQueue, responseBlocks(response), wakeConsumer);
    },
  });

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
          mockSdk.userContents.push(content);
          for (const block of content) {
            if (block.type === "text") text += block.text;
          }
          mockSdk.promptsBySession.push({ sessionKey, text });
        }

        const responseValue = await mockSdk.responseFn(text);
        let blocks = responseBlocks(responseValue);

        if (mockSdk.steerEcho) {
          const extra = await Promise.race([
            prompt.next() as Promise<IteratorResult<unknown>>,
            new Promise<null>((r) => setTimeout(() => r(null), 25)),
          ]);
          if (extra && !extra.done) {
            const extraContent = (extra.value as { message?: { content?: Array<{ type: string; text?: string }> } })
              ?.message?.content ?? [];
            mockSdk.userContents.push(extraContent);
            eventQueue.push({ type: "user", isReplay: true, message: { content: extraContent } });
            let extraText = "";
            for (const b of extraContent) {
              if (b.type === "text") extraText += b.text ?? "";
            }
            const extraResp = await mockSdk.responseFn(extraText);
            blocks = blocks.concat(responseBlocks(extraResp));
          }
        }

        enqueueAssistantTurnEvents(eventQueue, blocks, wakeConsumer);
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
          if (failWith) throw new Error(failWith);
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
      wakeConsumer();
    },
    async getContextUsage() {
      const { totalTokens, maxTokens } = mockSdk.contextUsage;
      return {
        totalTokens,
        maxTokens,
        percentage: (totalTokens / maxTokens) * 100,
        categories: [{ name: "conversation", tokens: totalTokens }],
      };
    },
    async setMcpServers(servers: Record<string, unknown>) {
      mockSdk.mcpServerSets.push(servers);
      return { added: Object.keys(servers), removed: [], errors: {} };
    },
  };

  return iterable;
}

// ---------------------------------------------------------------------------
// Mocked config / workspace state
// ---------------------------------------------------------------------------

export const mockWorkspace = { systemPrompt: "Test system prompt" };

export const mockConfig = {
  auth: {
    method: "subscription" as "subscription" | "api-key",
    apiKey: null as string | null,
    apiKeySource: null as "environment" | "config" | null,
    error: null as string | null,
  },
  telegramToken: "test-token",
  model: "claude-sonnet-5[1m]",
  workspaceDir: "",
  sessionsDir: "",
  sdkSessionsDir: "",
  historyLimit: 20,
  logsDir: "",
  tomoHome: "",
  continuity: false,
  continuityScript: null,
  city: null as string | null,
  identities: [] as Array<{ name: string; channels: Record<string, string>; replyPolicy: string }>,
  imessageProvider: null as "imsg" | null,
  imessageInboundSettleMs: 0,
  imessageInboundMaxSettleMs: 0,
  imessageTypingStartDelayMs: 1200,
  imessagePassiveTypingStartDelayMs: 4000,
  plugins: [] as Array<{ ref: string; isPath?: boolean; skipMcpDiscovery?: boolean }>,
  sessionModelOverrides: {} as Record<string, string>,
  channelAllowlists: {} as Record<string, string[]>,
  passiveGroups: {} as Record<string, string[]>,
  groupSecret: null as string | null,
  steering: true,
  liveSessionTimeoutMs: 10 * 60 * 1000,
  litellm: null as { mode: "anthropic-compatible" | "chatgpt-subscription"; baseUrl: string; apiKey: string } | null,
  /** External MCP servers (src/mcp/external-config.ts shape); undefined = none configured. */
  mcpServers: undefined as undefined | Record<string, {
    server: { type: "http"; url: string };
    oauth?: { clientId?: string; scopes: string[]; tokenStoreKey: string };
  }>,
  lcm: {
    nudgeAtPct: 70,
    nudgeResetPct: 60,
    groupCompactStyle: "lcm" as "sdk" | "lcm",
    dailyFreshTail: 32,
    globalFreshTail: false,
  },
};

/** Per-test paths under the tmp dir (set by resetConfig in agent-harness.ts).
 *  activateGroup and the /login flow read/write these files directly. */
export const agentEnv = {
  tmpDir: "",
  configFilePath: "",
  configBackupPath: "",
  restartReasonFilePath: "",
};

// ---------------------------------------------------------------------------
// Module factories for vi.mock
// ---------------------------------------------------------------------------

export function configModuleMock() {
  return {
    config: mockConfig,
    get CONFIG_PATH() { return agentEnv.configFilePath; },
    get CONFIG_BACKUP_PATH() { return agentEnv.configBackupPath; },
    TOMO_HOME: "/tmp/tomo-mock",
    get RESTART_REASON_FILE() { return agentEnv.restartReasonFilePath; },
  };
}

export function workspaceModuleMock() {
  return {
    buildSystemPrompt: () => mockWorkspace.systemPrompt,
    PRIVATE_MEMORY_SUBDIR: "private",
    PRIVATE_MEMORY_DIR: "/tmp/tomo-mock/workspace/memory/private",
    MEMORY_DIR: "/tmp/tomo-mock/workspace/memory",
  };
}

export function sdkModuleMock() {
  return {
    query: vi.fn(({ prompt, options }: { prompt: AsyncGenerator; options?: { env?: Record<string, string> } }) => {
      mockSdk.optionsBySession.push({
        sessionKey: options?.env?.TOMO_SESSION_KEY ?? "",
        options: (options ?? {}) as Record<string, unknown>,
      });
      return createMockQuery(prompt, options?.env?.TOMO_SESSION_KEY ?? "");
    }),
    // `tools` is kept (the real SDK hides them inside `instance`) so a test can
    // build the tomo-internal server for a session and call its handlers
    // directly — see tests/summon-private-tools.test.ts.
    createSdkMcpServer: vi.fn((opts: { name: string; tools?: unknown[] }) => ({
      type: "sdk", name: opts.name, instance: {}, tools: opts.tools ?? [],
    })),
    tool: vi.fn((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
      name, description, inputSchema, handler,
    })),
  };
}

export function loggerModuleMock() {
  return {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}
