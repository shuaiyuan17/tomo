import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { markDefiniteFailure } from "./types.js";
import { shortErrorMessage } from "../error-text.js";
import { log } from "../logger.js";

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
// Cap on in-flight RPC requests. Past this the pending map is treated as a
// symptom of a stuck child; new requests fail fast instead of piling up.
const MAX_PENDING_REQUESTS = 256;

/**
 * The imsg child answered the RPC with an error. Definite by construction: the
 * request was processed and refused, so nothing was sent — which is what lets
 * the channel fall back to a plain send on a refusal, and what lets the
 * delivery pipeline re-send a caption whose picture was refused. A timeout or
 * a dead child is a plain Error and stays ambiguous.
 *
 * Also used, with no `rpcCode`, for a request that was never written to any
 * child (see {@link notSentError}): equally certain that nothing went out.
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

/** A request that never reached a child: certainly not sent. */
export function notSentError(method: string, why: string): ImsgRpcResponseError {
  const message = `imsg rpc ${method} not sent: ${why}`;
  return new ImsgRpcResponseError(message, { publicMessage: message });
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface ImsgRpcConnectionEvents {
  /** A notification (a payload without an id) from the child. */
  onNotification(payload: Record<string, unknown>): void;
  /**
   * The child went away on its own (exit, spawn error, a wedged stdin).
   * Pending requests are already rejected. Not called after {@link kill}.
   */
  onDown(reason: string): void;
}

/**
 * One `imsg rpc` child and its JSON-RPC transport over stdio (newline-
 * delimited JSON): request/response matching, backpressure-aware serialized
 * writes, and the child's lifetime. Owned by {@link ImsgRpcClient}, which runs
 * one for the watch stream and one for mutations.
 */
export class ImsgRpcConnection {
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  // Settles a request's parked-on-'drain' write link, keyed by request id, so a
  // request timeout/cancel can release its own stuck write (else future writes
  // queue behind a forever-pending drain-wait).
  private writeWaiters = new Map<number, () => void>();
  // Serializes stdin writes so we can honor backpressure (await 'drain' when
  // write() returns false) instead of unboundedly buffering in the pipe.
  private writeChain: Promise<void> = Promise.resolve();
  /** Requests written and not yet settled (a lane restart waits for them). */
  private readonly inFlight = new Set<Promise<unknown>>();
  private down = false;
  readonly spawnedAt = Date.now();

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly drainWaitTimeoutMs: number,
    private readonly events: ImsgRpcConnectionEvents,
  ) {
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      // Drop late/buffered stdout from a child we already gave up on: a
      // straggler line from a dead child must not be parsed and dispatched
      // after its replacement took over.
      if (this.down) return;
      this.handleStdout(chunk);
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line) log.debug({ imsg: line }, "imsg rpc stderr");
    });
    // EVERY PIPE NEEDS AN 'error' LISTENER. A pipe to a dead child emits
    // 'error' (EPIPE/ERR_STREAM_DESTROYED/ECONNRESET), and an 'error' with no
    // listener on a stream is an uncaughtException — which, since the daemon
    // installs process-level handlers, logs and exits 1. The race is ordinary:
    // a child torn down while a read receipt or a typing tick is mid-write.
    // Nothing to recover here: the write callback fails the owning request,
    // and the exit path rejects everything still pending, so these listeners
    // exist purely to keep the emitters handled.
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
      // No pid: the process never started, so nothing written to it can have
      // gone out. The reason ends up in the message of every pending request
      // it rejects, so the short form; the full error is in the line above.
      this.goDown(`spawn error: ${shortErrorMessage(err)}`, child.pid === undefined);
    });
    child.on("exit", (code, signal) => {
      this.goDown(`exited with code ${code} signal ${signal}`, false);
    });
  }

  /** False once the child exited, failed, or was killed. */
  get alive(): boolean {
    return !this.down;
  }

  /** The requests written to this child and not yet settled. */
  inFlightRequests(): Promise<unknown>[] {
    return [...this.inFlight];
  }

  /** Kill the child; pending requests are rejected with `reason`. No onDown. */
  kill(reason: string): void {
    if (this.down) return;
    this.down = true;
    this.rejectAllPending(reason, false);
    this.child.kill();
  }

  private goDown(reason: string, neverStarted: boolean): void {
    if (this.down) return;
    this.down = true;
    this.rejectAllPending(reason, neverStarted);
    this.events.onDown(reason);
  }

  /** Reject every in-flight request (the child can no longer answer them). */
  private rejectAllPending(reason: string, neverStarted: boolean): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const req of pending) {
      clearTimeout(req.timer);
      req.reject(neverStarted
        ? notSentError(req.method, `the imsg rpc child never started (${reason})`)
        : new Error(`imsg rpc child ${reason} while awaiting ${req.method}`));
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const child = this.child;
    if (this.down || !child.stdin.writable) {
      return Promise.reject(notSentError(method, "the imsg rpc child is not running"));
    }
    // Bound the in-flight set. A pending map this large means the child has
    // stopped answering (or draining); fail fast rather than buffer unboundedly.
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error(`imsg rpc pending queue full (${MAX_PENDING_REQUESTS}); dropping ${method}`));
    }
    const id = this.nextRequestId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

    const sent = new Promise<Record<string, unknown>>((resolve, reject) => {
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
      this.enqueueWrite(line, id).catch((err: Error) => {
        const req = this.pending.get(id);
        if (req) {
          this.pending.delete(id);
          clearTimeout(req.timer);
          log.warn({ err, method }, "imsg rpc write failed");
          reject(err instanceof ImsgRpcResponseError
            ? err
            : new Error(`imsg rpc write failed for ${method}: ${shortErrorMessage(err)}`, { cause: err }));
        }
      });
    });
    this.inFlight.add(sent);
    const done = () => { this.inFlight.delete(sent); };
    sent.then(done, done);
    return sent;
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
  private enqueueWrite(line: string, id: number): Promise<void> {
    const child = this.child;
    this.writeChain = this.writeChain.then(() => new Promise<void>((resolve, reject) => {
      const req = this.pending.get(id);
      if (!req) {
        // Request already settled (timeout/reject); do not execute its write.
        resolve();
        return;
      }
      if (!child.stdin.writable) {
        // Nothing written: certainly not sent.
        reject(notSentError(req.method, "stdin is not writable"));
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
      //    the exit path), and
      //  - the owning request timing out settles this link (via writeWaiters),
      //    and
      //  - a backstop timeout catches a still-ALIVE child that silently stops
      //    draining: settle the link AND take the child down (the owner
      //    restarts it; the watch replays from the committed cursor) so one
      //    wedged pipe can't stall every future write.
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
          if (!this.down) {
            child.kill();
            this.goDown("stdin drain timeout", false);
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
      if (payload.id !== undefined && payload.id !== null) {
        this.handleResponse(payload);
      } else {
        this.events.onNotification(payload);
      }
      // A notification handler may have killed this child (watch stream
      // error, gap recovery): stop parsing its buffered output.
      if (this.down) break;
    }
  }

  private handleResponse(payload: Record<string, unknown>): void {
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
  }
}
