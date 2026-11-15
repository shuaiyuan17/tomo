import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerReader } from "../src/usage/ledger-reader.js";
import { buildCostReport, OTHER_SCHEDULED, type CostReportOptions } from "../src/usage/cost-report.js";
import { localParts } from "../src/usage/local-time.js";
import type { UsageLedgerRow } from "../src/usage/ledger.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-cost-report-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";

function row(ts: number | string, costUsd: number, extra: Partial<UsageLedgerRow> = {}): UsageLedgerRow {
  return { v: 1, ts: typeof ts === "string" ? Date.parse(ts) : ts, sessionKey: "dm:owner", source: "owner", costUsd,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 }, ...extra };
}
function write(file: string, rows: UsageLedgerRow[]) {
  writeFileSync(join(dir, file), rows.map((r) => JSON.stringify(r) + "\n").join(""));
}
function report(options: Partial<CostReportOptions> & Pick<CostReportOptions, "from" | "to">, reader = new LedgerReader(dir)) {
  return buildCostReport(reader, {
    timeZone: LA, now: Date.parse("2026-11-15T12:00:00-08:00"),
    describeSession: (key) => ({ label: key, kind: key.startsWith("dm:") ? "dm" : "group" }), ...options,
  });
}
const day = (r: ReturnType<typeof report>, date: string) => r.days.find((d) => d.date === date)!;

describe("Cost report: day boundaries", () => {
  it("splits days at the owner's local midnight, not UTC's", () => {
    // 23:59 and 00:01 Los Angeles time; both are Nov 11 in UTC.
    write("2026-11.ndjson", [row("2026-11-10T23:59:00-08:00", 1), row("2026-11-11T00:01:00-08:00", 2)]);
    const r = report({ from: "2026-11-10", to: "2026-11-11" });
    expect(day(r, "2026-11-10").costUsd).toBe(1);
    expect(day(r, "2026-11-11").costUsd).toBe(2);
    expect(r.hours[23].costUsd).toBe(1);
    expect(r.hours[0].costUsd).toBe(2);
  });

  it("moves the same rows to other days in another zone", () => {
    write("2026-11.ndjson", [row("2026-11-10T23:59:00-08:00", 1), row("2026-11-11T00:01:00-08:00", 2)]);
    // 16:59 and 17:01 on Nov 11 in Tokyo.
    const r = report({ from: "2026-11-10", to: "2026-11-11", timeZone: TOKYO });
    expect(day(r, "2026-11-10").costUsd).toBe(0);
    expect(day(r, "2026-11-11").costUsd).toBe(3);
    expect([r.hours[16].costUsd, r.hours[17].costUsd]).toEqual([1, 2]);
    expect(r.timeZone).toBe(TOKYO);
  });

  it("reads a range across month files, and a row filed under the writer's month lands on the owner's date", () => {
    write("2026-10.ndjson", [row("2026-10-31T23:30:00-07:00", 4)]);
    write("2026-11.ndjson", [row("2026-11-01T00:30:00-07:00", 5)]);
    const r = report({ from: "2026-10-31", to: "2026-11-01" });
    expect(r.days.map((d) => d.costUsd)).toEqual([4, 5]);
    expect(r.totals.costUsd).toBe(9);
    // In Tokyo both are Nov 1 — the October file still counts for it, even
    // when nothing else (the glance, the earliest file) asks for October.
    write("2026-08.ndjson", [row("2026-08-01T12:00:00-07:00", 1)]);
    const tokyo = report({ from: "2026-11-01", to: "2026-11-01", timeZone: TOKYO, now: Date.parse("2027-03-01T12:00:00Z") });
    expect(tokyo.days).toEqual([expect.objectContaining({ date: "2026-11-01", costUsd: 9, turns: 2 })]);
  });

  it("counts the hours of a DST day by the local clock", () => {
    // Nov 1 2026: 01:00–01:59 happens twice in Los Angeles.
    write("2026-11.ndjson", [row("2026-11-01T01:30:00-07:00", 1), row("2026-11-01T01:30:00-08:00", 2), row("2026-11-01T03:00:00-08:00", 4)]);
    const r = report({ from: "2026-11-01", to: "2026-11-01" });
    expect(r.hours[1]).toMatchObject({ costUsd: 3, turns: 2 });
    expect(r.hours[3].costUsd).toBe(4);
    expect(localParts(Date.parse("2026-03-08T03:30:00-07:00"), LA)).toEqual({ date: "2026-03-08", hour: 3 });
  });
});

describe("Cost report: breakdowns", () => {
  it("splits by category, session, cron job and model, and ranks the costliest turns", () => {
    write("2026-11.ndjson", [
      row("2026-11-14T09:00:00-08:00", 3, { trigger: "plan my trip", durationMs: 9000, tools: 4, numTurns: 5,
        models: { "claude-opus": { input: 10, output: 5, cacheRead: 100, cacheCreated: 1, costUsd: 2.5 }, "claude-haiku": { input: 1, output: 1, cacheRead: 0, cacheCreated: 0, costUsd: 0.5 } } }),
      row("2026-11-14T10:00:00-08:00", 1, { sessionKey: "telegram:-1", source: "group" }),
      row("2026-11-14T06:00:00-08:00", 2, { source: "cron", jobId: "j1", jobName: "daily-brief" }),
      row("2026-11-15T06:00:00-08:00", 0.5, { source: "cron", jobId: "j1", jobName: "daily-brief" }),
      row("2026-11-14T03:00:00-08:00", 0.25, { source: "system" }),
      row("2026-11-14T04:00:00-08:00", 6, { source: "heartbeat" }),
    ]);
    const r = report({ from: "2026-11-14", to: "2026-11-15", top: 3 });
    expect(r.totals.byCategory).toEqual({ you: 4, background: 6, scheduled: 2.75 });
    expect(r.sessions.map((s) => [s.label, s.costUsd, s.turns])).toEqual([["dm:owner", 11.75, 5], ["telegram:-1", 1, 1]]);
    expect(r.crons).toEqual([
      { jobId: "j1", name: "daily-brief", costUsd: 2.5, runs: 2 },
      { jobId: null, name: OTHER_SCHEDULED, costUsd: 0.25, runs: 1 },
    ]);
    expect(r.models.map((m) => [m.model, m.costUsd, m.tokens.cacheRead])).toEqual([["claude-opus", 2.5, 100], ["claude-haiku", 0.5, 0]]);
    expect(r.unsplitCostUsd).toBe(9.75);
    expect(r.topTurns.map((t) => t.costUsd)).toEqual([6, 3, 2]);
    expect(r.topTurns[1]).toMatchObject({ date: "2026-11-14", category: "you", source: "owner", trigger: "plan my trip", durationMs: 9000, tools: 4, numTurns: 5,
      session: { label: "dm:owner", kind: "dm" } });
    expect(day(r, "2026-11-14").byCategory).toEqual({ you: 4, background: 6, scheduled: 2.25 });
  });

  it("skips torn and foreign lines, and says which days nothing was recorded", () => {
    writeFileSync(join(dir, "2026-11.ndjson"), [JSON.stringify(row("2026-11-12T10:00:00-08:00", 2)), "{\"ts\":1", "not json", JSON.stringify({ hello: 1 }), ""].join("\n"));
    const r = report({ from: "2026-11-10", to: "2026-11-16" });
    expect(r.totals).toMatchObject({ costUsd: 2, turns: 1 });
    expect(r.days.map((d) => d.recorded)).toEqual([false, false, true, true, true, true, false]);
    expect(r.recordedSince).toBe(Date.parse("2026-11-12T10:00:00-08:00"));
  });
});

describe("Cost report: over-counted days are never compared", () => {
  const now = Date.parse("2026-09-30T12:00:00-07:00");
  beforeEach(() => {
    // Sep 18–22 over-counted (one huge day), Sep 23–30 normal.
    const rows: UsageLedgerRow[] = [];
    for (let d = 18; d <= 22; d++) rows.push(row(`2026-09-${d}T12:00:00-07:00`, d === 22 ? 1659 : 50, { overcounted: true, backfilled: true }));
    for (let d = 23; d <= 30; d++) rows.push(row(`2026-09-${d}T12:00:00-07:00`, d === 25 ? 40 : 10));
    write("2026-09.ndjson", rows);
  });

  it("keeps them out of the typical day, the busiest day and the week ratio", () => {
    const r = report({ from: "2026-09-18", to: "2026-09-30", now });
    expect(day(r, "2026-09-22")).toMatchObject({ costUsd: 1659, overcounted: true, backfilled: true });
    expect(r.totals.overcountedCostUsd).toBe(1659 + 4 * 50);
    expect(r.glance.typicalDay).toEqual({ costUsd: 10, days: 8 });
    expect(r.glance.busiestDay).toEqual({ date: "2026-09-25", costUsd: 40 });
    expect(r.glance.thisWeek).toMatchObject({ from: "2026-09-24", costUsd: 100, comparable: true });
    expect(r.glance.lastWeek).toMatchObject({ from: "2026-09-17", to: "2026-09-23", comparable: false });
    expect(r.glance.weekRatio).toBeNull();
    expect(r.glance.last30.comparable).toBe(false);
  });

  it("compares again once the window has no over-counted day", () => {
    const r = report({ from: "2026-09-18", to: "2026-09-30", now: Date.parse("2026-10-07T12:00:00-07:00") });
    expect(r.glance.lastWeek).toMatchObject({ from: "2026-09-24", costUsd: 100, comparable: true });
    expect(r.glance.thisWeek.costUsd).toBe(0);
    expect(r.glance.weekRatio).toBe(0);
  });
});

describe("LedgerReader cache", () => {
  it("serves a repeat read from memory and picks up appended, rewritten and replaced files", () => {
    write("2026-11.ndjson", [row("2026-11-14T10:00:00-08:00", 1)]);
    const reader = new LedgerReader(dir);
    const first = reader.rows(["2026-11.ndjson"])[0];
    expect(reader.rows(["2026-11.ndjson"])[0]).toBe(first);

    // Append, with a half-written last line that only counts once complete.
    appendFileSync(join(dir, "2026-11.ndjson"), JSON.stringify(row("2026-11-14T11:00:00-08:00", 2)) + "\n" + JSON.stringify(row("2026-11-14T12:00:00-08:00", 4)).slice(0, 20));
    expect(reader.rows(["2026-11.ndjson"])[0].map((r) => r.costUsd)).toEqual([1, 2]);
    expect(first.map((r) => r.costUsd)).toEqual([1]);
    appendFileSync(join(dir, "2026-11.ndjson"), JSON.stringify(row("2026-11-14T12:00:00-08:00", 4)).slice(20) + "\n");
    expect(reader.rows(["2026-11.ndjson"])[0].map((r) => r.costUsd)).toEqual([1, 2, 4]);

    // Rewritten shorter in place: read again whole.
    write("2026-11.ndjson", [row("2026-11-14T10:00:00-08:00", 5)]);
    expect(reader.rows(["2026-11.ndjson"])[0].map((r) => r.costUsd)).toEqual([5]);

    // Replaced by another file (a restore): read again whole.
    write("next.tmp", [row("2026-11-14T10:00:00-08:00", 7)]);
    renameSync(join(dir, "next.tmp"), join(dir, "2026-11.ndjson"));
    expect(reader.rows(["2026-11.ndjson"])[0].map((r) => r.costUsd)).toEqual([7]);

    // A cache smaller than the files read still answers right.
    write("2026-10.ndjson", [row("2026-10-14T10:00:00-07:00", 3)]);
    const small = new LedgerReader(dir, 1);
    for (let i = 0; i < 2; i++) expect(small.rows(["2026-10.ndjson", "2026-11.ndjson"]).map((rows) => rows.map((r) => r.costUsd))).toEqual([[3], [7]]);
    expect(small.rows(["2026-10.ndjson"])[0].map((r) => r.costUsd)).toEqual([3]);

    // Gone.
    rmSync(join(dir, "2026-11.ndjson"));
    expect(reader.rows(["2026-11.ndjson"])[0]).toEqual([]);
  });
});
