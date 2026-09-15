import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { WebData } from "./data.js";
import { checkRequest, CsrfTokens, securityHeaders } from "./security.js";
import { MAX_BODY_BYTES, MAX_BUFFER_BYTES, messageInputSchema, WebError,
  type EventEnvelope, type Rpc, type WebRequest, type WebSync } from "./protocol.js";

export interface HttpDependencies {
  data: WebData;
  assetsDir: string;
  rpc(value: Rpc): Promise<unknown>;
  subscribe(fn: (event: EventEnvelope) => void): () => void;
}

export async function startWebHttp(port: number, deps: HttpDependencies) {
  const csrf = new CsrfTokens();
  const streams = new Set<ServerResponse>();
  let active = 0;
  let boundPort = port;
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 10_000 }, (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      const err = error instanceof WebError ? error : new WebError(503, "service_unavailable");
      json(res, err.status, { error: err.code });
      req.resume();
    });
  });
  server.maxConnections = 64;
  server.headersTimeout = 10_000;
  server.setTimeout(30_000);
  server.on("timeout", (socket) => socket.destroy());
  // Bad header syntax is never allowed to escape as a process error.
  server.on("clientError", (_err, socket) => socket.destroy());

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const api = req.url?.startsWith("/api/") ?? false;
    checkRequest(req, boundPort, api);
    const url = new URL(req.url!, `http://127.0.0.1:${boundPort}`);
    if (url.pathname === "/api/v1/events" && req.method === "GET") {
      await events(url, req, res);
      return;
    }
    if (active >= 8) throw new WebError(429, "request_limit");
    active++;
    try {
      if (!api) {
        if (req.method !== "GET") throw new WebError(405, "method_not_allowed");
        await asset(url.pathname, res);
        return;
      }
      if (req.method === "GET") {
        if (url.pathname === "/api/v1/bootstrap") {
          const csrfToken = csrf.bootstrap(req, res);
          const { sessions, ownerId, setupRequired } = deps.data.catalog();
          const { snapshot } = await deps.rpc({ method: "snapshot" }) as WebSync;
          json(res, 200, { sessions, ownerId, setupRequired, ...snapshot, csrfToken });
          return;
        }
        if (url.pathname === "/api/v1/sessions") {
          const { sessions, ownerId, setupRequired } = deps.data.catalog();
          json(res, 200, { sessions, ownerId, setupRequired });
          return;
        }
        const history = /^\/api\/v1\/sessions\/([A-Za-z0-9_-]{43})\/messages$/.exec(url.pathname);
        if (history) {
          json(res, 200, await deps.data.history(history[1], url.searchParams.get("cursor") ?? undefined));
          return;
        }
        const request = /^\/api\/v1\/messages\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (request) {
          const value = await deps.rpc({ method: "request", requestId: request[1] }) as WebRequest;
          json(res, 200, value.state === "unknown" ? await deps.data.recordedRequest(request[1]) : value);
          return;
        }
      } else if (req.method === "POST" && url.pathname === "/api/v1/messages") {
        csrf.verify(req);
        const parsed = messageInputSchema.safeParse(await body(req));
        if (!parsed.success) throw new WebError(400, "invalid_message");
        const { ownerId } = deps.data.catalog();
        if (!ownerId) throw new WebError(409, "owner_setup_required");
        if (parsed.data.targetId !== undefined && parsed.data.targetId !== ownerId) throw new WebError(403, "owner_dm_only");
        const epoch = req.headers["x-tomo-epoch"];
        if (typeof epoch !== "string" || !/^[a-f0-9-]{36}$/.test(epoch)) throw new WebError(409, "epoch_required");
        json(res, 202, await deps.rpc({ method: "message", input: parsed.data, epoch }));
        return;
      }
      throw new WebError(404, "not_found");
    } finally { active--; }
  }

  async function events(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (streams.size >= 16) throw new WebError(429, "stream_limit");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (cursor && cursor.length > 128) throw new WebError(400, "invalid_cursor");
    streams.add(res);
    let pending: EventEnvelope[] | undefined = [];
    let pendingBytes = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const write = (name: string, data: unknown, id?: string) => {
      if (res.destroyed) return;
      const frame = `${id ? `id: ${id}\n` : ""}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      if (res.writableLength + Buffer.byteLength(frame) > MAX_BUFFER_BYTES) { res.destroy(); return; }
      res.write(frame);
    };
    // Subscribe before asking for the daemon watermark: RPC and activity
    // share an ordered IPC connection. Only events beyond that watermark
    // survive the buffer, so snapshot/replay never races live delivery.
    const unsubscribe = deps.subscribe((event) => {
      if (pending) {
        pendingBytes += Buffer.byteLength(JSON.stringify(event));
        if (pendingBytes > MAX_BUFFER_BYTES) { res.destroy(); return; }
        pending.push(event);
      } else write("update", event.event, event.id);
    });
    const cleanup = () => { unsubscribe(); streams.delete(res); clearInterval(heartbeat); };
    res.once("close", cleanup);
    try {
      const sync = await deps.rpc({ method: "snapshot", cursor }) as WebSync;
      if (res.destroyed) return;
      req.socket.setTimeout(0);
      res.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
      res.flushHeaders();
      for (const item of sync.replay ?? []) write("update", item.event, item.id);
      write("snapshot", { ...sync.snapshot, resync: sync.replay === null }, sync.snapshot.cursor);
      const watermark = Number(sync.snapshot.cursor.split(":")[1]);
      for (const item of pending) {
        const [epoch, sequence] = item.id.split(":");
        if (epoch === sync.snapshot.epoch && Number(sequence) > watermark) write("update", item.event, item.id);
      }
      pending = undefined;
      heartbeat = setInterval(() => {
        if (res.writableLength > 0) res.destroy();
        else res.write(": heartbeat\n\n");
      }, 15_000);
      heartbeat.unref();
    } catch (error) { cleanup(); throw error; }
  }

  async function asset(path: string, res: ServerResponse): Promise<void> {
    const relative = path === "/" ? "index.html" : /^\/assets\/[A-Za-z0-9_-]+\.(js|css|woff2)$/.test(path) ? path.slice(1) : null;
    if (!relative) throw new WebError(404, "not_found");
    const root = await realpath(deps.assetsDir);
    const candidate = resolve(root, relative);
    const canonical = await realpath(candidate);
    if (canonical !== candidate || !canonical.startsWith(root + sep)) throw new WebError(404, "not_found");
    const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BUFFER_BYTES) throw new WebError(404, "not_found");
      const bytes = await file.readFile();
      const ext = relative.split(".").pop()!;
      res.writeHead(200, { "content-type": ({ html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
        css: "text/css; charset=utf-8", woff2: "font/woff2" } as Record<string, string>)[ext] });
      res.end(bytes);
    } finally { await file.close(); }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  // Keep runtime listener errors local even after the startup promise settles.
  server.on("error", () => { for (const stream of streams) stream.destroy(); });
  boundPort = (server.address() as { port: number }).port;
  return { port: boundPort, async close() {
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_BUFFER_BYTES) throw new WebError(413, "response_too_large");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw new WebError(413, "body_too_large");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new WebError(413, "body_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WebError(400, "invalid_json"); }
}
