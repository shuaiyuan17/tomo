import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "../src/sessions/types.js";
import { transcriptFileStem } from "../src/sessions/store.js";
import { makeSessionStore, transcriptPath, writeTranscript } from "./helpers/session-store-fixtures.js";

// `recallTranscript`: the scored search behind `recall_conversation`. The
// scoring itself is in recall-score.test.ts; this is the scan around it — the
// time window, the rotation archives, the scan budget, and a read set that is
// not in time order.

const ROOT = mkdtempSync(join(tmpdir(), "tomo-test-session-recall-"));
// The root is unique to this run, so nothing else will clean it up.
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(ROOT, "case-"));
});

const KEY = "test";
const STEM = transcriptFileStem(KEY);

/** A day in 2026, UTC. */
const day = (month: number, n: number) => Date.UTC(2026, month - 1, n);

const msg = (content: string, timestamp: number, overrides: Partial<SessionMessage> = {}): Record<string, unknown> => ({
  role: "user",
  content,
  channel: "telegram",
  timestamp,
  ...overrides,
});

function writeFile(name: string, records: unknown[]): void {
  writeFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const recall = (opts: Parameters<ReturnType<typeof makeSessionStore>["recallTranscript"]>[1]) =>
  makeSessionStore(dir).recallTranscript(KEY, opts);

const contents = (result: ReturnType<typeof recall>) => result.hits.map((hit) => hit.msg.content);

describe("recallTranscript", () => {
  it("scores across the active file and its rotation archives, oldest first", () => {
    writeFile(`_archive_${STEM}_2026-06.jsonl`, [
      msg("booked the Tokyo flight", day(6, 3)),
      msg("june chatter", day(6, 4)),
    ]);
    writeFile(`_archive_${STEM}_2026-07.jsonl`, [
      msg("july chatter", day(7, 1)),
      msg("flight to Tokyo moved a day", day(7, 9)),
    ]);
    writeTranscript(dir, KEY, [
      msg("august chatter", day(8, 1)),
      msg("Tokyo hotel confirmed, flight still pending", day(8, 2)),
    ]);

    const result = recall({ queries: ["Tokyo flight"] });

    expect(contents(result)).toEqual([
      "booked the Tokyo flight",
      "flight to Tokyo moved a day",
      "Tokyo hotel confirmed, flight still pending",
    ]);
    expect(result.scanned).toBe(6);
    expect(result.stopped).toBeUndefined();
  });

  it("stops at the window's lower bound and leaves out what is above its upper bound", () => {
    writeFile(`_archive_${STEM}_2026-06.jsonl`, [msg("ramen in june", day(6, 3))]);
    writeTranscript(dir, KEY, [
      msg("ramen on the 1st", day(8, 1)),
      msg("ramen on the 5th", day(8, 5)),
      msg("ramen on the 9th", day(8, 9)),
    ]);

    const result = recall({ queries: ["ramen"], fromTime: day(8, 1), toTime: day(8, 5) });

    expect(contents(result)).toEqual(["ramen on the 1st", "ramen on the 5th"]);
    // The June archive is behind the lower bound: never read.
    expect(result.scanned).toBe(3);
    expect(result.stopped).toBeUndefined();
  });

  it("skips a record that cannot be placed under a bound, without ending the scan on it", () => {
    writeTranscript(dir, KEY, [
      msg("ramen, dated", day(8, 1)),
      msg("ramen, undated", 0),
      msg("ramen, dated later", day(8, 2)),
    ]);

    expect(contents(recall({ queries: ["ramen"], fromTime: day(7, 1) }))).toEqual(["ramen, dated", "ramen, dated later"]);
    // With no bound there is nothing to place it under.
    expect(contents(recall({ queries: ["ramen"] }))).toHaveLength(3);
  });

  it("skips records without string content", () => {
    writeTranscript(dir, KEY, [
      msg("ramen", day(8, 1)),
      { role: "user", channel: "telegram", timestamp: day(8, 2) },
      msg("ramen again", day(8, 3)),
    ]);

    expect(contents(recall({ queries: ["ramen"] }))).toEqual(["ramen", "ramen again"]);
  });

  it("stops when the byte budget runs out, and says how far back it got", () => {
    // Two archives of about 100 KB each behind a small active file. The budget
    // covers the active file and the newer archive, not the older one.
    const bulk = (month: number) => Array.from({ length: 500 }, (_, i) =>
      msg(`filler ${i} ${"x".repeat(150)}`, day(month, 1) + i * 60_000));
    writeFile(`_archive_${STEM}_2026-05.jsonl`, [msg("ramen in may", day(5, 1)), ...bulk(5)]);
    writeFile(`_archive_${STEM}_2026-06.jsonl`, [msg("ramen in june", day(6, 1) - 1), ...bulk(6)]);
    writeTranscript(dir, KEY, [msg("ramen in august", day(8, 1))]);

    const result = recall({ queries: ["ramen"], budget: { maxBytes: 150 * 1024 } });

    expect(contents(result)).toEqual(["ramen in june", "ramen in august"]);
    expect(result.stopped?.reason).toBe("bytes");
    // It got as far as the oldest record of the June archive.
    expect(result.stopped?.reachedBackTo).toBe(day(6, 1) - 1);

    // Unbounded, the same search reaches May.
    expect(contents(recall({ queries: ["ramen"], budget: { maxBytes: Infinity } }))).toContain("ramen in may");
  });

  it("stops inside a line longer than the byte budget instead of reading it whole", () => {
    // A record is only handed over once its whole line is read, so a budget
    // tested between records could not interrupt this one.
    writeTranscript(dir, KEY, [
      msg("ramen before the giant", day(8, 1)),
      msg(`giant ${"x".repeat(600 * 1024)}`, day(8, 2)),
      msg("ramen after the giant", day(8, 3)),
    ]);

    const result = recall({ queries: ["ramen"], budget: { maxBytes: 128 * 1024 } });

    expect(contents(result)).toEqual(["ramen after the giant"]);
    expect(result.stopped).toEqual({ reason: "bytes", reachedBackTo: day(8, 3) });
  });

  it("does not report a scan that reached the lower bound as cut short", () => {
    writeFile(`_archive_${STEM}_2026-05.jsonl`, [msg("ramen in may", day(5, 1))]);
    writeTranscript(dir, KEY, [msg("ramen in august", day(8, 1))]);
    const activeBytes = statSync(transcriptPath(dir, KEY)).size;

    // The budget is exactly the active file, so opening the archive overruns
    // it. But the first record read there is already behind the window: the
    // scan finished, it was not cut short.
    const result = recall({ queries: ["ramen"], fromTime: day(7, 1), budget: { maxBytes: activeBytes } });

    expect(contents(result)).toEqual(["ramen in august"]);
    expect(result.stopped).toBeUndefined();

    // Without the lower bound the same budget does cut it short.
    expect(recall({ queries: ["ramen"], budget: { maxBytes: activeBytes } }).stopped?.reason).toBe("bytes");
  });

  it("passes over a file that starts after `toTime`, so `before` reaches past what the budget covers", () => {
    // An active file far larger than the budget, all of it newer than the
    // window. Read from the newest record, the scan would spend the budget
    // there and never reach July.
    writeFile(`_archive_${STEM}_2026-07.jsonl`, [msg("ramen in july", day(7, 3))]);
    writeTranscript(dir, KEY, Array.from({ length: 1000 }, (_, i) =>
      msg(`filler ${i} ${"x".repeat(150)}`, day(8, 1) + i * 60_000)));

    // Room for the look at each file's first record, and nothing like the
    // 180 KB the active file would take.
    const result = recall({ queries: ["ramen"], toTime: day(7, 31), budget: { maxBytes: 100 * 1024 } });

    expect(contents(result)).toEqual(["ramen in july"]);
    expect(result.scanned).toBe(1);
    expect(result.stopped).toBeUndefined();
  });

  it("does not read far into a file to decide whether `toTime` rules it out", () => {
    // The first record is a line longer than the look the scan allows
    // itself. The file is then read like any other, within the budget.
    writeFile(`_archive_${STEM}_2026-07.jsonl`, [msg("ramen in july", day(7, 3))]);
    writeTranscript(dir, KEY, [
      msg(`giant ${"x".repeat(600 * 1024)}`, day(8, 1)),
      msg("ramen in august", day(8, 2)),
    ]);

    const result = recall({ queries: ["ramen"], toTime: day(7, 31), budget: { maxBytes: 128 * 1024 } });

    // 64 KB for the look, then the budget runs out inside the giant line.
    expect(contents(result)).toEqual([]);
    expect(result.stopped).toEqual({ reason: "bytes", reachedBackTo: day(8, 2) });
  });

  it("reads a file whose first record is undated even when the rest is after `toTime`", () => {
    // Only a record whose time is known may rule a file out.
    writeTranscript(dir, KEY, [
      msg("undated opener", 0),
      msg("ramen in july", day(7, 3)),
      msg("ramen in august", day(8, 3)),
    ]);

    expect(contents(recall({ queries: ["ramen"], toTime: day(7, 31) }))).toEqual(["ramen in july"]);
  });

  it("returns nothing for queries that are all blank", () => {
    writeTranscript(dir, KEY, [msg("ramen", day(8, 1))]);

    expect(recall({ queries: ["", "  "] })).toEqual({ hits: [], matched: 0, scanned: 0 });
  });
});

describe("recallTranscript over a read set with a legacy sidecar", () => {
  // A September active file, a JULY sidecar beside it, an AUGUST archive
  // behind both: files whose order says nothing about their records' time
  // (see `transcriptReadSet`).
  function seedOutOfOrderFamily(): void {
    writeTranscript(dir, KEY, [msg("ramen in september", day(9, 15)), msg("september chatter", day(9, 16))]);
    writeFile(`${STEM}.legacy-20260901-000000.jsonl`, [msg("july chatter", day(7, 14)), msg("ramen in july", day(7, 15))]);
    writeFile(`_archive_${STEM}_2026-08.jsonl`, [msg("ramen in august", day(8, 15))]);
  }

  it("scores every file and orders the result by the records' own time", () => {
    seedOutOfOrderFamily();

    const result = recall({ queries: ["ramen"] });

    expect(contents(result)).toEqual(["ramen in july", "ramen in august", "ramen in september"]);
    expect(result.scanned).toBe(5);
  });

  it("does not end the scan at a record behind the lower bound", () => {
    seedOutOfOrderFamily();

    // The July sidecar sits between the active file and the August archive.
    expect(contents(recall({ queries: ["ramen"], fromTime: day(8, 1) })))
      .toEqual(["ramen in august", "ramen in september"]);
    expect(contents(recall({ queries: ["ramen"], fromTime: day(7, 1), toTime: day(8, 31) })))
      .toEqual(["ramen in july", "ramen in august"]);
  });

  it("keeps the newest of equally scored records by timestamp, not by file", () => {
    seedOutOfOrderFamily();

    expect(contents(recall({ queries: ["ramen"], limit: 2 }))).toEqual(["ramen in august", "ramen in september"]);
  });

  it("names no date when the budget runs out, because none would mean anything", () => {
    seedOutOfOrderFamily();
    let readings = 0;

    const result = recall({ queries: ["ramen"], budget: { now: () => (++readings >= 2 ? 1000 : 0) } });

    expect(result.stopped).toEqual({ reason: "time", reachedBackTo: null });
  });
});
