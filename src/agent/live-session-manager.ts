import { RewindError } from "./session-rewind.js";
import type { OwnerText } from "../i18n/index.js";
import { createHash } from "node:crypto";
import type {
  ElicitationRequest,
  ElicitationResult,
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  McpSetServersResult,
} from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { McpConnection } from "../mcp/live-status.js";
import { McpHealthMonitor, MCP_PRE_TURN_WAIT_MS } from "./mcp-health.js";
import { InformationalNotices } from "./sdk-informational.js";
import { checkAndClearCompactTrigger } from "../lcm/index.js";
import { getCompactTriggerPath } from "../lcm/compact.js";
import { existsSync } from "node:fs";
import { CompactReservations, type BackgroundState, type ReserveResult } from "./compact-reservations.js";
import { TOMO_INTERNAL_MCP_NAME } from "../mcp/internal-server.js";
import { repairSdkSessionForResume } from "../sessions/repair.js";
import type { SessionMessage, UsageBaseline } from "../sessions/types.js";
import type { UsageLedgerRow } from "../usage/ledger.js";
import { SHUTDOWN_NOT_PROCESSED } from "./block-transcript.js";
import { DELIVERY_TIMEOUT_MS, LiveSession, MAX_TURNS_RESPONSE, QUERY_TIMEOUT_ERROR_PREFIX, STEER_MERGED, SdkResultError, TurnInterruptedError, type McpAuthRefreshOutcome, type QueryResult, type TurnRequest } from "./live-session.js";
import { SteerDeclinedError } from "./sdk-result.js";
import type { GroupSandboxConfig } from "./group-fs-policy.js";
import { makeTurnBudget, sdkOptions, type SessionContext } from "./sdk-options.js";
import type { RunWithRetryRequest } from "./turn-runner.js";
import { flattenSystemPrompt } from "../workspace/system-prompt-blocks.js";
import { errorMessage } from "../error-text.js";

/**
 * How long a prompt-stale session may wait for its background tasks before it
 * is retired anyway. Long enough for a typical subagent run, short enough that
 * a hung task cannot pin a stale system prompt for the rest of the day.
 */
export const PROMPT_RETIRE_BACKGROUND_WAIT_MS = 2 * 60 * 60 * 1000;

/**
 * After the background set drains, how long to wait for the follow-up turn
 * that reports the finished task before retiring without it.
 */
export const PROMPT_RETIRE_REPORT_WAIT_MS = 10 * 60 * 1000;

/**
 * Session-lifecycle failures that a reset-and-retry can genuinely fix:
 * a broken resume chain ("No conversation found") or the SDK child going
 * away ("Session is closed", process exit). Matched narrowly on purpose —
 * a retry re-runs the WHOLE turn, so a broad match (any error merely
 * mentioning "session", e.g. from an MCP tool or the API) would duplicate
 * side effects the turn's first attempt already performed.
 */
/**
 * Structural equality for two MCP server configs. Only used to recognize a
 * redundant hot-mount, so JSON is enough: these are plain config records
 * (url/headers/args), and an SDK server carries a non-serializable `instance`
 * that stringifies to the same shape only when it is literally the same
 * object — which the identity check below already covers.
 */
function sameServerConfig(a: McpServerConfig | undefined, b: McpServerConfig): boolean {
  if (a === b) return true;
  if (!a) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Upper bound on how long /rewind waits for a stopped session to wind down. */
export const REWIND_SUSPEND_TIMEOUT_MS = 10_000;

/** How often the idle reaper looks (capped by the timeout itself). */
export const IDLE_REAP_SWEEP_MS = 60_000;

/**
 * How long the SDK can take to get rid of a closed CLI child: it ends stdin,
 * waits ~2s, sends SIGTERM, and SIGKILLs ~5s after that (ProcessTransport's
 * close() in @anthropic-ai/claude-agent-sdk). A child can be alive, and
 * writing its transcript, for about this long after close().
 */
export const SDK_CLI_KILL_MS = 7_000;

/**
 * Upper bound on how long a message (or a /rewind) for a reaped key waits for
 * the old CLI child to exit before resuming. Above SDK_CLI_KILL_MS, so it
 * only gives up on a child the SDK's own SIGKILL did not end.
 */
export const IDLE_REAP_CLOSE_WAIT_MS = 10_000;

/** Resolves true if `promise` settled within `ms`, false on timeout. Never rejects. */
async function withTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecoverableSessionError(errMsg: string): boolean {
  return errMsg.includes("No conversation found")
    || /session (?:is )?closed/i.test(errMsg)
    || /process exited/i.test(errMsg);
}

/**
 * Upper bound on how long shutdown waits for in-flight turns to flush their
 * block transcripts before the daemon exits.
 *
 * `min(DELIVERY_TIMEOUT_MS, 5s)` — 5s, the short cap. The flush itself is
 * synchronous once a turn's promise settles, and `LiveSession.close()` now
 * settles it synchronously, so this is insurance and not a budget we expect to
 * spend. It has to stay well under the per-block delivery timeout, or one
 * wedged channel send could hold the daemon open for a minute; and well under
 * the ~10s SIGTERM grace period init systems allow, or shutdown gets SIGKILLed
 * and we lose the very entries this wait exists to write.
 */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = Math.min(DELIVERY_TIMEOUT_MS, 5_000);

/** Re-exported so shutdown policy reads in one place; defined with the other
 *  transcript markers (block-transcript.ts) to keep this module import-cycle
 *  free. */
export { SHUTDOWN_NOT_PROCESSED } from "./block-transcript.js";

/**
 * The narrow surface the session lifecycle needs from the Agent: the durable
 * SDK-session registry, per-session option assembly (MCP wiring, group
 * context), and the post-turn context-pressure hook.
 */
export interface LiveSessionManagerDeps {
  /**
   * Current system prompt — hashed to detect workspace changes. Only the
   * workspace (static, pre-boundary) prompt belongs here: per-session blocks
   * and the SDK cache-boundary marker are not workspace changes. A block array
   * is accepted and flattened, so the marker itself never moves the hash.
   */
  buildSystemPrompt(): string | readonly string[];
  getSdkSessionId(key: string): string | undefined;
  setSdkSessionId(key: string, sessionId: string): void;
  clearSdkSessionId(key: string): void;
  retireSdkSessionId(key: string): void;
  /**
   * The persisted SDK usage baseline for the session `key` links to — what a
   * resumed session's cumulative cost/token totals are differenced against.
   */
  getUsageBaseline(key: string, sdkSessionId: string): UsageBaseline | undefined | Promise<UsageBaseline | undefined>;
  updateStats(key: string, result: QueryResult): void;
  /**
   * One SDK result's usage-ledger row (see UsageRecorder), for every result,
   * background turns included. The row also carries the cumulative snapshot
   * that `getUsageBaseline` reads back first on the next resume.
   */
  recordUsage?(key: string, build: () => UsageLedgerRow | undefined, onWritten: () => void): void;
  /** Transcript messages for pre-resume repair. */
  getSessionMessages(key: string): SessionMessage[];
  /** Per-session model override, if any. */
  getModelOverride(key: string): string | undefined;
  /** Per-session internal MCP server bound to the caller's session key. */
  createInternalMcpServer(key: string): McpSdkServerConfigWithInstance;
  /** External MCP servers with OAuth, authorize-URL forwarding bound to the key. */
  buildExternalMcpServers(key: string): Promise<Record<string, McpServerConfig>>;
  /** Group metadata snapshot for the system prompt — undefined for non-groups. */
  buildGroupContext(key: string): SessionContext["group"];
  /**
   * Does the turn currently in flight on `key` belong to that session?
   * (`Agent.isOwnAudienceTurn`.) False while a summoned group is steering a
   * dm: session, and for a batch spanning several audiences. Read per tool
   * call by the private-memory PreToolUse guard, so it must be a live query
   * and not a value snapshotted at session creation.
   */
  isOwnAudienceTurn(key: string): boolean;
  /**
   * The key the turn in flight on `key` is scoped to (`Agent.scopedCallerKey`),
   * which is the steering group's key on a summoned turn. Read per tool call by
   * the private-memory guard so a summoned turn inherits its group's
   * `groupSandbox` entry; a live query for the same reason as above.
   */
  scopedCallerKey(key: string): string;
  /** The group sandbox config the guard applies on `key`, per tool call
   *  (config plus live Allow-once grants). Optional: absent ⇒ config alone. */
  groupSandbox?(key: string, opts: { once: boolean }): GroupSandboxConfig;
  /** A sandboxed call on `key`, for a later permission card's trigger line. */
  noteSandboxedCall?(key: string, text: string): void;
  handleMcpElicitation(key: string, request: ElicitationRequest): Promise<ElicitationResult>;
  /** Delivery plumbing for SDK-initiated (unowned) turns. */
  createUnownedTurnRequest(key: string): TurnRequest | undefined;
  /** Observe persisted SDK tool-result events for daemon control handshakes. */
  handleToolResult?(key: string, toolName: string, content: unknown, isError: boolean): void;
  /** A turn on this session just finished (successfully or with an SDK error). */
  handleTurnComplete?(key: string): void;
  /** Post-turn context-pressure check (Agent.maybeNudgeCompact). */
  maybeNudgeCompact(key: string, ctx: QueryResult | null): void;
  /**
   * A mounted external MCP server rejected a tool call for authorization
   * reasons: refresh its OAuth token (non-interactively) so the refreshed
   * config comes back through hotMountExternalMcpServer. The outcome feeds
   * the reporting session's retry budget.
   */
  refreshExternalMcpToken(serverName: string): Promise<McpAuthRefreshOutcome>;
  /**
   * The owner-notice path (Agent.notifyOwner), for an MCP server automatic
   * reconnects could not bring back. Absent: logged only.
   */
  notifyOwner?(text: OwnerText): Promise<boolean>;
}

/** How long an explicit (web / chat) reconnect is waited for; under the web's MCP_RECONNECT_RPC_TIMEOUT_MS. */
export const MCP_MANUAL_RECONNECT_WAIT_MS = 20_000;

/**
 * Owns the LiveSession lifecycle: creation (with SDK-session resume and
 * pre-resume repair), the system-prompt-hash sweep that retires stale
 * sessions, the send/steer retry policy, and shutdown. This is the
 * concurrency-sensitive core moved verbatim out of Agent.
 */
export class LiveSessionManager {
  private liveSessions = new Map<string, LiveSession>();
  /** Sessions with a compact approved and not yet reloaded (rollup gate). */
  private compactReservations = new CompactReservations((key, sdkSessionId) => {
    if (!existsSync(getCompactTriggerPath(sdkSessionId, config.sdkSessionsDir))) return false;
    // A key that has moved on to another SDK session (reset, fork) will never
    // consume the old session's trigger, so it no longer has a reload pending.
    const currentId = this.liveSessions.get(key)?.getSessionId() ?? this.deps.getSdkSessionId(key);
    return !currentId || currentId === sdkSessionId;
  });
  /** Per key: web "move to background" requests still waiting on the SDK. */
  private backgroundingInFlight = new Map<string, number>();
  /** Keys whose current SDK session id could not be written to the registry; retried on the next turn completion. */
  private unpersistedLinks = new Set<string>();
  private externalMcpServersBySession = new Map<string, ReadonlySet<string>>();
  private mcpServerConfigsBySession = new Map<string, Record<string, McpServerConfig>>();
  private hotMountQueue: Promise<void> = Promise.resolve();
  // Sessions whose system prompt is out of date (workspace changed since they
  // were built). They STAY in liveSessions so in-flight conversations keep
  // their steering target; each is retired at its next idle boundary instead
  // of all at once — see sweepPromptChanges().
  private promptStale = new Set<LiveSession>();
  private liveSessionCreates = new Map<string, Promise<LiveSession>>();
  private lastPromptHash: string = "";
  private stopping = false;
  /**
   * Turns currently inside runWithRetry. Shutdown waits on these (bounded) so
   * the process does not exit between a turn's session dying and its block
   * transcript being flushed.
   */
  private inFlightTurns = new Set<Promise<string>>();
  /**
   * Keys a /rewind is working on (see suspendForRewind). While a key is held,
   * no live session is created or handed out for it: turns that arrive in the
   * meantime — queued user messages, steered drains, crons, heartbeats — wait
   * here and then run on the rewound conversation.
   */
  private sessionHolds = new Map<string, Promise<void>>();
  /**
   * Turns inside dispatchTurn, per key. A turn is "running" from the moment it
   * is dispatched — still building its session (slow external-MCP setup), or
   * built but not yet claimed — not only once LiveSession.isBusy() says so.
   * suspendForRewind marks every one present as interrupted, which makes it
   * end with TurnInterruptedError at its next step instead of running later.
   */
  private dispatches = new Map<string, Set<{ interrupted: boolean }>>();
  /**
   * Per-key generation, bumped by suspendForRewind. A session build captures
   * it (and the SDK id it resumes) at start and refuses to publish if either
   * changed — so a build that outlived a rewind's wait budget cannot publish a
   * session resuming the pre-rewind conversation after the rewind finished.
   */
  private generations = new Map<string, number>();
  /** Release for each hold in `sessionHolds` — stop() releases them all. */
  private holdReleases = new Map<string, () => void>();
  /** The idle reaper's timer; armed with the first live session, cleared by stop(). */
  private idleReapTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * The CLOSING state of a reaped session. The reaper closes the session but
   * leaves it in `liveSessions` until its CLI child has exited (bounded by
   * IDLE_REAP_CLOSE_WAIT_MS), because that child may still append exit-time
   * records to the transcript. Every path that looks the key up therefore
   * still finds the entry and handles it (see `closingWait`); this marks
   * which dead entry is closing and holds the promise its removal rides on.
   */
  private closing = new WeakMap<LiveSession, Promise<void>>();

  /** SDK-reported MCP health: lifecycle logs, pre-turn reconnect, owner notice. */
  private readonly mcpHealth: McpHealthMonitor;
  /** Owner notices for SDK informational warnings, deduped per tag and session. */
  private readonly informationalNotices: InformationalNotices;
  /** Keys held by an explicit MCP reconnect: a turn waits (bounded) for it to finish. */
  private mcpReservations = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: LiveSessionManagerDeps) {
    this.mcpHealth = new McpHealthMonitor({
      notifyOwner: async (text) => (await this.deps.notifyOwner?.(text)) === true,
    });
    this.informationalNotices = new InformationalNotices({
      notifyOwner: async (text) => (await this.deps.notifyOwner?.(text)) === true,
    });
  }

  /** Is a live turn currently in flight on this session? (steering target check) */
  isBusy(key: string): boolean {
    const live = this.liveSessions.get(key);
    return !!live?.isAlive() && live.isBusy();
  }

  /** Soft-stop the key's running turn (SDK interrupt); the session stays. False when nothing runs. */
  async stopTurn(key: string): Promise<boolean> {
    const live = this.liveSessions.get(key);
    return live?.isAlive() && live.isBusy() ? live.stop() : false;
  }

  /**
   * Is a turn running on this key in any phase: dispatched (still building
   * its session, or built and not yet claimed), being answered, or held by a
   * /rewind? Wider than isBusy(), which only sees the answering phase. Used to
   * refuse a model switch from the web rather than close a session under a turn.
   */
  hasTurnInFlight(key: string): boolean {
    return this.isBusy(key) || (this.dispatches.get(key)?.size ?? 0) > 0
      || this.liveSessionCreates.has(key) || this.sessionHolds.has(key);
  }

  /**
   * Background work on the key's live session that a compact reload would
   * cut: live non-ambient tasks, and a drained task whose report turn is
   * still due (bounded like retireWhenIdle's report wait). Nothing without a
   * live session.
   */
  backgroundState(key: string): BackgroundState {
    const live = this.liveSessions.get(key);
    const backgroundingInFlight = this.backgroundingInFlight.get(key) ?? 0;
    if (!live?.isAlive()) return { activeBackgroundTasks: 0, awaitingTaskReport: false, backgroundingInFlight };
    return {
      activeBackgroundTasks: live.activeBackgroundTaskCount(),
      awaitingTaskReport: live.isAwaitingTaskReportWithin(PROMPT_RETIRE_REPORT_WAIT_MS),
      backgroundingInFlight,
    };
  }

  /**
   * The session key whose live session (or registry link) is this SDK
   * session id — what `tomo lcm` is given.
   */
  keyForSdkSession(sdkSessionId: string): string | undefined {
    for (const [key, live] of this.liveSessions) {
      // A closing (reaped) session still owns its file until its CLI exits.
      if ((live.isAlive() || this.closing.has(live)) && live.getSessionId() === sdkSessionId) return key;
    }
    for (const key of this.liveSessions.keys()) {
      if (this.deps.getSdkSessionId(key) === sdkSessionId) return key;
    }
    return undefined;
  }

  /**
   * Approve a session-file rewrite and mark the compact pending, in one
   * synchronous step (see compact-reservations.ts): refused while background
   * work runs; once approved, new background launches on the session are
   * denied until it reloads, the rewrite reports no reload pending, or the
   * reservation's TTL runs out.
   */
  reserveCompact(key: string, sdkSessionId: string): ReserveResult {
    // A reaped session's CLI may still be writing the file a rewrite would
    // rename: refused like any other "not now", and the next nudge retries.
    if (this.closingWait(key)) return { ok: false, reason: "session-closing", state: this.backgroundState(key) };
    return this.compactReservations.reserve(key, sdkSessionId, this.backgroundState(key));
  }

  /** The approved rewrite is over; see CompactReservations.finish. */
  finishCompact(key: string, reservationId: string): void {
    this.compactReservations.finish(key, reservationId);
  }

  isCompactPending(key: string): boolean {
    return this.compactReservations.isPending(key);
  }

  /** Stop one task of the key's live session (never creates one). */
  async stopTask(key: string, taskId: string): Promise<boolean> {
    const live = this.liveSessions.get(key);
    return live?.isAlive() ? live.stopTask(taskId) : false;
  }

  /** Move the foreground task a tool call started to the background (never creates a session). */
  async backgroundTask(key: string, toolUseId: string): Promise<boolean> {
    // A backgrounded task would be killed by the pending compact's reload.
    if (this.compactReservations.isPending(key)) return false;
    const live = this.liveSessions.get(key);
    if (!live?.isAlive()) return false;
    // In flight from here until the SDK answers: a reservation arriving in
    // between is refused (backgroundState), and a successful move starts the
    // settle window that covers the lag before the SDK reports the task.
    this.backgroundingInFlight.set(key, (this.backgroundingInFlight.get(key) ?? 0) + 1);
    try {
      const moved = await live.backgroundTask(toolUseId);
      if (moved) this.compactReservations.noteLaunch(key);
      return moved;
    } finally {
      const left = (this.backgroundingInFlight.get(key) ?? 1) - 1;
      if (left > 0) this.backgroundingInFlight.set(key, left);
      else this.backgroundingInFlight.delete(key);
    }
  }

  /** A shell/Monitor task's output tail from the key's live session; never creates one. */
  async taskOutput(key: string, taskId: string): Promise<{ output: string; size: number } | undefined> {
    const live = this.liveSessions.get(key);
    return live?.isAlive() ? live.getTaskOutput(taskId) : undefined;
  }

  /** A Bash tool call's full command from the key's live session (never creates one). */
  toolCommand(key: string, toolUseId: string): string | undefined {
    return this.liveSessions.get(key)?.getToolCommand(toolUseId);
  }

  isAlive(key: string): boolean {
    return this.liveSessions.get(key)?.isAlive() ?? false;
  }

  /**
   * SDK-reported MCP connection state of up to 32 live sessions (web Study).
   * Never creates a session or probes a server. Each answer also feeds the
   * health monitor, which only logs state changes (it never reconnects from a read).
   */
  async readMcpStatuses(): Promise<Array<{ key: string; connections: McpConnection[] | null }>> {
    const sessions = [...this.liveSessions].filter(([, session]) => session.isAlive()).slice(0, 32);
    return Promise.all(sessions.map(async ([key, session]) => {
      const connections = await session.readMcpStatus();
      this.observeMcpStatus(key, session, connections, "status-read");
      return { key, connections };
    }));
  }

  /**
   * One key's SDK-reported MCP connections: `undefined` when the key has no
   * live session (never creates one), `null` when it did not answer.
   */
  async readMcpStatus(key: string): Promise<McpConnection[] | null | undefined> {
    const session = this.liveSessions.get(key);
    if (!session?.isAlive()) return undefined;
    const connections = await session.readMcpStatus();
    this.observeMcpStatus(key, session, connections, "status-read");
    return connections;
  }

  /**
   * Hand a status answer to the health monitor (logging only) if `session`
   * is still the key's live session: a stale answer must not speak for its
   * replacement.
   */
  private observeMcpStatus(key: string, session: LiveSession, connections: McpConnection[] | null, trigger: string): void {
    if (this.liveSessions.get(key) !== session || !session.isAlive()) return;
    this.mcpHealth.observe(key, connections, trigger);
  }

  /**
   * An explicit reconnect of one server on the key's live session (never
   * creates one). Only while no turn runs or is on its way: the session is
   * then reserved, and a turn that arrives waits for the reconnect (bounded
   * like the pre-turn one).
   */
  async reconnectMcpServer(key: string, server: string): Promise<"reconnected" | "failed" | "busy" | "no-live-session"> {
    const session = this.liveSessions.get(key);
    if (!session?.isAlive()) return "no-live-session";
    if (this.hasTurnInFlight(key) || this.mcpReservations.has(key)) return "busy";
    // Re-checked after waiting on another reconnect of the server: the session
    // must still be ours (reserved, idle, current), or we give up. Only
    // called after an await, so `reservation` below is set by then.
    const stillAllowed = () => this.mcpReservations.get(key) === reservation && this.liveSessions.get(key) === session
      && session.isAlive() && !session.isBusy();
    const run = this.mcpHealth.reconnectNow(key, server, (name) => this.reconnectOn(key, session, name), stillAllowed);
    const reservation: Promise<unknown> = run.finally(() => { if (this.mcpReservations.get(key) === reservation) this.mcpReservations.delete(key); });
    this.mcpReservations.set(key, reservation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([run, new Promise<"failed">((resolve) => { timer = setTimeout(() => resolve("failed"), MCP_MANUAL_RECONNECT_WAIT_MS); })])
      .finally(() => clearTimeout(timer));
    return outcome;
  }

  /** Reconnect `server` on exactly `session`, if it is still the key's live session. */
  private async reconnectOn(key: string, session: LiveSession, server: string): Promise<void> {
    if (this.liveSessions.get(key) !== session || !session.isAlive()) throw new Error("session replaced");
    await session.reconnectMcpServer(server);
  }

  /**
   * Before a turn, holding the session: wait out an explicit reconnect, then
   * read the MCP state and let the monitor reconnect failed servers — all
   * bounded (MCP_PRE_TURN_WAIT_MS) so a hung SDK call cannot hold the turn.
   * Skipped on a session's first turn (its CLI may still be starting; the
   * read would only time out). Never throws.
   */
  private async preTurnMcp(key: string, session: LiveSession): Promise<void> {
    try {
      const reservation = this.mcpReservations.get(key);
      if (reservation && !await withTimeout(reservation, MCP_PRE_TURN_WAIT_MS)) {
        // The turn goes ahead: the reservation is no longer the reconnect's,
        // so one still queued behind another session's gives up (busy).
        if (this.mcpReservations.get(key) === reservation) this.mcpReservations.delete(key);
        log.warn({ key }, "Explicit MCP reconnect still running; starting the turn anyway");
      }
      if (session.lastResult === null || this.liveSessions.get(key) !== session || !session.isAlive()) return;
      const connections = await session.readMcpStatus();
      if (this.liveSessions.get(key) !== session || !session.isAlive()) return;
      await this.mcpHealth.beforeTurn(key, connections, (server) => this.reconnectOn(key, session, server));
    } catch (err) {
      log.warn({ key, err }, "Pre-turn MCP check failed; starting the turn anyway");
    }
  }

  isInteractiveTurn(key: string): boolean {
    return this.liveSessions.get(key)?.isInteractiveTurn() ?? false;
  }

  /** Read-and-clear: see LiveSession.takeUndeliveredReply. False when not live. */
  takeUndeliveredReply(key: string): boolean {
    return this.liveSessions.get(key)?.takeUndeliveredReply() ?? false;
  }

  mountedExternalMcpServers(key: string): ReadonlySet<string> {
    return this.externalMcpServersBySession.get(key) ?? new Set();
  }

  /**
   * Add an authenticated external server to every live session that missed it
   * at spawn time, AND replace it in sessions that are already serving it with
   * a stale token — a completed `/mcp login` or a background refresh reaches a
   * running session only through here. Calls are serialized because
   * setMcpServers replaces the complete dynamic set: two simultaneous token
   * completions must compose, rather than racing and removing one another.
   */
  hotMountExternalMcpServer(serverName: string, server: McpServerConfig): Promise<void> {
    // Shutdown has already closed every session and cleared the maps; a mount
    // enqueued now would run against a dead session and could only add work
    // to a process on its way out.
    if (this.stopping) {
      log.info({ serverName }, "Ignoring an external MCP hot-mount during shutdown");
      return Promise.resolve();
    }
    const operation = this.hotMountQueue.then(() => this.applyExternalMcpHotMount(serverName, server));
    this.hotMountQueue = operation.catch((err) => {
      log.warn({ serverName, err }, "External MCP hot-mount failed; a later session will retry");
    });
    return operation;
  }

  /** Last turn result for a session still in the map (context-nudge default). */
  lastResult(key: string): QueryResult | null {
    return this.liveSessions.get(key)?.lastResult ?? null;
  }

  /**
   * `abandon`: asked when a build was discarded (rewind/stale id); true makes
   * this return the dead session instead of building again — for a turn that
   * was itself stopped by the rewind.
   */
  async getOrCreateLiveSession(key: string, abandon?: () => boolean): Promise<LiveSession> {
    for (;;) {
      // A rewind holds this key (wait, then use the rewound conversation), or
      // a reaped session is still exiting (resume only once it is gone).
      // ONE loop, re-checking BOTH after every wake: a rewind can begin while
      // we wait on a close, and a single pass would walk past its hold.
      for (let wait = this.keyWait(key); wait; wait = this.keyWait(key)) await wait;

      // Checked on every message (not just on creation): a lone session that is
      // only ever reused would otherwise never notice a workspace change and
      // serve a stale prompt indefinitely.
      this.sweepPromptChanges();

      const session = this.liveSessions.get(key);
      if (session?.isAlive()) { session.noteActivity(); return session; }

      const created = await (this.liveSessionCreates.get(key) ?? this.startCreate(key));
      // Built for the pre-rewind conversation and discarded by createLiveSession
      // (a rewind began or finished meanwhile): build again on the current
      // conversation — after the rewind, if it is still holding the key.
      // createLiveSession returns a dead session only when it discarded it.
      if (!created.isAlive() && !this.stopping && !abandon?.()) continue;
      return created;
    }
  }

  /** What a new session for `key` must wait on first, if anything. */
  private keyWait(key: string): Promise<void> | undefined {
    return this.sessionHolds.get(key) ?? this.closingWait(key);
  }

  /**
   * The key's map entry is a reaped session whose CLI child is still exiting:
   * resolves once it is gone (and out of the map). Undefined otherwise.
   */
  private closingWait(key: string): Promise<void> | undefined {
    const session = this.liveSessions.get(key);
    return session && !session.isAlive() ? this.closing.get(session) : undefined;
  }

  private async startCreate(key: string): Promise<LiveSession> {
    const create = this.createLiveSession(key);
    this.liveSessionCreates.set(key, create);
    try {
      return await create;
    } finally {
      if (this.liveSessionCreates.get(key) === create) {
        this.liveSessionCreates.delete(key);
      }
    }
  }

  /**
   * Take a key away from every turn so /rewind can fork its transcript.
   *
   * Holds the key first (no live session is created or handed out for it),
   * then interrupts whatever is running: its
   * requests reject with TurnInterruptedError, which is never retried. Waits,
   * bounded, for the session's SDK event loop to end so nothing more is
   * handled or delivered from it. The CLI child can still be appending its
   * exit-time records after that — the caller waits for the transcript itself
   * to go quiet. A session the idle reaper already closed is waited for here
   * (its child's exit, bounded) before returning.
   *
   * `release()` MUST be called (finally) — held turns are waiting on it.
   */
  async suspendForRewind(key: string, timeoutMs = REWIND_SUSPEND_TIMEOUT_MS): Promise<{ stoppedTurn: boolean; droppedMessages: number; release: () => void }> {
    if (this.stopping) throw new RewindError({ kind: "stopping" });
    if (this.sessionHolds.has(key)) throw new RewindError({ kind: "in_progress" });
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    this.sessionHolds.set(key, hold);
    const release = () => {
      if (this.sessionHolds.get(key) === hold) {
        this.sessionHolds.delete(key);
        this.holdReleases.delete(key);
      }
      releaseHold();
    };
    this.holdReleases.set(key, release);
    try {
      // Every turn already dispatched for this key is stopped, whether or not
      // its session exists or has claimed it yet. Turns dispatched from here
      // on are untouched: they wait for the hold and run afterwards.
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      const deadline = Date.now() + timeoutMs;
      const dispatched = [...(this.dispatches.get(key) ?? [])];
      for (const token of dispatched) token.interrupted = true;
      // A session still being built finishes first (bounded): createLiveSession
      // re-checks the hold before publishing and closes it, so its CLI child
      // has started exiting before the caller waits for the transcript to go
      // quiet — rather than spawning in the middle of the snapshot.
      const creating = this.liveSessionCreates.get(key);
      if (creating && !await withTimeout(creating, timeoutMs)) {
        log.warn({ key, timeoutMs }, "Rewind: a session still being built did not finish in time; continuing");
      }
      // The key's entry is a reaped session still closing: its CLI child may
      // be appending to the very transcript the rewind is about to snapshot
      // and fork. Wait for it first (bounded by IDLE_REAP_CLOSE_WAIT_MS).
      // Only the closing wait: the key's other wait is this rewind's own hold.
      const closing = this.closingWait(key);
      if (closing) await closing;
      const session = this.liveSessions.get(key);
      let stoppedTurn = dispatched.length > 0;
      let droppedMessages = 0;
      if (session) {
        const busy = session.isAlive() && session.isBusy();
        stoppedTurn ||= busy;
        droppedMessages = busy ? session.steeredRequestCount() : 0;
        this.promptStale.delete(session);
        this.liveSessions.delete(key);
        this.externalMcpServersBySession.delete(key);
        this.mcpServerConfigsBySession.delete(key);
        this.mcpHealth.sessionClosed(key);
        session.interrupt(new TurnInterruptedError());
        if (!await withTimeout(session.whenEventLoopDone(), Math.max(0, deadline - Date.now()))) {
          log.warn({ key, timeoutMs }, "Rewind: the stopped session's event loop did not end in time; continuing");
        }
      }
      if (stoppedTurn) log.info({ key, droppedMessages }, "Rewind stopped the running turn");
      return { stoppedTurn, droppedMessages, release };
    } catch (err) {
      release();
      throw err;
    }
  }

  /**
   * Detect system-prompt changes and mark every current session prompt-stale
   * instead of retiring them all on the spot. Retiring en masse dropped every
   * MCP connection and prompt-cache prefix at once, and yanking a busy session
   * out of the map orphaned its in-flight turn as a steering target — the next
   * message for its key spawned a parallel fresh session while the old turn
   * was still running. Each stale session is retired at its own next idle
   * boundary (no turn in flight, no queued/steered work) by retireWhenIdle, so
   * active conversations finish undisturbed and reconnects stagger with each
   * key's natural traffic. New sessions are always built from the current
   * workspace, so a changed prompt reaches every key by its next idle turn.
   */
  private sweepPromptChanges(): void {
    const currentHash = this.hashString(flattenSystemPrompt(this.deps.buildSystemPrompt()));
    if (this.lastPromptHash && currentHash !== this.lastPromptHash) {
      log.info("System prompt changed; retiring live sessions at their next idle boundary");
      for (const [key, session] of this.liveSessions) {
        // A closing (reaped) entry is already on its way out; retiring it
        // would drop it from the map before its CLI has exited.
        if (this.promptStale.has(session) || this.closing.has(session)) continue;
        this.promptStale.add(session);
        void this.retireWhenIdle(key, session);
      }
    }
    this.lastPromptHash = currentHash;
  }

  /**
   * Close a prompt-stale session once it is truly idle — the next message for
   * its key then creates a fresh session with the new prompt. An already-idle
   * session closes synchronously (its idle boundary is now). Closing a busy
   * session instead would reject its in-flight turn, and runWithRetry's
   * reset-and-retry branch would re-run the whole turn, repeating side effects
   * its first half already performed — so the close waits for true idleness.
   */
  private async retireWhenIdle(key: string, session: LiveSession): Promise<void> {
    // waitForIdle resolves when no turn is in flight, but a queued send()
    // woken by the same turn-completion can start a new turn before this
    // continuation runs — re-check so a live conversation is never cut.
    //
    // Background tasks count too. A turn that launched a background subagent
    // ends while the subagent keeps working, and close() kills it mid-run —
    // so an edit to a prompt file (MEMORY.md, SOUL.md…) during a long agent
    // run used to cut the agent off. Wait for the SDK to report the
    // background set empty, but only up to a cap: a hung task must not keep
    // a stale prompt alive forever.
    // The cap starts at the first foreground-idle moment with background work,
    // not when retirement was scheduled: a long turn must not use it up and
    // leave a subagent it launched at the very end with no wait at all.
    let backgroundDeadline: number | null = null;
    let backgroundCapHit = false;
    // Every exit from a wait re-checks isBusy(): a new turn can start while
    // we wait on background work, and retiring then would reject it.
    const waitingOnBackground = () =>
      session.hasActiveBackgroundTasks() || session.isAwaitingTaskReport();
    while (session.isAlive() && (session.isBusy() || (waitingOnBackground() && !backgroundCapHit))) {
      if (session.isBusy()) {
        await session.waitForIdle();
        continue;
      }
      backgroundDeadline ??= Date.now() + PROMPT_RETIRE_BACKGROUND_WAIT_MS;
      const remaining = backgroundDeadline - Date.now();
      if (remaining <= 0) {
        backgroundCapHit = true;
      } else if (session.hasActiveBackgroundTasks()) {
        log.info({ key }, "Prompt-stale session has live background tasks; deferring retirement");
        if (!(await session.waitForBackgroundIdle(remaining))) backgroundCapHit = true;
      } else {
        // Drained: wait for the follow-up turn that reports the task's
        // result. Bounded separately, since the result may instead have been
        // folded into a turn that was already running.
        if (!(await session.waitForTurnStart(Math.min(remaining, PROMPT_RETIRE_REPORT_WAIT_MS)))) {
          backgroundCapHit = true;
        }
      }
      if (backgroundCapHit) {
        log.warn({ key }, "Prompt-stale session's background work outlasted the wait; retiring at the next idle boundary");
      }
    }
    this.promptStale.delete(session);
    // Replaced or closed by another path (error reset, compact reload,
    // shutdown) while we waited — nothing left to retire.
    if (this.liveSessions.get(key) !== session) return;
    this.liveSessions.delete(key);
    this.externalMcpServersBySession.delete(key);
    this.mcpServerConfigsBySession.delete(key);
    this.mcpHealth.sessionClosed(key);
    session.close();
    log.info({ key }, "Prompt-stale session retired at idle boundary");
  }

  private async createLiveSession(key: string): Promise<LiveSession> {
    let session = this.liveSessions.get(key);
    if (session?.isAlive()) return session;

    const generation = this.generations.get(key) ?? 0;
    const resumeId = this.deps.getSdkSessionId(key);
    if (resumeId) {
      const repair = repairSdkSessionForResume(
        resumeId,
        this.deps.getSessionMessages(key),
        config.sdkSessionsDir,
      );
      if (repair.error) {
        log.warn({ key, sessionId: resumeId, error: repair.error }, "Could not repair SDK session before resume");
      }
    }
    const model = this.deps.getModelOverride(key);
    const turnBudget = makeTurnBudget();
    const externalMcpServers = await this.deps.buildExternalMcpServers(key);
    const resumeBaseline = resumeId ? await this.deps.getUsageBaseline(key, resumeId) : undefined;
    // Per-session server instance: binds the caller's session key so tool
    // handlers (e.g. send_message) can attribute cross-session sends.
    const internalMcpServer = this.deps.createInternalMcpServer(key);
    const opts = sdkOptions(internalMcpServer, resumeId ?? undefined, model, {
      sessionKey: key,
      sdkSessionId: resumeId ?? undefined,
      group: this.deps.buildGroupContext(key),
      isOwnAudienceTurn: () => this.deps.isOwnAudienceTurn(key),
      scopedCallerKey: () => this.deps.scopedCallerKey(key),
      ...(this.deps.groupSandbox ? { groupSandbox: (opts: { once: boolean }) => this.deps.groupSandbox!(key, opts) } : {}),
      ...(this.deps.noteSandboxedCall ? { noteSandboxedCall: (text: string) => this.deps.noteSandboxedCall!(key, text) } : {}),
      onMcpElicitation: (request) => this.deps.handleMcpElicitation(key, request),
      // Late-bound on purpose: the options are built before the session that
      // owns the flag exists. Until it does, nothing was dropped.
      undeliveredReply: () => session?.takeUndeliveredReply() ?? false,
      backgroundLaunchDenial: () => this.compactReservations.launchDenial(key),
    }, turnBudget, externalMcpServers);

    session = new LiveSession(opts, key, turnBudget, () => this.deps.createUnownedTurnRequest(key), {
      timeoutMs: config.liveSessionTimeoutMs,
      showThinking: config.showThinking,
      onMcpAuthError: (serverName) => this.deps.refreshExternalMcpToken(serverName),
      onMcpStatus: (connections) => {
        // Only the key's current session speaks for it.
        if (session) this.observeMcpStatus(key, session, connections, "init");
      },
      onInformational: (message) => this.informationalNotices.observe(key, message),
      onToolResult: (toolName, content, isError) => {
        this.deps.handleToolResult?.(key, toolName, content, isError);
      },
      ...(resumeId ? { resumeFrom: { sdkSessionId: resumeId, baseline: resumeBaseline } } : {}),
      ...(this.deps.recordUsage
        ? { recordUsage: (build: () => UsageLedgerRow | undefined, onWritten: () => void) => this.deps.recordUsage?.(key, build, onWritten) }
        : {}),
    });
    // RE-CHECKED AFTER THE AWAIT, NOT ONLY BEFORE IT. `buildExternalMcpServers`
    // yields — it can spend real time on OAuth — and stop() may have run its
    // one-time sweep of `liveSessions` while we were in there. Publishing now
    // would put an ALIVE session into a map shutdown has already emptied and
    // will never look at again: it would outlive the sweep, keep an SDK child
    // running, and be killed at process exit with its turn's transcript
    // unflushed. Closing it here settles that turn synchronously instead, and
    // dispatchTurn turns it into a refusal.
    if (this.stopping) {
      session.close();
      log.info({ key }, "Discarding a live session that finished building after shutdown began");
      return session;
    }
    // Same for a /rewind that began while we were building: this session
    // resumes the conversation being rewound. getOrCreateLiveSession builds
    // again once the rewind is done.
    if (this.sessionHolds.has(key)) {
      session.close();
      log.info({ key }, "Discarding a live session that finished building after a rewind began");
      return session;
    }
    // ...or that began AND finished while this build was parked (it outlived
    // the rewind's wait budget), or anything else relinked the key (/new, a
    // timeout retirement): this session resumes a conversation the key no
    // longer points at.
    if ((this.generations.get(key) ?? 0) !== generation || (this.deps.getSdkSessionId(key) ?? null) !== (resumeId ?? null)) {
      session.close();
      log.info({ key }, "Discarding a live session built for a conversation the key no longer points at");
      return session;
    }
    // A dead predecessor's connections went with it.
    if (this.liveSessions.has(key)) this.mcpHealth.sessionClosed(key);
    this.liveSessions.set(key, session);
    this.armIdleReaper();
    this.externalMcpServersBySession.set(key, new Set(Object.keys(externalMcpServers)));
    this.mcpServerConfigsBySession.set(key, {
      ...externalMcpServers,
      [TOMO_INTERNAL_MCP_NAME]: internalMcpServer,
    });
    log.info(
      {
        key,
        resume: !!resumeId,
        model: opts.model,
        gateway: opts.env?.ANTHROPIC_BASE_URL ? "litellm" : "native",
      },
      "Live session created",
    );
    return session;
  }

  /**
   * IDLE SESSIONS ARE CLOSED, NOT KEPT FOREVER. Every live session is a CLI
   * child process (plus one process per stdio MCP server), and before this a
   * group that spoke once kept its whole tree resident until the next prompt
   * change or shutdown. Closing one costs little: the next message resumes it
   * from disk, and the prompt cache is server-side, so it outlives the child
   * up to its own TTL either way.
   *
   * Only a session with NOTHING going on is closed: no turn in any phase
   * (`hasTurnInFlight`), no live task, ambient watchers included (closing
   * kills them), no task report still due, no compact waiting on its reload,
   * no explicit MCP reconnect running on it (`mcpReservations`), no SDK id
   * the registry has not stored yet (`unpersistedLinks`), and no
   * prompt-stale retirement already in charge of it.
   *
   * The CLI child is still exiting after close() (and may append exit-time
   * records to the transcript), so the reaped session STAYS in the map, marked
   * closing, until the child has exited (bounded). Whatever finds it there
   * follows its usual rule for a key with a session: a message waits before
   * resuming, a /rewind waits before its snapshot, a compact reservation is
   * refused ("session-closing", retried later like any other refusal).
   */
  private armIdleReaper(): void {
    const timeoutMs = config.liveSessionIdleTimeoutMs;
    if (this.idleReapTimer || this.stopping || !timeoutMs || timeoutMs <= 0) return;
    this.idleReapTimer = setInterval(() => this.reapIdleSessions(), Math.min(IDLE_REAP_SWEEP_MS, timeoutMs));
    this.idleReapTimer.unref?.();
  }

  /** One reaper pass; public for tests. Returns the keys it closed. */
  reapIdleSessions(now = Date.now()): string[] {
    const timeoutMs = config.liveSessionIdleTimeoutMs;
    if (this.stopping || !timeoutMs || timeoutMs <= 0) return [];
    const reaped: string[] = [];
    for (const [key, session] of [...this.liveSessions]) {
      if (!session.isAlive() || this.promptStale.has(session)) continue;
      // The report wait is BOUNDED, as in backgroundState(): a result folded
      // into a turn that was already running never clears the flag, and an
      // unbounded check would keep such a session alive forever.
      // unpersistedLinks: the registry refused this session's id, so the live
      // session holds the only usable one until a later turn stores it.
      if (this.hasTurnInFlight(key) || this.mcpReservations.has(key) || this.unpersistedLinks.has(key)
        || session.hasAnyLiveTasks()
        || session.isAwaitingTaskReportWithin(PROMPT_RETIRE_REPORT_WAIT_MS)
        || (this.backgroundingInFlight.get(key) ?? 0) > 0 || this.isCompactPending(key)) {
        session.noteActivity();
        continue;
      }
      const idleMs = now - session.lastActivityAt();
      if (idleMs < timeoutMs) continue;
      this.closeReaped(key, session);
      reaped.push(key);
      log.info({ key, idleMinutes: Math.round(idleMs / 60_000) }, "Closed idle live session; the next message resumes it");
    }
    // "No LIVE session", not "empty map": a session that died on its own
    // stays in the map (lastResult, keyForSdkSession and createLiveSession's
    // predecessor check read it), and must not keep the timer running. The
    // next session built re-arms it.
    if (this.idleReapTimer && ![...this.liveSessions.values()].some((s) => s.isAlive())) {
      clearInterval(this.idleReapTimer);
      this.idleReapTimer = undefined;
    }
    return reaped;
  }

  /** Close a reaped session, keeping its entry (closing) until its CLI has exited. */
  private closeReaped(key: string, session: LiveSession): void {
    this.promptStale.delete(session);
    session.close();
    this.externalMcpServersBySession.delete(key);
    this.mcpServerConfigsBySession.delete(key);
    this.mcpHealth.sessionClosed(key);
    const gone: Promise<void> = withTimeout(session.whenClosed(), IDLE_REAP_CLOSE_WAIT_MS).then((exited) => {
      if (!exited) log.warn({ key, timeoutMs: IDLE_REAP_CLOSE_WAIT_MS }, "Reaped session's CLI did not exit in time; resuming anyway");
      this.closing.delete(session);
      if (this.liveSessions.get(key) === session) this.liveSessions.delete(key);
    });
    this.closing.set(session, gone);
  }

  closeLiveSession(key: string): void {
    const session = this.liveSessions.get(key);
    // Already closing (reaped): its own exit removes it, and until then it
    // must stay where the key's next session will look for it.
    if (session && this.closingWait(key)) return;
    if (session) {
      this.promptStale.delete(session);
      session.close();
      this.liveSessions.delete(key);
      this.externalMcpServersBySession.delete(key);
      this.mcpServerConfigsBySession.delete(key);
      this.mcpHealth.sessionClosed(key);
    }
  }

  private async applyExternalMcpHotMount(serverName: string, server: McpServerConfig): Promise<void> {
    // Re-checked here as well as at admission: a mount queued before shutdown
    // can reach the front of the queue after it.
    if (this.stopping) return;
    // If auth won the race just after a zero-wait build omitted the server,
    // allow those already-started creations to publish their LiveSession
    // before taking the target snapshot. The OAuth notification is detached
    // from its build promise, so this cannot deadlock session creation.
    const creating = [...this.liveSessionCreates.values()];
    if (creating.length > 0) await Promise.allSettled(creating);

    let mounted = 0;
    let unsupported = 0;
    const failures: Array<{ key: string; error: string }> = [];

    for (const [key, session] of [...this.liveSessions]) {
      if (!session.isAlive()) continue;
      const current = this.mcpServerConfigsBySession.get(key);
      if (!current) continue;
      const mountedHere = this.externalMcpServersBySession.get(key)?.has(serverName) ?? false;
      // Already serving this exact config — a duplicate notification, not a
      // new credential. Anything else (in particular a re-authenticated
      // server whose only change is its Authorization header) MUST go
      // through, or the session keeps using the token that just expired.
      if (mountedHere && sameServerConfig(current[serverName], server)) continue;

      try {
        // ONE call, whether this is a first mount or a re-authentication.
        // The CLI's reconcile (2.1.251) diffs the pushed map against the live
        // one by name AND by config fingerprint: a name present in both whose
        // config hash changed goes on its "will replace" list, where the old
        // client is cleaned up and reconnected inside this same call. The
        // fingerprint covers `headers`, so a new Bearer token is a real
        // reconnect — no remove-then-add, and therefore no window in which an
        // active turn's tool call finds the server missing.
        const result = await this.pushMcpServers(key, session, { ...current, [serverName]: server });
        if (result === "replaced") continue;
        if (result === "unsupported") {
          unsupported++;
          continue;
        }

        if (!result.errors[serverName] && !result.removed.includes(serverName)) {
          const mountedNames = new Set(this.externalMcpServersBySession.get(key) ?? []);
          mountedNames.add(serverName);
          this.externalMcpServersBySession.set(key, mountedNames);
          mounted++;
        } else {
          failures.push({ key, error: result.errors[serverName] ?? "server was removed" });
        }
      } catch (err) {
        failures.push({ key, error: errorMessage(err) });
      }
    }

    if (mounted > 0) {
      log.info({ serverName, sessions: mounted }, "External MCP server hot-mounted into live sessions");
    }
    if (unsupported > 0) {
      log.warn(
        { serverName, sessions: unsupported },
        "Agent SDK does not support live MCP updates; a later session will mount the server",
      );
    }
    if (failures.length > 0) {
      log.warn(
        { serverName, failures },
        "External MCP hot-mount failed for live sessions; a later session will retry",
      );
    }
  }

  /**
   * Push a COMPLETE MCP map to one live session and reconcile the mounted-name
   * bookkeeping from what the runtime reports. `"unsupported"` means the SDK
   * has no live-update capability; `"replaced"` means the session was swapped
   * out while the call was in flight, so its result must be discarded.
   */
  private async pushMcpServers(
    key: string,
    session: LiveSession,
    desired: Record<string, McpServerConfig>,
  ): Promise<McpSetServersResult | "unsupported" | "replaced"> {
    const result = await session.setMcpServers(desired);
    if (this.liveSessions.get(key) !== session) return "replaced";
    if (!result) return "unsupported";

    this.mcpServerConfigsBySession.set(key, desired);
    const mountedNames = new Set(this.externalMcpServersBySession.get(key) ?? []);
    // Dropped by omission: a name absent from the pushed map is gone whether
    // or not the runtime bothered to list it under `removed`.
    for (const name of mountedNames) if (!(name in desired)) mountedNames.delete(name);
    for (const name of result.removed) mountedNames.delete(name);
    for (const name of result.added) {
      if (name !== TOMO_INTERNAL_MCP_NAME && !result.errors[name]) mountedNames.add(name);
    }
    for (const name of Object.keys(result.errors)) mountedNames.delete(name);
    this.externalMcpServersBySession.set(key, mountedNames);
    return result;
  }

  private hashString(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }

  /**
   * Run one turn, with the retry and shutdown policy below. Registered in
   * `inFlightTurns` for its whole life so `stop()` can wait for it to finish
   * flushing before the daemon exits.
   */
  async runWithRetry(req: RunWithRetryRequest): Promise<string> {
    // ADMISSION CLOSES WITH stop(). Not a formality: `Agent.stop()` stops the
    // CHANNELS only after this manager finishes, so inbound messages keep
    // arriving throughout shutdown. Without this gate they built a brand-new
    // LiveSession — a live SDK child — after stop() had already swept the map,
    // and that session was invisible to the sweep that just ran. It would ship
    // blocks to the owner and then die at process exit with its deferred block
    // transcript unflushed: exactly the hole the previous commit closed for
    // pre-existing sessions, reopened for late ones.
    // EVERY EXIT FROM A TURN SIGNALS COMPLETION, which is why this is a
    // `finally` around the whole dispatch rather than a call inside
    // `recordTurnCompletion`. That hook only runs on the two paths that end
    // with a usable response; a turn can also leave via a shutdown refusal, a
    // session closed during shutdown, the legacy max-turns throw, a query
    // timeout, or an unrecoverable session error — and a deferred restart
    // waiting on the end of the turn must not be stranded by whichever exit
    // the turn happened to take.
    let merged = false;
    try {
      if (this.stopping) return this.refuseForShutdown(req, "admitted after stop()");

      const turn = this.dispatchTurn(req);
      this.inFlightTurns.add(turn);
      try {
        const response = await turn;
        // A steered message that MERGED into a running turn is the one exit
        // that is not a turn ending: the owning turn is still going, and
        // firing the signal here would let a restart claim its request and
        // kill it mid-flight. The owner's own exit reports for both.
        merged = req.steer === true && response === STEER_MERGED;
        return response;
      } catch (err) {
        // Not a turn ending either: it never started, and is re-queued.
        if (err instanceof SteerDeclinedError) merged = true;
        throw err;
      } finally {
        this.inFlightTurns.delete(turn);
      }
    } finally {
      if (!merged) this.deps.handleTurnComplete?.(req.key);
    }
  }

  /**
   * Decline a turn shutdown will never process, without losing anything it
   * managed to deliver first.
   *
   * The flush is not theatre even though a refused turn has usually shipped
   * nothing: `refuseForShutdown` is also the landing point for a turn that was
   * admitted before stop() and only got as far as session construction, and
   * the sink is the one thing that knows whether a block escaped. Flushing an
   * empty sink is a no-op; not flushing a non-empty one loses the record of a
   * message the owner is already holding.
   */
  private refuseForShutdown(req: RunWithRetryRequest, reason: string): string {
    const recorded = req.flushOnShutdown?.() ?? false;
    log.info(
      { key: req.key, reason, flushedBlocks: recorded },
      "Turn refused during shutdown; it was never processed",
    );
    return SHUTDOWN_NOT_PROCESSED;
  }

  private async dispatchTurn(req: RunWithRetryRequest): Promise<string> {
    const token = { interrupted: false };
    let tokens = this.dispatches.get(req.key);
    if (!tokens) this.dispatches.set(req.key, tokens = new Set());
    tokens.add(token);
    try {
      return await this.dispatchTurnOnce(req, token);
    } finally {
      tokens.delete(token);
      if (tokens.size === 0 && this.dispatches.get(req.key) === tokens) this.dispatches.delete(req.key);
    }
  }

  private async dispatchTurnOnce(req: RunWithRetryRequest, token: { interrupted: boolean }): Promise<string> {
    const { key, prompt, images, documents, steer = false, steerAudience, onBlock, onBlockAbandoned, hasShipped, origin, silentDelivery } = req;

    let session: LiveSession | undefined;
    try {
      session = await this.getOrCreateLiveSession(key, () => token.interrupted);
      // Stopped by /rewind while it was still getting its session.
      if (token.interrupted) throw new TurnInterruptedError();
      // The session was built while we were parked in buildExternalMcpServers
      // and shutdown began in the meantime, so createLiveSession closed it
      // rather than publishing it (see there). Refuse rather than call send()
      // on it: the "Session is closed" that would come back is
      // indistinguishable from a session that ran and died mid-turn, and would
      // record this never-processed prompt as a silent turn.
      if (this.stopping && !session.isAlive()) {
        return this.refuseForShutdown(req, "session built after stop() began");
      }
      // A steer joins a turn already running; a fresh turn first settles MCP.
      if (!steer && session.isAlive() && !session.isBusy()) await this.preTurnMcp(key, session);
      if (token.interrupted) throw new TurnInterruptedError();
      return await this.runTurnOnSession(key, session, steer, () => (steer
        ? session!.steer(prompt, images, documents, onBlock, onBlockAbandoned, origin, steerAudience, {
          replyContext: req.replyContext, onJoined: req.onJoined, onHandedOff: req.onHandedOff,
          onPromptHandedOff: req.onPromptHandedOff,
          canJoin: () => this.deps.isOwnAudienceTurn(key) })
        : session!.send(prompt, images, documents, onBlock, onBlockAbandoned, origin, silentDelivery, req.replyContext, req.onPromptHandedOff)));
    } catch (err) {
      // Declined before injection: nothing ran. The caller re-queues it.
      if (err instanceof SteerDeclinedError) throw err;
      // A turn the CLI ended on an error result is NOT a session error:
      // runTurnOnSession already recorded it; let it through to TurnRunner's
      // error policy untouched. Never retried — the conversation is intact,
      // and a re-run would re-send any blocks that already shipped.
      // Stopped on purpose by /rewind. Never retried: the turn may already
      // have run tools, and re-running it from the top would repeat them.
      // Whatever it failed with (a "Session is closed" from a send that had
      // not yet claimed the session included), it ends as interrupted.
      if (err instanceof TurnInterruptedError) throw err;
      if (token.interrupted) throw new TurnInterruptedError();
      // One exception: a resume that can't find its conversation. Current SDKs
      // report it as a zero-turn error result instead of throwing, so nothing
      // ran and the reset-and-retry below must still fire (see isResumeMissing).
      if (err instanceof SdkResultError && !err.isResumeMissing) throw err;

      // A missing-conversation result reaches here only with every error saying
      // so (isResumeMissing); give it the phrase the retry path matches on.
      const errMsg = err instanceof SdkResultError ? "No conversation found" : err instanceof Error ? err.message : "";

      if (this.stopping && errMsg.includes("closed")) {
        // FLUSH BEFORE CONVERTING, NOT AFTER — there is no after. Resolving
        // with NO_REPLY makes this a SUCCESSFUL turn as far as TurnRunner is
        // concerned, so its rejection path (which is what normally flushes a
        // turn's per-block transcript slots) never runs, and its success path
        // records the joined response — this fabricated "NO_REPLY" — as the
        // turn's outcome. A block already on the owner's phone would be
        // replaced in the transcript by an assertion that the turn was silent.
        // So the sink writes what it delivered first; the sink also tells
        // TurnRunner it has recorded, which suppresses the NO_REPLY entry.
        const recorded = req.flushOnShutdown?.() ?? false;
        req.onShutdownInterrupted?.();
        log.info(
          { key, flushedBlocks: recorded },
          "Session closed during shutdown; preserving SDK session link",
        );
        return "NO_REPLY";
      }

      // Legacy: older CLIs threw on the max-turns limit. Current ones yield
      // an `error_max_turns` result instead, which LiveSession handles.
      if (errMsg.includes("maximum number of turns")) {
        log.warn("Hit max turns, returning partial response");
        return MAX_TURNS_RESPONSE;
      }

      if (errMsg.includes(QUERY_TIMEOUT_ERROR_PREFIX)) {
        log.warn({ err, key }, "Query timed out; retiring SDK session to avoid resuming stale in-flight work");
        this.closeLiveSession(key);
        this.deps.retireSdkSessionId(key);
        throw err;
      }

      // Session error — reset and retry once
      if (isRecoverableSessionError(errMsg)) {
        // Shutdown closes live sessions while turns may still be in flight
        // (e.g. the agent restarting itself via Bash). That "Session is
        // closed" is not corruption — resetting here is what used to unlink
        // the resume id and silently start the user over on a blank session.
        if (this.stopping) throw err;

        // NO RETRY ONCE ANYTHING HAS SHIPPED.
        //
        // Under end-of-turn delivery a retry was free: nothing had left the
        // machine, so re-running the prompt could only produce the one message
        // the owner ever saw. Per-block delivery breaks that. If block A
        // reached the phone and the SDK child then died, resuming the same
        // prompt regenerates the turn from the top — and the model, asked the
        // same question again, says A again. The owner gets A twice.
        //
        // The alternative considered was a fresh sink that skips the first N
        // blocks by index. Rejected: it is not sound. The retry is a NEW
        // sampling of a resumed conversation, not a replay — it can produce
        // different text, in a different order, in a different number of
        // blocks. Skipping by index would silently swallow genuinely new
        // content when the retry says less, and would still re-send A when the
        // retry reorders. Index equality is not identity.
        //
        // So we refuse instead, and surface the failure. This cannot
        // double-send by construction, which is the property that matters: the
        // owner already has A, and an error note telling him the turn died is
        // strictly better than a second copy of A with no way to tell which is
        // real. Turns that have shipped nothing — every housekeeping turn with
        // suppressDelivery, and every turn that fails while the child is still
        // starting or resuming, which is where these errors overwhelmingly
        // occur — still retry exactly as before.
        if (hasShipped?.()) {
          log.warn(
            { err, key },
            "Session error after a block already shipped; refusing to retry (a retry would re-send delivered blocks)",
          );
          throw err;
        }

        log.warn({ err }, "Session error, resetting and retrying");
        this.closeLiveSession(key);
        // Only a true resume failure invalidates the persisted SDK session
        // id. "Session is closed"-style errors just mean the child process
        // went away; the JSONL history is intact and MUST be kept so the
        // retry resumes it instead of discarding the conversation.
        if (errMsg.includes("No conversation found")) {
          this.deps.clearSdkSessionId(key);
        }

        const retrySession = await this.getOrCreateLiveSession(key);
        // Safe to reuse the same sink: the guard above proved it has shipped
        // nothing, so this retry is the first and only delivery of the turn.
        // Same bookkeeping as the first attempt — a retry that ends on an SDK
        // error result still ran, and its (new) session id must be kept.
        return await this.runTurnOnSession(key, retrySession, false, () =>
          retrySession.send(prompt, images, documents, onBlock, onBlockAbandoned, origin, silentDelivery));
      }

      throw err;
    }
  }

  /**
   * Post-turn bookkeeping shared by runWithRetry's first attempt and its
   * session-error retry: capture a new SDK session id, persist stats,
   * reload after an external compact, and run the context-pressure check.
   */
  /**
   * Run one attempt of a turn on a session and do its completion bookkeeping
   * on EVERY outcome that means the turn happened: a response, or an SDK
   * error result (max turns, budget, an execution or API error — the session
   * is intact, the turn is over, and its session id and stats must be kept,
   * a first turn that fails included, or it could never be resumed). A
   * steered message that merged into another request's turn records nothing;
   * that turn's owner does the bookkeeping. Every other rejection is a
   * session error and propagates untouched for the caller's retry logic.
   */
  private async runTurnOnSession(
    key: string,
    session: LiveSession,
    steer: boolean,
    attempt: () => Promise<string>,
  ): Promise<string> {
    let response: string;
    try {
      response = await attempt();
    } catch (err) {
      // A failed resume ran nothing and is about to be retried: recording it
      // would count one turn twice and persist nothing useful.
      if (err instanceof SdkResultError && !err.isResumeMissing) this.recordTurnCompletion(key, session);
      throw err;
    }
    if (steer && response === STEER_MERGED) return response;
    this.recordTurnCompletion(key, session);
    return response;
  }

  private recordTurnCompletion(key: string, session: LiveSession): void {
    // Capture session ID if new — or if an earlier capture could not be
    // persisted. The registry may refuse a link change while its file is
    // unreadable (SessionRegistryReadError); by the time we are here the model
    // has already answered, so that must not fail the turn. Remember the key
    // and try again after the next turn; until then the live session keeps
    // working and only the durable link is missing.
    const sid = session.getSessionId();
    if (sid && (this.unpersistedLinks.has(key) || !this.deps.getSdkSessionId(key))) {
      try {
        this.deps.setSdkSessionId(key, sid);
        if (this.unpersistedLinks.delete(key)) {
          log.info({ sessionId: sid, key }, "Session ID persisted on retry");
        } else {
          log.info({ sessionId: sid, key }, "Session ID captured");
        }
      } catch (err) {
        this.unpersistedLinks.add(key);
        log.error({ err, sessionId: sid, key }, "Could not persist the SDK session link; will retry after the next turn");
      }
    }

    // Save stats
    if (session.lastResult) {
      this.deps.updateStats(key, session.lastResult);
    }

    // If compact happened during this turn, reload the session on next
    // turn. With steering, a promoted steered turn may already be running
    // on this session — closing now would kill it, so defer the reload
    // until the session is truly idle.
    const compactedThisTurn = sid ? checkAndClearCompactTrigger(sid, config.sdkSessionsDir) : false;
    if (compactedThisTurn) {
      // The trigger is consumed now; keep background launches denied until
      // the close below has actually happened.
      this.compactReservations.holdForReload(key);
      // The rollup paths refuse while background tasks run and deny new
      // launches until this reload (compact-reservations.ts), so this only
      // fires for a rewrite that bypassed the gate (e.g. --no-daemon-check).
      // The reload still has to happen now: the in-memory
      // session holds the pre-compact chain, and any turn it runs would
      // append events parented on uuids the compact removed.
      if (session.hasActiveBackgroundTasks()) {
        log.warn({ key }, "Compact reload closes a session with background tasks still running");
      }
      if (session.isBusy()) {
        void session.waitForIdle().then(() => {
          if (this.liveSessions.get(key) === session) {
            this.closeLiveSession(key);
            log.info({ key }, "Session reloaded after compact (deferred past steered turn)");
          }
          this.compactReservations.clear(key);
        });
      } else {
        this.closeLiveSession(key);
        this.compactReservations.clear(key);
        log.info({ key }, "Session reloaded after compact");
      }
      // Skip the context-pressure check for this turn: the compact/prune
      // rewrote the file mid-turn, but this turn's QueryResult was measured
      // against the OLD in-memory context, so its usage reading is stale-high.
      // Deciding on it would falsely escalate the nudge ladder (e.g. queue a
      // daily rollup right after a prune that already freed enough space).
      // Staleness only ever reads high, so skipping can't miss a legitimate
      // latch reset either — the next turn runs on the reloaded session and
      // provides a fresh reading for both escalation and reset.
      return;
    }

    // Fire-and-forget context-pressure check — don't block the current
    // reply on the nudge. Pass this turn's result explicitly.
    this.deps.maybeNudgeCompact(key, session.lastResult);
  }

  /**
   * Close every live session for shutdown; retries are disabled from here on.
   *
   * Awaited, because closing a session is only half of shutting a turn down:
   * the turn still has to observe its rejection and flush what it delivered
   * into the transcript. Exiting the process before that resolves loses the
   * record of messages the owner is already holding.
   */
  async stop(): Promise<void> {
    // `stopping` is set synchronously, before ANY await: it is the admission
    // gate from here on (runWithRetry), the don't-publish flag for a session
    // still under construction (createLiveSession) and the refusal gate for
    // new hot-mounts — so nothing may be added behind this one-time sweep,
    // even though the hot-mount drain below yields before the sessions are
    // closed.
    this.stopping = true;
    this.compactReservations.dispose();
    if (this.idleReapTimer) { clearInterval(this.idleReapTimer); this.idleReapTimer = undefined; }

    // NO HOLD OUTLIVES SHUTDOWN. The Agent awaits (bounded) and aborts any
    // rewind before calling this; a rewind still stalled past that budget must
    // not leave turns parked on its hold. Released turns find `stopping` set
    // and are refused (createLiveSession), and the rewind itself can no longer
    // publish (its publish step checks the Agent's stopping flag).
    for (const release of [...this.holdReleases.values()]) release();

    // BEFORE the sessions are closed. `stopping` is already the admission
    // gate, so nothing new joins the queue and anything queued-but-unstarted
    // bails at the top of applyExternalMcpHotMount — this waits only on an
    // operation that is already inside `setMcpServers`. Closing its session
    // first would invalidate that in-flight control request and leave the
    // call hanging until the drain budget expired. Bounded by the same budget
    // as the turn flush; the queue never rejects (hotMountExternalMcpServer
    // installs a catch), so this cannot throw.
    await this.awaitHotMountQueue();

    // Prompt-stale sessions stay in the map until their idle-boundary
    // retirement, so this loop covers them too.
    for (const [, s] of this.liveSessions) s.close();
    const keys = [...this.liveSessions.keys()];
    this.liveSessions.clear();
    this.externalMcpServersBySession.clear();
    this.mcpServerConfigsBySession.clear();
    for (const key of keys) this.mcpHealth.sessionClosed(key);
    this.promptStale.clear();
    await this.awaitInFlightFlush();
  }

  /** Drain whatever is already on the hot-mount queue, bounded. */
  private async awaitHotMountQueue(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn("Timed out draining the external MCP hot-mount queue during shutdown");
        resolve();
      }, SHUTDOWN_FLUSH_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.hotMountQueue, expiry]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Wait for in-flight turns to settle (and so to flush), bounded.
   *
   * Re-snapshots until nothing is left, rather than taking the set ONCE: a
   * single snapshot silently abandons anything that joins while we wait, and
   * an abandoned turn is precisely a turn whose delivered blocks never reach
   * the transcript. Admission is closed by the time we get here, so a late
   * arrival should be unreachable — this is the belt to that braces, and it
   * costs one extra pass over an empty set.
   *
   * `awaited` makes termination structural: every pass must consume at least
   * one promise never seen before, so the loop cannot spin on a settled-but-
   * not-yet-removed entry and starve the timeout timer (a macrotask) in a
   * microtask loop.
   */
  private async awaitInFlightFlush(): Promise<void> {
    if (this.inFlightTurns.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SHUTDOWN_FLUSH_TIMEOUT_MS);
    });
    const awaited = new Set<Promise<string>>();
    try {
      for (;;) {
        const pending = [...this.inFlightTurns].filter((turn) => !awaited.has(turn));
        if (pending.length === 0) return;
        for (const turn of pending) awaited.add(turn);

        const outcome = await Promise.race([
          Promise.allSettled(pending).then(() => "flushed" as const),
          expiry,
        ]);
        if (outcome === "timeout") {
          log.warn(
            { turns: this.inFlightTurns.size, timeoutMs: SHUTDOWN_FLUSH_TIMEOUT_MS },
            "Gave up waiting for in-flight turns to flush their block transcripts",
          );
          return;
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
