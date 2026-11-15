import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityFiles, backfillUsage, rowsFromActivity } from "../src/usage/backfill.js";
import { ledgerFileName } from "../src/usage/ledger.js";

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

  const snapshotDir = () => Object.fromEntries(readdirSync(usage).sort().map((f) => [f, readFileSync(join(usage, f), "utf8")]));

  it("reads rotated files oldest first", () => {
    expect(activityFiles(logs).map((f) => f.slice(logs.length + 1))).toEqual(["activity.ndjson.1", "activity.ndjson"]);
  });

  it("dry run reports and writes nothing", async () => {
    const report = await backfillUsage({ logsDir: logs, usageDir: usage, timeZone: LA, dryRun: true });
    expect(report).toMatchObject({ found: 5, written: 5, days: 2, firstDay: "2026-09-22", lastDay: "2026-09-23", overcountedDays: 1, costUsd: 307.75 });
    expect(existsSync(usage)).toBe(false);
  });

  it("is idempotent: a second run writes nothing and leaves the files byte for byte", async () => {
    const first = await backfillUsage({ logsDir: logs, usageDir: usage, timeZone: LA, dryRun: false });
    expect(first.written).toBe(5);
    const files = snapshotDir();
    expect(Object.keys(files)).toEqual([...new Set([ledgerFileName(at("2026-09-22T10:00:00-07:00")), ledgerFileName(at("2026-09-23T12:00:00-07:00"))])]);
    expect(statSync(join(usage, Object.keys(files)[0])).mode & 0o777).toBe(0o600);

    const second = await backfillUsage({ logsDir: logs, usageDir: usage, timeZone: LA, dryRun: false });
    expect(second).toMatchObject({ found: 5, alreadyThere: 5, written: 0 });
    expect(snapshotDir()).toEqual(files);
    const third = await backfillUsage({ logsDir: logs, usageDir: usage, timeZone: LA, dryRun: true });
    expect(third.written).toBe(0);
  });

  it("writes nothing at or after the ledger's first live row", async () => {
    const live = { v: 1, ts: at("2026-09-23T12:00:00-07:00"), sessionKey: "dm:owner", source: "owner", costUsd: 9, tokens: { input: 1, output: 1, cacheRead: 1, cacheCreated: 1 } };
    mkdirSync(usage, { recursive: true });
    writeFileSync(join(usage, ledgerFileName(live.ts)), JSON.stringify(live) + "\n");
    const report = await backfillUsage({ logsDir: logs, usageDir: usage, timeZone: LA, dryRun: false });
    expect(report).toMatchObject({ found: 5, afterLedger: 2, written: 3, ledgerStartsAt: live.ts });
    const lines = Object.values(snapshotDir()).join("").trim().split("\n").map((l) => JSON.parse(l) as { ts: number; backfilled?: boolean });
    expect(lines.filter((l) => l.backfilled).every((l) => l.ts < live.ts)).toBe(true);
    expect(lines.filter((l) => !l.backfilled)).toHaveLength(1);
  });
});
