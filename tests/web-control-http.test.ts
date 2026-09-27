import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { WebChannel } from "../src/channels/web.js";
import { ConfigStore } from "../src/config/store.js";
import { CronStore } from "../src/cron/store.js";
import type { WebBootstrap } from "../src/web/protocol.js";
let root: string; let service: Awaited<ReturnType<typeof startWebHttp>>; let channel: WebChannel; let cookie: string; let boot: WebBootstrap; let base: string;
let restarts: ReturnType<typeof vi.fn>;
let data: WebData; let rpcMethods: string[];
const token = "tomo_web_" + "b".repeat(64);
async function call(path: string, body?: unknown, method = "POST", headers: Record<string, string> = {}) {
  const response = await fetch(base + "/api/v1" + path, { method: body === undefined ? "GET" : method,
    headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin", cookie,
      ...(body === undefined ? {} : { origin: base, "content-type": "application/json", "x-tomo-csrf": boot.csrfToken, "x-tomo-epoch": boot.epoch }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, value: await response.json() };
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tomo-control-http-")); mkdirSync(join(root, "memory"));
  writeFileSync(join(root, "memory", "TODO.md"), "- [ ] A test task"); writeFileSync(join(root, "index.html"), "<!doctype html>");
  new ConfigStore(join(root, "config.json")).replace({ model: "test-model", auth: { apiKey: "synthetic-secret" } });
  const identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }];
  channel = new WebChannel(identities); channel.onMessage(async () => true); restarts = vi.fn(async () => ({ restarting: true })); cookie = "";
  rpcMethods = [];
  data = new WebData({ workspaceDir: root, tomoHome: root, sessionsDir: join(root, "sessions"), sdkSessionsDir: join(root, "sdk"), identities });
  service = await startWebHttp(0, { accessToken: token, assetsDir: root,
    data,
    subscribe: (fn) => channel.events.subscribe(fn), rpc: async (rpc) => {
      rpcMethods.push(rpc.method);
      if (rpc.method === "message") return channel.receive(rpc.input);
      if (rpc.method === "epoch") return channel.events.epoch;
      if (rpc.method === "snapshot") return { snapshot: channel.snapshot(), replay: null };
      if (rpc.method === "mcp-status") return [];
      if (rpc.method === "context-events") return [];
      if (rpc.method === "restart") return restarts(rpc.reason);
      return {};
    } });
  base = `http://127.0.0.1:${service.port}`;
  const response = await fetch(`${base}/api/v1/bootstrap?t=${token}`, { headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin" } });
  cookie = response.headers.getSetCookie()[0].split(";")[0]; boot = await response.json() as WebBootstrap;
});
afterEach(async () => { await service?.close(); await channel?.stop(); rmSync(root, { recursive: true, force: true }); });
it("protects every new read endpoint and renders actual workspace data", async () => {
  for (const path of ["/todos", "/memory/tree", "/memory/file?path=TODO.md", "/memory/search?q=test", "/cron", "/config", "/config/schema", "/mcp", `/sessions/${boot.ownerId}/context`]) {
    expect((await call(path, undefined, "GET", { cookie: "" })).status, path).toBe(401);
    expect((await call(path)).status, path).toBe(200);
  }
  expect((await call("/todos")).value.files[0].content).toBe("- [ ] A test task");
  expect(JSON.stringify((await call("/config")).value)).not.toContain("synthetic-secret");
  expect((await call("/memory/file?path=..%2Fconfig.json")).status).toBe(400);
});
it("requires CSRF and current daemon epoch on all management mutations", async () => {
  for (const [path, method] of [["/config/preview", "POST"], ["/config/apply", "POST"], ["/mcp/preview", "POST"], ["/mcp/apply", "POST"], ["/restart", "POST"], ["/cron/test-job", "PATCH"], ["/cron/test-job", "DELETE"]]) {
    expect((await call(path, {}, method, { "x-tomo-csrf": "bad" })).status).toBe(403);
    expect((await call(path, {}, method, { "x-tomo-epoch": randomUUID() })).status).toBe(409);
    expect((await call(path, {}, method, { origin: "https://other.invalid" })).status).toBe(403);
  }
  expect(restarts).not.toHaveBeenCalled();
});
it("validates, previews and applies a secret-safe config change over authenticated HTTP", async () => {
  const current = await call("/config");
  expect((await call("/config/preview", { revision: current.value.revision, changes: [{ path: ["web", "port"], value: 0 }] })).status).toBe(422);
  const preview = await call("/config/preview", { revision: current.value.revision, changes: [{ path: ["auth", "apiKey"], value: "replacement-secret" }] });
  expect(preview.status).toBe(200); expect(JSON.stringify(preview.value)).not.toContain("replacement-secret");
  expect((await call("/config/apply", { id: preview.value.id })).status).toBe(200);
  expect((await call("/config/apply", { id: preview.value.id })).status).toBe(409);
  expect(new ConfigStore(join(root, "config.json")).read().value.auth).toEqual({ apiKey: "replacement-secret" });
});
it("requires confirmation for cron and restarts, then delegates to the existing operations", async () => {
  const store = new CronStore(join(root, "data", "cron", "jobs.json")); store.add({ name: "Test task", schedule: { kind: "every", everyMs: 60000 }, message: "A note", sessionKey: "dm:owner" });
  const job = (await call("/cron")).value.jobs[0];
  expect((await call(`/cron/${job.id}`, { revision: job.revision, enabled: false }, "PATCH")).status).toBe(400);
  expect((await call(`/cron/${job.id}`, { revision: job.revision, enabled: false, confirm: true }, "PATCH")).status).toBe(200);
  const revision = (await call("/config")).value.revision;
  expect((await call("/restart", { revision, reason: "Reviewed settings", confirm: false })).status).toBe(400);
  expect((await call("/restart", { revision, reason: "Reviewed settings", confirm: true })).status).toBe(202);
  expect(restarts).toHaveBeenCalledExactlyOnceWith("Reviewed settings");
});

it("uses a small epoch RPC for local mutations and no snapshot round trip for messages", async () => {
  rpcMethods.length = 0;
  const current = (await call("/config")).value;
  expect((await call("/config/preview", { revision: current.revision, changes: [{ path: ["model"], value: "changed" }] })).status).toBe(200);
  expect(rpcMethods).toEqual(["epoch"]);
  rpcMethods.length = 0;
  expect((await call("/messages", { requestId: randomUUID(), text: "A test message" })).status).toBe(202);
  expect(rpcMethods).toEqual(["message"]);
});
it("bounds concurrent inspections while keeping lightweight reads available and releases the slot on failure", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  const spy = vi.spyOn(data.memory!, "search").mockImplementationOnce(async () => { started = true; await blocked; throw new Error("Synthetic read failure"); });
  const pending = call("/memory/search?q=example");
  await expect.poll(() => started).toBe(true);
  try {
    expect((await call(`/sessions/${boot.ownerId}/context`)).status).toBe(429);
    expect((await call("/todos")).status).toBe(429);
    expect((await call("/config")).status).toBe(200);
  } finally { release(); }
  expect((await pending).status).toBe(503);
  expect((await call("/todos")).status).toBe(200); spy.mockRestore();
});
