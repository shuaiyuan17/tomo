import { dispatchWebRestart } from "./restart.js";
import type { McpConnection } from "../mcp/live-status.js";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WebChannel, WebLifecycle } from "../channels/web.js";
import type { WebDataOptions } from "./data.js";
import { MAX_BUFFER_BYTES, rpcSchema, WebError } from "./protocol.js";
import { validAccessToken } from "./access.js";

export interface WebSupervisorOptions extends WebDataOptions {
  tomoHome: string;
  externalOrigin?: string;
  port: number;
  assetsDir?: string;
  mcpStatus?: () => Promise<Array<{ key: string; connections: McpConnection[] | null }>>;
  diagnostic?: (message: string) => void;
}
/** Internal timing/entry overrides allow real-process failure tests without
 * exposing executable paths or arbitrary process options in web config. */
export interface SupervisorRuntime { childPath?: string; startupMs?: number; heartbeatMs?: number; maxRestarts?: number; restart?: typeof dispatchWebRestart }

export class WebSupervisor implements WebLifecycle {
  private child?: ChildProcess;
  private stopping = false;
  private restarts = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private boundPort: number | null = null;
  private starting?: Promise<void>;
  private restartPending = false;

  constructor(private readonly channel: WebChannel, private readonly options: WebSupervisorOptions,
    private readonly runtime: SupervisorRuntime = {}) {}

  status() { return { port: this.boundPort, pid: this.child?.pid ?? null, restarts: this.restarts }; }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child && !this.stopping) return Promise.resolve();
    this.stopping = false;
    this.restarts = 0;
    this.starting = this.launch().catch(() => { this.report("Web UI unavailable; messaging channels remain active."); })
      .finally(() => { this.starting = undefined; });
    return this.starting;
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
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
  private report(message: string): void { try { this.options.diagnostic?.(message); } catch { /* logging is optional */ } }

  private launch(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const compiled = fileURLToPath(new URL("./child.js", import.meta.url));
    const entry = this.runtime.childPath ?? (existsSync(compiled) ? compiled : fileURLToPath(new URL("./child.ts", import.meta.url)));
    const child = fork(entry, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: ["--max-old-space-size=256", ...(entry.endsWith(".ts") ? ["--import", "tsx"] : [])],
      // Do not give the HTTP process bot tokens, API keys, SDK hooks, or the
      // live daemon log destination through its inherited environment.
      env: { PATH: process.env.PATH, LANG: process.env.LANG, TZ: process.env.TZ, TOMO_LOG_INLINE: "1", TOMO_LOG_FILE: "" },
    });
    this.child = child;
    let ipcBytes = 0;
    let activeRpc = 0;
    let lastPong = Date.now();
    let permanent = false;
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
      if (Date.now() - lastPong > heartbeatMs * 5) child.kill("SIGKILL");
      else send({ type: "ping" });
    }, heartbeatMs);
    heartbeat.unref();

    return new Promise<void>((resolve) => {
      const settle = () => { if (finished) return; finished = true; clearTimeout(deadline); resolve(); };
      const deadline = setTimeout(() => { this.report("Web UI startup timed out."); child.kill("SIGKILL"); settle(); }, this.runtime.startupMs ?? 3_000);
      child.on("message", (raw: unknown) => {
        if (!raw || typeof raw !== "object" || this.child !== child) return;
        const value = raw as Record<string, unknown>;
        if (value.type === "pong") { lastPong = Date.now(); return; }
        if (value.type === "token_created") { this.report("Web access token created or replaced; use the new access link."); return; }
        if (value.type === "ready" && typeof value.port === "number" && validAccessToken(value.accessToken)) {
          this.boundPort = value.port;
          this.report(`Web UI: http://127.0.0.1:${value.port}/?t=${value.accessToken}`);
          if (this.options.externalOrigin) this.report(`Web UI via Tailscale Serve: ${this.options.externalOrigin}/?t=${value.accessToken}`);
          this.report("Open the private access link in the runtime home's web-access.log (0600).");
          settle();
          return;
        }
        if (value.type === "failed") {
          permanent = value.reason === "port_in_use";
          this.report(permanent ? "Web UI port is in use; choose another web.port and restart." : "Web UI could not start.");
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
          if (input.method === "epoch") return this.channel.events.epoch;
          if (input.method === "restart-status") return { epoch: this.channel.events.epoch, pending: this.restartPending };
          if (input.method === "snapshot") {
            const result = { snapshot: this.channel.snapshot(), replay: input.cursor ? this.channel.events.after(input.cursor) : null };
            // An overflowing replay is a gap, not a reason to kill a healthy
            // child. Leave room for the IPC envelope around the snapshot.
            if (Buffer.byteLength(JSON.stringify(result)) > MAX_BUFFER_BYTES - 1024) result.replay = null;
            return result;
          }
          if (input.method === "mcp-status") return (await this.options.mcpStatus?.() ?? []).flatMap((entry) => {
            const sessionId = this.channel.sessionId(entry.key); return sessionId ? [{ sessionId, connections: entry.connections }] : [];
          });
          if (input.method === "context-events") return this.channel.contextEvents(input.sessionId);
          if (input.method === "request") return this.channel.request(input.requestId);
          if (input.epoch !== this.channel.events.epoch) throw new WebError(409, "epoch_changed");
          if (input.method === "restart") {
            if (this.restartPending) throw new WebError(409, "restart_pending");
            this.restartPending = true;
            try {
              await (this.runtime.restart ?? dispatchWebRestart)(input.reason, (failed) => {
                this.restartPending = false;
                if (failed) this.report("Web-requested daemon restart failed; retry is available.");
              });
              return { restarting: true };
            }
            catch { this.restartPending = false; throw new WebError(503, "restart_failed"); }
          }
          return this.channel.receive(input.input);
        };
        void run().then((result) => send({ type: "result", id, value: result }), (err: unknown) => {
          if (err instanceof WebError) failure(err.status, err.code);
          else failure(503, "service_unavailable");
        }).finally(() => { activeRpc--; });
      });
      child.once("error", () => { this.report("Web UI process unavailable."); child.kill("SIGKILL"); settle(); });
      child.once("exit", () => {
        unsubscribe();
        clearInterval(heartbeat);
        settle();
        if (this.child === child) { this.child = undefined; this.boundPort = null; }
        if (this.stopping || permanent) return;
        if (this.restarts >= (this.runtime.maxRestarts ?? 3)) { this.report("Web UI stopped after repeated failures; messaging channels remain active."); return; }
        this.restarts++;
        this.timer = setTimeout(() => { void this.launch().catch(() => this.report("Web UI restart failed.")); }, 500 * 2 ** (this.restarts - 1));
        this.timer.unref();
      });
      const { sessionsDir, sdkSessionsDir, identities, ownerIdentity, port, tomoHome, externalOrigin, workspaceDir, runningConfig } = this.options;
      send({ type: "init", options: { sessionsDir, sdkSessionsDir, identities, ownerIdentity, port, tomoHome, externalOrigin, workspaceDir, runningConfig,
        assetsDir: this.options.assetsDir ?? fileURLToPath(new URL("../../dist/web-assets/", import.meta.url)) } });
    });
  }
}
