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
import { checkAndClearCompactTrigger } from "../lcm/index.js";
import { TOMO_INTERNAL_MCP_NAME } from "../mcp/internal-server.js";
import { repairSdkSessionForResume } from "../sessions/repair.js";
import type { SessionMessage } from "../sessions/types.js";
import { SHUTDOWN_NOT_PROCESSED } from "./block-transcript.js";
import { DELIVERY_TIMEOUT_MS, LiveSession, MAX_TURNS_RESPONSE, QUERY_TIMEOUT_ERROR_PREFIX, STEER_MERGED, SdkResultError, type McpAuthRefreshOutcome, type QueryResult, type TurnRequest } from "./live-session.js";
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
  /**
   * Does the turn currently in flight on `key` belong to that session?
   * (`Agent.isOwnAudienceTurn`.) False while a summoned group is steering a
   * dm: session, and for a batch spanning several audiences. Read per tool
   * call by the private-memory PreToolUse guard, so it must be a live query
   * and not a value snapshotted at session creation.
   */
  isOwnAudienceTurn(key: string): boolean;
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
}

/**
 * Owns the LiveSession lifecycle: creation (with SDK-session resume and
 * pre-resume repair), the system-prompt-hash sweep that retires stale
 * sessions, the send/steer retry policy, and shutdown. This is the
 * concurrency-sensitive core moved verbatim out of Agent.
 */
export class LiveSessionManager {
  private liveSessions = new Map<string, LiveSession>();
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
    this.mcpServerConfigsBySession.delete(key);
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
    const internalMcpServer = this.deps.createInternalMcpServer(key);
    const opts = sdkOptions(internalMcpServer, resumeId ?? undefined, model, {
      sessionKey: key,
      sdkSessionId: resumeId ?? undefined,
      group: this.deps.buildGroupContext(key),
      isOwnAudienceTurn: () => this.deps.isOwnAudienceTurn(key),
      onMcpElicitation: (request) => this.deps.handleMcpElicitation(key, request),
    }, turnBudget, externalMcpServers);

    session = new LiveSession(opts, key, turnBudget, () => this.deps.createUnownedTurnRequest(key), {
      timeoutMs: config.liveSessionTimeoutMs,
      showThinking: config.showThinking,
      onMcpAuthError: (serverName) => this.deps.refreshExternalMcpToken(serverName),
      onToolResult: (toolName, content, isError) => {
        this.deps.handleToolResult?.(key, toolName, content, isError);
      },
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
    this.liveSessions.set(key, session);
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

  closeLiveSession(key: string): void {
    const session = this.liveSessions.get(key);
    if (session) {
      this.promptStale.delete(session);
      session.close();
      this.liveSessions.delete(key);
      this.externalMcpServersBySession.delete(key);
      this.mcpServerConfigsBySession.delete(key);
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
        failures.push({ key, error: err instanceof Error ? err.message : String(err) });
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
    const { key, prompt, images, documents, steer = false, steerAudience, onBlock, onBlockAbandoned, hasShipped, origin, silentDelivery } = req;

    let session: LiveSession | undefined;
    try {
      session = await this.getOrCreateLiveSession(key);
      // The session was built while we were parked in buildExternalMcpServers
      // and shutdown began in the meantime, so createLiveSession closed it
      // rather than publishing it (see there). Refuse rather than call send()
      // on it: the "Session is closed" that would come back is
      // indistinguishable from a session that ran and died mid-turn, and would
      // record this never-processed prompt as a silent turn.
      if (this.stopping && !session.isAlive()) {
        return this.refuseForShutdown(req, "session built after stop() began");
      }
      return await this.runTurnOnSession(key, session, steer, () => (steer
        ? session!.steer(prompt, images, documents, onBlock, onBlockAbandoned, origin, steerAudience)
        : session!.send(prompt, images, documents, onBlock, onBlockAbandoned, origin, silentDelivery)));
    } catch (err) {
      // A turn the CLI ended on an error result is NOT a session error:
      // runTurnOnSession already recorded it; let it through to TurnRunner's
      // error policy untouched. Never retried — the conversation is intact,
      // and a re-run would re-send any blocks that already shipped.
      if (err instanceof SdkResultError) throw err;

      const errMsg = err instanceof Error ? err.message : "";

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
      if (err instanceof SdkResultError) this.recordTurnCompletion(key, session);
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
    this.liveSessions.clear();
    this.externalMcpServersBySession.clear();
    this.mcpServerConfigsBySession.clear();
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
