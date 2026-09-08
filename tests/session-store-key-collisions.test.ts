import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionMessage } from "../src/sessions/types.js";

/**
 * Transcript filenames must be injective in the session key.
 *
 * The old mapping replaced every character outside `[A-Za-z0-9_-]` with `_`,
 * which is many-to-one: `imessage:any;-;alex.smith@example.com` and
 * `imessage:any;-;alex_smith@example.com` are two different people whose
 * transcripts, rotation archives, searches and rotations all landed in the
 * same files. This file pins the encoding, the reproduction, and the lazy
 * migration that carries an existing legacy file over to its new name — or
 * deliberately refuses to, when the file could belong to more than one key.
 */
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

const { log } = await import("../src/logger.js");
const { SessionStore, transcriptFileStem, legacyTranscriptFileStem } = await import("../src/sessions/store.js");

const warn = log.warn as unknown as ReturnType<typeof vi.fn>;
const info = log.info as unknown as ReturnType<typeof vi.fn>;

const TEST_ROOT = join(tmpdir(), `tomo-test-key-collisions-${process.pid}`);
let testDir: string;
let counter = 0;

const ALEX_DOT = "imessage:any;-;alex.smith@example.com";
const ALEX_UNDERSCORE = "imessage:any;-;alex_smith@example.com";

function newStore(dir = testDir) {
  return new SessionStore(dir, 20, join(dir, "sdk-sessions"));
}

function msg(content: string, timestamp = Date.now()): SessionMessage {
  return { role: "user", content, channel: "imessage", timestamp };
}

function warningsMatching(needle: string): unknown[][] {
  return warn.mock.calls.filter((call) => String(call[1] ?? "").includes(needle));
}

beforeEach(() => {
  testDir = join(TEST_ROOT, `case-${counter++}`);
  mkdirSync(testDir, { recursive: true });
  warn.mockClear();
  info.mockClear();
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("transcriptFileStem", () => {
  it("gives two keys that differ only in an unsafe character different stems", () => {
    expect(legacyTranscriptFileStem(ALEX_DOT)).toBe(legacyTranscriptFileStem(ALEX_UNDERSCORE));
    expect(transcriptFileStem(ALEX_DOT)).not.toBe(transcriptFileStem(ALEX_UNDERSCORE));
  });

  it("leaves the everyday keys on exactly the filenames they already use", () => {
    for (const key of ["dm:alice", "telegram:123", "telegram:-100123", "dm:Alice-2"]) {
      expect(transcriptFileStem(key)).toBe(legacyTranscriptFileStem(key));
    }
    expect(transcriptFileStem("dm:alice")).toBe("dm_alice");
    expect(transcriptFileStem("telegram:-100123")).toBe("telegram_-100123");
  });

  it("suffixes an iMessage handle key, whose `+`/`@` would otherwise alias `:`", () => {
    // These DO move on first touch — that is what the lazy migration is for.
    expect(transcriptFileStem("imessage:+15551234567")).not.toBe("imessage__15551234567");
    expect(transcriptFileStem("imessage:+15551234567"))
      .not.toBe(transcriptFileStem("imessage::15551234567"));
  });

  it("suffixes a key containing `_`, which is indistinguishable from an encoded `:`", () => {
    // `dm:a_b` and `dm:a:b` share a legacy stem, so neither may keep it.
    expect(legacyTranscriptFileStem("dm:a_b")).toBe(legacyTranscriptFileStem("dm:a:b"));
    expect(transcriptFileStem("dm:a_b")).not.toBe("dm_a_b");
    expect(transcriptFileStem("dm:a:b")).toBe("dm_a_b");
    expect(transcriptFileStem("dm:a_b")).not.toBe(transcriptFileStem("dm:a:b"));
  });

  it("is injective over a corpus of realistic and awkward keys", () => {
    const keys = [
      "dm:alice", "dm:bob", "dm:a_b", "dm:a:b", "dm:a.b", "dm:a-b",
      "telegram:123", "telegram:-100123", "telegram:-100123_", "telegram:1_23",
      "imessage:+15551234567",
      ALEX_DOT, ALEX_UNDERSCORE,
      "imessage:chat123;+;abc", "imessage:any;-;a@b.co", "imessage:any_-_a_b_co",
      "dm:ünïcode", "dm:名前", "dm:emoji-🐈", "dm:", "", "dm:a/b", "dm:a\\b", "dm:a b",
    ];
    const stems = new Map<string, string>();
    for (const key of keys) {
      const stem = transcriptFileStem(key);
      expect(stems.has(stem), `${key} collides with ${stems.get(stem)}`).toBe(false);
      stems.set(stem, key);
      // A stem must never be usable as a path traversal or a directory hop.
      expect(stem).not.toMatch(/[/\\]/);
    }
    // The two families are disjoint by construction: suffixed stems carry a
    // `.`, legacy-shaped ones can never contain one.
    for (const [stem, key] of stems) {
      expect(stem.includes(".")).toBe(stem !== legacyTranscriptFileStem(key));
    }
  });

  it("is stable across calls", () => {
    for (const key of ["dm:ünïcode", ALEX_DOT, "dm:emoji-🐈"]) {
      expect(transcriptFileStem(key)).toBe(transcriptFileStem(key));
    }
  });
});

describe("transcript isolation between colliding keys", () => {
  it("does not leak one key's messages into another key that shared its legacy name", () => {
    const store = newStore();
    store.append(ALEX_DOT, msg("secret from the dotted address"));

    const other = store.get(ALEX_UNDERSCORE);
    expect(other.messages).toEqual([]);
    expect(store.searchTranscript(ALEX_UNDERSCORE, {})).toEqual([]);
    expect(store.searchTranscript(ALEX_UNDERSCORE, { query: "secret" })).toEqual([]);

    // …and the dotted address still sees its own history.
    expect(store.get(ALEX_DOT).messages).toHaveLength(1);
    expect(store.searchTranscript(ALEX_DOT, { query: "secret" })).toHaveLength(1);
  });

  it("keeps rotation archives separate too", () => {
    const store = newStore();
    const dotStem = transcriptFileStem(ALEX_DOT);
    const underscoreStem = transcriptFileStem(ALEX_UNDERSCORE);
    writeFileSync(
      join(testDir, `_archive_${dotStem}_2020-01.jsonl`),
      JSON.stringify(msg("archived for the dotted address", Date.parse("2020-01-05T00:00:00Z"))) + "\n",
    );

    expect(store.searchTranscript(ALEX_UNDERSCORE, {})).toEqual([]);
    expect(store.searchTranscript(ALEX_DOT, {})).toHaveLength(1);
    expect(underscoreStem).not.toBe(dotStem);
  });
});

describe("lazy migration of legacy transcript files", () => {
  /** Seed a legacy-named active transcript plus two monthly archives. */
  function seedLegacy(key: string): { legacy: string; stem: string } {
    const legacy = legacyTranscriptFileStem(key);
    writeFileSync(
      join(testDir, `${legacy}.jsonl`),
      JSON.stringify(msg("recent", Date.parse("2026-03-01T00:00:00Z"))) + "\n",
    );
    writeFileSync(
      join(testDir, `_archive_${legacy}_2026-01.jsonl`),
      JSON.stringify(msg("january", Date.parse("2026-01-02T00:00:00Z"))) + "\n",
    );
    writeFileSync(
      join(testDir, `_archive_${legacy}_2026-02.jsonl`),
      JSON.stringify(msg("february", Date.parse("2026-02-02T00:00:00Z"))) + "\n",
    );
    return { legacy, stem: transcriptFileStem(key) };
  }

  it("renames the active file and every archive when the key is the only owner", () => {
    const first = newStore();
    first.setSdkSessionId(ALEX_DOT, "sdk-1"); // the registry knows only this key
    const { legacy, stem } = seedLegacy(ALEX_DOT);

    const session = first.get(ALEX_DOT);

    expect(existsSync(join(testDir, `${legacy}.jsonl`))).toBe(false);
    expect(existsSync(join(testDir, `${stem}.jsonl`))).toBe(true);
    expect(existsSync(join(testDir, `_archive_${legacy}_2026-01.jsonl`))).toBe(false);
    expect(existsSync(join(testDir, `_archive_${stem}_2026-01.jsonl`))).toBe(true);
    expect(existsSync(join(testDir, `_archive_${stem}_2026-02.jsonl`))).toBe(true);

    // History, createdAt and search all still cover the migrated files.
    expect(session.messages.map((m) => m.content)).toEqual(["recent"]);
    expect(session.createdAt).toBe(Date.parse("2026-01-02T00:00:00Z"));
    expect(first.searchTranscript(ALEX_DOT, {}).map((m) => m.content))
      .toEqual(["january", "february", "recent"]);
    expect(info.mock.calls.some((c) => String(c[1] ?? "").includes("collision-free name"))).toBe(true);
  });

  it("is a no-op for a second store over the already-migrated directory", () => {
    const first = newStore();
    first.setSdkSessionId(ALEX_DOT, "sdk-1");
    const { legacy, stem } = seedLegacy(ALEX_DOT);
    first.get(ALEX_DOT);

    info.mockClear();
    const second = newStore();
    expect(second.get(ALEX_DOT).messages.map((m) => m.content)).toEqual(["recent"]);
    expect(existsSync(join(testDir, `${legacy}.jsonl`))).toBe(false);
    expect(existsSync(join(testDir, `${stem}.jsonl`))).toBe(true);
    expect(info.mock.calls.some((c) => String(c[1] ?? "").includes("collision-free name"))).toBe(false);
  });

  it("does nothing for a key with no legacy files", () => {
    const store = newStore();
    store.append(ALEX_DOT, msg("hello"));
    expect(existsSync(join(testDir, `${legacyTranscriptFileStem(ALEX_DOT)}.jsonl`))).toBe(false);
    expect(existsSync(join(testDir, `${transcriptFileStem(ALEX_DOT)}.jsonl`))).toBe(true);
    expect(warningsMatching("filename collision")).toHaveLength(0);
  });

  it("leaves the legacy file alone, warns once, and starts both keys fresh when ownership is ambiguous", () => {
    const store = newStore();
    // Both colliding keys are known to the registry before either is touched.
    store.setSdkSessionId(ALEX_DOT, "sdk-dot");
    store.setSdkSessionId(ALEX_UNDERSCORE, "sdk-underscore");
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    const legacyPath = join(testDir, `${legacy}.jsonl`);
    writeFileSync(legacyPath, JSON.stringify(msg("mixed history")) + "\n");

    expect(store.get(ALEX_DOT).messages).toEqual([]);
    expect(store.get(ALEX_UNDERSCORE).messages).toEqual([]);
    expect(store.searchTranscript(ALEX_DOT, {})).toEqual([]);
    expect(store.searchTranscript(ALEX_UNDERSCORE, {})).toEqual([]);

    // The only record of the mixed history is untouched.
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(legacyPath, "utf-8")).toContain("mixed history");

    // One warning naming both keys, not one per touch.
    const collisions = warningsMatching("filename collision");
    expect(collisions).toHaveLength(1);
    expect((collisions[0][0] as { keys: string[] }).keys.sort())
      .toEqual([ALEX_DOT, ALEX_UNDERSCORE].sort());

    // Appends go to two distinct new files.
    store.append(ALEX_DOT, msg("from the dot"));
    store.append(ALEX_UNDERSCORE, msg("from the underscore"));
    const dotFile = join(testDir, `${transcriptFileStem(ALEX_DOT)}.jsonl`);
    const underscoreFile = join(testDir, `${transcriptFileStem(ALEX_UNDERSCORE)}.jsonl`);
    expect(dotFile).not.toBe(underscoreFile);
    expect(readFileSync(dotFile, "utf-8")).toContain("from the dot");
    expect(readFileSync(dotFile, "utf-8")).not.toContain("from the underscore");
    expect(readFileSync(underscoreFile, "utf-8")).toContain("from the underscore");
    // Nothing was appended to (or removed from) the legacy file.
    expect(readFileSync(legacyPath, "utf-8").trimEnd().split("\n")).toHaveLength(1);
  });

  it("treats a `migratedFrom` key as an owner of the legacy name", () => {
    const store = newStore();
    // `dm:alex` was unified out of the dotted address; the underscore address
    // is a different person whose legacy file may hold the dotted history.
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    store.migrateSessionKey(ALEX_DOT, "dm:alex");
    const legacyPath = join(testDir, `${legacyTranscriptFileStem(ALEX_UNDERSCORE)}.jsonl`);
    writeFileSync(legacyPath, JSON.stringify(msg("mixed history")) + "\n");

    expect(store.get(ALEX_UNDERSCORE).messages).toEqual([]);
    expect(existsSync(legacyPath)).toBe(true);
    expect(warningsMatching("filename collision")).toHaveLength(1);
  });
});

describe("migrateSessionKey with the new naming", () => {
  it("carries a legacy-named transcript and its archives to a dm: key", () => {
    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    writeFileSync(
      join(testDir, `${legacy}.jsonl`),
      JSON.stringify(msg("recent", Date.parse("2026-03-01T00:00:00Z"))) + "\n",
    );
    writeFileSync(
      join(testDir, `_archive_${legacy}_2026-01.jsonl`),
      JSON.stringify(msg("january", Date.parse("2026-01-02T00:00:00Z"))) + "\n",
    );

    store.migrateSessionKey(ALEX_DOT, "dm:alex");

    expect(existsSync(join(testDir, `${legacy}.jsonl`))).toBe(false);
    expect(existsSync(join(testDir, `${transcriptFileStem(ALEX_DOT)}.jsonl`))).toBe(false);
    expect(existsSync(join(testDir, "dm_alex.jsonl"))).toBe(true);
    expect(existsSync(join(testDir, "_archive_dm_alex_2026-01.jsonl"))).toBe(true);

    const session = store.get("dm:alex");
    expect(session.messages.map((m) => m.content)).toEqual(["recent"]);
    expect(session.createdAt).toBe(Date.parse("2026-01-02T00:00:00Z"));
    expect(store.searchTranscript("dm:alex", {}).map((m) => m.content)).toEqual(["january", "recent"]);
  });

  it("carries an already-migrated (suffixed) transcript across too", () => {
    const store = newStore();
    store.append(ALEX_DOT, msg("hello"));
    store.setSdkSessionId(ALEX_DOT, "sdk-1");

    store.migrateSessionKey(ALEX_DOT, "dm:alex");

    expect(existsSync(join(testDir, `${transcriptFileStem(ALEX_DOT)}.jsonl`))).toBe(false);
    expect(store.get("dm:alex").messages.map((m) => m.content)).toEqual(["hello"]);
  });
});
