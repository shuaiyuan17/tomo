import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "../src/sessions/types.js";
import { makeSessionStore, writeTranscript } from "./helpers/session-store-fixtures.js";

// The two read paths over history: `searchTranscript` (Tomo's own transcript
// and its rotation archives) and `searchArchive` (an archived SDK session's
// JSONL). Rotation itself, and search across rotated months, is in
// session-store.test.ts ("transcript tail-loading and rotation").

const ROOT = mkdtempSync(join(tmpdir(), "tomo-test-session-search-"));
// The root is unique to this run, so nothing else will clean it up.
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(ROOT, "case-"));
});

const msg = (overrides: Partial<SessionMessage> = {}): Record<string, unknown> => ({
  role: "user",
  content: "hello",
  channel: "telegram",
  timestamp: 1_700_000_000_000,
  ...overrides,
});

/** A day in August 2026, UTC. */
const day = (n: number) => Date.UTC(2026, 7, n);

function writeArchiveFile(name: string, records: unknown[]): void {
  writeFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const search = (opts: Parameters<ReturnType<typeof makeSessionStore>["searchTranscript"]>[1]) =>
  makeSessionStore(dir).searchTranscript("test", opts);

describe("searchTranscript", () => {
  it("returns the most recent matches in chronological order, and applies seq ranges", () => {
    writeTranscript(dir, "test", Array.from({ length: 40 }, (_, i) =>
      msg({ content: i % 2 === 0 ? `even ${i}` : `odd ${i}`, seq: i + 1, timestamp: 1000 + i })));

    expect(search({ query: "even", limit: 3 }).map((r) => r.content)).toEqual(["even 34", "even 36", "even 38"]);
    expect(search({ fromSeq: 5, toSeq: 8, limit: 10 }).map((r) => r.seq)).toEqual([5, 6, 7, 8]);
  });
});

// ---------------------------------------------------------------------------
// searchTranscript scans newest→oldest and stops at the first record older
// than the window's lower bound. Only a record whose position is KNOWN may end
// that scan: `break outer` abandons the rest of the file AND every rotation
// archive behind it, so one corrupt or legacy record truncates the whole
// answer while the search still reports success.
//
// Two bounds do this. `fromTime` is the live one — recall_conversation's
// `after` argument is the only lower bound any caller passes
// (recall-tools.ts, Agent.searchSessionTranscript), and a legacy record with
// `timestamp: 0` sits below every `after`. `fromSeq` has the same shape for
// direct callers of the store API.
// ---------------------------------------------------------------------------

describe("searchTranscript with records that cannot be placed in the window", () => {
  it("skips a seq-less record instead of ending the scan of the file", () => {
    // A hand-edited/legacy record sits between seq 3 and seq 4.
    writeTranscript(dir, "test", [
      msg({ content: "one", seq: 1 }),
      msg({ content: "two", seq: 2 }),
      msg({ content: "three", seq: 3 }),
      msg({ content: "legacy" }),
      msg({ content: "four", seq: 4 }),
      msg({ content: "five", seq: 5 }),
    ]);

    expect(search({ fromSeq: 2, limit: 50 }).map((r) => r.content)).toEqual(["two", "three", "four", "five"]);
  });

  it("still reaches the rotation archives behind a seq-less record", () => {
    writeArchiveFile("_archive_test_2020-01.jsonl", [
      msg({ content: "archived one", seq: 1, timestamp: Date.UTC(2020, 0, 15) }),
      msg({ content: "archived two", seq: 2, timestamp: Date.UTC(2020, 0, 16) }),
    ]);
    writeTranscript(dir, "test", [
      msg({ content: "legacy" }),
      msg({ content: "recent", seq: 3 }),
    ]);

    expect(search({ fromSeq: 1, limit: 50 }).map((r) => r.content)).toEqual(["archived one", "archived two", "recent"]);
  });

  // --- fromTime: the bound recall_conversation actually passes ------------

  it("skips a record with a corrupt timestamp instead of ending the scan", () => {
    // A legacy record carrying `timestamp: 0` (the epoch) sits between two
    // real days. Under `after: 2026-08-10` it used to end the scan.
    writeTranscript(dir, "test", [
      msg({ content: "aug 11", seq: 1, timestamp: day(11) }),
      msg({ content: "legacy", seq: 2, timestamp: 0 }),
      msg({ content: "aug 13", seq: 3, timestamp: day(13) }),
    ]);

    expect(search({ fromTime: day(10), limit: 50 }).map((r) => r.content)).toEqual(["aug 11", "aug 13"]);
  });

  it("still reaches the rotation archives behind a corrupt timestamp", () => {
    writeArchiveFile("_archive_test_2026-07.jsonl", [
      msg({ content: "archived", seq: 1, timestamp: Date.UTC(2026, 6, 20) }),
    ]);
    writeTranscript(dir, "test", [
      msg({ content: "legacy", seq: 2, timestamp: 0 }),
      msg({ content: "recent", seq: 3, timestamp: day(13) }),
    ]);

    // `after: 2026-07-01` covers both real records; the archive was dropped.
    expect(search({ fromTime: Date.UTC(2026, 6, 1), limit: 50 }).map((r) => r.content)).toEqual(["archived", "recent"]);
  });

  it("treats a seconds-precision timestamp as unusable rather than ancient", () => {
    writeTranscript(dir, "test", [
      msg({ content: "aug 11", seq: 1, timestamp: day(11) }),
      // Seconds where milliseconds were expected: 1970-01-20, not 2023.
      msg({ content: "seconds", seq: 2, timestamp: 1_700_000_000 }),
      msg({ content: "aug 13", seq: 3, timestamp: day(13) }),
    ]);

    expect(search({ fromTime: day(10), limit: 50 }).map((r) => r.content)).toEqual(["aug 11", "aug 13"]);
  });

  // --- upper bounds stay consistent with the lower ones -------------------

  it("excludes a seq-less record from a toSeq-bounded search", () => {
    writeTranscript(dir, "test", [
      msg({ content: "one", seq: 1 }),
      msg({ content: "legacy" }),
      msg({ content: "three", seq: 3 }),
    ]);

    // It used to be coerced to seq 0 and silently included in every upper
    // bound; a record that cannot be placed in the window is not in it.
    expect(search({ toSeq: 2, limit: 50 }).map((r) => r.content)).toEqual(["one"]);
  });

  it("excludes a record with a corrupt timestamp from a toTime-bounded search", () => {
    writeTranscript(dir, "test", [
      msg({ content: "aug 11", seq: 1, timestamp: day(11) }),
      msg({ content: "legacy", seq: 2, timestamp: 0 }),
      msg({ content: "aug 13", seq: 3, timestamp: day(13) }),
    ]);

    // `before` is the bound recall_conversation pages with; an epoch-0 record
    // used to be "older than everything" and so inside every `before`.
    expect(search({ toTime: day(12), limit: 50 }).map((r) => r.content)).toEqual(["aug 11"]);
  });

  it("ends the whole scan at a placeable record below the bound — archives behind it are not read", () => {
    // Pins `break outer` as opposed to `continue`: with in-order data the two
    // are indistinguishable, so put a record ABOVE the bound in an archive
    // behind a record BELOW it in the active file. Early exit never sees it;
    // a full scan would return it. (Out of order across files does not occur
    // in practice — this is the one arrangement that makes the exit visible.)
    writeArchiveFile("_archive_test_2020-01.jsonl", [
      msg({ content: "archived, above the bound", seq: 9, timestamp: Date.UTC(2020, 0, 15) }),
    ]);
    writeTranscript(dir, "test", [
      msg({ content: "below the bound", seq: 1 }),
    ]);

    expect(search({ fromSeq: 5, limit: 50 })).toEqual([]);
  });
});

describe("searchArchive (an archived SDK session)", () => {
  const SDK_ID = "11111111-2222-3333-4444-555555555555";

  function writeArchive(lines: string[]): void {
    writeFileSync(join(dir, `_archive_${SDK_ID}.jsonl`), lines.join("\n") + "\n");
  }

  const searchArchive = (opts: Parameters<ReturnType<typeof makeSessionStore>["searchArchive"]>[1]) => {
    mkdirSync(join(dir, "sdk-sessions"), { recursive: true });
    return makeSessionStore(dir).searchArchive(SDK_ID, opts);
  };

  it("returns nothing when there is no archive", () => {
    expect(searchArchive({})).toEqual([]);
  });

  it("reads string content", () => {
    writeArchive([
      JSON.stringify({ type: "user", timestamp: "2026-01-02T03:04:05.000Z", message: { role: "user", content: "  plain words  " } }),
    ]);
    expect(searchArchive({})).toEqual([
      { role: "user", content: "plain words", channel: "archive", timestamp: Date.parse("2026-01-02T03:04:05.000Z") },
    ]);
  });

  it("joins text blocks with a space and ignores other blocks", () => {
    writeArchive([
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "first" },
            { type: "tool_use", name: "Bash", input: {} },
            { type: "text", text: "second" },
          ],
        },
      }),
    ]);
    const [hit] = searchArchive({});
    expect(hit.role).toBe("assistant");
    expect(hit.content).toBe("first second");
    expect(hit.timestamp).toBe(0);
  });

  it("keeps a separator for missing text and stringifies non-string text", () => {
    writeArchive([
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text" },
            { type: "text", text: null },
            { type: "text", text: 42 },
            { type: "image", text: "not text" },
            null,
            { type: "text", text: "b" },
          ],
        },
      }),
    ]);
    expect(searchArchive({}).map((m) => m.content)).toEqual(["a   42 b"]);
  });

  it("skips malformed lines and non-conversation events", () => {
    writeArchive([
      "{not json",
      "null",
      "42",
      JSON.stringify({ type: "system", message: { role: "user", content: "system noise" } }),
      JSON.stringify({ type: "user" }),
      JSON.stringify({ type: "user", message: { role: "user", content: 7 } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "out" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "survivor" } }),
    ]);
    expect(searchArchive({}).map((m) => m.content)).toEqual(["survivor"]);
  });

  it("filters by query (case-insensitive) and respects limit", () => {
    writeArchive([
      JSON.stringify({ type: "user", message: { role: "user", content: "Coffee one" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "tea" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "coffee two" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "COFFEE three" } }),
    ]);
    expect(searchArchive({ query: "coffee", limit: 2 }).map((m) => m.content)).toEqual(["Coffee one", "coffee two"]);
  });
});
