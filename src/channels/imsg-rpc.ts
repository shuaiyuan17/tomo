import { spawn as nodeSpawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describeError } from "../error-text.js";
import { DEFAULT_RPC_TIMEOUT_MS, ImsgRpcConnection, ImsgRpcResponseError, notSentError } from "./imsg-rpc-connection.js";
import { log } from "../logger.js";
import { writeJsonAtomicSync } from "../fs-utils.js";
import type { ImsgChannelConfig } from "./imsg-channel-config.js";

export { ImsgRpcResponseError } from "./imsg-rpc-connection.js";

const STATUS_PROBE_TIMEOUT_MS = 15_000;
// Backstop for a write that parked on 'drain': if a still-alive child never
// drains within this window, treat it as wedged, settle the parked write (so
// the chain recovers) and restart the child (its watch replays from the
// committed cursor, so delivery is preserved).
const DEFAULT_DRAIN_WAIT_TIMEOUT_MS = 10_000;
export const DEFAULT_CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
// Backoff schedule for restarting a crashed `imsg rpc` child. The last entry
// repeats forever; the index resets once a child stays up for STABLE_CHILD_MS.
const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
const STABLE_CHILD_MS = 60_000;
// Silent retry schedule for a DEGRADED startup capability probe. The common
// cause is a boot-order race: after a reboot (every macOS update) the daemon
// comes up before Messages.app has relaunched with the bridge dylib injected,
// so the first probe reports advanced_features=false even though the bridge
// appears on its own moments later (#258). Retries are quiet; the loud
// actionable warning fires only after the whole schedule is exhausted, by
// which point the bridge is genuinely absent and the `imsg launch` advice is
// accurate. These are the gaps BETWEEN probe attempts (122s summed), and each
// probe can itself take up to STATUS_PROBE_TIMEOUT_MS (15s), so the warning
// lands ~2 minutes after start when probes answer promptly and up to ~4
// minutes when every probe times out — a bound on retry pacing, not a
// wall-clock deadline. The schedule is finite, not a forever-loop: after it,
// on-demand re-probes (below) take over.
const DEFAULT_CAPABILITY_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 15_000, 30_000, 60_000];
// Floor between on-demand capability re-probes (a capability-gated call that
// found the cached answer false). Each probe spawns `imsg status --json`, and
// gated sites fire per message / per typing start — the floor keeps the
// degraded steady state at one cheap subprocess per 30s instead of one per
// call, while still picking a late-appearing bridge up within ~30s of the
// next gated call.
const DEFAULT_CAPABILITY_REPROBE_MIN_INTERVAL_MS = 30_000;
// imsg's "Mutation lane blocked" refusal: an earlier mutation on that child is
// still in flight, and imsg refuses every later mutation on the same process
// until it is restarted (the block is process-local by design). Mutations run
// in their own child, so only that child is restarted: the watch stream is
// never touched. At most DEFAULT_LANE_RESTART_LIMIT restarts per
// DEFAULT_LANE_RESTART_WINDOW_MS; past that the client stops and tells the owner.
export const MUTATION_LANE_BLOCKED = -32004;
const DEFAULT_LANE_RESTART_LIMIT = 3;
const DEFAULT_LANE_RESTART_WINDOW_MS = 10 * 60_000;

export interface ImsgCapabilities {
  /**
   * RPC methods advertised by the installed imsg binary. Provenance (verified
   * against imsg v0.13.4 source): this is `kSupportedRPCMethods` in
   * Sources/imsg/RPCServer.swift — a STATIC list compiled into the CLI. It
   * proves the CLI process we spawn can dispatch the method; it says NOTHING
   * about the bridge dylib actually running inside Messages.app (which may be
   * older: the injected copy persists across brew upgrades until Messages
   * truly relaunches). Never gate a bridge-side surface on this alone.
   */
  rpcMethods: Set<string>;
  /** IMCore bridge injected into Messages.app (advanced features live). */
  advancedFeatures: boolean;
  /**
   * Per-selector availability probed by the bridge — the LIVE signal: `imsg
   * status` asks the injected dylib, which answers with the selector dict
   * compiled into it. 0.13+ dylibs emit every key they know as an explicit
   * true/false (a dictionary literal), which makes the two negative shapes
   * distinguishable: key === false means the bridge probed the OS and the
   * IMCore surface is missing (a real OS limit, e.g. the macOS 26 edit
   * selectors); key ABSENT means the running dylib predates the feature
   * entirely (e.g. a 0.12.x bridge never mentions `stickerSend`) — a state
   * that heals only via a real Messages relaunch with the newer dylib.
   */
  selectors: Record<string, boolean>;
  typingIndicators: boolean;
  readReceipts: boolean;
}

export const NO_CAPABILITIES: ImsgCapabilities = {
  rpcMethods: new Set(),
  advancedFeatures: false,
  selectors: {},
  typingIndicators: false,
  readReceipts: false,
};

/** What {@link ImsgRpcClient} needs from the channel that owns it. */
export interface ImsgRpcDeps {
  /** Handle one `watch.subscribe` row. Called on the watch FIFO, in rowid order. */
  onWatchMessage(data: Record<string, unknown>, generation: number): Promise<void>;
  /**
   * The lane-blocked restarts ran out for this window: the client has stopped
   * restarting the mutation child and lets -32004 refusals through. Called
   * once per such stretch.
   */
  onLaneRestartsExhausted?(info: { restarts: number; windowMs: number }): void;
}

/** True for imsg's -32004 "Mutation lane blocked" error response. */
export function isMutationLaneBlocked(err: unknown): boolean {
  return err instanceof ImsgRpcResponseError && err.rpcCode === MUTATION_LANE_BLOCKED;
}

/**
 * The two `imsg rpc` children, the watch cursor and the capability probe.
 * Owned by {@link ImsgChannel}.
 *
 * - The WATCH child only holds the `watch.subscribe` stream. It is restarted
 *   with backoff when it dies, and resubscribes from the committed cursor.
 * - The MUTATION child carries every other request (sends, tapbacks, edits,
 *   typing, read receipts). It is spawned on first use and again after it
 *   goes away, and it is the only one restarted on -32004, so recovering a
 *   blocked mutation lane never interrupts or replays the watch stream.
 *
 * Two `imsg rpc` processes may run side by side: the poison is per process,
 * the CLI holds no global lock, and bridge requests are keyed by UUID.
 */
export class ImsgRpcClient {
  private readonly cliPath: string;
  private readonly dbPath: string | undefined;
  private readonly cursorStorePath: string | null;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly probeCapabilitiesFn: () => Promise<ImsgCapabilities>;
  private readonly restartDelaysMs: number[];
  private readonly drainWaitTimeoutMs: number;

  /** The watch child (null while it is down and a restart is pending). */
  private watch: ImsgRpcConnection | null = null;
  private watchSpawnedAt = 0;
  /** The mutation child (null until the next request spawns one). */
  private mutation: ImsgRpcConnection | null = null;
  /** killChild ran: no child is spawned again. */
  private tornDown = false;
  private subscriptionId: number | null = null;
  private readonly laneRestartLimit: number;
  private readonly laneRestartWindowMs: number;
  /** When each lane-blocked restart started (epoch ms), pruned to the window. */
  private laneRestarts: number[] = [];
  /** The mutation-child restart in progress; requests issued meanwhile wait for it. */
  private laneRecovery: Promise<boolean> | null = null;
  /** The owner has been told the restarts ran out (reset by the next restart). */
  private laneExhaustedReported = false;
  /**
   * Settles once start() has finished: true when the watch is subscribed.
   * Mutations wait for it, so nothing is sent before the watch can see the
   * reply (the mutation child is spawned on demand, not by start()).
   */
  private startup: Promise<boolean> | null = null;
  private startupOk: boolean | null = null;
  private stopping = false;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private capabilities: ImsgCapabilities = NO_CAPABILITIES;
  private readonly capabilityRetryDelaysMs: number[];
  private readonly capabilityReprobeMinIntervalMs: number;
  /** Pending timer of the silent startup capability-retry loop. */
  private capabilityRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Single-flight guard: at most one capability probe subprocess at a time. */
  private capabilityProbeInFlight = false;
  /** When the last capability probe completed (rate-limits on-demand re-probes). */
  private lastCapabilityProbeAt = 0;
  /**
   * How the last capability probe ended: null = it answered (even if it
   * reported the bridge down), otherwise the error it threw. The exhaustion
   * warning branches on this — "bridge not injected" and "probe keeps
   * failing" are operationally different failures with different remedies,
   * and naming the wrong one sends the operator to the wrong subsystem.
   */
  private lastCapabilityProbeError: unknown = null;
  /** Exclusive chat.db rowid cursor; watch resubscribes after this row. */
  private lastRowId = 0;
  // Lowest rowid whose dispatch failed and hasn't been re-handled yet. While
  // set, the cursor refuses to advance PAST it (never skip a failed real
  // message) and a resubscribe from the committed cursor replays the gap.
  private failedRowId: number | null = null;
  // Serializes watch-notification processing. Rows arrive in rowid order on the
  // stream, but each row's handler awaits attachment IO — without this chain a
  // later row could overtake an earlier one and reach the agent out of order.
  private watchChain: Promise<void> = Promise.resolve();
  // Bumped whenever the current subscription is torn down (crash, gap
  // recovery). Chain links captured under an older generation short-circuit,
  // so stale rows from a dead subscription never dispatch out of order.
  private watchGeneration = 0;

  constructor(config: ImsgChannelConfig, private readonly deps: ImsgRpcDeps) {
    this.cliPath = config.cliPath ?? "imsg";
    this.dbPath = config.dbPath;
    this.cursorStorePath = config.cursorStorePath ?? null;
    this.spawnFn = config.spawnFn ?? nodeSpawn;
    this.probeCapabilitiesFn = config.probeCapabilities ?? (() => this.probeStatus());
    this.restartDelaysMs = config.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.capabilityRetryDelaysMs = config.capabilityRetryDelaysMs ?? DEFAULT_CAPABILITY_RETRY_DELAYS_MS;
    this.capabilityReprobeMinIntervalMs = config.capabilityReprobeMinIntervalMs ?? DEFAULT_CAPABILITY_REPROBE_MIN_INTERVAL_MS;
    this.drainWaitTimeoutMs = config.drainWaitTimeoutMs ?? DEFAULT_DRAIN_WAIT_TIMEOUT_MS;
    this.laneRestartLimit = config.laneRestartLimit ?? DEFAULT_LANE_RESTART_LIMIT;
    this.laneRestartWindowMs = config.laneRestartWindowMs ?? DEFAULT_LANE_RESTART_WINDOW_MS;
    this.loadCursor();
  }

  /** What the last capability probe reported. */
  get currentCapabilities(): ImsgCapabilities {
    return this.capabilities;
  }

  /** True once ingestion has closed (or teardown began). */
  get isStopping(): boolean {
    return this.stopping;
  }

  /** The current watch-subscription generation (see `watchGeneration`). */
  get generation(): number {
    return this.watchGeneration;
  }

  /** The tail of the watch FIFO, for awaiting the rows already on it. */
  get watchChainTail(): Promise<void> {
    return this.watchChain;
  }

  /** Append one link to the watch FIFO; `build` receives the current tail. */
  appendToWatchChain(build: (tail: Promise<void>) => Promise<void>): Promise<void> {
    this.watchChain = build(this.watchChain);
    return this.watchChain;
  }

  /**
   * The rpc half of {@link ImsgChannel.start}: probe capabilities, spawn and
   * subscribe (must succeed), then arm the quiet capability retry loop.
   */
  async start(): Promise<void> {
    const run = this.startOnce();
    this.startup = run.then(() => true, () => false).then((ok) => { this.startupOk = ok; return ok; });
    await run;
  }

  private async startOnce(): Promise<void> {
    // Capability probe: `imsg status --json` reports the injected bridge's
    // selector availability. Failure is non-fatal — the channel degrades to
    // basic send/watch (AppleScript transport needs no bridge). A degraded
    // first probe is usually a boot-order race (daemon up before Messages.app
    // has the bridge injected, #258), so it is NOT warned about here: the
    // silent retry loop below re-probes with backoff and only warns once the
    // schedule is exhausted, and capability-gated call sites keep re-probing
    // on demand after that — a bridge that appears later is picked up without
    // a daemon restart.
    try {
      this.capabilities = await this.probeCapabilitiesFn();
      this.lastCapabilityProbeError = null;
    } catch (err) {
      this.capabilities = NO_CAPABILITIES;
      this.lastCapabilityProbeError = err;
      log.info({ err }, "imsg status probe failed; assuming basic features until a re-probe succeeds");
    }
    this.lastCapabilityProbeAt = Date.now();
    log.info({
      advancedFeatures: this.capabilities.advancedFeatures,
      typing: this.capabilities.typingIndicators,
      readReceipts: this.capabilities.readReceipts,
      editSupported: this.isEditSupported(),
    }, "imsg capabilities probed");

    // First spawn + subscribe must succeed or daemon startup should fail
    // loudly (missing binary, missing Full Disk Access, ...).
    await this.spawnChildAndSubscribe();

    // Start the capability retry loop only once startup has SUCCEEDED. If the
    // subscribe above throws, start() rejects and nothing here has armed a
    // timer — otherwise a channel that never started would keep spawning
    // `imsg status` probes and eventually warn about a bridge it isn't using.
    if (!this.capabilities.advancedFeatures) {
      log.info({ retryDelaysMs: this.capabilityRetryDelaysMs }, "imsg bridge not available yet (advanced_features=false); re-probing quietly with backoff");
      this.scheduleCapabilityRetry(0);
    }
  }

  /** Ingestion is closing: refuse new rows and stop every restart/retry timer. */
  closeIngestion(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.capabilityRetryTimer) {
      clearTimeout(this.capabilityRetryTimer);
      this.capabilityRetryTimer = null;
    }
  }

  /** First step of teardown: mark stopping and unsubscribe (best-effort). */
  async beginTeardown(): Promise<void> {
    this.stopping = true;
    if (this.watch && this.subscriptionId !== null) {
      try {
        await this.watch.request("watch.unsubscribe", { subscription: this.subscriptionId }, 3_000);
      } catch {
        // Best-effort; the child is about to be killed anyway.
      }
    }
  }

  /**
   * True only when the whole edit path is live: the IMCore bridge is injected,
   * the installed imsg advertises `message.edit`, AND the bridge selector probe
   * confirmed an edit selector exists. Gated the same way as typing/read so a
   * partial capability set can never reach `message.edit` (see #227).
   */
  isEditSupported(): boolean {
    return this.capabilities.advancedFeatures
      && this.capabilities.rpcMethods.has("message.edit")
      && (this.capabilities.selectors.editMessageItem === true
        || this.capabilities.selectors.editMessage === true
        // macOS 26+ replaced both with editMessageItem:atPartIndex:withNewPartText:
        // newPartTranslation:backwardCompatabilityText:, which imsg probes and
        // calls as `editMessageItemTranslation`.
        || this.capabilities.selectors.editMessageItemTranslation === true);
  }

  // --- imsg rpc child lifecycle ---

  private spawnConnection(onNotification: (conn: ImsgRpcConnection, payload: Record<string, unknown>) => void,
    onDown: (conn: ImsgRpcConnection, reason: string) => void): ImsgRpcConnection {
    const args = ["rpc", ...(this.dbPath ? ["--db", this.dbPath] : [])];
    const child = this.spawnFn(this.cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const conn: ImsgRpcConnection = new ImsgRpcConnection(child, this.drainWaitTimeoutMs, {
      onNotification: (payload) => onNotification(conn, payload),
      onDown: (reason) => onDown(conn, reason),
    });
    return conn;
  }

  private async spawnChildAndSubscribe(): Promise<void> {
    const conn = this.spawnConnection(
      (c, payload) => { if (this.watch === c) this.handleWatchNotification(c, payload); },
      (c, reason) => this.handleChildDown(c, reason),
    );
    this.watch = conn;
    this.watchSpawnedAt = Date.now();

    // Subscribe to the all-chat watch stream. `since_rowid` resumes from the
    // persisted cursor so messages that arrived while we were down replay
    // (the GUID dedupe store drops any we already dispatched).
    try {
      const result = await conn.request("watch.subscribe", {
        attachments: true,
        convert_attachments: true,
        include_reactions: true,
        ...(this.lastRowId > 0 ? { since_rowid: this.lastRowId } : {}),
      });
      const subscription = result.subscription;
      this.subscriptionId = typeof subscription === "number" ? subscription : null;
      log.info({ subscription: this.subscriptionId, sinceRowId: this.lastRowId || undefined }, "imsg watch subscribed");
    } catch (err) {
      // The child spawned but the subscribe failed (FDA missing, startup
      // error, ...). Kill the child we just started before propagating —
      // otherwise it leaks as a live `imsg rpc` process with dangling pipes.
      if (this.watch === conn) {
        this.watch = null;
        this.subscriptionId = null;
      }
      conn.kill("subscribe failed");
      throw err;
    }
  }

  private handleChildDown(conn: ImsgRpcConnection, reason: string): void {
    if (this.watch !== conn) return; // stale event from an already-replaced child
    this.watch = null;
    this.subscriptionId = null;
    // Abandon the current watch chain: queued rows belong to the dead
    // subscription and will replay in order after resubscribe.
    this.watchGeneration++;
    this.watchChain = Promise.resolve();
    this.scheduleRestart(reason);
  }

  /** Schedule a backoff restart of the watch child (no-op once stopping). */
  private scheduleRestart(reason: string): void {
    if (this.stopping || this.restartTimer) return;

    // A child that survived a while earns a fresh backoff schedule.
    if (Date.now() - this.watchSpawnedAt >= STABLE_CHILD_MS) {
      this.restartAttempt = 0;
    }
    const delay = this.restartDelaysMs[Math.min(this.restartAttempt, this.restartDelaysMs.length - 1)];
    this.restartAttempt++;
    log.warn({ reason, delayMs: delay, attempt: this.restartAttempt }, "imsg rpc child down; restarting with backoff");

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.spawnChildAndSubscribe().catch((err) => {
        // spawnChildAndSubscribe already killed the failed child; just queue
        // another attempt (its own exit event is ignored as stale).
        log.error({ err }, "imsg rpc child restart failed");
        this.scheduleRestart("restart failed");
      });
    }, delay);
    // Don't hold the process open just for a pending restart.
    this.restartTimer.unref?.();
  }

  /** Kill both children; in-flight requests are rejected. Nothing respawns. */
  killChild(): void {
    this.tornDown = true;
    const watch = this.watch;
    this.watch = null;
    this.subscriptionId = null;
    // Killing settles in-flight requests — otherwise a send awaited during
    // shutdown would never resolve (its timeout timer is unref'd, so it may
    // never fire before the process exits).
    watch?.kill("stopped");
    const mutation = this.mutation;
    this.mutation = null;
    mutation?.kill("stopped");
  }

  // --- The mutation child ---

  /** The live mutation child, spawning one if there is none (null after teardown). */
  private mutationChild(): ImsgRpcConnection | null {
    if (this.tornDown) return null;
    if (this.mutation?.alive) return this.mutation;
    const conn = this.spawnConnection(
      () => { /* the mutation child never subscribes; nothing to notify */ },
      (c, reason) => {
        if (this.mutation !== c) return;
        this.mutation = null;
        log.warn({ reason }, "imsg rpc mutation child down; the next request starts a new one");
      },
    );
    this.mutation = conn;
    return conn;
  }

  private mutationRequest(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const conn = this.mutationChild();
    if (!conn) return Promise.reject(notSentError(method, "the iMessage channel has stopped"));
    return conn.request(method, params, timeoutMs);
  }

  /**
   * Refused with -32004 → restart the mutation child, then send the same
   * request once more on the new one.
   *
   * The retry cannot double-deliver: imsg rejects a request on a blocked lane
   * before queueing it, so it never started. Only that refusal is retried. A
   * timeout, a dead child or a failed write may have delivered, and is never
   * retried here; nor is the retry itself, whatever its outcome.
   */
  private async requestWithLaneRetry(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    try {
      return await this.mutationRequest(method, params, timeoutMs);
    } catch (err) {
      if (!isMutationLaneBlocked(err)) throw err;
      if (!(await this.recoverFromLaneBlocked())) throw err;
      return await this.mutationRequest(method, params, timeoutMs);
    }
  }

  /**
   * Restart the mutation child for a blocked lane, or join the restart already
   * under way (several requests refused together share one). Resolves true
   * once a new child can take requests; false when the restarts for this
   * window are used up (the owner is told once) or the channel tore down.
   */
  private recoverFromLaneBlocked(): Promise<boolean> {
    if (this.laneRecovery) return this.laneRecovery;
    if (this.tornDown) return Promise.resolve(false);
    const now = Date.now();
    this.laneRestarts = this.laneRestarts.filter((at) => now - at < this.laneRestartWindowMs);
    if (this.laneRestarts.length >= this.laneRestartLimit) {
      log.error(
        { restarts: this.laneRestarts.length, windowMs: this.laneRestartWindowMs },
        "imsg mutation lane still blocked (-32004) after the restart limit; not restarting the mutation child again in this window",
      );
      if (!this.laneExhaustedReported) {
        this.laneExhaustedReported = true;
        try {
          this.deps.onLaneRestartsExhausted?.({ restarts: this.laneRestarts.length, windowMs: this.laneRestartWindowMs });
        } catch (err) {
          log.warn({ err }, "imsg lane-blocked owner notice failed");
        }
      }
      return Promise.resolve(false);
    }
    this.laneRestarts.push(now);
    this.laneExhaustedReported = false;
    const recovery = this.restartMutationChild(this.laneRestarts.length).finally(() => {
      if (this.laneRecovery === recovery) this.laneRecovery = null;
    });
    this.laneRecovery = recovery;
    return recovery;
  }

  private async restartMutationChild(attempt: number): Promise<boolean> {
    const old = this.mutation;
    if (old) {
      // Let the requests already on the wire settle first: killing the child
      // under them would make a delivered-or-refused send an unknown one. On
      // a blocked lane imsg answers them at once; the backstop only covers a
      // timer that never fires.
      const others = old.inFlightRequests();
      if (others.length > 0) {
        let backstop: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(others),
          new Promise<void>((resolve) => {
            backstop = setTimeout(resolve, DEFAULT_RPC_TIMEOUT_MS * 2);
            backstop.unref?.();
          }),
        ]);
        clearTimeout(backstop);
      }
      log.warn(
        { attempt, limit: this.laneRestartLimit, windowMs: this.laneRestartWindowMs },
        "imsg mutation lane blocked (-32004); restarting the mutation child (the watch stream is untouched)",
      );
      if (this.mutation === old) this.mutation = null;
      old.kill("restarted (mutation lane blocked)");
    }
    if (this.tornDown) return false;
    this.mutationChild();
    return true;
  }

  // --- Requests ---

  /**
   * One JSON-RPC request on the mutation child. A -32004 refusal restarts that
   * child and retries the request once (see requestWithLaneRetry); a request
   * issued while such a restart is under way waits for the new child instead
   * of writing to the one being replaced, and fails as not sent if the
   * channel tears down meanwhile.
   */
  request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<Record<string, unknown>> {
    // Not before the watch is subscribed: a reply arriving earlier would be missed.
    if (!this.startup) return Promise.reject(notSentError(method, "the iMessage channel has not started"));
    if (this.startupOk === null) {
      return this.startup.then((ok) => ok
        ? this.request(method, params, timeoutMs)
        : Promise.reject(notSentError(method, "the iMessage channel failed to start")));
    }
    if (!this.startupOk) return Promise.reject(notSentError(method, "the iMessage channel failed to start"));
    const recovery = this.laneRecovery;
    if (recovery) {
      return recovery.then(() => this.tornDown
        ? Promise.reject(notSentError(method, "the iMessage channel stopped while the mutation child restarted"))
        : this.requestWithLaneRetry(method, params, timeoutMs));
    }
    return this.requestWithLaneRetry(method, params, timeoutMs);
  }

  private handleWatchNotification(conn: ImsgRpcConnection, payload: Record<string, unknown>): void {
    // Notification (no id)
    if (payload.method === "message") {
      const params = payload.params as Record<string, unknown> | undefined;
      const message = params?.message as Record<string, unknown> | undefined;
      if (!message) return;
      // Serialize through a FIFO chain: rows arrive in rowid order, but each
      // handler awaits attachment IO, so without this a later row could reach
      // the agent before an earlier one. Capture the generation so that if the
      // subscription is torn down (crash / gap recovery) while rows are queued,
      // those stale rows short-circuit instead of dispatching out of order.
      const generation = this.watchGeneration;
      this.watchChain = this.watchChain.then(() => {
        if (generation !== this.watchGeneration) return;
        return this.deps.onWatchMessage(message, generation).catch((err) => {
          log.error({ err }, "Error processing imsg watch message");
        });
      });
      return;
    }

    if (payload.method === "error") {
      // The watch stream died server-side; the subscription will not recover
      // on its own. Restart the child to rebuild it from the rowid cursor.
      log.error({ params: payload.params }, "imsg watch stream errored; restarting rpc child");
      // Kill first (no onDown from a killed child), then restart ourselves.
      conn.kill("watch stream error");
      this.handleChildDown(conn, "watch stream error");
    }
  }

  /** True (with a log) when a row's generation has been superseded by a replay. */
  isStaleGeneration(generation: number, rowId: number): boolean {
    if (generation === this.watchGeneration) return false;
    log.debug({ rowId, generation, current: this.watchGeneration }, "imsg abandoning stale-generation row (superseded by replay)");
    return true;
  }

  /**
   * Persist the exclusive rowid cursor once a row is fully handled. Refuses to
   * advance PAST an unresolved failed row (that would skip it); reaching the
   * failed row again (successful replay) clears the floor.
   */
  advanceCursor(rowId: number): void {
    if (this.failedRowId !== null) {
      if (rowId > this.failedRowId) return; // never commit past the gap
      if (rowId >= this.failedRowId) this.failedRowId = null; // gap re-handled
    }
    if (rowId > this.lastRowId) {
      this.lastRowId = rowId;
      this.persistCursor();
    }
  }

  /**
   * A real message failed to dispatch. Mark its rowid as the failed floor and
   * tear down the subscription so it resubscribes from the last committed
   * cursor — replaying the failed row and everything after it, in order. The
   * generation bump in handleChildDown abandons any rows already queued behind
   * the failure so they don't reach the agent out of order.
   */
  recoverFromGap(rowId: number, err: unknown): void {
    // A row without a numeric rowid (parsed as 0) can't be replayed by
    // since_rowid. Flooring at 0 would block every future cursor commit (all
    // real rowids are > 0) and the floor could never clear — the cursor file
    // would silently freeze forever. Log and move on instead.
    if (rowId <= 0) {
      log.error({ err }, "imsg dispatch failed for a row with no rowid; cannot replay — skipping");
      return;
    }
    if (this.failedRowId === null || rowId < this.failedRowId) this.failedRowId = rowId;
    log.error({ err, rowId, sinceRowId: this.lastRowId }, "imsg dispatch failed; resubscribing to replay the gap");
    const watch = this.watch;
    if (watch) {
      watch.kill("dispatch gap recovery");
      this.handleChildDown(watch, "dispatch gap recovery");
    } else {
      // No live child (a restart is already in flight) — it will resubscribe
      // from the (un-advanced) committed cursor and replay the failed row.
      this.scheduleRestart("dispatch gap recovery");
    }
  }

  // --- Capability probe ---

  /**
   * Silent startup retry loop for a degraded capability probe (#258). The
   * common cause is a boot-order race — the daemon starts before Messages.app
   * has come up with the bridge dylib injected (every macOS-update reboot) —
   * so retries stay QUIET: no warning until the whole schedule is exhausted,
   * and a retry that finds the bridge simply swaps the snapshot in (one info
   * line from reprobeCapabilities) and ends the loop. Once exhausted, the
   * loud warning fires — worded for what actually happened (bridge reported
   * absent vs. probe kept failing; see the branch below) — and on-demand
   * re-probes take over so a bridge that appears even later is still picked
   * up without a restart. Only armed after start() has fully succeeded, so a
   * failed startup never leaks a probing loop for a dead channel.
   * Never calls `imsg launch` itself: that kills and relaunches Messages.app
   * and must stay a human decision.
   */
  private scheduleCapabilityRetry(attempt: number): void {
    if (this.stopping || this.capabilityRetryTimer) return;
    if (attempt >= this.capabilityRetryDelaysMs.length) {
      // Hard operational prerequisite: without `imsg launch` (bridge
      // injected), the IMCore-backed outbound RPCs — send.rich, tapback,
      // message.unsend, group.rename, typing — have no live path and BLOCK
      // until their request timeouts (30s / 5s) fire. Inbound watch and plain
      // AppleScript `send` still work, but outbound is effectively dead. Warn
      // loudly (only now, after the silent retries) so a cutover that skipped
      // `imsg launch` is obvious in the logs.
      //
      // Two operationally different failures reach this point, and the
      // warning must say which it saw — a confidently wrong remedy is worse
      // than none (#258's original sin):
      // - the probe ANSWERED with advanced_features=false → the bridge is
      //   genuinely not injected and `imsg launch` is the accurate remedy;
      // - the probe kept THROWING (missing/broken binary, spawn error,
      //   timeout, malformed JSON) → capabilities are UNKNOWN, the bridge may
      //   be fine, and `imsg launch` likely won't help.
      if (this.lastCapabilityProbeError == null) {
        log.warn(
          { retriesExhausted: this.capabilityRetryDelaysMs.length },
          "imsg bridge NOT injected (advanced_features=false) after startup retries: run `imsg launch`. Until then, outbound tapback/typing/unsend/rename/threaded-reply RPCs will hang until timeout; only inbound watch and plain sends work. The channel keeps re-probing in the background and picks the bridge up automatically once it is injected.",
        );
      } else {
        log.warn(
          { err: this.lastCapabilityProbeError, retriesExhausted: this.capabilityRetryDelaysMs.length },
          "imsg status probe still failing after startup retries — capabilities UNKNOWN, assuming basic features. This is a probe failure, not (necessarily) a missing bridge: check the imsg binary first (`imsg status --json`) before reaching for `imsg launch`. Typing and threaded replies degrade to no-ops (they are capability-gated); tapback/unsend/rename are NOT gated and will still be attempted — if the bridge is in fact absent they hang until their request timeout. The channel keeps re-probing in the background.",
        );
      }
      return;
    }
    const timer = setTimeout(() => {
      this.capabilityRetryTimer = null;
      if (this.stopping) return;
      void this.reprobeCapabilities("startup retry").then(() => {
        if (this.stopping || this.capabilities.advancedFeatures) return; // healed (or shutting down) — silently done
        this.scheduleCapabilityRetry(attempt + 1);
      });
    }, this.capabilityRetryDelaysMs[attempt]);
    // Don't hold the process open just for a pending capability retry.
    timer.unref?.();
    this.capabilityRetryTimer = timer;
  }

  /**
   * Legible failure mode for a closed capability gate: names exactly what the
   * gate read and what it saw, plus a one-line verdict on WHICH link of the
   * chain broke and what (if anything) heals it. Logged at every refusal
   * point so a reader seeing "stickers not sending" can tell, from the logs
   * alone, whether the bridge lacks the surface or the gate misread it —
   * absence of a key from a probe is otherwise indistinguishable from
   * "probed and refused" (the exact confusion that shipped these gates
   * pointing at signals nobody had verified; see the provenance notes on
   * ImsgCapabilities).
   *
   * The checks mirror the gate conditions in short-circuit order:
   * advancedFeatures, then the CLI-side rpc_methods entry (when the gate has
   * one), then the bridge-side selectors. Pass `rpcMethod: null` for gates
   * that don't read rpc_methods, so the diagnosis can never claim a check
   * the gate doesn't make.
   */
  capabilityGateDiagnosis(
    rpcMethod: string | null,
    selectorKeys: string[],
  ): { checked: Record<string, string | boolean>; verdict: string } {
    const caps = this.capabilities;
    const checked: Record<string, string | boolean> = { advancedFeatures: caps.advancedFeatures };
    if (rpcMethod !== null) checked[`rpcMethods.${rpcMethod}`] = caps.rpcMethods.has(rpcMethod);
    const absent: string[] = [];
    const probedFalse: string[] = [];
    for (const key of selectorKeys) {
      const value = caps.selectors[key];
      checked[`selectors.${key}`] = value === undefined ? "absent" : value;
      if (value === undefined) absent.push(key);
      else if (value !== true) probedFalse.push(key);
    }
    let verdict: string;
    if (!caps.advancedFeatures) {
      verdict = "bridge not injected (advanced_features=false): run `imsg launch`";
    } else if (rpcMethod !== null && !caps.rpcMethods.has(rpcMethod)) {
      verdict = `installed imsg CLI does not implement ${rpcMethod} `
        + "(rpc_methods is a static list compiled into the CLI, not a bridge probe): upgrade imsg";
    } else if (absent.length > 0) {
      verdict = Object.keys(caps.selectors).length === 0
        ? "bridge is up but reported no selectors (its status probe failed or predates selector reporting); "
          + "a background re-probe may heal this"
        : `selector(s) ${absent.join(", ")} ABSENT from the bridge's probe output: the dylib running inside `
          + "Messages.app predates this feature (0.13+ dylibs report every selector they know as explicit "
          + "true/false). Heals only via a real relaunch: quit Messages.app, then `imsg launch` — "
          + "launch alone silently no-ops while the old bridge still answers ping";
    } else {
      verdict = `selector(s) ${probedFalse.join(", ")} probed FALSE by the live bridge: the IMCore surface `
        + "is missing on this macOS; no relaunch or upgrade changes this";
    }
    return { checked, verdict };
  }

  /**
   * Fire-and-forget re-probe for capability-gated call sites that found the
   * cached answer false. The gated call itself still skips exactly as before
   * (no subprocess, no latency on its path) — the probe runs in the
   * background so the NEXT call sees a fresh answer. No-op when:
   * - the bridge is already up (a per-selector false, e.g. editSupported on
   *   macOS 26, is a real OS limit a re-probe cannot change) — UNLESS the
   *   caller passes `evenIfBridged`, for selectors whose absence means "the
   *   injected bridge predates the feature" rather than "the OS removed it":
   *   the rich-link selectors appear when Messages relaunches with a newer
   *   bridge dylib, an event the daemon survives with advanced_features true
   *   throughout — so without the opt-in this gate would return early
   *   forever and the cached selector snapshot could never heal,
   * - the startup retry loop still owns probing, or
   * - a probe ran within the last capabilityReprobeMinIntervalMs (keeps the
   *   degraded steady state at ≤1 subprocess per interval, not one per call).
   */
  maybeReprobeCapabilities(options: { evenIfBridged?: boolean } = {}): void {
    if (this.stopping) return;
    if (this.capabilities.advancedFeatures && !options.evenIfBridged) return;
    if (this.capabilityRetryTimer) return;
    if (Date.now() - this.lastCapabilityProbeAt < this.capabilityReprobeMinIntervalMs) return;
    // No reservation needed before the async call: reprobeCapabilities sets
    // its single-flight guard synchronously, so same-tick gated calls that
    // also pass the rate check coalesce there, and the guard's finally block
    // re-anchors lastCapabilityProbeAt on completion.
    void this.reprobeCapabilities("on-demand");
  }

  /**
   * Re-run the capability probe and swap in the fresh snapshot. Single-flight:
   * concurrent callers coalesce into one subprocess. A probe FAILURE keeps the
   * cached snapshot — callers only re-probe while degraded, so there is
   * nothing to lose — and logs at debug (failures while degraded are expected
   * noise, and the actionable warning already fired once at startup). The only
   * non-debug output is one info line when the bridge transitions to
   * available, so a transient boot-order race that resolves itself resolves
   * without ever warning.
   */
  private async reprobeCapabilities(reason: string): Promise<void> {
    if (this.capabilityProbeInFlight || this.stopping) return;
    this.capabilityProbeInFlight = true;
    try {
      const caps = await this.probeCapabilitiesFn();
      // stop() may have run while the probe was in flight — a stopped channel
      // must not mutate its snapshot (or log an upgrade it can't honor).
      if (this.stopping) return;
      this.lastCapabilityProbeError = null;
      const hadBridge = this.capabilities.advancedFeatures;
      this.capabilities = caps;
      if (!hadBridge && caps.advancedFeatures) {
        log.info({
          reason,
          advancedFeatures: caps.advancedFeatures,
          typing: caps.typingIndicators,
          readReceipts: caps.readReceipts,
          editSupported: this.isEditSupported(),
        }, "imsg bridge is now available; capabilities upgraded");
      }
    } catch (err) {
      if (this.stopping) return;
      this.lastCapabilityProbeError = err;
      log.debug({ err, reason }, "imsg capability re-probe failed; keeping cached capabilities");
    } finally {
      this.capabilityProbeInFlight = false;
      if (!this.stopping) this.lastCapabilityProbeAt = Date.now();
    }
  }

  /** Run `imsg status --json` and normalize the capability surface. */
  private probeStatus(): Promise<ImsgCapabilities> {
    return new Promise((resolve, reject) => {
      execFile(this.cliPath, ["status", "--json"], { timeout: STATUS_PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) {
          // execFile hands stderr to the callback, not to the error.
          const withStderr = Object.assign(err, { stderr: (err as { stderr?: unknown }).stderr ?? stderr });
          reject(new Error(`imsg status probe failed: ${describeError(withStderr)}`, { cause: err }));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          resolve({
            rpcMethods: new Set(Array.isArray(parsed.rpc_methods) ? parsed.rpc_methods.filter((m): m is string => typeof m === "string") : []),
            advancedFeatures: parsed.advanced_features === true,
            selectors: (parsed.selectors ?? {}) as Record<string, boolean>,
            typingIndicators: parsed.typing_indicators === true,
            readReceipts: parsed.read_receipts === true,
          });
        } catch (parseErr) {
          reject(new Error(`imsg status probe returned invalid JSON: ${describeError(parseErr)}`, { cause: parseErr }));
        }
      });
    });
  }

  // --- Watch cursor persistence ---

  private loadCursor(): void {
    if (!this.cursorStorePath || !existsSync(this.cursorStorePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.cursorStorePath, "utf-8")) as { lastRowId?: unknown };
      if (typeof data.lastRowId === "number" && Number.isFinite(data.lastRowId)) {
        this.lastRowId = data.lastRowId;
      }
    } catch (err) {
      log.warn({ err, file: this.cursorStorePath }, "Could not load imsg watch cursor; starting from now");
    }
  }

  private persistCursor(): void {
    if (!this.cursorStorePath) return;
    try {
      mkdirSync(dirname(this.cursorStorePath), { recursive: true });
      writeJsonAtomicSync(this.cursorStorePath, { lastRowId: this.lastRowId });
    } catch (err) {
      log.debug({ err, file: this.cursorStorePath }, "Could not persist imsg watch cursor");
    }
  }
}
