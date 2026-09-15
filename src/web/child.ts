import { WebData, type WebDataOptions } from "./data.js";
import { startWebHttp } from "./http.js";
import { WebError, type EventEnvelope, type Rpc } from "./protocol.js";

interface Init { type: "init"; options: WebDataOptions & { port: number; assetsDir: string } }
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
  void startWebHttp(value.options.port, {
    data: new WebData(value.options),
    assetsDir: value.options.assetsDir,
    subscribe(fn) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
    rpc(input: Rpc) {
      if (pending.size >= 32) return Promise.reject(new WebError(429, "rpc_limit"));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new WebError(503, "daemon_timeout")); }, 5_000);
        pending.set(id, { resolve, reject, timer });
        try { send({ type: "rpc", id, input }); }
        catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
      });
    },
  }).then((result) => { service = result; send({ type: "ready", port: result.port }); })
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
