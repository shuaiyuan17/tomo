/**
 * A realistic usage ledger for the Study's Cost page (gallery and E2E): ten
 * weeks of turns shaped like a real install's (a quiet night, a late-morning
 * peak, cron jobs at fixed hours, a group chat, the odd costly turn), the
 * oldest days flagged over-counted, and a quota sample. Deterministic for a
 * given `now`. Writes only under `tomoHome` (a test's temporary home).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerFileName, type UsageLedgerRow } from "../../src/usage/ledger.js";
import { usageDataDir } from "../../src/usage/dir.js";

const DAY = 86_400_000;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OWNER_TRIGGERS = [
  "Why did the notes in workspace/memory/CONTINUITY.md disappear?", "Should I create the GitHub repo?", "Can you check why the morning brief ran twice?",
  "The last task shows the wrong model for the memory analysis, is that a bug?", "Plan a weekend hiking trip, with a packing list",
  "Make sure we use everything useful the latest SDK reports", "Look at the failing CI on the release branch",
  "Check this week's calendar for conflicts", "Summarise the three PRs that landed today", "When is the next team meeting?",
  "Subagents or sub-sessions for background work: which is better?", "Rewrite the README intro, it reads like a changelog",
];
const GROUP_TRIGGERS = ["Who's bringing the second rope?", "Can someone book the campsite for Friday?", "Next month: Piranesi.", "Sam: permits are sorted 🎉"];
const JOBS = [
  { jobId: "job-brief", jobName: "Morning brief", hour: 8, cost: 1.4 },
  { jobId: "job-water", jobName: "Water the seedlings — check the soil moisture in all three beds first", hour: 15, cost: 0.35 },
  { jobId: "job-review", jobName: "Weekly PR review", hour: 20, cost: 4.2, weekday: 0 },
];

export interface CostFixtureOptions {
  now?: number;
  /** Days of history including today (default 72, a little over ten weeks). */
  days?: number;
  /** Days at the start of the history flagged over-counted (default 16). */
  overcountedDays?: number;
  /** A quota sample in limits.ndjson (default true). */
  limits?: boolean;
  /** Sub-session turns over the last ten days (default true): own turns, relay turns, and old-style rows. */
  tasks?: boolean;
  seed?: number;
}

/** Writes the ledger month files (and limits.ndjson) under `tomoHome`; returns the rows written. */
export function seedCostLedger(tomoHome: string, options: CostFixtureOptions = {}): UsageLedgerRow[] {
  const now = options.now ?? Date.now();
  const days = options.days ?? 72;
  const overcountedDays = options.overcountedDays ?? 16;
  const random = rng(options.seed ?? 7);
  const between = (lo: number, hi: number) => lo + random() * (hi - lo);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const rows: UsageLedgerRow[] = [];
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  for (let back = days - 1; back >= 0; back--) {
    const start = new Date(midnight); start.setDate(start.getDate() - back);
    const dayStart = start.getTime();
    const weekday = start.getDay();
    const overcounted = back >= days - overcountedDays;
    // A busier weekday, a quieter weekend, and the odd heavy day.
    const load = (weekday === 0 || weekday === 6 ? 0.6 : 1) * (random() < 0.12 ? 2.6 : between(0.6, 1.4));
    const add = (hour: number, row: Omit<UsageLedgerRow, "v" | "ts" | "tokens">) => {
      const ts = dayStart + hour * 3_600_000 + Math.floor(between(0, 3_590_000));
      if (ts > now) return;
      const cost = overcounted && random() < 0.08 ? row.costUsd * between(15, 40) : row.costUsd;
      rows.push({ v: 1, ts, tokens: { input: Math.round(cost * 900), output: Math.round(cost * 4_000), cacheRead: Math.round(cost * 220_000), cacheCreated: Math.round(cost * 9_000) },
        ...row, costUsd: Math.round(cost * 10_000) / 10_000, ...(overcounted ? { overcounted: true as const, backfilled: true as const } : {}) });
    };
    // You: mostly late morning and evening.
    const ownerTurns = Math.round(between(18, 34) * load);
    for (let i = 0; i < ownerTurns; i++) {
      const hour = Math.min(23, Math.max(6, Math.round(random() < 0.6 ? between(9, 13) : between(14, 23))));
      const heavy = random() < 0.07;
      const durationMs = Math.round(heavy ? between(90_000, 600_000) : between(6_000, 45_000));
      add(hour, { sessionKey: "dm:owner", source: "owner", trigger: pick(OWNER_TRIGGERS), costUsd: heavy ? between(3, 9) : between(0.25, 2.2),
        durationMs, numTurns: Math.round(durationMs / 4000) + 1, tools: Math.round(heavy ? between(10, 50) : between(0, 8)) });
    }
    // The group chat, a few times a day.
    for (let i = 0, n = Math.round(between(0, 4)); i < n; i++) {
      add(Math.round(between(10, 21)), { sessionKey: "telegram:-100111", source: "group", trigger: pick(GROUP_TRIGGERS), costUsd: between(0.2, 1.1),
        durationMs: Math.round(between(4_000, 20_000)), numTurns: 2, tools: Math.round(between(0, 3)) });
    }
    // Background: heartbeats overnight and finished subagents through the day.
    for (let i = 0, n = Math.round(between(4, 10) * load); i < n; i++) {
      const finished = random() < 0.5;
      add(Math.round(between(0, 23)), { sessionKey: "dm:owner", source: finished ? "background" : "heartbeat", costUsd: finished ? between(0.8, 4) : between(0.15, 0.6),
        durationMs: Math.round(between(5_000, 30_000)), numTurns: 3, tools: Math.round(between(1, 6)) });
    }
    // Scheduled: the cron jobs at their hours, plus a nightly rollup with no job.
    for (const job of JOBS) {
      if (job.weekday !== undefined && job.weekday !== weekday) continue;
      add(job.hour, { sessionKey: "dm:owner", source: "cron", jobId: job.jobId, jobName: job.jobName, costUsd: job.cost * between(0.7, 1.3),
        durationMs: Math.round(between(15_000, 90_000)), numTurns: 6, tools: Math.round(between(2, 12)) });
    }
    add(3, { sessionKey: "dm:owner", source: "system", costUsd: between(0.3, 0.9), durationMs: 20_000, numTurns: 2, tools: 1 });
  }
  // Just after midnight today has nothing yet; a page that opens on today still needs a few turns to show.
  const todayStart = midnight.getTime();
  if (rows.filter((r) => r.ts >= todayStart).length < 4) {
    for (let k = 1; k <= 4; k++) {
      const ts = todayStart + Math.floor(((now - todayStart) * k) / 5);
      rows.push({ v: 1, ts, sessionKey: "dm:owner", source: "owner", trigger: pick(OWNER_TRIGGERS), costUsd: Math.round(between(0.4, 3) * 10_000) / 10_000,
        tokens: { input: 900, output: 4_000, cacheRead: 220_000, cacheCreated: 9_000 }, durationMs: Math.round(between(6_000, 45_000)), numTurns: 3, tools: Math.round(between(0, 8)) });
    }
  }
  if (options.tasks !== false) rows.push(...taskRows(now, Math.min(days, 10), options.seed ?? 7));
  rows.sort((a, b) => a.ts - b.ts);
  const dir = usageDataDir(tomoHome);
  mkdirSync(dir, { recursive: true });
  for (const row of rows) appendFileSync(join(dir, ledgerFileName(row.ts)), JSON.stringify(row) + "\n");
  if (options.limits !== false) {
    writeFileSync(join(dir, "limits.ndjson"), JSON.stringify({ v: 1, ts: new Date(now - 12 * 60_000).toISOString(), source: "oauth-usage", windows: [
      { window: "five_hour::", label: "Session (5h)", group: "session", scoped: false, percent: 34, resetsAt: new Date(now + 2 * 3_600_000 + 14 * 60_000).toISOString(), status: "normal" },
      { window: "seven_day::", label: "Weekly (all)", group: "weekly", scoped: false, percent: 61, resetsAt: new Date(now + 2.4 * DAY).toISOString(), status: "normal" },
      { window: "seven_day_opus:opus:", label: "Weekly · Opus", group: "weekly", scoped: true, percent: 72, resetsAt: new Date(now + 2.4 * DAY).toISOString(), status: "normal" },
    ] }) + "\n");
  }
  return rows;
}

const RELAY_REPORT = "A sub-session finished; its report is in a note above. Tell the owner the result in a few lines, in your own words";
const RELAY_MESSAGE = "A sub-session handed you something for the owner; it is in a note above. Pass it on as that note says";

/**
 * Sub-sessions over the last `span` days, on their own random stream (so the
 * rest of the ledger is the same with or without them): each task's own
 * turns on `task:<id>` (one with a forced-compaction summary call), the
 * owning session's report turn for it, a merged message wake tied to no one
 * task, and, for the oldest task, rows as they were written before tasks had
 * sources of their own (all `background`).
 */
function taskRows(now: number, span: number, seed: number): UsageLedgerRow[] {
  const random = rng(seed * 31 + 5);
  const between = (lo: number, hi: number) => lo + random() * (hi - lo);
  const rows: UsageLedgerRow[] = [];
  const tokens = (cost: number) => ({ input: Math.round(cost * 900), output: Math.round(cost * 4_000), cacheRead: Math.round(cost * 220_000), cacheCreated: Math.round(cost * 9_000) });
  const push = (ts: number, row: Omit<UsageLedgerRow, "v" | "ts" | "tokens">) => {
    if (ts > now) return;
    const costUsd = Math.round(row.costUsd * 10_000) / 10_000;
    rows.push({ v: 1, ts, tokens: tokens(costUsd), ...row, costUsd });
  };
  const count = 9;
  for (let n = 1; n <= count; n++) {
    const id = `s${n}`;
    const legacy = n === 1;
    const start = now - Math.round(((count - n + 0.5) / count) * span * 86_400_000 * 0.9);
    const turns = Math.round(between(1, 6));
    let ts = start;
    for (let i = 0; i < turns; i++) {
      ts += Math.round(between(2, 25) * 60_000);
      const heavy = i === 0;
      const durationMs = Math.round(heavy ? between(400_000, 3_000_000) : between(20_000, 400_000));
      push(ts, { sessionKey: `task:${id}`, source: legacy ? "background" : "task", ...(legacy ? {} : { taskId: id }),
        costUsd: heavy ? between(4, 18) : between(0.1, 3), durationMs, numTurns: Math.round(durationMs / 15_000) + 1, tools: Math.round(between(3, 60)) });
    }
    if (n === 4) push(ts + 60_000, { sessionKey: `task:${id}`, source: "task", taskId: id, trigger: "force-compact", costUsd: between(0.3, 0.8), durationMs: 40_000, numTurns: 1 });
    push(ts + 120_000, { sessionKey: "dm:owner", source: legacy ? "background" : "task-relay", ...(legacy ? {} : { taskId: id }), trigger: RELAY_REPORT,
      costUsd: between(0.2, 1.2), durationMs: Math.round(between(8_000, 40_000)), numTurns: 3, tools: Math.round(between(1, 4)) });
  }
  push(now - Math.round(span * 0.3 * 86_400_000), { sessionKey: "dm:owner", source: "task-relay", trigger: RELAY_MESSAGE, costUsd: 0.4, durationMs: 12_000, numTurns: 2, tools: 1 });
  return rows;
}
