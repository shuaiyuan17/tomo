import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_EVERY_MS,
  MIN_EVERY_MS,
  ONE_SHOT_STALE_AFTER_MS,
  parseCreatableSchedule,
  parseScheduleString,
  parseStaleAfter,
  staleWindowMs,
  unschedulableReason,
} from "../src/cron/schedule.js";
import { POLL_INTERVAL_MS } from "../src/cron/scheduler.js";
import { cronAddRefusal } from "../src/cli/cron-errors.js";

// The schedule grammar (src/cron/schedule.ts) and the CLI's refusal line for
// it (src/cli/cron-errors.ts). Nothing here touches a CronStore.

// Every unit spelling the schedule grammar accepts, with its size in ms. The
// word spellings are also tried with a trailing plural "s" ("secs", "mins",
// "hrs", "days"); single letters take no plural.
const UNITS: ReadonlyArray<readonly [unit: string, ms: number]> = [
  ["s", 1_000],
  ["sec", 1_000],
  ["m", 60_000],
  ["min", 60_000],
  ["h", 3_600_000],
  ["hr", 3_600_000],
  ["d", 86_400_000],
  ["day", 86_400_000],
];
const SPELLINGS = UNITS.flatMap(([unit, ms]) =>
  unit.length > 1 ? [{ unit, ms }, { unit: `${unit}s`, ms }] : [{ unit, ms }],
);

// A bare letter followed by "s" used to be read as that letter's plural:
// "5ms" meant five minutes and "3ss" three seconds. Both are refused now.
const PLURAL_LETTERS = ["5ms", "3ss", "2hs", "1ds"];

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

describe("parseScheduleString", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(SPELLINGS)("in 3$unit is a one-shot 3 x $ms ms from now", ({ unit, ms }) => {
    expect(parseScheduleString(`in 3${unit}`)).toEqual({ kind: "at", at: new Date(NOW + 3 * ms).toISOString() });
    expect(parseScheduleString(`in 3 ${unit.toUpperCase()}`)).toEqual({ kind: "at", at: new Date(NOW + 3 * ms).toISOString() });
  });

  it.each(SPELLINGS)("every 3$unit is an interval of 3 x $ms ms", ({ unit, ms }) => {
    expect(parseScheduleString(`every 3${unit}`)).toEqual({ kind: "every", everyMs: 3 * ms });
    expect(parseScheduleString(`every 3 ${unit.toUpperCase()}`)).toEqual({ kind: "every", everyMs: 3 * ms });
  });

  it("parses a cron expression, in the host time zone", () => {
    const s = parseScheduleString("0 9 * * *");
    expect(s.kind).toBe("cron");
    if (s.kind === "cron") {
      expect(s.expr).toBe("0 9 * * *");
      expect(s.tz).toBeTruthy();
    }
  });

  it("parses an ISO date as a one-shot at that instant", () => {
    const s = parseScheduleString("2026-12-25T00:00:00Z");
    expect(s.kind).toBe("at");
    if (s.kind === "at") expect(Date.parse(s.at)).toBe(Date.UTC(2026, 11, 25));
  });
});

describe("parseStaleAfter units", () => {
  it.each(SPELLINGS)("3$unit is 3 x $ms ms", ({ unit, ms }) => {
    expect(parseStaleAfter(`3${unit}`)).toBe(3 * ms);
    expect(parseStaleAfter(` 3 ${unit.toUpperCase()} `)).toBe(3 * ms);
  });

  it("keeps its own whole-number guard, and refuses what is not a duration", () => {
    expect(parseStaleAfter("0")).toBe(0);
    expect(parseStaleAfter("soon")).toBeNull();
    expect(parseStaleAfter("-5m")).toBeNull();
    expect(parseStaleAfter("99999999999999999d")).toBeNull();
    expect(parseStaleAfter("3w")).toBeNull();
  });
});

describe("single-letter units take no plural", () => {
  // An unmatched string falls through to "cron expression", which croner then
  // rejects as malformed — the same refusal any other typo gets.
  it.each(PLURAL_LETTERS)("refuses %s everywhere", (text) => {
    for (const input of [`in ${text}`, `every ${text}`]) {
      const parsed = parseScheduleString(input);
      expect(parsed.kind).toBe("cron");
      expect(() => unschedulableReason(parsed, NOW)).toThrow(/CronPattern/);
    }
    expect(parseStaleAfter(text)).toBeNull();
  });
});

/** February 30th: a well-formed pattern croner accepts and never matches. */
const NEVER_CRON = "0 0 30 2 *";

describe("unschedulableReason", () => {
  const now = Date.parse("2026-05-01T12:00:00Z");

  it("passes a schedule that still has a future run", () => {
    expect(unschedulableReason({ kind: "every", everyMs: 60_000 }, now)).toBeNull();
    expect(unschedulableReason(parseScheduleString("0 9 * * *"), now)).toBeNull();
    expect(unschedulableReason({ kind: "at", at: "2026-05-01T13:00:00Z" }, now)).toBeNull();
  });

  it("names the past one-shot — the shape the model produces off a stale clock", () => {
    expect(unschedulableReason({ kind: "at", at: "2026-04-30T09:00:00Z" }, now))
      .toMatch(/is in the past$/);
  });

  it("names an `at` string that is not a date at all", () => {
    // `parseAtSchedule` returns NaN, which is neither > now nor a real time —
    // a different failure from "already happened" and worth saying so.
    expect(unschedulableReason({ kind: "at", at: "next tuesday-ish" }, now))
      .toMatch(/not a date\/time that can be parsed/);
  });

  it("refuses a zero interval — the schedule that is due again the moment it runs", () => {
    expect(unschedulableReason({ kind: "every", everyMs: 0 }, now))
      .toBe(`an interval of 0ms is below the ${MIN_EVERY_MS / 1000}s minimum`);
    // The user-facing route into the same value.
    expect(unschedulableReason(parseScheduleString("every 0s"), now)).not.toBeNull();
  });

  it("refuses an interval below the scheduler's poll and accepts exactly the minimum", () => {
    expect(unschedulableReason({ kind: "every", everyMs: MIN_EVERY_MS - 1 }, now))
      .toMatch(/below the 30s minimum$/);
    expect(unschedulableReason({ kind: "every", everyMs: MIN_EVERY_MS }, now)).toBeNull();
  });

  it("refuses an interval so large it stops being a safe integer", () => {
    // `every 99999999999999d` — Number gets an answer, the clock never does.
    const huge = parseScheduleString("every 99999999999999d");
    expect(huge).toEqual({ kind: "every", everyMs: 99999999999999 * 86_400_000 });
    expect(unschedulableReason(huge, now)).toBe("its interval is not a whole number of milliseconds");
    expect(unschedulableReason({ kind: "every", everyMs: MAX_EVERY_MS + 1 }, now))
      .toMatch(/above the 366-day maximum$/);
    expect(unschedulableReason({ kind: "every", everyMs: MAX_EVERY_MS }, now)).toBeNull();
  });

  it("keeps the floor pinned to the scheduler's poll interval", () => {
    // A job cannot fire more often than the scan that dispatches it; if one
    // of these moves, the other has to be looked at.
    expect(MIN_EVERY_MS).toBe(POLL_INTERVAL_MS);
  });

  it("names a recurring pattern with no occurrence left", () => {
    // The case a try/catch around computeNextRun cannot see: croner accepts
    // the pattern and simply returns null forever.
    expect(unschedulableReason(parseScheduleString(NEVER_CRON), now))
      .toBe("it has no future occurrence");
  });
});

describe("`tomo cron add` refusal", () => {
  it("refuses a time that has already passed, in one line", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const parsed = parseCreatableSchedule(past);
    expect(parsed.kind).toBe("unschedulable");
    expect(cronAddRefusal(past, parsed as Exclude<typeof parsed, { kind: "ok" }>))
      .toMatch(/^Cannot schedule ".*": .* is in the past, so the job could never fire\.$/);
  });

  it("refuses a recurring pattern that can never come round again", () => {
    const parsed = parseCreatableSchedule(NEVER_CRON);
    expect(parsed.kind).toBe("unschedulable");
    expect(cronAddRefusal(NEVER_CRON, parsed as Exclude<typeof parsed, { kind: "ok" }>))
      .toBe(`Cannot schedule "${NEVER_CRON}": it has no future occurrence, so the job could never fire.`);
  });

  it("turns croner's throw into one line instead of a stack trace", () => {
    // `parseScheduleString` funnels anything it does not recognise into
    // `kind: "cron"`, so a typo reaches croner — which throws only when the
    // expression is evaluated. The CLI used to print that stack at whoever
    // typed the command.
    const garbage = "whenever i feel like it";
    const parsed = parseCreatableSchedule(garbage);
    expect(parsed.kind).toBe("unparseable");
    const line = cronAddRefusal(garbage, parsed as Exclude<typeof parsed, { kind: "ok" }>);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toMatch(/^Cannot schedule "whenever i feel like it": not a schedule expression — /);
    expect(line).not.toMatch(/\bat Object\b|\bat Module\b/); // no stack frames
  });

  it("accepts a live schedule and hands back the parsed value", () => {
    const parsed = parseCreatableSchedule("every 2h");
    expect(parsed).toEqual({ kind: "ok", schedule: { kind: "every", everyMs: 7_200_000 } });
  });
});

describe("staleWindowMs", () => {
  it("scales the default with the period, and honours a per-job value", () => {
    const HOUR = 3_600_000;
    const every = (everyMs: number, staleAfterMs?: number) =>
      ({ schedule: { kind: "every" as const, everyMs }, deleteAfterRun: false, ...(staleAfterMs !== undefined ? { staleAfterMs } : {}) });
    const cron = (expr: string) => ({ schedule: { kind: "cron" as const, expr, tz: "UTC" }, deleteAfterRun: false });
    const from = Date.UTC(2026, 10, 7, 12);
    // Sub-daily: half the period, floored at 5 minutes.
    expect(staleWindowMs(every(HOUR), from)).toBe(30 * 60_000);
    expect(staleWindowMs(every(60_000), from)).toBe(5 * 60_000);
    // Daily: half the period = 12h (the cap).
    expect(staleWindowMs(every(24 * HOUR), from)).toBe(12 * HOUR);
    expect(staleWindowMs(cron("0 3 * * *"), Date.UTC(2026, 10, 7, 3))).toBe(12 * HOUR);
    // The period is measured FROM the missed slot: a weekday cron missed on a
    // Thursday is daily, one missed on a Friday waits 72h for Monday.
    expect(staleWindowMs(cron("0 9 * * 1-5"), Date.UTC(2026, 10, 12, 9))).toBe(12 * HOUR);
    expect(staleWindowMs(cron("0 9 * * 1-5"), Date.UTC(2026, 10, 13, 9))).toBe(0);
    // Longer than a day: always catch up.
    expect(staleWindowMs(every(14 * 24 * HOUR), from)).toBe(0);
    expect(staleWindowMs(cron("0 9 * * 1"), Date.UTC(2026, 10, 9, 9))).toBe(0);
    expect(staleWindowMs(cron("0 9 1 * *"), Date.UTC(2026, 10, 1, 9))).toBe(0);
    expect(staleWindowMs(cron("0 9 1 1,4,7,10 *"), Date.UTC(2026, 9, 1, 9))).toBe(0);
    expect(staleWindowMs(cron("0 9 1 12 *"), Date.UTC(2026, 11, 1, 9))).toBe(0);
    // No slot given: judged from the next occurrence.
    expect(staleWindowMs(cron("0 9 1 * *"))).toBe(0);
    // One-shots: a fixed retry window.
    expect(staleWindowMs({ schedule: { kind: "at", at: "2026-11-07T10:00" }, deleteAfterRun: true }, from)).toBe(ONE_SHOT_STALE_AFTER_MS);
    // Explicit values win; a damaged one falls back to the default.
    expect(staleWindowMs(every(24 * HOUR, 0), from)).toBe(0);
    expect(staleWindowMs(every(24 * HOUR, 600_000), from)).toBe(600_000);
    expect(staleWindowMs(every(HOUR, -1), from)).toBe(30 * 60_000);
  });
});
