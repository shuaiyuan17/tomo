import { spawn as nodeSpawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { markDefiniteFailure } from "./types.js";
import { describeError, shortErrorMessage } from "../error-text.js";
import { log } from "../logger.js";
import { writeJsonAtomicSync } from "../fs-utils.js";
import type { ImsgChannelConfig } from "./imsg-channel-config.js";

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const STATUS_PROBE_TIMEOUT_MS = 15_000;
// Cap on in-flight RPC requests. Past this the pending map is treated as a
// symptom of a stuck child; new requests fail fast instead of piling up.
const MAX_PENDING_REQUESTS = 256;
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

/**
 * A JSON-RPC error RESPONSE from the imsg child: the request was received,
 * processed, and refused — proof the message was NOT sent, so recovering with
 * a fallback plain send cannot double-deliver. Timeouts, child death, and
 * write failures reject with plain Errors instead: the child may have
 * consumed the request and dispatched the message before the failure, so a
 * fallback there risks the recipient seeing the text twice. A missing message
 * is the recoverable failure; a duplicate is the visible one.
 */
/**
 * The imsg child answered the RPC with an error. Definite by construction: the
 * request was processed and refused, so nothing was sent — which is what lets
 * this module fall back to a plain send on a refusal, and what lets the
 * delivery pipeline re-send a caption whose picture was refused. A timeout or
 * a dead child is a plain Error and stays ambiguous.
 */
export class ImsgRpcResponseError extends Error {
  /**
   * The JSON-RPC error's `code` and `data`, kept structured so the log line
   * (pino serializes an Error's own fields) shows them as they arrived.
   * Named `rpc*` so describeError, which reads `code`/`data`, does not append
   * them a second time after the message that already spells them out.
   */
  readonly rpcCode?: number;
  readonly rpcData?: unknown;
  /** The message WITHOUT the RPC `data` — what shortErrorMessage shows. */
  readonly publicMessage?: string;

  constructor(message?: string, rpc?: { code?: number; data?: unknown; publicMessage?: string }) {
    super(message);
    this.name = "ImsgRpcResponseError";
    if (rpc?.publicMessage !== undefined) this.publicMessage = rpc.publicMessage;
    if (rpc?.code !== undefined) this.rpcCode = rpc.code;
    if (rpc?.data !== undefined) this.rpcData = rpc.data;
    markDefiniteFailure(this);
  }
}

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

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/** What {@link ImsgRpcClient} needs from the channel that owns it. */
export interface ImsgRpcDeps {
  /** Handle one `watch.subscribe` row. Called on the watch FIFO, in rowid order. */
  onWatchMessage(data: Record<string, unknown>, generation: number): Promise<void>;
}

/**
 * The `imsg rpc` child process, its JSON-RPC transport, the watch cursor and
 * the capability probe. Owned by {@link ImsgChannel}.
 */
export class ImsgRpcClient {
  private readonly cliPath: string;
  private readonly dbPath: string | undefined;
  private readonly cursorStorePath: string | null;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly probeCapabilitiesFn: () => Promise<ImsgCapabilities>;
  private readonly restartDelaysMs: number[];
  private readonly drainWaitTimeoutMs: number;
  // Settles a request's parked-on-'drain' write link, keyed by request id, so a
  // request timeout/cancel can release its own stuck write (else future writes
  // queue behind a forever-pending drain-wait).
  private writeWaiters = new Map<number, () => void>();

  private child: ChildProcessWithoutNullStreams | null = null;
  private childSpawnedAt = 0;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private subscriptionId: number | null = null;
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
  // Serializes stdin writes so we can honor backpressure (await 'drain' when
  // write() returns false) instead of unboundedly buffering in the pipe.
  private writeChain: Promise<void> = Promise.resolve();

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
    if (this.child && this.subscriptionId !== null) {
      try {
        await this.request("watch.unsubscribe", { subscription: this.subscriptionId }, 3_000);
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

  private async spawnChildAndSubscribe(): Promise<void> {
    const args = ["rpc", ...(this.dbPath ? ["--db", this.dbPath] : [])];
    const child = this.spawnFn(this.cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.childSpawnedAt = Date.now();
    this.stdoutBuffer = "";

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      // Drop late/buffered stdout from a child that is no longer current: after
      // a kill + gap-recovery generation bump, a straggler line from the dead
      // child must not be parsed and dispatched under the new subscription
      // (out of order, before the in-order replay).
      if (this.child !== child) return;
      this.handleStdout(chunk);
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line) log.debug({ imsg: line }, "imsg rpc stderr");
    });
    // THE WRITE SIDE NEEDS A LISTENER TOO. A pipe to a dead child emits
    // 'error' (EPIPE/ERR_STREAM_DESTROYED) on `stdin`, and an 'error' with no
    // listener on a stream is an uncaughtException — which, since the daemon
    // installs process-level handlers, logs and exits 1. The race is ordinary:
    // `killChild`/`recoverFromGap` tear the child down while a read receipt or
    // a typing tick is mid-write, and the whole daemon dies because one
    // fire-and-forget write lost a race with a restart it caused.
    //
    // Nothing to recover here: `enqueueWrite`'s write callback already fails
    // the owning request, and `handleChildDown` rejects everything still
    // pending, so this listener exists purely to keep the emitter handled.
    // Debug, not warn: a broken pipe to a child we just killed is expected.
    // THE READ SIDES TOO. Same class, same consequence: `stdout`/`stderr` are
    // streams, an unhandled 'error' on either is an uncaughtException, and a
    // child torn down mid-read (killChild, recoverFromGap, a crash) is the
    // ordinary way EPIPE/ECONNRESET arrives on a pipe we are still reading.
    // Only `stdin` was covered, so the same race on the other two pipes still
    // took the daemon down. Nothing to recover here either — `handleChildDown`
    // (via 'error'/'exit' below) owns the restart; these keep the emitters
    // handled so the process survives long enough for it to run.
    child.stdin.on("error", (err) => {
      log.debug({ err }, "imsg rpc stdin error (write to a closed child pipe)");
    });
    child.stdout.on("error", (err) => {
      log.debug({ err }, "imsg rpc stdout error (read from a closed child pipe)");
    });
    child.stderr.on("error", (err) => {
      log.debug({ err }, "imsg rpc stderr error (read from a closed child pipe)");
    });
    child.on("error", (err) => {
      log.error({ err }, "imsg rpc child failed to spawn");
      // The reason ends up in the message of every pending request it
      // rejects, so the short form; the full error is in the line above.
      this.handleChildDown(child, `spawn error: ${shortErrorMessage(err)}`);
    });
    child.on("exit", (code, signal) => {
      this.handleChildDown(child, `exited with code ${code} signal ${signal}`);
    });

    // Subscribe to the all-chat watch stream. `since_rowid` resumes from the
    // persisted cursor so messages that arrived while we were down replay
    // (the GUID dedupe store drops any we already dispatched).
    try {
      const result = await this.request("watch.subscribe", {
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
      // Also reject any OTHER in-flight requests (e.g. sends issued during a
      // restart): once we null this.child, the child's exit event is stale and
      // handleChildDown() would skip them, hanging them until timeout.
      if (this.child === child) {
        this.child = null;
        this.subscriptionId = null;
      }
      // Fresh write chain for the next attempt (a stalled drain-wait on this
      // dead child must not block future writes) and reject in-flight requests.
      this.writeChain = Promise.resolve();
      this.rejectAllPending("subscribe failed");
      child.kill();
      throw err;
    }
  }

  /** Reject every in-flight request (the child can no longer answer them). */
  private rejectAllPending(reason: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const req of pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`imsg rpc child ${reason} while awaiting ${req.method}`));
    }
  }

  private handleChildDown(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.child !== child) return; // stale event from an already-replaced child
    this.child = null;
    this.subscriptionId = null;
    // Abandon the current watch chain: queued rows belong to the dead
    // subscription and will replay in order after resubscribe.
    this.watchGeneration++;
    this.watchChain = Promise.resolve();
    // Give the restarted child a fresh write chain. A write that returned false
    // and is still awaiting 'drain' on the dead child would otherwise keep the
    // global chain pending forever, so every restarted watch.subscribe would
    // queue behind it and time out — a permanent restart loop. (The stalled
    // link itself settles via the drain/exit race in enqueueWrite.)
    this.writeChain = Promise.resolve();

    this.rejectAllPending(reason);
    this.scheduleRestart(reason);
  }

  /** Schedule a backoff restart of the rpc child (no-op once stopping). */
  private scheduleRestart(reason: string): void {
    if (this.stopping || this.restartTimer) return;

    // A child that survived a while earns a fresh backoff schedule.
    if (Date.now() - this.childSpawnedAt >= STABLE_CHILD_MS) {
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

  killChild(): void {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.subscriptionId = null;
    // Nulling this.child above makes the kill's exit event a stale no-op in
    // handleChildDown, so settle in-flight requests here — otherwise a send
    // awaited during shutdown would never resolve (its timeout timer is
    // unref'd, so it may never fire before the process exits).
    this.rejectAllPending("stopped");
    child.kill();
  }

  // --- JSON-RPC over stdio (newline-delimited JSON) ---

  request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error(`imsg rpc child is not running (${method})`));
    }
    // Bound the in-flight set. A pending map this large means the child has
    // stopped answering (or draining); fail fast rather than buffer unboundedly.
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error(`imsg rpc pending queue full (${MAX_PENDING_REQUESTS}); dropping ${method}`));
    }
    const id = this.nextRequestId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Settle this request's write link if it is still parked on 'drain':
        // the request is gone, so leaving the link pending would queue every
        // future write behind it forever.
        this.writeWaiters.get(id)?.();
        reject(new Error(`imsg rpc ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      // Route the write through the backpressure-aware, serialized writer.
      // A write failure rejects the request (the response will never come).
      this.enqueueWrite(child, line, id).catch((err: Error) => {
        const req = this.pending.get(id);
        if (req) {
          this.pending.delete(id);
          clearTimeout(req.timer);
          log.warn({ err, method }, "imsg rpc write failed");
          reject(new Error(`imsg rpc write failed for ${method}: ${shortErrorMessage(err)}`, { cause: err }));
        }
      });
    });
  }

  /**
   * Serialized, backpressure-aware stdin writer. When `write()` returns false
   * the pipe buffer is full — await the 'drain' event before the next write so
   * we never let Node buffer an unbounded backlog in memory.
   *
   * `id` is the owning request: if it is no longer pending by the time this
   * write dequeues (the request already timed out or was rejected), the write
   * is SKIPPED. Otherwise a queued send could fire late — after the caller saw
   * a timeout and possibly retried — producing a duplicate side-effecting send.
   */
  private enqueueWrite(child: ChildProcessWithoutNullStreams, line: string, id: number): Promise<void> {
    this.writeChain = this.writeChain.then(() => new Promise<void>((resolve, reject) => {
      if (!this.pending.has(id)) {
        // Request already settled (timeout/reject); do not execute its write.
        resolve();
        return;
      }
      if (!child.stdin.writable) {
        reject(new Error("stdin is not writable"));
        return;
      }
      let settled = false;
      let onDrain: (() => void) | null = null;
      let onExit: (() => void) | null = null;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (onDrain) child.stdin.removeListener("drain", onDrain);
        if (onExit) {
          child.removeListener("exit", onExit);
          child.removeListener("close", onExit);
        }
        if (drainTimer) clearTimeout(drainTimer);
        this.writeWaiters.delete(id);
      };
      const finishOk = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const ok = child.stdin.write(line, (err) => {
        if (err) fail(err);
      });
      // write() true → the chunk was flushed/queued below the highWaterMark, so
      // proceed immediately. false → wait for 'drain', but never forever:
      //  - the child exiting/closing unblocks the chain (request rejected via
      //    handleChildDown), and
      //  - the owning request timing out settles this link (via writeWaiters),
      //    and
      //  - a backstop timeout catches a still-ALIVE child that silently stops
      //    draining: settle the link AND restart the child (its watch replays
      //    from the committed cursor, so no delivery is lost) so one wedged
      //    pipe can't stall every future write.
      if (ok) {
        finishOk();
      } else {
        onDrain = finishOk;
        onExit = finishOk;
        child.stdin.once("drain", onDrain);
        child.once("exit", onExit);
        child.once("close", onExit);
        this.writeWaiters.set(id, finishOk);
        drainTimer = setTimeout(() => {
          if (settled) return;
          log.warn({ drainWaitTimeoutMs: this.drainWaitTimeoutMs }, "imsg stdin never drained; restarting the rpc child");
          finishOk();
          if (this.child === child) {
            child.kill();
            this.handleChildDown(child, "stdin drain timeout");
          }
        }, this.drainWaitTimeoutMs);
        drainTimer.unref?.();
      }
    }));
    // Keep the chain from rejecting (which would poison every later write);
    // per-write failures are surfaced through the returned promise instead.
    const result = this.writeChain;
    this.writeChain = this.writeChain.catch(() => {});
    return result;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(line) as Record<string, unknown>;
      } catch {
        log.warn({ line: line.slice(0, 200) }, "imsg rpc emitted a non-JSON line");
        continue;
      }
      this.handleRpcPayload(payload);
    }
  }

  private handleRpcPayload(payload: Record<string, unknown>): void {
    // Response to one of our requests
    if (payload.id !== undefined && payload.id !== null) {
      const id = typeof payload.id === "number" ? payload.id : Number(payload.id);
      const req = this.pending.get(id);
      if (!req) return;
      this.pending.delete(id);
      clearTimeout(req.timer);
      // A response proves the child consumed the request line, so a write
      // link still parked on 'drain' for it can settle now instead of waiting
      // out the drain backstop (which would needlessly restart a healthy,
      // answering child).
      this.writeWaiters.get(id)?.();
      if (payload.error) {
        // `data` is free-form in JSON-RPC: imsg sends a string for most
        // refusals but an OBJECT for some (e.g. -32004 "Mutation lane
        // blocked"), which used to be interpolated as "[object Object]".
        const error = payload.error as { code?: number; message?: string; data?: unknown };
        // A STRING `data` is the human refusal text and stays in the message,
        // verbatim and unclipped, exactly as before: callers match refusal
        // phrases in it (isStickerStagingRefusal). A STRUCTURED payload is
        // diagnostic, not prose — it is kept out of the message (which can be
        // shown, e.g. as a send_message tool error) and travels as `rpcData`,
        // which the log serializer writes as a field.
        const detail = typeof error.data === "string" && error.data !== "" ? `: ${error.data}` : "";
        // Typed rejection: an error RESPONSE proves the child processed and
        // refused the request (nothing was sent) — callers with a fallback
        // send key on this to avoid double-delivering after ambiguous
        // failures (timeout/child-death), which reject as plain Errors.
        const head = `imsg rpc ${req.method} failed (${error.code ?? "?"}) ${typeof error.message === "string" ? error.message : shortErrorMessage(error.message ?? "error")}`;
        req.reject(new ImsgRpcResponseError(`${head}${detail}`, { code: error.code, data: error.data, publicMessage: head }));
      } else {
        req.resolve((payload.result ?? {}) as Record<string, unknown>);
      }
      return;
    }

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
      const child = this.child;
      if (child) {
        child.kill();
        // Schedule the restart ourselves: handleChildDown nulls this.child,
        // so the child's own late "exit" event is ignored as stale.
        this.handleChildDown(child, "watch stream error");
      }
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
    const child = this.child;
    if (child) {
      child.kill();
      this.handleChildDown(child, "dispatch gap recovery");
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
