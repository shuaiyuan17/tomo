import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WebChannel, WebLifecycle } from "../channels/web.js";
import type { WebDataOptions } from "./data.js";
import { MAX_BUFFER_BYTES, rpcSchema, WebError } from "./protocol.js";
import { validAccessToken } from "./access.js";
import { writeWebStatus, type WebState, type WebStatusRecord } from "./status-file.js";

export type DiagnosticLevel = "info" | "warn" | "error";

export interface WebSupervisorOptions extends WebDataOptions {
  tomoHome: string;
  externalOrigin?: string;
  port: number;
  assetsDir?: string;
  diagnostic?: (message: string, level?: DiagnosticLevel) => void;
}
/** Internal timing/entry overrides allow real-process failure tests without
 * exposing executable paths or arbitrary process options in web config.
 * `maxRestarts` caps attempts for tests only; production retries forever. */
export interface SupervisorRuntime {
  childPath?: string; startupMs?: number; heartbeatMs?: number; maxRestarts?: number;
  baseBackoffMs?: number; maxBackoffMs?: number; healthyResetMs?: number;
}

/** First retry delay; doubles per consecutive failure up to MAX_BACKOFF_MS. */
export const BASE_BACKOFF_MS = 500;
/** The web UI is never abandoned: a broken child is retried at least this often. */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;
/** A child that has stayed up this long clears the consecutive-failure count. */
export const HEALTHY_RESET_MS = 5 * 60 * 1000;
/** Consecutive failures after which the supervisor reports, at error level, that
 *  it is backing off. Below this a crash is restarted quietly (warn). */
export const BACKOFF_ALERT_AFTER = 3;

export class WebSupervisor implements WebLifecycle {
  private child?: ChildProcess;
  private stopping = false;
  /** Consecutive failed starts/crashes; cleared after HEALTHY_RESET_MS of health. */
  private restarts = 0;
  private state: WebState = "stopped";
  private nextRetryAt: number | null = null;
  private lastError: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private healthyTimer?: ReturnType<typeof setTimeout>;
  private portInUseReported = false;
  private unsubscribe?: () => void;
  private boundPort: number | null = null;
  private starting?: Promise<void>;

  constructor(private readonly channel: WebChannel, private readonly options: WebSupervisorOptions,
    private readonly runtime: SupervisorRuntime = {}) {}

  status(): Omit<WebStatusRecord, "daemonPid" | "updatedAt"> {
    return {
      state: this.state, port: this.boundPort, targetPort: this.options.port, pid: this.child?.pid ?? null, restarts: this.restarts,
      nextRetryAt: this.nextRetryAt, lastError: this.lastError,
    };
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child && !this.stopping) return Promise.resolve();
    this.stopping = false;
    // A restart pending from an earlier failure would launch a second child
    // next to the one started here.
    clearTimeout(this.timer);
    this.nextRetryAt = null;
    this.restarts = 0;
    this.lastError = null;
    this.portInUseReported = false;
    this.starting = this.launch().catch(() => { this.report("Web UI unavailable; messaging channels remain active."); })
      .finally(() => { this.starting = undefined; });
    return this.starting;
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    clearTimeout(this.healthyTimer);
    this.nextRetryAt = null;
    this.setState("stopped");
    this.unsubscribe?.();
    const child = this.child;
    this.child = undefined;
    this.boundPort = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 500);
      child.once("exit", () => { clearTimeout(kill); resolve(); });
      child.kill("SIGTERM");
    });
  }
  private report(message: string, level: DiagnosticLevel = "info"): void {
    try { this.options.diagnostic?.(message, level); } catch { /* logging is optional */ }
  }

  /** Publish the state for `tomo status` (best effort: it must not affect the UI). */
  private setState(state: WebState): void {
    this.state = state;
    try {
      writeWebStatus(this.options.tomoHome, { ...this.status(), daemonPid: process.pid, updatedAt: Date.now() });
    } catch { /* status reporting is optional */ }
  }

  /** Note why this attempt failed; the exit handler decides what happens next. */
  private fail(reason: string): void { this.lastError = reason; }

  /**
   * Schedule the next start after a failure. Never gives up: the delay doubles
   * per consecutive failure and is capped at MAX_BACKOFF_MS, so a child that
   * missed its startup deadline under heavy load comes back once the load is
   * gone instead of staying dead until the daemon restarts.
   */
  private scheduleRestart(): void {
    const cap = this.runtime.maxRestarts;
    if (cap !== undefined && this.restarts >= cap) {
      this.nextRetryAt = null;
      this.setState("failed");
      this.report("Web UI stopped after repeated failures; messaging channels remain active.", "error");
      return;
    }
    this.restarts++;
    const base = this.runtime.baseBackoffMs ?? BASE_BACKOFF_MS;
    const max = this.runtime.maxBackoffMs ?? MAX_BACKOFF_MS;
    const delay = Math.min(base * 2 ** (this.restarts - 1), max);
    this.nextRetryAt = Date.now() + delay;
    this.setState("backoff");
    const why = this.lastError ? ` Last failure: ${this.lastError}.` : "";
    const message = `Web UI down after ${this.restarts} consecutive failed start(s); retrying in ${formatDelay(delay)} (capped at ${formatDelay(max)}).${why}`;
    // Error level once, when quick restarts have stopped working; warn after
    // that so a long outage is visible without an error line every retry.
    this.report(message, this.restarts === BACKOFF_ALERT_AFTER ? "error" : "warn");
    this.timer = setTimeout(() => {
      this.nextRetryAt = null;
      if (this.stopping || this.child) return;
      void this.launch().catch(() => this.report("Web UI restart failed.", "warn"));
    }, delay);
    this.timer.unref();
  }

  private launch(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.setState("starting");
    const compiled = fileURLToPath(new URL("./child.js", import.meta.url));
    const entry = this.runtime.childPath ?? (existsSync(compiled) ? compiled : fileURLToPath(new URL("./child.ts", import.meta.url)));
    let child: ChildProcess;
    try {
      child = fork(entry, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: ["--max-old-space-size=256", ...(entry.endsWith(".ts") ? ["--import", "tsx"] : [])],
        // Do not give the HTTP process bot tokens, API keys, SDK hooks, or the
        // live daemon log destination through its inherited environment.
        env: { PATH: process.env.PATH, LANG: process.env.LANG, TZ: process.env.TZ, TOMO_LOG_INLINE: "1", TOMO_LOG_FILE: "" },
      });
    } catch {
      // fork() can throw synchronously (EAGAIN under process pressure). That
      // is one more failed start, not a reason to stop retrying.
      this.fail("could not spawn the web process");
      this.scheduleRestart();
      return Promise.resolve();
    }
    this.child = child;
    let ipcBytes = 0;
    let activeRpc = 0;
    let lastPong = Date.now();
    let finished = false;
    const heartbeatMs = this.runtime.heartbeatMs ?? 1_000;
    const send = (value: object): void => {
      if (this.child !== child || !child.connected) return;
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (ipcBytes + bytes > MAX_BUFFER_BYTES) { child.kill("SIGKILL"); return; }
      ipcBytes += bytes;
      try { child.send(value, (err) => { ipcBytes -= bytes; if (err) child.kill("SIGKILL"); }); }
      catch { ipcBytes -= bytes; child.kill("SIGKILL"); }
    };
    this.unsubscribe?.();
    const unsubscribe = this.channel.events.subscribe((value) => send({ type: "event", value }));
    this.unsubscribe = unsubscribe;
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > heartbeatMs * 5) { this.fail("heartbeat missed"); child.kill("SIGKILL"); }
      else send({ type: "ping" });
    }, heartbeatMs);
    heartbeat.unref();

    return new Promise<void>((resolve) => {
      const settle = () => { if (finished) return; finished = true; clearTimeout(deadline); resolve(); };
      const deadline = setTimeout(() => { this.fail("startup timed out"); this.report("Web UI startup timed out.", "warn"); child.kill("SIGKILL"); settle(); }, this.runtime.startupMs ?? 3_000);
      child.on("message", (raw: unknown) => {
        if (!raw || typeof raw !== "object" || this.child !== child) return;
        const value = raw as Record<string, unknown>;
        if (value.type === "pong") { lastPong = Date.now(); return; }
        if (value.type === "token_created") { this.report("Web access token created or replaced; use the new access link."); return; }
        if (value.type === "ready" && typeof value.port === "number" && validAccessToken(value.accessToken)) {
          this.boundPort = value.port;
          const recovered = this.restarts;
          this.lastError = null;
          this.portInUseReported = false;
          this.setState("running");
          if (recovered >= BACKOFF_ALERT_AFTER) this.report(`Web UI recovered after ${recovered} consecutive failed start(s).`);
          // Consecutive failures are forgotten only after a period of health,
          // so a child that crashes right after "ready" still backs off.
          clearTimeout(this.healthyTimer);
          this.healthyTimer = setTimeout(() => {
            if (this.child === child && !this.stopping) { this.restarts = 0; this.setState("running"); }
          }, this.runtime.healthyResetMs ?? HEALTHY_RESET_MS);
          this.healthyTimer.unref();
          this.report(`Web UI: http://127.0.0.1:${value.port}/?t=${value.accessToken}`);
          if (this.options.externalOrigin) this.report(`Web UI via Tailscale Serve: ${this.options.externalOrigin}/?t=${value.accessToken}`);
          this.report("Open the private access link in the runtime home's web-access.log (0600).");
          settle();
          return;
        }
        if (value.type === "failed") {
          const portInUse = value.reason === "port_in_use";
          this.fail(portInUse ? "port in use" : "child reported a startup failure");
          // A busy port is retried too (whatever holds it may go away), but
          // it is reported at error level straight away: it usually needs a
          // config change.
          // Error level once per outage, not on every capped retry.
          this.report(portInUse ? "Web UI port is in use; choose another web.port and restart." : "Web UI could not start.",
            portInUse && !this.portInUseReported ? "error" : "warn");
          if (portInUse) this.portInUseReported = true;
          settle();
          return;
        }
        if (value.type !== "rpc" || !Number.isSafeInteger(value.id)) return;
        const id = value.id as number;
        const parsed = rpcSchema.safeParse(value.input);
        const failure = (status: number, code: string) => send({ type: "result", id, error: { status, code } });
        if (!parsed.success) { failure(400, "invalid_rpc"); return; }
        if (activeRpc >= 32) { failure(429, "rpc_limit"); return; }
        activeRpc++;
        const run = async () => {
          const input = parsed.data;
          if (input.method === "snapshot") {
            const result = { snapshot: this.channel.snapshot(), replay: input.cursor ? this.channel.events.after(input.cursor) : null };
            // An overflowing replay is a gap, not a reason to kill a healthy
            // child. Leave room for the IPC envelope around the snapshot.
            if (Buffer.byteLength(JSON.stringify(result)) > MAX_BUFFER_BYTES - 1024) result.replay = null;
            return result;
          }
          if (input.method === "request") return this.channel.request(input.requestId);
          if (input.method === "task") return this.channel.task(input.sessionId, input.taskId, input.output);
          if (input.method === "usage") return this.channel.usage(input.refresh);
          if (input.epoch !== this.channel.events.epoch) throw new WebError(409, "epoch_changed");
          return this.channel.receive(input.input);
        };
        void run().then((result) => send({ type: "result", id, value: result }), (err: unknown) => {
          if (err instanceof WebError) failure(err.status, err.code);
          else failure(503, "service_unavailable");
        }).finally(() => { activeRpc--; });
      });
      // Runs once per child, from "exit" or from a spawn failure — after which
      // Node does not promise an "exit" event at all.
      let gone = false;
      const onGone = () => {
        if (gone) return;
        gone = true;
        unsubscribe();
        clearInterval(heartbeat);
        settle();
        if (this.child !== child) return;
        this.child = undefined; this.boundPort = null;
        clearTimeout(this.healthyTimer);
        if (this.stopping) return;
        if (!this.lastError) this.fail("process exited");
        this.scheduleRestart();
      };
      child.once("error", () => {
        this.fail("process unavailable");
        this.report("Web UI process unavailable.", "warn");
        // No pid: the spawn itself failed and no "exit" will follow.
        if (child.pid === undefined) onGone();
        else child.kill("SIGKILL");
        settle();
      });
      child.once("exit", onGone);
      const { sessionsDir, sdkSessionsDir, owner, port, tomoHome, externalOrigin } = this.options;
      send({ type: "init", options: { sessionsDir, sdkSessionsDir, owner, port, tomoHome, externalOrigin,
        assetsDir: this.options.assetsDir ?? fileURLToPath(new URL("../../dist/web-assets/", import.meta.url)) } });
    });
  }
}

function formatDelay(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
