import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseScheduleString, parseStaleAfter } from "../src/cron/store.js";

// Every unit spelling the schedule grammar accepts, with its size in ms. Each
// is also tried with a trailing plural "s" ("mins", "hrs", "days", ...).
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
const SPELLINGS = UNITS.flatMap(([unit, ms]) => [
  { unit, ms },
  { unit: `${unit}s`, ms },
]);

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

describe("parseScheduleString units", () => {
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
});

describe("parseStaleAfter units", () => {
  it.each(SPELLINGS)("3$unit is 3 x $ms ms", ({ unit, ms }) => {
    expect(parseStaleAfter(`3${unit}`)).toBe(3 * ms);
    expect(parseStaleAfter(` 3 ${unit.toUpperCase()} `)).toBe(3 * ms);
  });

  it("keeps its own whole-number guard", () => {
    expect(parseStaleAfter("0")).toBe(0);
    expect(parseStaleAfter("99999999999999999d")).toBeNull();
    expect(parseStaleAfter("3w")).toBeNull();
  });
});
