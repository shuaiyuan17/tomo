import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { convertUpload, discardUpload, MAX_UPLOAD_BYTES, stageUpload, UploadError } from "./uploads.js";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { WebData } from "./data.js";
import { SCREEN_RATES, type ScreenLoop, type ScreenRate } from "./screen.js";
import { MemoryReadError } from "../workspace/memory-reader.js";
import { checkRequest, CsrfTokens, securityHeaders } from "./security.js";
import { WebAccess } from "./access.js";
import { webConfigSchema } from "./config.js";
import { cronChangeSchema, MAX_BODY_BYTES, MAX_BUFFER_BYTES, messageInputSchema, modelChangeSchema, WebError,
  type EventEnvelope, type Rpc, type WebCompaction, type WebMcpLiveSession, type WebRequest, type WebSync, type WebTaskAccess, type WebUsage } from "./protocol.js";

/**
 * App icons and the web manifest, served like the bundle: public, no cookie.
 * Browsers fetch them without our headers or credentials (a favicon or
 * manifest request never carries the CSRF header), and they reveal nothing.
 */
const ICON_FILES = new Set(["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"]);

export interface HttpDependencies {
  accessToken: string;
  externalOrigin?: string;
  now?: () => number;
  data: WebData;
  assetsDir: string;
  rpc(value: Rpc): Promise<unknown>;
  subscribe(fn: (event: EventEnvelope) => void): () => void;
  /** The shared desktop capture loop; absent where the screen cannot be captured. */
  screen?: ScreenLoop;
  /** Where image uploads wait to be sent (uploads.ts); absent: uploads are unavailable. */
  uploadsDir?: string;
}

/** Idle socket timeout; every RPC deadline (e.g. USAGE_RPC_TIMEOUT_MS) stays under it. */
export const SOCKET_TIMEOUT_MS = 30_000;

export async function startWebHttp(port: number, deps: HttpDependencies) {
  const csrf = new CsrfTokens(deps.now);
  const access = new WebAccess(deps.accessToken, deps.now);
  const externalOrigin = webConfigSchema.shape.externalOrigin.parse(deps.externalOrigin);
  const streams = new Set<ServerResponse>();
  const screenStreams = new Set<ServerResponse>();
  let active = 0;
  let inspecting = false;
  let boundPort = port;
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 10_000 }, (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      const err = error instanceof WebError ? error : error instanceof MemoryReadError
        ? new WebError(({ invalid_path: 400, not_found: 404, limit: 413, unavailable: 503 } as const)[error.code], `memory_${error.code}`)
        : new WebError(503, "service_unavailable");
      json(res, err.status, { error: err.code });
      req.resume();
    });
  });
  server.maxConnections = 64;
  server.headersTimeout = 10_000;
  server.setTimeout(SOCKET_TIMEOUT_MS);
  server.on("timeout", (socket) => socket.destroy());
  // Bad header syntax is never allowed to escape as a process error.
  server.on("clientError", (_err, socket) => socket.destroy());

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const api = req.url?.startsWith("/api/") ?? false;
    // An <img> cannot send our x-tomo-request header, so the media endpoint
    // (GET, read-only, cookie-authenticated like every API) instead requires
    // a same-origin image fetch: a hostile page's <img> is cross-site.
    // The same holds for a picture the agent sent (`/outgoing/<id>`).
    const mediaRequest = req.method === "GET" && /^\/api\/v1\/sessions\/[A-Za-z0-9_-]{43}\/(?:media(?:\?|$)|outgoing\/[a-f0-9]{32}$)/.test(req.url ?? "");
    const origin = checkRequest(req, boundPort, api && !mediaRequest, externalOrigin);
    if (mediaRequest && (req.headers["sec-fetch-site"] !== "same-origin" || !["image", "empty"].includes(String(req.headers["sec-fetch-dest"] ?? "")))) {
      throw new WebError(403, "same_origin_required");
    }
    const url = new URL(req.url!, origin);
    const bootstrap = url.pathname === "/api/v1/bootstrap" && req.method === "GET";
    const session = api ? (bootstrap ? access.bootstrap(req, res, url, origin) : access.require(req, origin)) : undefined;
    if (url.pathname === "/api/v1/events" && req.method === "GET") {
      await events(url, req, res, origin);
      return;
    }
    if (url.pathname === "/api/v1/screen" && req.method === "GET") {
      await screen(url, req, res, origin);
      return;
    }
    if (active >= 8) throw new WebError(429, "request_limit");
    // One bounded disk inspection (TODOs, memory, context) at a time across
    // clients; chat, SSE and the other reads stay available meanwhile.
    const inspection = req.method === "GET" && (url.pathname === "/api/v1/todos"
      || url.pathname.startsWith("/api/v1/memory/") || /^\/api\/v1\/sessions\/[^/]+\/context$/.test(url.pathname));
    if (inspection && inspecting) throw new WebError(429, "inspection_busy");
    if (inspection) inspecting = true;
    active++;
    try {
      if (!api) {
        if (req.method !== "GET") throw new WebError(405, "method_not_allowed");
        await asset(url.pathname, res);
        return;
      }
      if (req.method === "GET") {
        if (url.pathname === "/api/v1/todos") { json(res, 200, await required(deps.data.memory).todos()); return; }
        if (url.pathname === "/api/v1/memory/tree") { json(res, 200, await required(deps.data.memory).tree()); return; }
        if (url.pathname === "/api/v1/memory/file") { json(res, 200, await required(deps.data.memory).file(url.searchParams.get("path") ?? "")); return; }
        if (url.pathname === "/api/v1/memory/search") { json(res, 200, await required(deps.data.memory).search(url.searchParams.get("q") ?? "")); return; }
        if (url.pathname === "/api/v1/cron") { json(res, 200, await deps.data.cron.list()); return; }
        if (url.pathname === "/api/v1/config") { json(res, 200, await required(deps.data.config).view()); return; }
        if (url.pathname === "/api/v1/mcp") {
          const saved = await required(deps.data.config).mcp();
          // Live health is whatever the SDK reports; unreachable is "unknown", never healthy.
          const live = await deps.rpc({ method: "mcp-status" }).then((sessions) => ({ available: true, sessions: sessions as WebMcpLiveSession[] }),
            () => ({ available: false, sessions: [] }));
          json(res, 200, { ...saved, live });
          return;
        }
        const context = /^\/api\/v1\/sessions\/([A-Za-z0-9_-]{43})\/context$/.exec(url.pathname);
        if (context) {
          const value = await deps.data.context(context[1]);
          const recentCompactions = await deps.rpc({ method: "context-events", sessionId: context[1] }).catch(() => []) as WebCompaction[];
          json(res, 200, { ...value, recentCompactions });
          return;
        }
        if (url.pathname === "/api/v1/bootstrap") {
          const csrfToken = csrf.bootstrap(session!);
          const { sessions, ownerId, setupRequired } = deps.data.catalog();
          const { snapshot } = await deps.rpc({ method: "snapshot" }) as WebSync;
          json(res, 200, { sessions, ownerId, setupRequired, ...snapshot, csrfToken, capabilities: { screen: !!deps.screen, uploads: !!deps.uploadsDir }, agentName: deps.data.agentName() });
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
        const tools = /^\/api\/v1\/sessions\/([A-Za-z0-9_-]{43})\/tools$/.exec(url.pathname);
        if (tools) {
          const number = (name: string) => {
            const raw = url.searchParams.get(name);
            if (raw === null) return undefined;
            if (!/^\d{1,15}$/.test(raw)) throw new WebError(400, "invalid_cursor");
            return Number(raw);
          };
          const transcript = url.searchParams.get("transcript") ?? undefined;
          if (transcript !== undefined && !/^[A-Za-z0-9_-]{0,32}$/.test(transcript)) throw new WebError(400, "invalid_cursor");
          json(res, 200, await deps.data.tools(tools[1], { from: number("from"), after: number("after"), transcript }));
          return;
        }
        if (url.pathname === "/api/v1/usage") {
          // Cached for 30 minutes in the daemon; refresh=1 forces a read, at most every 30 s.
          try { json(res, 200, await deps.rpc({ method: "usage", refresh: url.searchParams.get("refresh") === "1" })); }
          catch (error) {
            // The daemon did not answer in time: a named state, not a dropped request.
            if (!(error instanceof WebError) || error.code !== "daemon_timeout") throw error;
            const now = Date.now();
            json(res, 200, { state: "timeout", windows: [], fetchedAt: now, updatedAt: null, nextRefreshAt: now, expiresAt: now, serverNow: now } satisfies WebUsage);
          }
          return;
        }
        if (url.pathname === "/api/v1/models") {
          // The model of a conversation the catalog shows, from the daemon (which holds the overrides).
          const sessionId = url.searchParams.get("session") ?? "";
          if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId)) throw new WebError(400, "invalid_session");
          json(res, 200, await deps.rpc({ method: "model", sessionId }));
          return;
        }
        const task = /^\/api\/v1\/sessions\/([A-Za-z0-9_-]{43})\/tasks\/([A-Za-z0-9_-]{1,64})\/(transcript|output|command|brief)$/.exec(url.pathname);
        if (task) {
          const [, sessionId, taskId, what] = task;
          const access = await deps.rpc({ method: "task", sessionId, taskId, output: what === "output", command: what === "command" }) as WebTaskAccess;
          if (what === "output") { json(res, 200, access.output); return; }
          if (what === "command") { json(res, 200, access.command); return; }
          if (what === "brief") { json(res, 200, await deps.data.subagentBrief(access.sessionKey, taskId)); return; }
          const number = (name: string) => {
            const raw = url.searchParams.get(name);
            if (raw === null) return undefined;
            if (!/^\d{1,15}$/.test(raw)) throw new WebError(400, "invalid_cursor");
            return Number(raw);
          };
          json(res, 200, await deps.data.subagent(access.sessionKey, taskId, { before: number("before"), after: number("after") }));
          return;
        }
        const media = /^\/api\/v1\/sessions\/([A-Za-z0-9_-]{43})\/media$/.exec(url.pathname);
        if (media) {
          const path = url.searchParams.get("path") ?? "";
          if (!path || path.length > 1024) throw new WebError(400, "invalid_media");
          const file = await deps.data.mediaFile(media[1], path);
          res.writeHead(200, { "content-type": file.type, "content-length": file.bytes.length, "cache-control": "no-store" });
          res.end(file.bytes);
          return;
        }
        const sent = /^\/api\/v1\/sessions\/([A-Za-z0-9_-]{43})\/outgoing\/([a-f0-9]{32})$/.exec(url.pathname);
        if (sent) {
          const file = deps.data.outgoingFile(sent[1], sent[2]);
          res.writeHead(200, { "content-type": file.type, "content-length": file.bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
          res.end(file.bytes);
          return;
        }
        const request = /^\/api\/v1\/messages\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (request) {
          const value = await deps.rpc({ method: "request", requestId: request[1] }) as WebRequest;
          json(res, 200, value);
          return;
        }
      } else if ((req.method === "PATCH" || req.method === "DELETE") && /^\/api\/v1\/cron\/[A-Za-z0-9-]{1,64}$/.test(url.pathname)) {
        // Same guards as a message: exact Origin (checkRequest), cookie,
        // CSRF and JSON; plus the daemon epoch the page was loaded under.
        csrf.verify(req, session!);
        const epoch = req.headers["x-tomo-epoch"];
        if (typeof epoch !== "string" || epoch !== await deps.rpc({ method: "epoch" })) throw new WebError(409, "epoch_changed");
        const parsed = cronChangeSchema.safeParse(await body(req));
        if (!parsed.success || (req.method === "PATCH") !== (parsed.data.enabled !== undefined)) throw new WebError(400, "invalid_cron_change");
        json(res, 200, await deps.data.cron.change(url.pathname.split("/").at(-1)!, parsed.data.revision, parsed.data.enabled));
        return;
      } else if (req.method === "POST" && url.pathname === "/api/v1/models") {
        // A model switch, guarded like a cron action: exact Origin, cookie,
        // CSRF, JSON with confirm: true, the current daemon epoch; and only
        // the owner's own conversation (groups are read-only in the browser).
        csrf.verify(req, session!);
        const epoch = req.headers["x-tomo-epoch"];
        if (typeof epoch !== "string" || epoch !== await deps.rpc({ method: "epoch" })) throw new WebError(409, "epoch_changed");
        const parsed = modelChangeSchema.safeParse(await body(req));
        if (!parsed.success) throw new WebError(400, "invalid_model_change");
        const { ownerId } = deps.data.catalog();
        if (!ownerId) throw new WebError(409, "owner_setup_required");
        if (parsed.data.sessionId !== ownerId) throw new WebError(403, "owner_dm_only");
        json(res, 200, await deps.rpc({ method: "model-switch", epoch, sessionId: parsed.data.sessionId, model: parsed.data.model, from: parsed.data.from }));
        return;
      } else if (req.method === "POST" && url.pathname === "/api/v1/compact-request") {
        // Same gate as sending a message: CSRF, the owner, the daemon epoch.
        csrf.verify(req, session!);
        await body(req);
        const { ownerId } = deps.data.catalog();
        if (!ownerId) throw new WebError(409, "owner_setup_required");
        const epoch = req.headers["x-tomo-epoch"];
        if (typeof epoch !== "string" || !/^[a-f0-9-]{36}$/.test(epoch)) throw new WebError(409, "epoch_required");
        json(res, 202, await deps.rpc({ method: "compact", epoch }));
        return;
      } else if (req.method === "POST" && url.pathname === "/api/v1/uploads") {
        // An image for the owner's next message: the same gate as sending one
        // (CSRF, the owner, the daemon epoch), a raw body of at most
        // MAX_UPLOAD_BYTES, and the type decided by its leading bytes.
        csrf.verify(req, session!, "application/octet-stream");
        const { ownerId } = deps.data.catalog();
        if (!ownerId) throw new WebError(409, "owner_setup_required");
        if (url.searchParams.get("targetId") !== ownerId) throw new WebError(403, "owner_dm_only");
        const epoch = req.headers["x-tomo-epoch"];
        if (typeof epoch !== "string" || epoch !== await deps.rpc({ method: "epoch" })) throw new WebError(409, "epoch_changed");
        const bytes = await rawBody(req, MAX_UPLOAD_BYTES);
        try { json(res, 201, stageUpload(required(deps.uploadsDir), await convertUpload(bytes))); }
        catch (error) {
          if (!(error instanceof UploadError)) throw error;
          throw new WebError(error.code === "not_image" ? 415 : error.code === "too_large" ? 413 : 429, error.code);
        }
        return;
      } else if (req.method === "DELETE" && /^\/api\/v1\/uploads\/[a-f0-9]{32}$/.test(url.pathname)) {
        csrf.verify(req, session!);
        await body(req).catch(() => undefined);
        discardUpload(required(deps.uploadsDir), url.pathname.split("/").at(-1)!);
        json(res, 200, {});
        return;
      } else if (req.method === "POST" && url.pathname === "/api/v1/messages") {
        csrf.verify(req, session!);
        const parsed = messageInputSchema.safeParse(await body(req));
        if (!parsed.success) throw new WebError(400, "invalid_message");
        const { ownerId } = deps.data.catalog();
        if (!ownerId) throw new WebError(409, "owner_setup_required");
        if (parsed.data.targetId !== undefined && parsed.data.targetId !== ownerId) throw new WebError(403, "owner_dm_only");
        const epoch = req.headers["x-tomo-epoch"];
        if (typeof epoch !== "string" || !/^[a-f0-9-]{36}$/.test(epoch)) throw new WebError(409, "epoch_required");
        json(res, 202, await deps.rpc({ method: "message", input: parsed.data, epoch }));
        return;
      } else if (req.method === "POST" && /^\/api\/v1\/messages\/[a-f0-9-]{36}\/dismiss$/.test(url.pathname)) {
        csrf.verify(req, session!);
        const epoch = req.headers["x-tomo-epoch"];
        if (typeof epoch !== "string" || !/^[a-f0-9-]{36}$/.test(epoch)) throw new WebError(409, "epoch_required");
        await body(req); // Content is unused; read so the connection stays clean.
        const requestId = url.pathname.split("/")[4];
        json(res, 200, await deps.rpc({ method: "dismiss", requestId, epoch }));
        return;
      }
      throw new WebError(404, "not_found");
    } finally { active--; if (inspection) inspecting = false; }
  }

  async function events(url: URL, req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
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
      write("snapshot", { ...sync.snapshot, resync: sync.replay === null }, sync.snapshot.cursor);
      // Durable blocks/receipts come from the snapshot. Replaying old blocks
      // would resurrect settled work; only transient activity needs replay.
      for (const item of sync.replay ?? []) {
        if (item.event.type === "tool" || item.event.type === "typing") write("update", item.event);
      }
      const watermark = Number(sync.snapshot.cursor.split(":")[1]);
      for (const item of pending) {
        const [epoch, sequence] = item.id.split(":");
        if (epoch === sync.snapshot.epoch && Number(sequence) > watermark) write("update", item.event, item.id);
      }
      pending = undefined;
      heartbeat = setInterval(() => {
        try { access.require(req, origin); } catch { res.destroy(); return; }
        if (res.writableLength > 0) res.destroy();
        else res.write(": heartbeat\n\n");
      }, 15_000);
      heartbeat.unref();
    } catch (error) { cleanup(); throw error; }
  }

  /**
   * Read-only view of the desktop: an SSE stream (read with fetch, so it
   * carries the same custom header, cookie and same-origin checks as every
   * other API) of base64 JPEG frames from the one shared capture loop. The
   * loop runs only while a stream is open. A frame is skipped for a client
   * that has not drained the previous one, so a slow browser never queues
   * pictures. Nothing here accepts input.
   */
  async function screen(url: URL, req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
    const loop = deps.screen;
    if (!loop) throw new WebError(503, "screen_unavailable");
    const rate = Number(url.searchParams.get("fps") ?? "1") as ScreenRate;
    if (!SCREEN_RATES.includes(rate)) throw new WebError(400, "invalid_rate");
    const epoch = url.searchParams.get("epoch");
    const { snapshot } = await deps.rpc({ method: "snapshot" }) as WebSync;
    if (!epoch || epoch !== snapshot.epoch) throw new WebError(409, "epoch_changed");
    if (screenStreams.size >= 4) throw new WebError(429, "stream_limit");
    if (res.destroyed) return;
    screenStreams.add(res);
    req.socket.setTimeout(0);
    res.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no", "cache-control": "no-store" });
    res.flushHeaders();
    const unsubscribe = loop.subscribe(rate, (frame) => {
      if (res.destroyed || res.writableLength > 0) return;
      const data = JSON.stringify({ status: frame.status, capturedAt: frame.capturedAt, ...(frame.jpeg ? { jpeg: frame.jpeg.toString("base64") } : {}) });
      res.write(`event: frame\ndata: ${data}\n\n`);
    });
    const heartbeat = setInterval(() => {
      try { access.require(req, origin); } catch { res.destroy(); return; }
      if (res.writableLength === 0) res.write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref();
    res.once("close", () => { unsubscribe(); clearInterval(heartbeat); screenStreams.delete(res); });
  }

  async function asset(path: string, res: ServerResponse): Promise<void> {
    const relative = path === "/" ? "index.html" : /^\/assets\/[A-Za-z0-9_-]+\.(js|css|woff2)$/.test(path) || ICON_FILES.has(path) ? path.slice(1) : null;
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
        css: "text/css; charset=utf-8", woff2: "font/woff2", svg: "image/svg+xml", ico: "image/x-icon", png: "image/png",
        webmanifest: "application/manifest+json" } as Record<string, string>)[ext] });
      res.end(bytes);
    } finally { await file.close(); }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  // Keep runtime listener errors local even after the startup promise settles.
  server.on("error", () => { for (const stream of [...streams, ...screenStreams]) stream.destroy(); });
  boundPort = (server.address() as { port: number }).port;
  return { port: boundPort, async close() {
    for (const stream of [...streams, ...screenStreams]) stream.destroy();
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

/** A raw body of at most `limit` bytes (a larger one is refused before it is read in full). */
async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers["content-length"]) > limit) throw new WebError(413, "too_large");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new WebError(413, "too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

function required<T>(value: T | undefined): T {
  if (!value) throw new WebError(503, "service_unavailable");
  return value;
}
