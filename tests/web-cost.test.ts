import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request, type IncomingMessage } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { SessionStore } from "../src/sessions/store.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { webSessionId } from "../src/web/owner.js";
import { usageDataDir } from "../src/usage/dir.js";
import type { WebCost } from "../src/web/protocol.js";
import type { UsageLedgerRow } from "../src/usage/ledger.js";

let root: string;
let usage: string;
let service: Awaited<ReturnType<typeof startWebHttp>>;
let cookie: string;
let now: number;
const accessToken = "tomo_web_" + "b".repeat(64);
const baseHeaders = { "x-tomo-request": "1", "sec-fetch-site": "same-origin" };
const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };

function call(path: string, headers: Record<string, string | undefined> = {}) {
  return new Promise<{ status: number; text: string; headers: IncomingMessage["headers"] }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: service.port, path, method: "GET",
      headers: Object.fromEntries(Object.entries({ ...baseHeaders, cookie, ...headers }).filter(([, v]) => v !== undefined)) as Record<string, string> }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (part) => { text += part; });
      res.on("end", () => resolve({ status: res.statusCode!, text, headers: res.headers }));
    });
    req.on("error", reject); req.end();
  });
}

const row = (ts: string | number, costUsd: number, extra: Partial<UsageLedgerRow> = {}): UsageLedgerRow => ({
  v: 1, ts: typeof ts === "string" ? Date.parse(ts) : ts, sessionKey: "dm:owner", source: "owner", costUsd,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 }, ...extra,
});

beforeEach(async () => {
  cookie = ""; now = Date.parse("2026-11-15T12:00:00-08:00");
  root = mkdtempSync(join(tmpdir(), "tomo-web-cost-"));
  usage = usageDataDir(root);
  mkdirSync(usage, { recursive: true });
  const sessionsDir = join(root, "sessions"); const sdkSessionsDir = join(root, "sdk");
  const workspaceDir = join(root, "workspace");
  // The owner's clock is on his people record: Tokyo, not this machine's.
  mkdirSync(join(workspaceDir, "memory", "people"), { recursive: true });
  writeFileSync(join(workspaceDir, "memory", "people", "owner.md"), "---\nname: owner\ntimezone: Asia/Tokyo\n---\n");
  const assetsDir = join(root, "assets"); mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "index.html"), "<!doctype html>");
  const store = new SessionStore(sessionsDir, 20, sdkSessionsDir);
  store.touchSession("dm:owner");
  store.touchSession("telegram:-1"); store.setChatTitle("telegram:-1", "Test group");
  service = await startWebHttp(0, { accessToken, now: () => now, assetsDir,
    data: new WebData({ sessionsDir, sdkSessionsDir, owner, tomoHome: root, workspaceDir }),
    subscribe: () => () => {}, rpc: async () => ({ snapshot: {}, replay: null }) });
  const boot = await call(`/api/v1/bootstrap?t=${accessToken}`);
  expect(boot.status).toBe(200);
  cookie = boot.headers["set-cookie"]![0].split(";")[0];
});
afterEach(async () => { await service?.close(); rmSync(root, { recursive: true, force: true }); });

describe("GET /api/v1/cost", () => {
  it("is owner-only: no cookie, a forged cookie or a missing request header are refused", async () => {
    writeFileSync(join(usage, "2026-11.ndjson"), JSON.stringify(row("2026-11-14T10:00:00+09:00", 5, { trigger: "private words" })) + "\n");
    for (const headers of [{ cookie: undefined }, { cookie: `tomo_web=${"0".repeat(64)}.${now + 1000}.${"0".repeat(64)}` }]) {
      const res = await call("/api/v1/cost", headers);
      expect(res.status).toBe(401);
      expect(res.text).not.toContain("private words");
    }
    // Without the same-origin request header the API refuses before reading anything.
    const bare = await call("/api/v1/cost", { "x-tomo-request": undefined });
    expect(bare.status).toBeGreaterThanOrEqual(400);
    expect(bare.text).not.toContain("private words");
    expect((await call("/api/v1/cost")).status).toBe(200);
  });

  it("answers in the owner's zone with sessions named as the browser knows them, plus the quota bar", async () => {
    writeFileSync(join(usage, "2026-11.ndjson"), [
      // 23:30 on Nov 13 in Los Angeles is Nov 14 in Tokyo.
      row("2026-11-13T23:30:00-08:00", 2, { trigger: "plan my trip", tools: 3, durationMs: 4000 }),
      row("2026-11-14T10:00:00+09:00", 1, { sessionKey: "telegram:-1", source: "group" }),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(join(usage, "limits.ndjson"), [
      { v: 1, ts: "2026-11-15T01:00:00.000Z", source: "oauth-usage", windows: [{ window: "seven_day", label: "Weekly", group: "weekly", percent: 61, resetsAt: "2026-11-17T00:00:00.000Z", status: "normal", active: true }] },
      { v: 1, ts: "2026-11-15T02:00:00.000Z", source: "rate-limit-event", windows: [{ window: "five_hour", percent: 12 }] },
    ].map((s) => JSON.stringify(s)).join("\n") + "\n");
    const res = await call("/api/v1/cost?from=2026-11-14&to=2026-11-15");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(res.text) as WebCost;
    expect(body).toMatchObject({ from: "2026-11-14", to: "2026-11-15", timeZone: "Asia/Tokyo" });
    expect(body.days.map((d) => d.costUsd)).toEqual([3, 0]);
    expect(body.sessions).toEqual([
      expect.objectContaining({ id: webSessionId("dm:owner"), label: "owner (DM)", kind: "dm", costUsd: 2 }),
      expect.objectContaining({ id: webSessionId("telegram:-1"), label: "Test group", kind: "group", costUsd: 1 }),
    ]);
    expect(body.topTurns[0]).toMatchObject({ trigger: "plan my trip", tools: 3, durationMs: 4000, session: { label: "owner (DM)" } });
    expect(body.limits).toEqual({ sampledAt: "2026-11-15T01:00:00.000Z", source: "oauth-usage",
      windows: [{ window: "seven_day", label: "Weekly", group: "weekly", percent: 61, resetsAt: "2026-11-17T00:00:00.000Z", status: "normal" }] });
  });

  it("names a sub-session's turns by its id and title, and by id alone when the task table is unreadable", async () => {
    writeFileSync(join(usage, "2026-11.ndjson"), [
      row("2026-11-14T10:00:00+09:00", 4, { sessionKey: "task:s3", source: "system" }),
      row("2026-11-14T11:00:00+09:00", 1, { sessionKey: "task:s9", source: "system" }),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "subsessions.json"), "{ not json");
    const labels = async () => (JSON.parse((await call("/api/v1/cost?from=2026-11-14&to=2026-11-15")).text) as WebCost).sessions.map((s) => [s.label, s.kind]);
    expect(await labels()).toEqual([["s3", "task"], ["s9", "task"]]);
    rmSync(join(root, "data", "subsessions.json"));
    const tasks = new SubsessionStore(join(root, "data", "subsessions.json"));
    for (const title of ["One", "Two", "Fix CI"]) tasks.create({ parentKey: "dm:owner", title, brief: "b", model: "opus" });
    expect(await labels()).toEqual([["s3 · Fix CI", "task"], ["s9", "task"]]);
  });

  it("defaults to the last 30 days and refuses a bad range", async () => {
    const body = JSON.parse((await call("/api/v1/cost")).text) as WebCost;
    expect([body.from, body.to, body.days.length, body.limits, body.recordedSince]).toEqual(["2026-10-18", "2026-11-16", 30, null, null]);
    for (const query of ["from=2026-11-15&to=2026-11-01", "from=2026-02-30&to=2026-03-01", "from=2025-01-01&to=2026-11-15", "from=x", "top=500"]) {
      const res = await call(`/api/v1/cost?${query}`);
      expect([query, res.status, res.text]).toEqual([query, 400, '{"error":"invalid_range"}']);
    }
  });
});

describe("GET /api/v1/cost performance", () => {
  it("answers a year of ledger (~36k rows, live-row shape) in under 200 ms", async () => {
    // A year to Nov 15, 100 turns a day, rows shaped like live ones: per-model split and snapshot.
    const models = (n: number) => ({
      "claude-opus-5-5": { input: 10 * n, output: 500 * n, cacheRead: 90_000 * n, cacheCreated: 2_000 * n, cacheCreated5m: 0, cacheCreated1h: 2_000 * n, thinking: 300 * n, webSearch: 0, costUsd: 0.4 * n, costBasis: "list" },
      "claude-haiku-4-5": { input: 1_000 * n, output: 50 * n, cacheRead: 0, cacheCreated: 0, webSearch: 0, costUsd: 0.01 * n },
    });
    const sources = ["owner", "owner", "group", "cron", "heartbeat", "background", "system"] as const;
    const byMonth = new Map<string, string[]>();
    const end = Date.parse("2026-11-15T00:00:00Z");
    const start = end - 365 * 86_400_000;
    let i = 0;
    for (let ts = start; ts < end; ts += 864_000, i++) {
      const source = sources[i % sources.length];
      const r = row(ts, 0.41 + (i % 13) * 0.07, {
        source, sessionKey: source === "group" ? "telegram:-1" : "dm:owner",
        ...(source === "cron" ? { jobId: `job${i % 9}`, jobName: `job-${i % 9}` } : {}),
        trigger: "a message of some length that the owner sent to start this turn, clipped to 80", durationMs: 30_000, durationApiMs: 20_000, numTurns: 6, tools: 5,
        models: models(1), sdkSessionId: "0f8c2b1e-4a7d-4e2b-9c1a-5d6e7f8a9b0c",
        snapshot: { sdkSessionId: "0f8c2b1e-4a7d-4e2b-9c1a-5d6e7f8a9b0c", totalCostUsd: 0.41 * i, tokens: { input: i, output: i, cacheRead: i, cacheCreated: i },
          models: { "claude-opus-5-5": models(i)["claude-opus-5-5"], "claude-haiku-4-5": models(i)["claude-haiku-4-5"] } } as never,
      });
      const d = new Date(ts);
      const file = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.ndjson`;
      if (!byMonth.has(file)) byMonth.set(file, []);
      byMonth.get(file)!.push(JSON.stringify(r));
    }
    for (const [file, lines] of byMonth) writeFileSync(join(usage, file), lines.join("\n") + "\n");
    expect(i).toBeGreaterThanOrEqual(36_000);

    const timed = async () => {
      const t = performance.now();
      const res = await call("/api/v1/cost?from=2025-11-15&to=2026-11-15");
      const ms = performance.now() - t;
      expect(res.status).toBe(200);
      return { ms, body: JSON.parse(res.text) as WebCost };
    };
    const cold = await timed();
    expect(cold.body.totals.turns).toBe(i);
    expect(cold.body.days).toHaveLength(366);
    // Then as in use: the current month grows by a row between requests (read
    // incrementally), the rest is served from the month cache.
    const warm: number[] = [];
    for (let n = 0; n < 5; n++) {
      appendFileSync(join(usage, "2026-11.ndjson"), JSON.stringify(row(end - 1000 - n, 1)) + "\n");
      const next = await timed();
      expect(next.body.totals.turns).toBe(i + n + 1);
      warm.push(next.ms);
    }
    const best = Math.min(...warm);
    console.log(`cost API, ${i} rows: cold ${cold.ms.toFixed(0)} ms, warm ${warm.map((ms) => ms.toFixed(0)).join("/")} ms`);
    // The budget: 200 ms per request with the month cache filled (the web
    // process fills it at start). Best of five, so a test worker competing for
    // the CPU with the rest of the suite does not decide it. The cold read of a
    // whole year (~150 ms on a laptop) gets a loose bound against regressions.
    expect(best).toBeLessThan(200);
    expect(cold.ms).toBeLessThan(2_000);
  });
});
