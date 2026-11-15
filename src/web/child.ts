import { WebData, type WebDataOptions } from "./data.js";
import { sweepUploads, uploadsDir } from "./uploads.js";
import { startWebHttp } from "./http.js";
import { macScreenSource, ScreenLoop } from "./screen.js";
import { USAGE_RPC_TIMEOUT_MS, WebError, type EventEnvelope, type Rpc } from "./protocol.js";
import { loadWebToken, writeWebAccessLinks } from "./token-store.js";

interface Init { type: "init"; options: WebDataOptions & { port: number; assetsDir: string; tomoHome: string; externalOrigin?: string; uploadsEnabled?: boolean } }
type Message = Init | { type: "ping" } | { type: "event"; value: EventEnvelope }
  | { type: "result"; id: number; value?: unknown; error?: { status: number; code: string } };
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
const subscribers = new Set<(event: EventEnvelope) => void>();
let sequence = 0;
let initialized = false;
let service: Awaited<ReturnType<typeof startWebHttp>> | undefined;

function send(value: unknown) {
  if (!process.connected) throw new WebError(503, "daemon_disconnected");
  process.send!(value as object, (error: Error | null) => { if (error) process.exit(1); });
}

process.on("message", (value: Message) => {
  if (value.type === "ping") { send({ type: "pong" }); return; }
  if (value.type === "event") {
    for (const subscriber of subscribers) {
      try { subscriber(value.value); } catch { /* Per-client isolation. */ }
    }
    return;
  }
  if (value.type === "result") {
    const item = pending.get(value.id);
    if (!item) return;
    pending.delete(value.id);
    clearTimeout(item.timer);
    if (value.error) item.reject(new WebError(value.error.status, value.error.code));
    else item.resolve(value.value);
    return;
  }
  if (value.type !== "init" || initialized) return;
  initialized = true;
  let accessToken: string;
  void Promise.resolve().then(() => {
    accessToken = loadWebToken(value.options.tomoHome, () => send({ type: "token_created" }));
    // Uploads never sent expire; sweep at start and every few minutes (also on each upload).
    sweepUploads(uploadsDir(value.options.tomoHome));
    setInterval(() => sweepUploads(uploadsDir(value.options.tomoHome)), 5 * 60_000).unref();
    return startWebHttp(value.options.port, {
    accessToken,
    externalOrigin: value.options.externalOrigin,
    data: new WebData(value.options),
    ...(value.options.uploadsEnabled !== false ? { uploadsDir: uploadsDir(value.options.tomoHome) } : {}),
    // Captured here, in the web process, so frames never cross the daemon IPC
    // and the daemon thread does no image work. Same user and GUI session as
    // the daemon (this process is its child), so the same Screen Recording grant.
    ...(process.platform === "darwin" ? { screen: new ScreenLoop(macScreenSource()) } : {}),
    assetsDir: value.options.assetsDir,
    subscribe(fn) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
    rpc(input: Rpc) {
      if (pending.size >= 32) return Promise.reject(new WebError(429, "rpc_limit"));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        // Usage may wait on the claude.ai endpoint; the daemon answers it within
        // its own deadline, and this stays under the HTTP socket timeout.
        const timer = setTimeout(() => { pending.delete(id); reject(new WebError(503, "daemon_timeout")); }, input.method === "usage" ? USAGE_RPC_TIMEOUT_MS : 5_000);
        pending.set(id, { resolve, reject, timer });
        try { send({ type: "rpc", id, input }); }
        catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
      });
    },
    });
  }).then((result) => {
    service = result;
    const origins = [`http://127.0.0.1:${result.port}`, ...(value.options.externalOrigin ? [value.options.externalOrigin] : [])];
    writeWebAccessLinks(value.options.tomoHome, origins.map((origin) => `${origin}/?t=${accessToken}`));
    send({ type: "ready", port: result.port, accessToken });
  })
    .catch((err: unknown) => {
      // Only an enumerated error crosses the process boundary, never a path,
      // request body, transcript, config value, or arbitrary exception text.
      send({ type: "failed", reason: (err as NodeJS.ErrnoException).code === "EADDRINUSE" ? "port_in_use" : "startup_failed" });
      process.exit(1);
    });
});
process.on("disconnect", () => { void service?.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 250).unref(); });
process.on("SIGTERM", () => { void service?.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 250).unref(); });
process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));
