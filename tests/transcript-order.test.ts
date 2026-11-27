import { describe, expect, it } from "vitest";
import {
  orderTimestamp,
  sortByRecordTime,
  usableSeq,
  usableTimestamp,
} from "../src/sessions/transcript-order.js";
import type { SessionMessage } from "../src/sessions/types.js";

/** The oldest instant a real record can carry: 2000-01-01T00:00:00Z. */
const FLOOR_MS = 946_684_800_000;
const T1 = Date.UTC(2026, 0, 1);
const T2 = T1 + 1000;
const T3 = T1 + 2000;

/**
 * A record as read off disk. `timestamp` and `seq` are `unknown` because a
 * transcript line can be hand-edited or written by an older version, which is
 * exactly what these helpers exist to survive.
 */
function record(content: string, fields: { timestamp?: unknown; seq?: unknown } = {}): SessionMessage {
  return { role: "user", content, channel: "test", ...fields } as unknown as SessionMessage;
}

const contents = (messages: readonly SessionMessage[]): string[] => messages.map((m) => m.content);

describe("usableSeq", () => {
  it.each<{ seq: number }>([{ seq: 0 }, { seq: 1 }, { seq: 12 }, { seq: -3 }, { seq: 4.5 }])(
    "returns the finite number $seq as it is",
    ({ seq }) => {
      expect(usableSeq(record("a", { seq, timestamp: T1 }))).toBe(seq);
    },
  );

  it.each<{ name: string; seq: unknown }>([
    { name: "a missing seq", seq: undefined },
    { name: "null", seq: null },
    { name: "the numeric string '12'", seq: "12" },
    { name: "an empty string", seq: "" },
    { name: "NaN", seq: Number.NaN },
    { name: "Infinity", seq: Number.POSITIVE_INFINITY },
    { name: "-Infinity", seq: Number.NEGATIVE_INFINITY },
    { name: "a boolean", seq: true },
  ])("returns null for $name, which cannot be ordered by", ({ seq }) => {
    expect(usableSeq(record("a", { seq, timestamp: T1 }))).toBeNull();
  });
});

describe("usableTimestamp", () => {
  it.each<{ name: string; timestamp: number }>([
    { name: "exactly 2000-01-01T00:00:00Z", timestamp: FLOOR_MS },
    { name: "one millisecond after the floor", timestamp: FLOOR_MS + 1 },
    { name: "a present-day millisecond epoch", timestamp: 1_700_000_000_000 },
    { name: "a fractional millisecond epoch", timestamp: T1 + 0.5 },
  ])("returns $name as it is", ({ timestamp }) => {
    expect(usableTimestamp(record("a", { timestamp }))).toBe(timestamp);
  });

  it.each<{ name: string; timestamp: unknown }>([
    { name: "a missing timestamp", timestamp: undefined },
    { name: "null", timestamp: null },
    { name: "zero", timestamp: 0 },
    { name: "a negative number", timestamp: -1 },
    { name: "a seconds-precision epoch (1_700_000_000)", timestamp: 1_700_000_000 },
    { name: "one millisecond before 2000-01-01", timestamp: FLOOR_MS - 1 },
    { name: "NaN", timestamp: Number.NaN },
    { name: "Infinity", timestamp: Number.POSITIVE_INFINITY },
    { name: "-Infinity", timestamp: Number.NEGATIVE_INFINITY },
    { name: "a millisecond epoch written as a string", timestamp: "1700000000000" },
    { name: "an ISO date string", timestamp: "2026-01-01T00:00:00Z" },
  ])("returns null for $name", ({ timestamp }) => {
    expect(usableTimestamp(record("a", { timestamp }))).toBeNull();
  });
});

describe("orderTimestamp", () => {
  it("is the record's own timestamp when that is usable", () => {
    expect(orderTimestamp(record("a", { timestamp: T1 }))).toBe(T1);
    expect(orderTimestamp(record("a", { timestamp: FLOOR_MS }))).toBe(FLOOR_MS);
  });

  it.each<{ name: string; timestamp: unknown }>([
    { name: "a missing timestamp", timestamp: undefined },
    { name: "zero", timestamp: 0 },
    { name: "a negative number", timestamp: -5 },
    { name: "a seconds-precision epoch", timestamp: 1_700_000_000 },
    { name: "NaN", timestamp: Number.NaN },
    { name: "Infinity", timestamp: Number.POSITIVE_INFINITY },
    { name: "a string", timestamp: "1700000000000" },
  ])("is -Infinity for $name, so the record sorts as older than every dated one", ({ timestamp }) => {
    expect(orderTimestamp(record("a", { timestamp }))).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("sortByRecordTime", () => {
  it("orders dated records oldest first", () => {
    const sorted = sortByRecordTime([
      record("third", { timestamp: T3 }),
      record("first", { timestamp: T1 }),
      record("second", { timestamp: T2 }),
    ]);
    expect(contents(sorted)).toEqual(["first", "second", "third"]);
  });

  it("puts records with no usable timestamp before every dated one, in their input order", () => {
    const sorted = sortByRecordTime([
      record("dated-late", { timestamp: T3 }),
      record("seconds-epoch", { timestamp: 1_700_000_000 }),
      record("dated-early", { timestamp: T1 }),
      record("zero", { timestamp: 0 }),
      record("missing"),
      record("dated-floor", { timestamp: FLOOR_MS }),
      record("nan", { timestamp: Number.NaN }),
      record("infinite", { timestamp: Number.POSITIVE_INFINITY }),
      record("negative", { timestamp: -1 }),
    ]);
    expect(contents(sorted)).toEqual([
      "seconds-epoch",
      "zero",
      "missing",
      "nan",
      "infinite",
      "negative",
      "dated-floor",
      "dated-early",
      "dated-late",
    ]);
  });

  it("keeps a whole run of undated records in input order", () => {
    // Long enough that an unstable or inconsistent comparator would show.
    const input = Array.from({ length: 200 }, (_, i) =>
      record(`undated-${i}`, i % 3 === 0 ? {} : { timestamp: i % 3 === 1 ? 0 : Number.NaN }),
    );
    const expected = contents(input);
    expect(contents(sortByRecordTime(input))).toEqual(expected);
  });

  it("keeps records with the same timestamp in input order", () => {
    const input = Array.from({ length: 200 }, (_, i) => record(`same-${i}`, { timestamp: T1 }));
    const expected = contents(input);
    expect(contents(sortByRecordTime(input))).toEqual(expected);
  });

  it("breaks ties by input order while still sorting the rest", () => {
    const sorted = sortByRecordTime([
      record("t2-a", { timestamp: T2 }),
      record("t1-a", { timestamp: T1 }),
      record("undated-a"),
      record("t2-b", { timestamp: T2 }),
      record("t1-b", { timestamp: T1 }),
      record("undated-b", { timestamp: 0 }),
      record("t2-c", { timestamp: T2 }),
    ]);
    expect(contents(sorted)).toEqual(["undated-a", "undated-b", "t1-a", "t1-b", "t2-a", "t2-b", "t2-c"]);
  });

  it("returns a new array of the same record objects and leaves the input untouched", () => {
    const late = record("late", { timestamp: T3 });
    const undated = record("undated");
    const early = record("early", { timestamp: T1 });
    // Frozen, so sorting it in place would throw rather than pass unnoticed.
    const input: readonly SessionMessage[] = Object.freeze([late, undated, early]);

    const sorted = sortByRecordTime(input);

    expect(sorted).not.toBe(input);
    expect(sorted).toHaveLength(3);
    expect(sorted[0]).toBe(undated);
    expect(sorted[1]).toBe(early);
    expect(sorted[2]).toBe(late);
    expect(input[0]).toBe(late);
    expect(input[1]).toBe(undated);
    expect(input[2]).toBe(early);
  });

  it("returns an empty array for an empty input", () => {
    expect(sortByRecordTime([])).toEqual([]);
  });
});
