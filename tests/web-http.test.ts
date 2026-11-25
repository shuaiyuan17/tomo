import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { SessionStore } from "../src/sessions/store.js";
import { WebChannel } from "../src/channels/web.js";
import { webSessionId } from "../src/web/owner.js";
import { checkRequest, CsrfTokens } from "../src/web/security.js";
import type { WebBootstrap } from "../src/web/protocol.js";
import { sendMessage } from "../web/src/api.js";
import type { IncomingMessage } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { CompressedAssets, pickEncoding } from "../src/web/static-assets.js";

let root: string;
let service: Awaited<ReturnType<typeof startWebHttp>>;
let channel: WebChannel;
let handoff: ReturnType<typeof vi.fn>;
let cookie: string;
let bootstrap: WebBootstrap;
const baseHeaders = { "x-tomo-request": "1", "sec-fetch-site": "same-origin" };
const accessToken = "tomo_web_" + "a".repeat(64);
const externalOrigin = "https://test-node.test-tailnet.ts.net";
let now: number;

async function call(path: string, options: { method?: string; headers?: Record<string, string | undefined>; body?: string } = {}) {
  return new Promise<{ status: number; text: string; headers: IncomingMessage["headers"] }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: service.port, path, method: options.method ?? "GET",
      headers: Object.fromEntries(Object.entries({ ...baseHeaders, cookie, ...options.headers }).filter(([, value]) => value !== undefined)) }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (part) => { text += part; });
      res.on("end", () => resolve({ status: res.statusCode!, text, headers: res.headers }));
    });
    req.on("error", reject); req.end(options.body);
  });
}
function mutationHeaders() { return { origin: `http://127.0.0.1:${service.port}`, cookie,
  "content-type": "application/json", "x-tomo-csrf": bootstrap.csrfToken, "x-tomo-epoch": bootstrap.epoch }; }

beforeEach(async () => {
  cookie = ""; now = Date.now();
  root = mkdtempSync(join(tmpdir(), "tomo-web-http-"));
  const sessionsDir = join(root, "sessions"); const sdkSessionsDir = join(root, "sdk");
  const assetsDir = join(root, "assets"); mkdirSync(join(assetsDir, "assets"), { recursive: true });
  writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>Tomo</title>");
  for (const icon of ["favicon.svg", "favicon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "manifest.webmanifest"]) writeFileSync(join(assetsDir, icon), icon);
  writeFileSync(join(assetsDir, "assets", "app-test.js"), "export {};");
  const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
  const store = new SessionStore(sessionsDir, 20, sdkSessionsDir);
  store.touchSession("telegram:-1"); store.setChatTitle("telegram:-1", "Test group");
  store.append("telegram:-1", { role: "user", content: "Group history", timestamp: Date.now(), channel: "telegram" });
  store.touchSession("dm:peer");
  channel = new WebChannel(owner); handoff = vi.fn(async () => true); channel.onMessage(handoff);
  service = await startWebHttp(0, { accessToken, externalOrigin, now: () => now, assetsDir, data: new WebData({ sessionsDir, sdkSessionsDir, owner }),
    subscribe: (fn) => channel.events.subscribe(fn), rpc: async (input) => {
      if (input.method === "message") return channel.receive(input.input);
      if (input.method === "request") return channel.request(input.requestId);
      if (input.method === "dismiss") return channel.resolveInterrupted(input.requestId, "dismissed");
      if (input.method === "compact") return channel.requestCompact();
      if (input.method === "stop") return channel.stopOwnerTurn();
      if (input.method === "task-action") return channel.taskAction(input.sessionId, input.taskId, input.action);
      if (input.method === "task") return channel.task(input.sessionId, input.taskId, input.output);
      if (input.method === "usage") return channel.usage(input.refresh);
      if (input.method === "subsessions") return channel.subsessionList();
      if (input.method === "subsession") return channel.subsession(input.id);
      if (input.method === "subsession-message") return channel.messageSubsession(input.id, input.input);
      return { snapshot: channel.snapshot(), replay: input.cursor ? channel.events.after(input.cursor) : null };
    } });
  const response = await call(`/api/v1/bootstrap?t=${accessToken}`);
  expect(response.status).toBe(200);
  bootstrap = JSON.parse(response.text);
  cookie = response.headers["set-cookie"]![0].split(";")[0];
});
afterEach(async () => { vi.unstubAllGlobals(); await service?.close(); await channel?.stop(); rmSync(root, { recursive: true, force: true }); });

describe("local HTTP boundary", () => {
  it("refuses to listen with an external origin and no access token", async () => {
    await expect(startWebHttp(0, { accessToken: "", externalOrigin, assetsDir: root,
      data: {} as WebData, rpc: async () => ({}), subscribe: () => () => {} })).rejects.toThrow("Web access token required");
  });
  it("delivers snapshot before transient replay without resurrecting settled blocks", async () => {
    channel.events.publish({ type: "invalidate" });
    const cursor = channel.events.cursor();
    channel.events.publish({ type: "block", sessionId: bootstrap.ownerId!, requestId: randomUUID(), id: "old-block", text: "already settled" });
    channel.events.publish({ type: "tool", sessionId: bootstrap.ownerId!, tool: "Read", state: "completed" });
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${service.port}/api/v1/events?cursor=${cursor}`, { headers: { ...baseHeaders, cookie }, signal: controller.signal });
    const reader = response.body!.getReader(); let text = "";
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      while (!text.includes('"tool":"Read"')) {
        const part = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (part.done) break;
        text += new TextDecoder().decode(part.value);
      }
    } finally { clearTimeout(timeout); controller.abort(); await reader.cancel().catch(() => {}); }
    expect(text).toContain('"tool":"Read"');
    expect(text).toContain("event: snapshot");
    expect(text.indexOf("event: snapshot")).toBeLessThan(text.indexOf("event: update"));
    expect(text).not.toContain("already settled");
  });
  it("leaves locale out of bootstrap when config has none, so the browser's language decides", async () => {
    const fresh = JSON.parse((await call("/api/v1/bootstrap")).text) as WebBootstrap;
    expect(fresh).not.toHaveProperty("locale");
    expect(new WebData({ sessionsDir: "/nonexistent", sdkSessionsDir: "/nonexistent", locale: "zh-Hans" }).locale()).toBe("zh-Hans");
  });
  it("serves current tasks in bootstrap and the SSE snapshot, without replaying stale task lists", async () => {
    const { watchBus } = await import("../src/watch/bus.js");
    const task = (taskId: string) => ({ taskId, taskType: "local_agent", description: `work ${taskId}`, ambient: false, background: true, startedAt: 1 });
    watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [task("old")] });
    const cursor = channel.events.cursor();
    watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [task("current")] });
    const fresh = JSON.parse((await call("/api/v1/bootstrap")).text) as WebBootstrap;
    expect(fresh.tasks.map((t) => [t.taskId, t.state])).toEqual([["current", "running"], ["old", "ended"]]);
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${service.port}/api/v1/events?cursor=${cursor}`, { headers: { ...baseHeaders, cookie }, signal: controller.signal });
    const reader = response.body!.getReader(); let text = "";
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      while (!text.includes("event: snapshot")) {
        const part = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (part.done) break;
        text += new TextDecoder().decode(part.value);
      }
      watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [task("current"), task("next")] });
      while (!text.includes('"taskId":"next"')) {
        const part = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (part.done) break;
        text += new TextDecoder().decode(part.value);
      }
    } finally { clearTimeout(timeout); controller.abort(); await reader.cancel().catch(() => {}); }
    const snapshot = text.split("\n\n").find((frame) => frame.includes("event: snapshot"))!;
    expect(snapshot).toContain('"taskId":"current"');
    // The replayed range held a task list; only the snapshot and live updates carry tasks.
    const updates = text.split("\n\n").filter((frame) => frame.includes("event: update") && frame.includes('"type":"tasks"'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('"taskId":"next"');
  });
  it("serves a shown subagent's transcript pages and refuses tasks the panel does not show", async () => {
    const { watchBus } = await import("../src/watch/bus.js");
    const sessionsDir = join(root, "sessions"), sdkSessionsDir = join(root, "sdk");
    new SessionStore(sessionsDir, 20, sdkSessionsDir).setSdkSessionId("dm:owner", "sdk-1");
    mkdirSync(join(sdkSessionsDir, "sdk-1", "subagents"), { recursive: true });
    const line = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } }) + "\n";
    writeFileSync(join(sdkSessionsDir, "sdk-1", "subagents", "agent-a1.jsonl"),
      JSON.stringify({ type: "user", message: { content: "Check the config" } }) + "\n" + line([{ type: "text", text: "Reading the config." }]));
    writeFileSync(join(sdkSessionsDir, "sdk-1", "subagents", "agent-zz.jsonl"), line([{ type: "text", text: "not on the board" }]));
    const task = { taskId: "a1", taskType: "local_agent", description: "x", ambient: false, background: true, startedAt: 1 };
    watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [task, { ...task, taskId: "b1", taskType: "local_bash" }] });
    const base = `/api/v1/sessions/${bootstrap.ownerId}/tasks`;
    const page = await call(`${base}/a1/transcript`);
    expect(page.status).toBe(200);
    const body = JSON.parse(page.text);
    expect(body.items).toMatchObject([{ kind: "text", text: "Reading the config." }]);
    expect((await call(`${base}/a1/transcript?after=${body.end}`)).status).toBe(200);
    expect(JSON.parse((await call(`${base}/a1/brief`)).text)).toEqual({ text: "Check the config", truncated: false });
    expect((await call(`${base}/zz/brief`)).status).toBe(404);
    expect((await call(`${base}/a1/transcript?after=abc`)).status).toBe(400);
    // On disk but never shown by the panel: refused by the daemon gate.
    const refused = await call(`${base}/zz/transcript`);
    expect(refused.status).toBe(404);
    // The browser tells "left the panel" from "not written yet" by this code.
    expect(JSON.parse(refused.text).error).toBe("task_not_found");
    expect(JSON.parse((await call(`${base}/b1/transcript`)).text).error).toBe("transcript_not_found");
    // A shown task whose transcript does not exist (yet).
    expect((await call(`${base}/b1/transcript`)).status).toBe(404);
    // No live SDK session to read a shell tail from.
    expect((await call(`${base}/b1/output`)).status).toBe(503);
    expect((await call(`${base}/a1/output`)).status).toBe(400);
  });
  it("lets a same-origin <img> reach the media endpoint without the API header, and nothing else", async () => {
    const path = `/api/v1/sessions/${bootstrap.ownerId}/media?path=${encodeURIComponent("/nope.png")}`;
    const img = { "x-tomo-request": undefined, "sec-fetch-dest": "image" };
    expect((await call(path, { headers: img })).status).toBe(404); // authenticated; not a shown image
    expect((await call(path, { headers: { ...img, cookie: undefined } })).status).toBe(401);
    expect((await call(path, { headers: { ...img, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await call(path, { headers: { ...img, "sec-fetch-dest": "document" } })).status).toBe(403);
    // Other APIs still require the header.
    expect((await call("/api/v1/sessions", { headers: img })).status).toBe(403);
  });
  it("serves plan usage through the daemon, passing a forced refresh", async () => {
    const usage = vi.spyOn(channel, "usage");
    const plain = await call("/api/v1/usage");
    expect(plain.status).toBe(200);
    expect(JSON.parse(plain.text)).toMatchObject({ state: "unavailable", windows: [] });
    await call("/api/v1/usage?refresh=1");
    expect(usage.mock.calls).toEqual([[false], [true]]);
  });
  it("turns a daemon that misses the usage deadline into a named timeout state", async () => {
    vi.spyOn(channel, "usage").mockRejectedValueOnce(new (await import("../src/web/protocol.js")).WebError(503, "daemon_timeout"));
    const res = await call("/api/v1/usage");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ state: "timeout", windows: [] });
  });
  it("compact requests need CSRF and the epoch, reach the owner's compact, and are refused while tasks run", async () => {
    const compact = vi.fn((_key: string, _settled: (outcome: "done" | "unverified" | "failed") => void) => "queued" as const);
    (channel as unknown as { compact: typeof compact }).compact = compact;
    const post = (headers: Record<string, string | undefined>) => call("/api/v1/compact-request", { method: "POST", headers, body: "{}" });
    expect((await post({ ...mutationHeaders(), "x-tomo-csrf": "wrong" })).status).toBe(403);
    expect((await post({ ...mutationHeaders(), "x-tomo-epoch": undefined })).status).toBe(409);
    const ok = await post(mutationHeaders());
    expect(ok.status).toBe(202);
    expect(JSON.parse(ok.text)).toMatchObject({ status: "queued", requestId: expect.any(String) });
    expect(compact).toHaveBeenCalledTimes(1);
    const { watchBus } = await import("../src/watch/bus.js");
    watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [{ taskId: "a1", taskType: "local_agent", description: "x", ambient: false, background: true, startedAt: 1 }] });
    const busy = await post(mutationHeaders());
    expect(busy.status).toBe(409);
    expect(JSON.parse(busy.text)).toEqual({ error: "tasks_running" });
    expect(compact).toHaveBeenCalledTimes(1);
  });
  it("the owner writes to a sub-session through its own route, with CSRF and the epoch; groups stay read-only", async () => {
    const task = { id: "s1", title: "T", status: "waiting" as const, waitingOn: "owner" as const, working: false, createdAt: 1, lastActivityAt: 1, activeMs: 0, revision: 1, writable: true };
    const message = vi.fn((_id: string, _text: string, _requestId: string) => ({ ok: true as const, duplicate: false, task }));
    const get = vi.fn((id: string) => id === "s1" ? { ...task, brief: "b", conversation: [] } : undefined);
    (channel as unknown as { subsessionAccess: unknown }).subsessionAccess = { list: () => ({ available: true, tasks: [task] }), get, message };
    expect(JSON.parse((await call("/api/v1/subsessions")).text)).toEqual({ available: true, tasks: [task] });
    expect(JSON.parse((await call("/api/v1/subsessions/s1")).text)).toMatchObject({ id: "s1", brief: "b" });
    expect((await call("/api/v1/subsessions/s2")).status).toBe(404);
    for (const bad of ["dm:owner", "task:s1", "s0", "..%2Fs1"]) expect((await call(`/api/v1/subsessions/${bad}`)).status).toBe(404);
    const post = (path: string, body: unknown, headers: Record<string, string | undefined> = mutationHeaders()) =>
      call(`/api/v1/subsessions/${path}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
    const requestId = randomUUID();
    expect((await post("s1", { requestId, text: "hi" }, { ...mutationHeaders(), "x-tomo-csrf": "wrong" })).status).toBe(403);
    expect((await post("s1", { requestId, text: "hi" }, { ...mutationHeaders(), "x-tomo-epoch": undefined })).status).toBe(409);
    expect((await post("s1", { requestId, text: "  " })).status).toBe(400);
    expect((await post("task:s1", { requestId, text: "hi" })).status).toBe(404);
    expect(message).not.toHaveBeenCalled();
    const ok = await post("s1", { requestId, text: "use plan B" });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toEqual({ status: "delivered", task });
    expect(message).toHaveBeenCalledWith("s1", "use plan B", requestId);
    // Nothing went through the DM's ingress, and a group is still not writable through /messages.
    expect(handoff).not.toHaveBeenCalled();
    const group = bootstrap.sessions.find((s) => s.id !== bootstrap.ownerId)!;
    const refused = await call("/api/v1/messages", { method: "POST", headers: mutationHeaders(), body: JSON.stringify({ requestId: randomUUID(), targetId: group.id, text: "hi" }) });
    expect(refused.status).toBe(403);
  });
  it("stop needs CSRF and the epoch, and reaches the owner conversation's running turn", async () => {
    const stop = vi.fn(async (_key: string) => true);
    (channel as unknown as { stopTurn: typeof stop }).stopTurn = stop;
    const post = (headers: Record<string, string | undefined>) => call("/api/v1/stop", { method: "POST", headers, body: "{}" });
    expect((await post({ ...mutationHeaders(), "x-tomo-csrf": "wrong" })).status).toBe(403);
    expect((await post({ ...mutationHeaders(), "x-tomo-epoch": undefined })).status).toBe(409);
    expect(stop).not.toHaveBeenCalled();
    const ok = await post(mutationHeaders());
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toEqual({ stopped: true });
    expect(stop).toHaveBeenCalledWith("dm:owner");
    stop.mockResolvedValueOnce(false);
    expect(JSON.parse((await post(mutationHeaders())).text)).toEqual({ stopped: false });
  });
  it("a task action needs CSRF, the epoch and the owner conversation, and reaches the task by its id", async () => {
    const stop = vi.fn(async (_key: string, _taskId: string) => true);
    const background = vi.fn(async (_key: string, _toolUseId: string) => true);
    const { watchBus } = await import("../src/watch/bus.js");
    (channel as unknown as { taskControl: unknown }).taskControl = { stop, background };
    watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [
      { taskId: "a1", taskType: "local_agent", description: "x", ambient: false, background: false, toolUseId: "toolu_1", startedAt: 1 }] });
    const post = (path: string, headers: Record<string, string | undefined> = mutationHeaders()) =>
      call(`/api/v1/sessions/${path}`, { method: "POST", headers, body: "{}" });
    const own = `${bootstrap.ownerId}/tasks/a1`;
    expect((await post(`${own}/stop`, { ...mutationHeaders(), "x-tomo-csrf": "wrong" })).status).toBe(403);
    expect((await post(`${own}/stop`, { ...mutationHeaders(), "x-tomo-epoch": undefined })).status).toBe(409);
    const group = bootstrap.sessions.find((s) => s.id !== bootstrap.ownerId)!;
    const refused = await post(`${group.id}/tasks/a1/stop`);
    expect(refused.status).toBe(403); expect(JSON.parse(refused.text)).toEqual({ error: "owner_dm_only" });
    expect((await post(`${own}/kill`)).status).toBe(404);
    expect((await post(`${bootstrap.ownerId}/tasks/zz/stop`)).status).toBe(404);
    expect(stop).not.toHaveBeenCalled();
    const moved = await post(`${own}/background`);
    expect(moved.status).toBe(200); expect(JSON.parse(moved.text)).toEqual({ done: true });
    expect(background).toHaveBeenCalledWith("dm:owner", "toolu_1");
    expect(JSON.parse((await post(`${own}/stop`)).text)).toEqual({ done: true });
    expect(stop).toHaveBeenCalledWith("dm:owner", "a1");
  });
  it("gates every private API including SSE, while keeping static assets public", async () => {
    for (const path of ["/api/v1/bootstrap", "/api/v1/sessions", `/api/v1/sessions/${bootstrap.ownerId}/messages`, `/api/v1/messages/${randomUUID()}`, "/api/v1/events",
      `/api/v1/sessions/${bootstrap.ownerId}/tasks/a1/transcript`, `/api/v1/sessions/${bootstrap.ownerId}/tasks/b1/output`, "/api/v1/usage"]) {
      const result = await call(path, { headers: { cookie: undefined } });
      expect(result.status).toBe(401); expect(result.text).toBe('{"error":"authentication_required"}');
    }
    expect((await call("/", { headers: { cookie: undefined } })).status).toBe(200);
    expect((await call("/api/v1/bootstrap")).status).toBe(200);
  });
  it("serves the app icons and manifest publicly (no cookie, no custom header) with their MIME types; nothing else at the root", async () => {
    const types: Record<string, string> = { "/favicon.svg": "image/svg+xml", "/favicon.ico": "image/x-icon", "/apple-touch-icon.png": "image/png",
      "/icon-192.png": "image/png", "/icon-512.png": "image/png", "/manifest.webmanifest": "application/manifest+json" };
    for (const [path, type] of Object.entries(types)) {
      const result = await call(path, { headers: { cookie: undefined, "x-tomo-csrf": undefined } });
      expect(result.status).toBe(200);
      expect(result.headers["content-type"]).toBe(type);
    }
    expect((await call("/favicon.png", { headers: { cookie: undefined } })).status).toBe(404);
    expect((await call("/index.html", { headers: { cookie: undefined } })).status).toBe(404);
  });
  it("supports an exact Serve Host/Origin pair with independent secure authentication", async () => {
    const host = new URL(externalOrigin).host;
    expect((await call("/api/v1/bootstrap", { headers: { host } })).status).toBe(401);
    const login = await call(`/api/v1/bootstrap?t=${accessToken}`, { headers: { host, cookie: undefined } });
    expect(login.status).toBe(200); expect(login.headers["set-cookie"]![0]).toContain("; Secure");
    const session = JSON.parse(login.text) as WebBootstrap;
    const headers = { ...mutationHeaders(), host, origin: externalOrigin, cookie: login.headers["set-cookie"]![0].split(";")[0], "x-tomo-csrf": session.csrfToken };
    expect((await call("/api/v1/messages", { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID(), text: "from Serve" }) })).status).toBe(202);
    for (const extra of [{ host: `${host}.evil.example` }, { origin: `${externalOrigin}.evil.example` }, { origin: `http://127.0.0.1:${service.port}` }]) {
      expect((await call("/api/v1/bootstrap", { headers: { ...headers, ...extra } })).status).toBe(403);
    }
  });
  it.each(["€".repeat(16_000), "😀".repeat(8_000), "\u0000".repeat(16_000)])("accepts every advertised UTF-16 unit within the JSON byte limit %#", async (text) => {
    const response = await call("/api/v1/messages", { method: "POST", headers: mutationHeaders(), body: JSON.stringify({ requestId: randomUUID(), text }) });
    expect(response.status).toBe(202); expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ text }));
  });
  it("transparently re-bootstraps once after CSRF expiry without losing login or duplicating a send", async () => {
    now += 12 * 60 * 60_000 + 1;
    const statuses: number[] = [];
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      const result = await call(path, { method: init.method, headers: { origin: `http://127.0.0.1:${service.port}`, ...init.headers as Record<string, string> }, body: init.body as string });
      statuses.push(result.status);
      return new Response(result.text, { status: result.status });
    });
    const refresh = vi.fn(async () => JSON.parse((await call("/api/v1/bootstrap")).text) as WebBootstrap);
    await expect(sendMessage({ requestId: randomUUID(), text: "after expiry" }, bootstrap, refresh)).resolves.toMatchObject({ state: "queued" });
    expect(statuses).toEqual([403, 202]);
    expect(refresh).toHaveBeenCalledOnce(); expect(handoff).toHaveBeenCalledOnce();
  });
  it("reports malformed and stale cursors separately from service failures", async () => {
    const path = `/api/v1/sessions/${bootstrap.ownerId}/messages?cursor=`;
    expect((await call(`${path}bad-cursor`)).status).toBe(400);
    const cursor = Buffer.from(JSON.stringify({ time: 1, order: 1, revision: "old" })).toString("base64url");
    const response = await call(`${path}${cursor}`);
    expect(response.status).toBe(409); expect(JSON.parse(response.text)).toEqual({ error: "history_changed" });
  });
  it.each([
    ["host", "evil.example"], ["host", "localhost:9465"], ["origin", "null"], ["origin", "https://evil.example"],
    ["sec-fetch-site", "cross-site"], ["sec-fetch-site", "same-site"], ["sec-fetch-site", undefined], ["x-tomo-request", undefined],
  ])("denies hostile/missing %s=%s before private bootstrap", async (key, value) => {
    const response = await call("/api/v1/bootstrap", { headers: { [key!]: value } });
    expect(response.status).toBe(403);
    expect(response.text).not.toContain("csrfToken");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("serves the page shell to a top-level navigation a phone re-issues as cross-site, and nothing else", async () => {
    const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    for (const site of ["cross-site", "same-site"]) {
      // A discarded tab first opened from another app comes back labelled cross-site.
      const page = await call("/", { headers: { "x-tomo-request": undefined, "sec-fetch-site": site, ...nav } });
      expect(page.status).toBe(200);
      expect(page.text).not.toContain("csrfToken");
      // The same label on anything that is not a top-level document GET is still refused.
      for (const headers of [{ "sec-fetch-mode": "no-cors", "sec-fetch-dest": "document" }, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }, {}]) {
        const other = await call("/", { headers: { "x-tomo-request": undefined, "sec-fetch-site": site, ...headers } });
        expect(other.status).toBe(403);
      }
      // An API call never gets the exemption, even dressed as a navigation.
      const api = await call("/api/v1/bootstrap", { headers: { "sec-fetch-site": site, ...nav } });
      expect(api.status).toBe(403);
      expect(api.text).not.toContain("csrfToken");
    }
  });
  it("requires Origin, JSON, and a matching cookie-bound CSRF token before mutation", async () => {
    for (const headers of [{ origin: undefined }, { cookie: undefined }, { "x-tomo-csrf": "wrong" },
      { "x-tomo-csrf": "é".repeat(43) }, { "content-type": "text/plain" }]) {
      const response = await call("/api/v1/messages", { method: "POST", headers: { ...mutationHeaders(), ...headers },
        body: JSON.stringify({ requestId: randomUUID(), text: "blocked" }) });
      expect([401, 403, 415]).toContain(response.status);
    }
    expect(handoff).not.toHaveBeenCalled();
    const accepted = await call("/api/v1/messages", { method: "POST", headers: mutationHeaders(),
      body: JSON.stringify({ requestId: randomUUID(), text: "accepted" }) });
    expect(accepted.status).toBe(202); expect(handoff).toHaveBeenCalledOnce();
    expect(bootstrap.csrfToken).not.toBe(cookie);
  });
  it("routes dismiss only as a CSRF- and epoch-guarded mutation", async () => {
    const requestId = randomUUID();
    const blocked = await call(`/api/v1/messages/${requestId}/dismiss`, { method: "POST", headers: { ...mutationHeaders(), "x-tomo-csrf": "wrong" }, body: "{}" });
    expect(blocked.status).toBe(403);
    const noEpoch = await call(`/api/v1/messages/${requestId}/dismiss`, { method: "POST", headers: { ...mutationHeaders(), "x-tomo-epoch": undefined }, body: "{}" });
    expect(noEpoch.status).toBe(409);
    // Only an interrupted request awaiting the owner can be dismissed.
    const notInterrupted = await call(`/api/v1/messages/${requestId}/dismiss`, { method: "POST", headers: mutationHeaders(), body: "{}" });
    expect(notInterrupted.status).toBe(404);
    expect(JSON.parse(notInterrupted.text).error).toBe("not_interrupted");
  });
  it("offers only owner DM and read-only groups, rejecting forged group sends", async () => {
    expect(bootstrap.sessions.map((s) => [s.kind, s.writable]).sort()).toEqual([["dm", true], ["group", false]]);
    expect(JSON.stringify(bootstrap)).not.toContain("dm:peer");
    expect(JSON.stringify(bootstrap)).not.toContain("test-owner");
    const id = webSessionId("telegram:-1");
    const history = await call(`/api/v1/sessions/${id}/messages`);
    expect(history.status).toBe(200); expect(JSON.parse(history.text).messages[0].content).toBe("Group history");
    const denied = await call("/api/v1/messages", { method: "POST", headers: mutationHeaders(),
      body: JSON.stringify({ requestId: randomUUID(), targetId: id, text: "blocked" }) });
    expect(denied.status).toBe(403); expect(handoff).not.toHaveBeenCalled();
  });
  it("rejects malformed, extra-field, oversized and non-JSON bodies", async () => {
    for (const body of ["{", JSON.stringify({ requestId: randomUUID(), text: "", senderId: "test-owner" }),
      JSON.stringify({ requestId: randomUUID(), text: "x".repeat(40_000) })]) {
      const response = await call("/api/v1/messages", { method: "POST", headers: mutationHeaders(), body });
      expect([400, 413]).toContain(response.status);
    }
    expect(handoff).not.toHaveBeenCalled();
  });
  it("serves only packaged assets with CSP, and denies preflights and path escapes", async () => {
    const page = await call("/"); expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect((await call("/assets/app-test.js")).headers["content-type"]).toContain("javascript");
    writeFileSync(join(root, "private.js"), "private data");
    symlinkSync(join(root, "private.js"), join(root, "assets", "assets", "escape.js"));
    for (const path of ["/config.json", "/../private.js", "/assets/escape.js", "/assets/%2e%2e/private.js"]) {
      const response = await call(path); expect(response.status).toBe(404); expect(response.text).not.toContain("private data");
    }
    expect((await call("/api/v1/messages", { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });
  it("caches hashed assets for a year and compresses text once per version; index.html and icons stay no-store", async () => {
    const raw = (path: string, encoding?: string) => new Promise<{ headers: IncomingMessage["headers"]; body: Buffer }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: service.port, path, headers: { ...(encoding ? { "accept-encoding": encoding } : {}) } }, (res) => {
        const parts: Buffer[] = []; res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(parts) }));
      });
      req.on("error", reject); req.end();
    });
    const source = `export const text = ${JSON.stringify("tomo ".repeat(2_000))};`;
    writeFileSync(join(root, "assets", "assets", "big-abc123.js"), source);
    const br = await raw("/assets/big-abc123.js", "gzip, deflate, br");
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(br.headers.vary).toBe("accept-encoding");
    expect(Number(br.headers["content-length"])).toBe(br.body.length);
    expect(br.body.length).toBeLessThan(source.length / 10);
    expect(brotliDecompressSync(br.body).toString()).toBe(source);
    const gz = await raw("/assets/big-abc123.js", "gzip");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.body).toString()).toBe(source);
    const plain = await raw("/assets/big-abc123.js");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.toString()).toBe(source);
    // The security headers still go out with a cached asset.
    expect(plain.headers["content-security-policy"]).toContain("script-src 'self'");
    // A rebuilt file under the same name is not served from the stale compressed copy.
    writeFileSync(join(root, "assets", "assets", "big-abc123.js"), source + "\n// rebuilt");
    expect(brotliDecompressSync((await raw("/assets/big-abc123.js", "br")).body).toString()).toBe(source + "\n// rebuilt");
    // Tiny files and already-compressed formats go out as they are.
    expect((await raw("/assets/app-test.js", "br")).headers["content-encoding"]).toBeUndefined();
    for (const path of ["/", "/favicon.svg", "/manifest.webmanifest"]) {
      expect((await raw(path, "br")).headers["cache-control"]).toBe("no-store");
    }
  });
  it("warms the bundle's brotli copies at startup, regular files only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-web-warm-")); mkdirSync(join(dir, "assets"));
    const source = "x".repeat(4_000);
    writeFileSync(join(dir, "assets", "app-1.js"), source); writeFileSync(join(dir, "index.html"), source);
    writeFileSync(join(dir, "elsewhere.js"), source); symlinkSync(join(dir, "elsewhere.js"), join(dir, "assets", "link-1.js"));
    const cache = new CompressedAssets();
    await cache.warm(dir);
    const version = (path: string) => { const stat = statSync(join(dir, path)); return `${stat.size}:${stat.mtimeMs}`; };
    // Already compressed: the bytes passed now are not what is returned.
    for (const path of ["assets/app-1.js", "index.html"]) {
      expect(brotliDecompressSync(await cache.get(path, version(path), "br", Buffer.from("other"))).toString()).toBe(source);
    }
    expect(brotliDecompressSync(await cache.get("assets/link-1.js", version("assets/link-1.js"), "br", Buffer.from("other"))).toString()).toBe("other");
    await cache.warm(join(dir, "missing"));
    rmSync(dir, { recursive: true, force: true });
  });
  it("negotiates brotli, then gzip, honouring q=0", () => {
    expect(pickEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(pickEncoding("gzip;q=1.0, br;q=0")).toBe("gzip");
    expect(pickEncoding("GZIP")).toBe("gzip");
    expect(pickEncoding("br ;q=1")).toBe("br");
    expect(pickEncoding("gzip, br ;q=0")).toBe("gzip");
    expect(pickEncoding("*")).toBe("br");
    expect(pickEncoding("*;q=0, gzip")).toBe("gzip");
    expect(pickEncoding("identity")).toBeUndefined();
    expect(pickEncoding("br;q=0, gzip;q=0")).toBeUndefined();
    expect(pickEncoding(undefined)).toBeUndefined();
    expect(pickEncoding("")).toBeUndefined();
  });
  it("sends an SSE snapshot and live completed blocks without a browser read acknowledgment", async () => {
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "stream" });
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${service.port}/api/v1/events`, { headers: { ...baseHeaders, cookie }, signal: controller.signal });
    const reader = response.body!.getReader();
    let text = new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("event: snapshot");
    await channel.send({ chatId: requestId, text: "completed block" });
    while (!text.includes("completed block")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"type":"block"');
    controller.abort(); await reader.cancel().catch(() => {});
    expect(channel.snapshot().blocks[0].text).toBe("completed block");
  });
});

it("rejects duplicate Host and absolute-form targets", () => {
  const fake = (rawHeaders: string[], url: string) => ({ rawHeaders, headers: { host: "127.0.0.1:9465" }, url, method: "GET" }) as IncomingMessage;
  expect(() => checkRequest(fake(["Host", "127.0.0.1:9465", "Host", "evil.example"], "/"), 9465, false)).toThrow();
  expect(() => checkRequest(fake(["Host", "127.0.0.1:9465"], "http://127.0.0.1:9465/"), 9465, false)).toThrow();
});

it("expires CSRF capabilities and does not accept a token from another browser", () => {
  let now = 0;
  const tokens = new CsrfTokens(() => now);
  const token = tokens.bootstrap("test-session");
  const verified = { headers: { "x-tomo-csrf": token, "content-type": "application/json" } } as IncomingMessage;
  expect(() => tokens.verify(verified, "test-session")).not.toThrow();
  expect(() => tokens.verify(verified, "other-session")).toThrow();
  now = 12 * 60 * 60_000 + 1;
  expect(() => tokens.verify(verified, "test-session")).toThrow();
});
