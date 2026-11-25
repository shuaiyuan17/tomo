import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronStore } from "../src/cron/store.js";
import { MAX_CRON_STORE_BYTES, WebCron } from "../src/web/inspection.js";
import { WebData } from "../src/web/data.js";
import { WebChannel } from "../src/channels/web.js";
import { SessionStore } from "../src/sessions/store.js";
import type { WebCronJob } from "../src/web/protocol.js";
import { channelRpc, startWebService, type WebService } from "./helpers/web-http.js";

/** The Study's Cron tab: WebCron (src/web/inspection.ts) reads and changes the store, and the PATCH / DELETE routes reach it. */
let root: string;
let path: string;
let store: CronStore;
let web: WebCron;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-web-cron-")));
  path = join(root, "cron", "jobs.json");
  store = new CronStore(path);
  web = new WebCron(path);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("WebCron.list", () => {
  it("lists a job's intent and run state", async () => {
    const path = join(root, "data", "cron", "jobs.json");
    const store = new CronStore(path);
    const job = store.add({ name: "Example task", schedule: { kind: "every", everyMs: 60_000 }, message: "Review the test note", sessionKey: "dm:owner" });
    expect((await new WebCron(path).list()).jobs).toEqual([expect.objectContaining({ id: job.id, name: "Example task", message: "Review the test note",
      sessionKey: "dm:owner", scheduleLabel: "every 1m", enabled: true, lastStatus: null })]);
  });
  it("reports an unreadable store as unavailable, not as no jobs", async () => {
    const path = join(root, "jobs.json");
    writeFileSync(path, "{not json");
    await expect(new WebCron(path).list()).rejects.toMatchObject({ status: 503, code: "cron_unavailable" });
    writeFileSync(path, JSON.stringify({ jobs: [null] }));
    await expect(new WebCron(path).list()).rejects.toMatchObject({ code: "cron_unavailable" });
  });
  it("reads a missing store as no jobs, and has no path of its own", async () => {
    expect(await new WebCron(join(root, "absent.json")).list()).toEqual({ jobs: [] });
    await expect(new WebCron(undefined).list()).rejects.toMatchObject({ code: "cron_unavailable" });
  });
  it("refuses a FIFO, a symlink and a directory without blocking", async () => {
    const fifo = join(root, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    await expect(new WebCron(fifo).list()).rejects.toMatchObject({ code: "cron_unavailable" });
    const real = join(root, "real.json"); writeFileSync(real, JSON.stringify({ version: 1, revision: 1, jobs: [] }));
    symlinkSync(real, join(root, "link.json"));
    await expect(new WebCron(join(root, "link.json")).list()).rejects.toMatchObject({ code: "cron_unavailable" });
    await expect(new WebCron(root).list()).rejects.toMatchObject({ code: "cron_unavailable" });
  });
  it("refuses a store over the size bound with an explicit error", async () => {
    const path = join(root, "big.json");
    writeFileSync(path, JSON.stringify({ version: 1, revision: 1, jobs: [], pad: "x".repeat(MAX_CRON_STORE_BYTES) }));
    await expect(new WebCron(path).list()).rejects.toMatchObject({ status: 413, code: "cron_store_too_large" });
  });
});

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
  let service: WebService;
  let channel: WebChannel;
  let jobId: string;
  const job = async (): Promise<WebCronJob> => (await service.get("/api/v1/cron")).json<{ jobs: WebCronJob[] }>().jobs[0];
  const send = async (method: string, p: string, body: unknown) => {
    const response = await service.send(method, "/api/v1" + p, body);
    return { status: response.status, value: response.json() };
  };
  beforeEach(async () => {
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    jobId = store.add({ name: "Morning briefing", schedule: { kind: "every", everyMs: 3_600_000 }, message: "Summarise", sessionKey: "dm:owner" }).id;
    const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
    const sessionsDir = join(root, "sessions"); const sdkSessionsDir = join(root, "sdk");
    new SessionStore(sessionsDir, 20, sdkSessionsDir).touchSession("dm:owner");
    channel = new WebChannel(owner); channel.onMessage(async () => true);
    service = await startWebService({ assetsDir: root, data: new WebData({ cronStorePath: path, sessionsDir, sdkSessionsDir, owner }),
      subscribe: (fn) => channel.events.subscribe(fn), rpc: channelRpc(channel) });
  });
  afterEach(async () => { await service?.close(); await channel?.stop(); });

  it("requires an explicit confirmation, and enabled on a PATCH only", async () => {
    // Origin, cookie, CSRF, JSON and the epoch are rows of web-http.test.ts's write-gate table.
    const { revision } = await job();
    const body = { revision, confirm: true, enabled: false };
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
    expect((await service.get("/api/v1/cron")).json<{ jobs: unknown[] }>().jobs).toEqual([]);
  });
});
