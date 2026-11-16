import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { acquireBackfillLock, activityFiles, BackfillError, backfillRowId, backfillUsage, BACKFILL_LOCK_FILE, rowsFromActivity } from "../src/usage/backfill.js";
import { BACKFILL_FILE, LEDGER_STARTED_FILE, ledgerFileName, writeLedgerStarted, type UsageLedgerRow } from "../src/usage/ledger.js";
import { LedgerReader } from "../src/usage/ledger-reader.js";
import { buildCostReport } from "../src/usage/cost-report.js";

const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);
const ev = (o: Record<string, unknown>) => JSON.stringify(o);

/** One owner turn, one cron turn, a group turn, a self-started result, around the #389 fix. */
function activity(): string[] {
  const t0 = at("2026-09-22T10:00:00-07:00");
  const t1 = at("2026-09-23T06:00:00-07:00");
  const t2 = at("2026-09-23T12:00:00-07:00");
  return [
    ev({ ts: t0 - 2000, type: "transcript", sessionKey: "dm:owner", role: "user", channel: "imessage", text: "check this key sk-ant-api03-" + "x".repeat(40) + " please" }),
    ev({ ts: t0, type: "turn.start", sessionKey: "dm:owner", source: "user" }),
    ev({ ts: t0 + 100, type: "tool.start", sessionKey: "dm:owner", tool: "Bash" }),
    ev({ ts: t0 + 200, type: "tool.start", sessionKey: "dm:owner", tool: "Read", agent: "subagent" }),
    ev({ ts: t0 + 300, type: "tool.start", sessionKey: "dm:owner", tool: "Grep" }),
    ev({ ts: t0 + 9000, type: "turn.stats", sessionKey: "dm:owner", costUsd: 283, contextUsed: 1, contextMax: 2 }),
    ev({ ts: t0 + 9010, type: "turn.end", sessionKey: "dm:owner", source: "user", ok: true, durationMs: 9010 }),
    // Cron: fired 2 s before its turn; turn.end before turn.stats this time.
    ev({ ts: t1 - 2000, type: "cron.fired", jobId: "j1", name: "daily-brief" }),
    ev({ ts: t1, type: "turn.start", sessionKey: "dm:owner", source: "cron" }),
    ev({ ts: t1 + 5000, type: "turn.end", sessionKey: "dm:owner", source: "cron", ok: true, durationMs: 5000 }),
    ev({ ts: t1 + 5001, type: "turn.stats", sessionKey: "dm:owner", costUsd: 0.5, contextUsed: 1, contextMax: 2 }),
    // A cron turn with no job fired near it.
    ev({ ts: t1 + 60_000, type: "turn.start", sessionKey: "dm:owner", source: "cron" }),
    ev({ ts: t1 + 61_000, type: "turn.stats", sessionKey: "dm:owner", costUsd: 0.25, contextUsed: 1, contextMax: 2 }),
    ev({ ts: t1 + 61_001, type: "turn.end", sessionKey: "dm:owner", source: "cron", ok: true, durationMs: 1000 }),
    // Group turn, and a turn that never reported a cost.
    ev({ ts: t2 - 1000, type: "transcript", sessionKey: "imessage:any;+;g1", role: "user", channel: "imessage", text: "hi all" }),
    ev({ ts: t2, type: "turn.start", sessionKey: "imessage:any;+;g1", source: "user" }),
    ev({ ts: t2 + 500, type: "turn.start", sessionKey: "dm:owner", source: "continuity" }),
    ev({ ts: t2 + 900, type: "turn.end", sessionKey: "dm:owner", source: "continuity", ok: false, durationMs: 400 }),
    ev({ ts: t2 + 1000, type: "turn.stats", sessionKey: "imessage:any;+;g1", costUsd: 1.5, contextUsed: 1, contextMax: 2 }),
    ev({ ts: t2 + 1001, type: "turn.end", sessionKey: "imessage:any;+;g1", source: "user", ok: true, durationMs: 1001 }),
    // A result with no turn.start: the CLI started it itself.
    ev({ ts: t2 + 5000, type: "turn.stats", sessionKey: "dm:owner", costUsd: 22.5, contextUsed: 1, contextMax: 2 }),
    "{\"ts\":12", "",
  ];
}

describe("rowsFromActivity", () => {
  it("rebuilds one row per result with source, job, trigger, duration and tools", () => {
    const rows = rowsFromActivity(activity(), LA);
    expect(rows.map((r) => [r.sessionKey, r.source, r.costUsd])).toEqual([
      ["dm:owner", "owner", 283], ["dm:owner", "cron", 0.5], ["dm:owner", "system", 0.25],
      ["imessage:any;+;g1", "group", 1.5], ["dm:owner", "background", 22.5],
    ]);
    const [owner, cron, system, group] = rows;
    expect(owner).toMatchObject({ v: 1, durationMs: 9010, tools: 2, backfilled: true, overcounted: true, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 } });
    // The trigger is scrubbed like a live row's.
    expect(owner.trigger).toMatch(/^check this key /);
    expect(owner.trigger).not.toContain("x".repeat(40));
    expect(cron).toMatchObject({ jobId: "j1", jobName: "daily-brief", durationMs: 5000, trigger: "daily-brief" });
    expect(cron.overcounted).toBeUndefined();
    expect(system.jobId).toBeUndefined();
    expect(group).toMatchObject({ trigger: "hi all", durationMs: 1001 });
    for (const r of rows) { expect(r.snapshot).toBeUndefined(); expect(r.models).toBeUndefined(); }
  });

  it("decides over-counted by the owner's date", () => {
    // 2026-09-23 01:00 in Tokyo is still Sep 22 in Los Angeles.
    const ts = at("2026-09-23T01:00:00+09:00");
    const lines = [ev({ ts, type: "turn.start", sessionKey: "dm:owner", source: "user" }), ev({ ts: ts + 1, type: "turn.stats", sessionKey: "dm:owner", costUsd: 1 })];
    expect(rowsFromActivity(lines, LA)[0].overcounted).toBe(true);
    expect(rowsFromActivity(lines, "Asia/Tokyo")[0].overcounted).toBeUndefined();
  });
});

describe("backfillUsage", () => {
  let root: string, logs: string, usage: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tomo-backfill-"));
    logs = join(root, "logs"); usage = join(root, "data", "usage");
    mkdirSync(logs, { recursive: true });
    const lines = activity();
    // Split across a rotation: .1 is older than the live file.
    writeFileSync(join(logs, "activity.ndjson.1"), lines.slice(0, 9).join("\n") + "\n");
    writeFileSync(join(logs, "activity.ndjson"), lines.slice(9).join("\n") + "\n");
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const run = (dryRun = false) => backfillUsage({ logsDir: logs, usageDir: usage, timeZone: LA, dryRun });
  /** The ledger started after everything in the activity log. */
  const startedLate = () => writeLedgerStarted(usage, at("2026-11-15T00:00:00-08:00"));
  const listing = () => readdirSync(usage).sort();

  it("reads rotated files oldest first", () => {
    expect(activityFiles(logs).map((f) => f.slice(logs.length + 1))).toEqual(["activity.ndjson.1", "activity.ndjson"]);
  });

  it("refuses when the ledger never started (no marker), dry run included", () => {
    expect(() => run(true)).toThrow(BackfillError);
    expect(() => run()).toThrow(/never started/);
    expect(existsSync(usage)).toBe(false);
  });

  it("dry run reports and writes nothing", () => {
    startedLate();
    const report = run(true);
    expect(report).toMatchObject({ found: 5, afterStart: 0, fromLog: 5, existing: 0, added: 5, total: 5, days: 2, firstDay: "2026-09-22", lastDay: "2026-09-23", overcountedDays: 1, costUsd: 307.75 });
    expect(listing()).toEqual([LEDGER_STARTED_FILE]);
  });

  it("writes its own file, owner-only, each row with a stable id; a second run gives the same bytes", () => {
    startedLate();
    expect(run()).toMatchObject({ added: 5, total: 5 });
    const path = join(usage, BACKFILL_FILE);
    const first = readFileSync(path, "utf8");
    const rows = first.trim().split("\n").map((l) => JSON.parse(l) as UsageLedgerRow);
    expect(rows).toHaveLength(5);
    expect(rows[0].backfillId).toBe(backfillRowId("dm:owner", rows[0].ts));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(usage).mode & 0o777).toBe(0o700);

    expect(run()).toMatchObject({ existing: 5, added: 0, total: 5 });
    expect(readFileSync(path, "utf8")).toBe(first);
    // No month file, temp or lock left.
    expect(listing()).toEqual([BACKFILL_FILE, LEDGER_STARTED_FILE]);
  });

  it("tightens a wider file and directory on a run that adds nothing", () => {
    startedLate();
    run();
    const path = join(usage, BACKFILL_FILE);
    const bytes = readFileSync(path, "utf8");
    chmodSync(path, 0o644);
    chmodSync(usage, 0o755);
    expect(run()).toMatchObject({ added: 0, total: 5 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(usage).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("merges: after the log rotates, history already backfilled stays and new turns are added", () => {
    startedLate();
    run();
    const path = join(usage, BACKFILL_FILE);
    const before = readFileSync(path, "utf8").trim().split("\n");
    // Rotation dropped the oldest file (the owner's Sep 22 turn) and a new turn arrived.
    rmSync(join(logs, "activity.ndjson.1"));
    const t = at("2026-09-24T09:00:00-07:00");
    writeFileSync(join(logs, "activity.ndjson"), activity().slice(9).join("\n") + "\n" + [
      ev({ ts: t, type: "turn.start", sessionKey: "dm:owner", source: "continuity" }),
      ev({ ts: t + 10, type: "turn.stats", sessionKey: "dm:owner", costUsd: 2 }),
    ].join("\n") + "\n");
    expect(run()).toMatchObject({ fromLog: 5, existing: 5, added: 1, total: 6, firstDay: "2026-09-22", lastDay: "2026-09-24" });
    const after = readFileSync(path, "utf8").trim().split("\n");
    expect(after.filter((line) => before.includes(line))).toEqual(before);
    expect(after.some((line) => line.includes('"costUsd":283'))).toBe(true);
  });

  it("refuses an empty log, or one yielding under half of what is backfilled, unless forced", () => {
    startedLate();
    run();
    const path = join(usage, BACKFILL_FILE);
    const before = readFileSync(path, "utf8");
    // Empty: the logs directory is (for now) empty.
    rmSync(join(logs, "activity.ndjson.1")); rmSync(join(logs, "activity.ndjson"));
    expect(() => run()).toThrow(/yields no turns/);
    expect(() => run(true)).toThrow(BackfillError);
    // Cut short: only the last turn is left (1 of 5).
    writeFileSync(join(logs, "activity.ndjson"), activity().slice(-3).join("\n") + "\n");
    expect(() => run()).toThrow(/under half the 5/);
    expect(readFileSync(path, "utf8")).toBe(before);
    // Forced: merged, and still nothing removed.
    expect(backfillUsage({ logsDir: logs, usageDir: usage, timeZone: LA, dryRun: false, force: true })).toMatchObject({ fromLog: 1, added: 0, total: 5 });
    expect(readFileSync(path, "utf8")).toBe(before);
    // A first run with nothing to read is refused too.
    rmSync(path);
    rmSync(join(logs, "activity.ndjson"));
    expect(() => run()).toThrow(/yields no turns/);
    expect(existsSync(path)).toBe(false);
  });

  it("one backfill at a time: a second one refuses while the lock is held, a dead holder's lock is cleared", async () => {
    startedLate();
    const release = acquireBackfillLock(usage);
    expect(() => acquireBackfillLock(usage)).toThrow(new RegExp(`Another backfill is running \\(pid ${process.pid}\\)`));
    expect(() => run()).toThrow(BackfillError);
    expect(existsSync(join(usage, BACKFILL_FILE))).toBe(false);
    release();
    expect(run().total).toBe(5);

    // A lock left by a run that died.
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => child.on("exit", resolve));
    writeFileSync(join(usage, BACKFILL_LOCK_FILE), `${child.pid}\n`);
    expect(run().total).toBe(5);
    expect(existsSync(join(usage, BACKFILL_LOCK_FILE))).toBe(false);
  });

  it("the CLI exits 1 with the reason while another backfill holds the lock", async () => {
    startedLate();
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      writeFileSync(join(usage, BACKFILL_LOCK_FILE), `${holder.pid}\n`);
      const cli = promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli.ts", "usage", "backfill", "--logs-dir", logs, "--usage-dir", usage, "--timezone", LA]);
      await expect(cli).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(`Another backfill is running (pid ${holder.pid})`) });
      expect(existsSync(join(usage, BACKFILL_FILE))).toBe(false);
    } finally {
      holder.kill();
    }
  }, 30_000);

  it("stops at the ledger's start marker, so a live row carrying a failed row's cost is not counted twice", () => {
    // The ledger started between the cron turn and the system turn. The
    // system turn's row failed to land; the next live row of that session
    // carries its cost (0.25 + 22.5). The group turn landed on its own.
    writeLedgerStarted(usage, at("2026-09-23T06:00:30-07:00"));
    const live: UsageLedgerRow[] = [
      { v: 1, ts: at("2026-09-23T12:00:01-07:00"), sessionKey: "imessage:any;+;g1", source: "group", costUsd: 1.5, tokens: { input: 1, output: 1, cacheRead: 1, cacheCreated: 1 } },
      { v: 1, ts: at("2026-09-23T12:00:05-07:00"), sessionKey: "dm:owner", source: "background", costUsd: 22.75, tokens: { input: 1, output: 1, cacheRead: 1, cacheCreated: 1 } },
    ];
    writeFileSync(join(usage, ledgerFileName(live[0].ts)), live.map((r) => JSON.stringify(r) + "\n").join(""));
    const report = run();
    expect(report).toMatchObject({ found: 5, afterStart: 3, added: 2, total: 2, costUsd: 283.5 });
    const cost = buildCostReport(new LedgerReader(usage), { from: "2026-09-22", to: "2026-09-23", timeZone: LA, now: at("2026-09-30T12:00:00-07:00"),
      describeSession: (k) => ({ label: k, kind: "dm" }) });
    // Exactly what the activity log says was spent: nothing twice, nothing lost.
    expect(cost.totals.costUsd).toBeCloseTo(283 + 0.5 + 0.25 + 1.5 + 22.5, 9);
    expect(cost.totals.turns).toBe(4);
    expect(cost.days.map((d) => [d.date, d.overcounted, d.backfilled])).toEqual([["2026-09-22", true, true], ["2026-09-23", false, true]]);
  });

  it("the report reads both files and never a backfilled row from after the marker", () => {
    writeLedgerStarted(usage, at("2026-09-23T00:00:00-07:00"));
    writeFileSync(join(usage, BACKFILL_FILE), [
      { v: 1, ts: at("2026-09-22T10:00:00-07:00"), sessionKey: "dm:owner", source: "owner", costUsd: 3, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 }, backfilled: true },
      // Hand-made or stale: after the start, so the live ledger's to tell.
      { v: 1, ts: at("2026-09-23T10:00:00-07:00"), sessionKey: "dm:owner", source: "owner", costUsd: 100, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 }, backfilled: true },
    ].map((r) => JSON.stringify(r) + "\n").join(""));
    const ts = at("2026-09-23T10:00:00-07:00");
    writeFileSync(join(usage, ledgerFileName(ts)), JSON.stringify({ v: 1, ts, sessionKey: "dm:owner", source: "owner", costUsd: 4, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 } }) + "\n");
    const reader = new LedgerReader(usage);
    const cost = () => buildCostReport(reader, { from: "2026-09-22", to: "2026-09-23", timeZone: LA, now: at("2026-09-30T12:00:00-07:00"),
      describeSession: (k) => ({ label: k, kind: "dm" }) });
    expect(cost().days.map((d) => d.costUsd)).toEqual([3, 4]);
    expect(cost().recordedSince).toBe(at("2026-09-22T10:00:00-07:00"));
    // No marker: no history is added.
    rmSync(join(usage, LEDGER_STARTED_FILE));
    expect(cost().days.map((d) => d.costUsd)).toEqual([0, 4]);
  });
});
