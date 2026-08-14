import { createHash } from "node:crypto";
import type {
  ElicitationRequest,
  ElicitationResult,
  McpSdkServerConfigWithInstance,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { log } from "../logger.js";
import { checkAndClearCompactTrigger } from "../lcm/index.js";
import { repairSdkSessionForResume } from "../sessions/repair.js";
import type { SessionMessage } from "../sessions/types.js";
import { LiveSession, QUERY_TIMEOUT_ERROR_PREFIX, STEER_MERGED, type QueryResult, type TurnRequest } from "./live-session.js";
import { makeTurnBudget, sdkOptions, type SessionContext } from "./sdk-options.js";
import type { RunWithRetryRequest } from "./turn-runner.js";

/**
 * Session-lifecycle failures that a reset-and-retry can genuinely fix:
 * a broken resume chain ("No conversation found") or the SDK child going
 * away ("Session is closed", process exit). Matched narrowly on purpose —
 * a retry re-runs the WHOLE turn, so a broad match (any error merely
 * mentioning "session", e.g. from an MCP tool or the API) would duplicate
 * side effects the turn's first attempt already performed.
 */
function isRecoverableSessionError(errMsg: string): boolean {
  return errMsg.includes("No conversation found")
    || /session (?:is )?closed/i.test(errMsg)
    || /process exited/i.test(errMsg);
}

/**
 * The narrow surface the session lifecycle needs from the Agent: the durable
 * SDK-session registry, per-session option assembly (MCP wiring, group
 * context), and the post-turn context-pressure hook.
 */
export interface LiveSessionManagerDeps {
  /** Current system prompt — hashed to detect workspace changes. */
  buildSystemPrompt(): string;
  getSdkSessionId(key: string): string | undefined;
  setSdkSessionId(key: string, sessionId: string): void;
  clearSdkSessionId(key: string): void;
  retireSdkSessionId(key: string): void;
  updateStats(key: string, result: QueryResult): void;
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
  handleMcpElicitation(key: string, request: ElicitationRequest): Promise<ElicitationResult>;
  /** Delivery plumbing for SDK-initiated (unowned) turns. */
  createUnownedTurnRequest(key: string): TurnRequest | undefined;
  /** Post-turn context-pressure check (Agent.maybeNudgeCompact). */
  maybeNudgeCompact(key: string, ctx: QueryResult | null): void;
}

/**
 * Owns the LiveSession lifecycle: creation (with SDK-session resume and
 * pre-resume repair), the system-prompt-hash sweep that retires stale
 * sessions, the send/steer retry policy, and shutdown. This is the
 * concurrency-sensitive core moved verbatim out of Agent.
 */
export class LiveSessionManager {
  private liveSessions = new Map<string, LiveSession>();
  private externalMcpServersBySession = new Map<string, ReadonlySet<string>>();
  // Sessions whose system prompt is out of date (workspace changed since they
  // were built). They STAY in liveSessions so in-flight conversations keep
  // their steering target; each is retired at its next idle boundary instead
  // of all at once — see sweepPromptChanges().
  private promptStale = new Set<LiveSession>();
  private liveSessionCreates = new Map<string, Promise<LiveSession>>();
  private lastPromptHash: string = "";
  private stopping = false;

  constructor(private readonly deps: LiveSessionManagerDeps) {}

  /** Is a live turn currently in flight on this session? (steering target check) */
  isBusy(key: string): boolean {
    const live = this.liveSessions.get(key);
    return !!live?.isAlive() && live.isBusy();
  }

  isAlive(key: string): boolean {
    return this.liveSessions.get(key)?.isAlive() ?? false;
  }

  mountedExternalMcpServers(key: string): ReadonlySet<string> {
    return this.externalMcpServersBySession.get(key) ?? new Set();
  }

  /** Last turn result for a session still in the map (context-nudge default). */
  lastResult(key: string): QueryResult | null {
    return this.liveSessions.get(key)?.lastResult ?? null;
  }

  async getOrCreateLiveSession(key: string): Promise<LiveSession> {
    // Checked on every message (not just on creation): a lone session that is
    // only ever reused would otherwise never notice a workspace change and
    // serve a stale prompt indefinitely.
    this.sweepPromptChanges();

    const session = this.liveSessions.get(key);
    if (session?.isAlive()) return session;

    const creating = this.liveSessionCreates.get(key);
    if (creating) return creating;

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
    const currentHash = this.hashString(this.deps.buildSystemPrompt());
    if (this.lastPromptHash && currentHash !== this.lastPromptHash) {
      log.info("System prompt changed; retiring live sessions at their next idle boundary");
      for (const [key, session] of this.liveSessions) {
        if (this.promptStale.has(session)) continue;
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
    while (session.isAlive() && session.isBusy()) {
      await session.waitForIdle();
    }
    this.promptStale.delete(session);
    // Replaced or closed by another path (error reset, compact reload,
    // shutdown) while we waited — nothing left to retire.
    if (this.liveSessions.get(key) !== session) return;
    this.liveSessions.delete(key);
    this.externalMcpServersBySession.delete(key);
    session.close();
    log.info({ key }, "Prompt-stale session retired at idle boundary");
  }

  private async createLiveSession(key: string): Promise<LiveSession> {
    let session = this.liveSessions.get(key);
    if (session?.isAlive()) return session;

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
    // Per-session server instance: binds the caller's session key so tool
    // handlers (e.g. send_message) can attribute cross-session sends.
    const opts = sdkOptions(this.deps.createInternalMcpServer(key), resumeId ?? undefined, model, {
      sessionKey: key,
      sdkSessionId: resumeId ?? undefined,
      group: this.deps.buildGroupContext(key),
      onMcpElicitation: (request) => this.deps.handleMcpElicitation(key, request),
    }, turnBudget, externalMcpServers);

    session = new LiveSession(opts, key, turnBudget, () => this.deps.createUnownedTurnRequest(key), {
      timeoutMs: config.liveSessionTimeoutMs,
    });
    this.liveSessions.set(key, session);
    this.externalMcpServersBySession.set(key, new Set(Object.keys(externalMcpServers)));
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

  closeLiveSession(key: string): void {
    const session = this.liveSessions.get(key);
    if (session) {
      this.promptStale.delete(session);
      session.close();
      this.liveSessions.delete(key);
      this.externalMcpServersBySession.delete(key);
    }
  }

  private hashString(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }

  async runWithRetry(req: RunWithRetryRequest): Promise<string> {
    const {
      key,
      prompt,
      onText,
      images,
      onBlockComplete,
      documents,
      steer = false,
    } = req;

    try {
      const session = await this.getOrCreateLiveSession(key);
      const response = steer
        ? await session.steer(prompt, onText, images, onBlockComplete, documents)
        : await session.send(prompt, onText, images, onBlockComplete, documents);

      // Merged into another request's in-flight turn — that turn's owner
      // does the per-turn bookkeeping (stats, compact triggers) when it
      // resolves; nothing to record for this caller.
      if (steer && response === STEER_MERGED) return response;

      this.recordTurnCompletion(key, session);
      return response;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "";

      if (this.stopping && errMsg.includes("closed")) {
        log.info({ key }, "Session closed during shutdown; preserving SDK session link");
        return "NO_REPLY";
      }

      if (errMsg.includes("maximum number of turns")) {
        log.warn("Hit max turns, returning partial response");
        return "I ran out of steps trying to complete that. Can you try a simpler request?";
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

        log.warn({ err }, "Session error, resetting and retrying");
        this.closeLiveSession(key);
        // Only a true resume failure invalidates the persisted SDK session
        // id. "Session is closed"-style errors just mean the child process
        // went away; the JSONL history is intact and MUST be kept so the
        // retry resumes it instead of discarding the conversation.
        if (errMsg.includes("No conversation found")) {
          this.deps.clearSdkSessionId(key);
        }

        const session = await this.getOrCreateLiveSession(key);
        const response = await session.send(prompt, onText, images, onBlockComplete, documents);
        this.recordTurnCompletion(key, session);
        return response;
      }

      throw err;
    }
  }

  /**
   * Post-turn bookkeeping shared by runWithRetry's first attempt and its
   * session-error retry: capture a new SDK session id, persist stats,
   * reload after an external compact, and run the context-pressure check.
   */
  private recordTurnCompletion(key: string, session: LiveSession): void {
    // Capture session ID if new
    const sid = session.getSessionId();
    if (sid && !this.deps.getSdkSessionId(key)) {
      this.deps.setSdkSessionId(key, sid);
      log.info({ sessionId: sid, key }, "Session ID captured");
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
      if (session.isBusy()) {
        void session.waitForIdle().then(() => {
          if (this.liveSessions.get(key) === session) {
            this.closeLiveSession(key);
            log.info({ key }, "Session reloaded after compact (deferred past steered turn)");
          }
        });
      } else {
        this.closeLiveSession(key);
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

  /** Close every live session for shutdown; retries are disabled from here on. */
  stop(): void {
    this.stopping = true;
    // Prompt-stale sessions stay in the map until their idle-boundary
    // retirement, so this loop covers them too.
    for (const [, s] of this.liveSessions) s.close();
    this.liveSessions.clear();
    this.externalMcpServersBySession.clear();
    this.promptStale.clear();
  }
}
