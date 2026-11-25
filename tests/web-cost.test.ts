import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebData } from "../src/web/data.js";
import { SessionStore } from "../src/sessions/store.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { webSessionId } from "../src/web/owner.js";
import { usageDataDir } from "../src/usage/dir.js";
import type { WebCost } from "../src/web/protocol.js";
import type { UsageLedgerRow } from "../src/usage/ledger.js";
import { startWebService, type WebService } from "./helpers/web-http.js";

let root: string;
let usage: string;
let web: WebService;
let data: WebData;
let now: number;
const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
const call = (path: string) => web.get(path);

const row = (ts: string | number, costUsd: number, extra: Partial<UsageLedgerRow> = {}): UsageLedgerRow => ({
  v: 1, ts: typeof ts === "string" ? Date.parse(ts) : ts, sessionKey: "dm:owner", source: "owner", costUsd,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 }, ...extra,
});

beforeEach(async () => {
  now = Date.parse("2026-11-15T12:00:00-08:00");
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
  web = await startWebService({ now: () => now, assetsDir,
    data: data = new WebData({ sessionsDir, sdkSessionsDir, owner, tomoHome: root, workspaceDir }),
    rpc: async () => ({ snapshot: {}, replay: null }) });
});
afterEach(async () => { await web?.close(); rmSync(root, { recursive: true, force: true }); });

describe("GET /api/v1/cost", () => {
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

  it("keeps one reader across requests, and a row appended to the current month is in the next answer", async () => {
    // The per-file cache itself is unit-tested ("LedgerReader cache" in usage-cost-report.test.ts);
    // here: the route holds one reader (a new one per request would read every file again) and it stays fresh.
    writeFileSync(join(usage, "2026-11.ndjson"), [row("2026-11-14T10:00:00+09:00", 1), row("2026-11-14T11:00:00+09:00", 2)].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const turns = async () => (JSON.parse((await call("/api/v1/cost?from=2026-11-14&to=2026-11-15")).text) as WebCost).totals.turns;
    const reader = () => (data as unknown as { ledger?: object }).ledger;
    expect(reader()).toBeUndefined();
    expect(await turns()).toBe(2);
    const first = reader();
    expect(first).toBeDefined();
    appendFileSync(join(usage, "2026-11.ndjson"), JSON.stringify(row("2026-11-15T09:00:00+09:00", 3)) + "\n");
    expect(await turns()).toBe(3);
    expect(reader()).toBe(first);
  });

  it("refuses a request without the same-origin header, or with a forged cookie, before reading anything", async () => {
    // No cookie at all: the 401 list in web-http.test.ts.
    writeFileSync(join(usage, "2026-11.ndjson"), JSON.stringify(row("2026-11-14T10:00:00+09:00", 5, { trigger: "private words" })) + "\n");
    const bare = await web.get("/api/v1/cost", { "x-tomo-request": undefined });
    expect([bare.status, bare.text]).toEqual([403, '{"error":"same_origin_required"}']);
    const forged = await web.get("/api/v1/cost", { cookie: `tomo_web=${"0".repeat(64)}.${now + 1000}.${"0".repeat(64)}` });
    expect([forged.status, forged.text]).toEqual([401, '{"error":"authentication_required"}']);
    expect((data as unknown as { ledger?: object }).ledger).toBeUndefined();
    expect((await call("/api/v1/cost")).status).toBe(200);
  });
});

// A wall-clock budget: meaningful on a quiet machine, flaky on a loaded test
// worker, and about a second of setup. Run it on purpose: TOMO_PERF=1 npx vitest run tests/web-cost.test.ts
describe.skipIf(!process.env.TOMO_PERF)("GET /api/v1/cost performance", () => {
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
