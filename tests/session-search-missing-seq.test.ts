import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage } from "../src/sessions/types.js";
import type { SessionStore as SessionStoreType } from "../src/sessions/store.js";

// ---------------------------------------------------------------------------
// searchTranscript scans newest→oldest and stops at the first record older
// than the window. `seq` is optional, so a legacy or hand-edited record
// without one must not be read as "older than everything" — that ends the
// scan of this file and of every rotation archive behind it, and
// recall_conversation reports the truncated result as the whole answer.
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

describe("searchTranscript with records that have no seq", () => {
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

  it("still stops early at a record genuinely older than the window", () => {
    writeJsonl(join(dir, "test.jsonl"), Array.from({ length: 6 }, (_, i) =>
      msg({ content: `m${i + 1}`, seq: i + 1 })));

    const results = makeStore().searchTranscript("test", { fromSeq: 4, toSeq: 5, limit: 50 });
    expect(results.map((r) => r.seq)).toEqual([4, 5]);
  });
});
