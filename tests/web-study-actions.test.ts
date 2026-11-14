import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CronStore } from "../src/cron/store.js";
import { WebCron } from "../src/web/inspection.js";
import { startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { WebChannel } from "../src/channels/web.js";
import { SessionStore } from "../src/sessions/store.js";
import type { WebBootstrap, WebCronJob } from "../src/web/protocol.js";

let root: string;
let path: string;
let store: CronStore;
let web: WebCron;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-web-study-actions-")));
  path = join(root, "cron", "jobs.json");
  store = new CronStore(path);
  web = new WebCron(path);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("WebCron.change", () => {
  it("pauses, resumes and deletes a job it was shown, through the store", async () => {
    const job = store.add({ name: "Example task", schedule: { kind: "every", everyMs: 60_000 }, message: "Review the test note", sessionKey: "dm:owner" });
    await web.change(job.id, (await web.list()).jobs[0].revision, false);
    expect(new CronStore(path).get(job.id)).toMatchObject({ enabled: false, nextRunAt: null });
    await web.change(job.id, (await web.list()).jobs[0].revision, true);
    expect(new CronStore(path).get(job.id)).toMatchObject({ enabled: true });
    await web.change(job.id, (await web.list()).jobs[0].revision);
    expect(new CronStore(path).list()).toEqual([]);
  });

  it("refuses a confirmation for a job whose intent changed since review", async () => {
    const job = store.add({ name: "Example task", schedule: { kind: "every", everyMs: 60_000 }, message: "Review the test note", sessionKey: "dm:owner" });
    const reviewed = (await web.list()).jobs[0].revision;
    store.setEnabled(job.id, false);
    await expect(web.change(job.id, reviewed, true)).rejects.toThrow("cron_changed");
    await expect(web.change(job.id, reviewed)).rejects.toThrow("cron_changed");
    expect(new CronStore(path).get(job.id)).toBeDefined();
  });

  it("lets a confirmed pause / delete survive scheduler bookkeeping in between", async () => {
    const job = store.add({ name: "Frequent task", schedule: { kind: "every", everyMs: 30_000 }, message: "Example", sessionKey: "dm:owner" });
    const revision = (await web.list()).jobs[0].revision;
    store.markStarted(job.id); store.markRun(job.id, "ok"); store.markStarted(job.id);
    await expect(web.change(job.id, revision, false)).resolves.toEqual({ ok: true });
    expect((await web.list()).jobs[0]).toMatchObject({ enabled: false, lastStatus: "ok" });
    const paused = (await web.list()).jobs[0].revision;
    store.markRun(job.id, "error");
    await expect(web.change(job.id, paused)).resolves.toEqual({ ok: true });
    expect((await web.list()).jobs).toEqual([]);
  });

  it("refuses to change a store it would refuse to read", async () => {
    store.add({ name: "x", schedule: { kind: "every", everyMs: 60_000 }, message: "x", sessionKey: "dm:owner" });
    writeFileSync(path, JSON.stringify({ version: 1, revision: 9, jobs: [], pad: "x".repeat(4 * 1024 * 1024) }));
    await expect(web.change("x", "0".repeat(64))).rejects.toMatchObject({ code: "cron_store_too_large" });
  });

  it("reports a missing job and an unschedulable resume distinctly", async () => {
    await expect(web.change("missing", "0".repeat(64))).rejects.toThrow("job_not_found");
    const job = store.add({ name: "Past", schedule: { kind: "cron", expr: "0 0 30 2 *" }, message: "x", sessionKey: "dm:owner" });
    store.setEnabled(job.id, false);
    await expect(web.change(job.id, (await web.list()).jobs[0].revision, true)).rejects.toThrow("unschedulable");
  });
});

describe("cron mutations over HTTP", () => {
  let service: Awaited<ReturnType<typeof startWebHttp>>;
  let channel: WebChannel;
  let cookie = "";
  let boot: WebBootstrap;
  let base: string;
  let jobId: string;
  const token = "tomo_web_" + "d".repeat(64);
  const job = async (): Promise<WebCronJob> => (await (await get("/cron")).json() as { jobs: WebCronJob[] }).jobs[0];
  const get = (p: string) => fetch(base + "/api/v1" + p, { headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin", cookie } });
  const send = async (method: string, p: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + "/api/v1" + p, { method, body: JSON.stringify(body), headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin", cookie,
      origin: base, "content-type": "application/json", "x-tomo-csrf": boot.csrfToken, "x-tomo-epoch": boot.epoch, ...headers } });
    return { status: response.status, value: await response.json() as Record<string, unknown> };
  };
  beforeEach(async () => {
    cookie = "";
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    jobId = store.add({ name: "Morning briefing", schedule: { kind: "every", everyMs: 3_600_000 }, message: "Summarise", sessionKey: "dm:owner" }).id;
    const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
    const sessionsDir = join(root, "sessions"); const sdkSessionsDir = join(root, "sdk");
    new SessionStore(sessionsDir, 20, sdkSessionsDir).touchSession("dm:owner");
    channel = new WebChannel(owner); channel.onMessage(async () => true);
    service = await startWebHttp(0, { accessToken: token, assetsDir: root,
      data: new WebData({ cronStorePath: path, sessionsDir, sdkSessionsDir, owner }),
      subscribe: (fn) => channel.events.subscribe(fn), rpc: async (rpc) => {
        if (rpc.method === "snapshot") return { snapshot: channel.snapshot(), replay: null };
        if (rpc.method === "epoch") return channel.events.epoch;
        throw new Error("unexpected rpc");
      } });
    base = `http://127.0.0.1:${service.port}`;
    const response = await fetch(`${base}/api/v1/bootstrap?t=${token}`, { headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin" } });
    cookie = response.headers.getSetCookie()[0].split(";")[0];
    boot = await response.json() as WebBootstrap;
  });
  afterEach(async () => { await service?.close(); await channel?.stop(); });

  it("requires origin, CSRF, JSON, the current epoch and an explicit confirmation", async () => {
    const { revision } = await job();
    const body = { revision, confirm: true, enabled: false };
    expect((await send("PATCH", `/cron/${jobId}`, body, { origin: "http://127.0.0.1:1" })).status).toBe(403);
    expect((await send("PATCH", `/cron/${jobId}`, body, { "x-tomo-csrf": "bad" })).value).toEqual({ error: "invalid_csrf" });
    expect((await send("PATCH", `/cron/${jobId}`, body, { "content-type": "text/plain" })).status).toBe(415);
    expect((await send("PATCH", `/cron/${jobId}`, body, { "x-tomo-epoch": randomUUID() })).value).toEqual({ error: "epoch_changed" });
    expect((await send("PATCH", `/cron/${jobId}`, { revision, enabled: false })).status).toBe(400);
    expect((await send("PATCH", `/cron/${jobId}`, { revision, confirm: true })).status).toBe(400);
    expect((await send("DELETE", `/cron/${jobId}`, body)).status).toBe(400);
    expect((await job()).enabled).toBe(true);
  });

  it("pauses and deletes with a reviewed revision, and refuses a stale one", async () => {
    const reviewed = (await job()).revision;
    expect(await send("PATCH", `/cron/${jobId}`, { revision: reviewed, confirm: true, enabled: false })).toEqual({ status: 200, value: { ok: true } });
    expect((await job()).enabled).toBe(false);
    expect((await send("DELETE", `/cron/${jobId}`, { revision: reviewed, confirm: true })).value).toEqual({ error: "cron_changed" });
    expect((await send("DELETE", `/cron/${jobId}`, { revision: (await job()).revision, confirm: true })).status).toBe(200);
    expect((await (await get("/cron")).json() as { jobs: unknown[] }).jobs).toEqual([]);
  });
});

describe("Study write helper", async () => {
  const { mutate, ApiError } = await import("../web/src/api.js");
  it("retries only a definite CSRF rejection, once, under the same epoch", async () => {
    const calls: Array<{ method?: string; csrf: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ method: init.method, csrf: headers["x-tomo-csrf"] });
      return calls.length === 1 ? new Response(JSON.stringify({ error: "invalid_csrf" }), { status: 403 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const boot = { epoch: "e1", csrfToken: "old" } as WebBootstrap;
      expect(await mutate("/cron/x", "DELETE", {}, boot, async () => ({ ...boot, csrfToken: "new" }))).toEqual({ ok: true });
      expect(calls).toEqual([{ method: "DELETE", csrf: "old" }, { method: "DELETE", csrf: "new" }]);
      calls.length = 0;
      await expect(mutate("/cron/x", "DELETE", {}, boot, async () => ({ ...boot, epoch: "e2", csrfToken: "new" }))).rejects.toEqual(new ApiError(409, "epoch_changed"));
      expect(calls).toHaveLength(1);
    } finally { globalThis.fetch = original; }
  });
});
