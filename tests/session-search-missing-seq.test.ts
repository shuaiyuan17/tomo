import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage } from "../src/sessions/types.js";
import type { SessionStore as SessionStoreType } from "../src/sessions/store.js";

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
//
// The store is handed an explicit scratch directory, and HOME/TOMO_WORKSPACE
// are stubbed before the module is imported so nothing resolves against the
// developer's real ~/.tomo.
// ---------------------------------------------------------------------------

let dir = "";
let home = "";
let SessionStore: typeof SessionStoreType;

const msg = (overrides: Partial<SessionMessage> = {}): Record<string, unknown> => ({
  role: "user",
  content: "hello",
  channel: "telegram",
  timestamp: 1_700_000_000_000,
  ...overrides,
});

function writeJsonl(path: string, messages: unknown[]): void {
  writeFileSync(path, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
}

function makeStore(): SessionStoreType {
  return new SessionStore(dir, 20, join(dir, "sdk-sessions"));
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tomo-search-seq-home-"));
  dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("TOMO_WORKSPACE", join(home, "workspace"));
  ({ SessionStore } = await import("../src/sessions/store.js"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
  dir = "";
});

describe("searchTranscript with records that cannot be placed in the window", () => {
  it("skips a seq-less record instead of ending the scan of the file", () => {
    // A hand-edited/legacy record sits between seq 3 and seq 4.
    writeJsonl(join(dir, "test.jsonl"), [
      msg({ content: "one", seq: 1 }),
      msg({ content: "two", seq: 2 }),
      msg({ content: "three", seq: 3 }),
      msg({ content: "legacy" }),
      msg({ content: "four", seq: 4 }),
      msg({ content: "five", seq: 5 }),
    ]);

    const results = makeStore().searchTranscript("test", { fromSeq: 2, limit: 50 });
    expect(results.map((r) => r.content)).toEqual(["two", "three", "four", "five"]);
  });

  it("still reaches the rotation archives behind a seq-less record", () => {
    writeJsonl(join(dir, "_archive_test_2020-01.jsonl"), [
      msg({ content: "archived one", seq: 1, timestamp: Date.UTC(2020, 0, 15) }),
      msg({ content: "archived two", seq: 2, timestamp: Date.UTC(2020, 0, 16) }),
    ]);
    writeJsonl(join(dir, "test.jsonl"), [
      msg({ content: "legacy" }),
      msg({ content: "recent", seq: 3 }),
    ]);

    const results = makeStore().searchTranscript("test", { fromSeq: 1, limit: 50 });
    expect(results.map((r) => r.content)).toEqual(["archived one", "archived two", "recent"]);
  });

  // --- fromTime: the bound recall_conversation actually passes ------------

  it("skips a record with a corrupt timestamp instead of ending the scan", () => {
    const day = (n: number) => Date.UTC(2026, 7, n);
    // A legacy record carrying `timestamp: 0` (the epoch) sits between two
    // real days. Under `after: 2026-08-10` it used to end the scan.
    writeJsonl(join(dir, "test.jsonl"), [
      msg({ content: "aug 11", seq: 1, timestamp: day(11) }),
      msg({ content: "legacy", seq: 2, timestamp: 0 }),
      msg({ content: "aug 13", seq: 3, timestamp: day(13) }),
    ]);

    const results = makeStore().searchTranscript("test", { fromTime: day(10), limit: 50 });
    expect(results.map((r) => r.content)).toEqual(["aug 11", "aug 13"]);
  });

  it("still reaches the rotation archives behind a corrupt timestamp", () => {
    const day = (n: number) => Date.UTC(2026, 7, n);
    writeJsonl(join(dir, "_archive_test_2026-07.jsonl"), [
      msg({ content: "archived", seq: 1, timestamp: Date.UTC(2026, 6, 20) }),
    ]);
    writeJsonl(join(dir, "test.jsonl"), [
      msg({ content: "legacy", seq: 2, timestamp: 0 }),
      msg({ content: "recent", seq: 3, timestamp: day(13) }),
    ]);

    // `after: 2026-07-01` covers both real records; the archive was dropped.
    const results = makeStore().searchTranscript("test", { fromTime: Date.UTC(2026, 6, 1), limit: 50 });
    expect(results.map((r) => r.content)).toEqual(["archived", "recent"]);
  });

  it("treats a seconds-precision timestamp as unusable rather than ancient", () => {
    const day = (n: number) => Date.UTC(2026, 7, n);
    writeJsonl(join(dir, "test.jsonl"), [
      msg({ content: "aug 11", seq: 1, timestamp: day(11) }),
      // Seconds where milliseconds were expected: 1970-01-20, not 2023.
      msg({ content: "seconds", seq: 2, timestamp: 1_700_000_000 }),
      msg({ content: "aug 13", seq: 3, timestamp: day(13) }),
    ]);

    const results = makeStore().searchTranscript("test", { fromTime: day(10), limit: 50 });
    expect(results.map((r) => r.content)).toEqual(["aug 11", "aug 13"]);
  });

  // --- upper bounds stay consistent with the lower ones -------------------

  it("excludes a seq-less record from a toSeq-bounded search", () => {
    writeJsonl(join(dir, "test.jsonl"), [
      msg({ content: "one", seq: 1 }),
      msg({ content: "legacy" }),
      msg({ content: "three", seq: 3 }),
    ]);

    // It used to be coerced to seq 0 and silently included in every upper
    // bound; a record that cannot be placed in the window is not in it.
    const results = makeStore().searchTranscript("test", { toSeq: 2, limit: 50 });
    expect(results.map((r) => r.content)).toEqual(["one"]);
  });

  it("excludes a record with a corrupt timestamp from a toTime-bounded search", () => {
    const day = (n: number) => Date.UTC(2026, 7, n);
    writeJsonl(join(dir, "test.jsonl"), [
      msg({ content: "aug 11", seq: 1, timestamp: day(11) }),
      msg({ content: "legacy", seq: 2, timestamp: 0 }),
      msg({ content: "aug 13", seq: 3, timestamp: day(13) }),
    ]);

    // `before` is the bound recall_conversation pages with; an epoch-0 record
    // used to be "older than everything" and so inside every `before`.
    const results = makeStore().searchTranscript("test", { toTime: day(12), limit: 50 });
    expect(results.map((r) => r.content)).toEqual(["aug 11"]);
  });

  it("still stops early at a record genuinely older than the window", () => {
    writeJsonl(join(dir, "test.jsonl"), Array.from({ length: 6 }, (_, i) =>
      msg({ content: `m${i + 1}`, seq: i + 1 })));

    const results = makeStore().searchTranscript("test", { fromSeq: 4, toSeq: 5, limit: 50 });
    expect(results.map((r) => r.seq)).toEqual([4, 5]);
  });

  it("ends the whole scan at a placeable record below the bound — archives behind it are not read", () => {
    // Pins `break outer` as opposed to `continue`: with in-order data the two
    // are indistinguishable, so put a record ABOVE the bound in an archive
    // behind a record BELOW it in the active file. Early exit never sees it;
    // a full scan would return it. (Out of order across files does not occur
    // in practice — this is the one arrangement that makes the exit visible.)
    writeJsonl(join(dir, "_archive_test_2020-01.jsonl"), [
      msg({ content: "archived, above the bound", seq: 9, timestamp: Date.UTC(2020, 0, 15) }),
    ]);
    writeJsonl(join(dir, "test.jsonl"), [
      msg({ content: "below the bound", seq: 1 }),
    ]);

    const results = makeStore().searchTranscript("test", { fromSeq: 5, limit: 50 });
    expect(results).toEqual([]);
  });
});
