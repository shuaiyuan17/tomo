import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
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

  it("leaves every key Tomo builds for itself on exactly the filename it already uses", () => {
    // `dmSessionKeyForIdentity` lowercases, chat ids are numeric, and the
    // harness keys are literals — so nothing the product constructs moves.
    for (const key of [
      "dm:shuai", "dm:alice", "telegram:123", "telegram:-100123", "heartbeat",
      "cron:nightly-sweep", "imessage:15551234567",
    ]) {
      expect(transcriptFileStem(key), key).toBe(legacyTranscriptFileStem(key));
    }
    expect(transcriptFileStem("dm:shuai")).toBe("dm_shuai");
    expect(transcriptFileStem("dm:alice")).toBe("dm_alice");
    expect(transcriptFileStem("telegram:-100123")).toBe("telegram_-100123");
    expect(transcriptFileStem("heartbeat")).toBe("heartbeat");
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

describe("injectivity on a case-insensitive filesystem", () => {
  // APFS and NTFS both default to case-insensitive, so `imessage_AbC` and
  // `imessage_abc` are ONE file on the machines Tomo runs on. Asserted on the
  // stems rather than on the directory listing so the property is pinned on
  // case-sensitive CI too.
  const UPPER = "imessage:AbC";
  const LOWER = "imessage:abc";

  it("gives two keys differing only in case stems that do not case-fold together", () => {
    expect(legacyTranscriptFileStem(UPPER).toLowerCase())
      .toBe(legacyTranscriptFileStem(LOWER).toLowerCase());

    const upper = transcriptFileStem(UPPER);
    const lower = transcriptFileStem(LOWER);
    expect(upper).not.toBe(lower);
    expect(upper.toLowerCase()).not.toBe(lower.toLowerCase());
  });

  it("takes the hash suffix for any key carrying an uppercase letter", () => {
    for (const key of ["dm:Alice-2", "telegram:A1", "imessage:AbC"]) {
      expect(transcriptFileStem(key), key).not.toBe(legacyTranscriptFileStem(key));
      expect(transcriptFileStem(key), key).toMatch(/\.[0-9a-f]{12}$/);
    }
  });

  it("writes two case-only-different keys to two filenames that stay distinct when folded", () => {
    const store = newStore();
    store.append(UPPER, msg("from the uppercase handle"));
    store.append(LOWER, msg("from the lowercase handle"));

    const folded = readdirSync(testDir).filter((n) => n.endsWith(".jsonl")).map((n) => n.toLowerCase());
    expect(new Set(folded).size).toBe(2);

    expect(store.get(UPPER).messages.map((m) => m.content)).toEqual(["from the uppercase handle"]);
    expect(store.get(LOWER).messages.map((m) => m.content)).toEqual(["from the lowercase handle"]);
  });

  it("keeps the hash suffix itself immune to folding", () => {
    // Hex digits are lowercase, so the discriminator survives a case-folding
    // filesystem intact — without that, two suffixed stems could still meet.
    expect(transcriptFileStem(UPPER)).toBe(transcriptFileStem(UPPER).replace(/[^.]*$/, (h) => h.toLowerCase()));
  });
});

describe("persisted legacy-stem ownership (_legacy_stems.json)", () => {
  const LEDGER = () => join(testDir, "_legacy_stems.json");
  const REGISTRY = () => join(testDir, "_sessions.json");

  function seedSharedLegacyFile(): string {
    const legacyPath = join(testDir, `${legacyTranscriptFileStem(ALEX_DOT)}.jsonl`);
    writeFileSync(legacyPath, JSON.stringify(msg("mixed history")) + "\n");
    return legacyPath;
  }

  /** Force every registry entry's TTL into the past so the next store's
   *  constructor sweeps it (`cleanupExpiredLocked`). */
  function ageOutEveryEntry(): void {
    const data = JSON.parse(readFileSync(REGISTRY(), "utf-8")) as { sessions: Record<string, unknown>[] };
    for (const entry of data.sessions) {
      entry.unlinkedAt = 1;
      entry.expiresAt = 2;
    }
    writeFileSync(REGISTRY(), JSON.stringify(data));
  }

  it("still refuses a shared legacy file after the partner key aged out of the registry", () => {
    // THE REVIEWER'S REPRODUCTION. `cleanupExpiredLocked` deletes the registry
    // entry 30 days after unlink while the transcript file stays, so inferring
    // ownership from the live registry answers "only this key" for a file that
    // holds two people's messages.
    const first = newStore();
    first.setSdkSessionId(ALEX_UNDERSCORE, "sdk-underscore");
    first.clearSdkSessionId(ALEX_UNDERSCORE);
    ageOutEveryEntry();

    const legacyPath = seedSharedLegacyFile();
    const second = newStore(); // constructor sweeps the expired entry
    expect((JSON.parse(readFileSync(REGISTRY(), "utf-8")) as { sessions: unknown[] }).sessions).toEqual([]);

    warn.mockClear();
    expect(second.get(ALEX_DOT).messages).toEqual([]);
    expect(second.searchTranscript(ALEX_DOT, {})).toEqual([]);

    // The only record of the mixed history is still there, untouched.
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(legacyPath, "utf-8")).toContain("mixed history");

    const collisions = warningsMatching("filename collision");
    expect(collisions).toHaveLength(1);
    expect((collisions[0][0] as { keys: string[] }).keys).toContain(ALEX_UNDERSCORE);
  });

  it("records the aged-out key under its legacy stem, before dropping the entry", () => {
    const store = newStore();
    store.setSdkSessionId(ALEX_UNDERSCORE, "sdk-underscore");
    store.clearSdkSessionId(ALEX_UNDERSCORE);
    ageOutEveryEntry();

    newStore();
    const ledger = JSON.parse(readFileSync(LEDGER(), "utf-8")) as { version: number; stems: Record<string, string[]> };
    expect(ledger.version).toBe(1);
    expect(ledger.stems[legacyTranscriptFileStem(ALEX_UNDERSCORE)]).toEqual([ALEX_UNDERSCORE]);
  });

  it("still refuses after the partner key was re-keyed without a migratedFrom breadcrumb", () => {
    // `migrateSessionKeyLocked` only records `migratedFrom` for a non-DM→DM
    // unification, so a raw→raw re-key leaves the registry with no trace of
    // the old key at all.
    const first = newStore();
    first.setSdkSessionId(ALEX_DOT, "sdk-dot");
    first.migrateSessionKey(ALEX_DOT, "telegram:555");
    expect(readFileSync(REGISTRY(), "utf-8")).not.toContain(ALEX_DOT);
    expect(
      (JSON.parse(readFileSync(LEDGER(), "utf-8")) as { stems: Record<string, string[]> })
        .stems[legacyTranscriptFileStem(ALEX_DOT)],
    ).toEqual([ALEX_DOT]);

    const legacyPath = seedSharedLegacyFile();
    const second = newStore();
    warn.mockClear();
    expect(second.get(ALEX_UNDERSCORE).messages).toEqual([]);
    expect(existsSync(legacyPath)).toBe(true);
    const collisions = warningsMatching("filename collision");
    expect(collisions).toHaveLength(1);
    expect((collisions[0][0] as { keys: string[] }).keys).toContain(ALEX_DOT);
  });

  it("records a metadata-only stub before removing it outright", () => {
    const store = newStore();
    store.setChatTitle(ALEX_UNDERSCORE, "Alex"); // creates a stub with no sdkSessionId
    store.clearSdkSessionId(ALEX_UNDERSCORE); // stubs are deleted, not TTL'd
    expect(readFileSync(REGISTRY(), "utf-8")).not.toContain(ALEX_UNDERSCORE);

    const legacyPath = seedSharedLegacyFile();
    const second = newStore();
    warn.mockClear();
    expect(second.get(ALEX_DOT).messages).toEqual([]);
    expect(existsSync(legacyPath)).toBe(true);
    expect(warningsMatching("filename collision")).toHaveLength(1);
  });

  it("refuses to adopt a legacy file while the ledger is unreadable, and does not throw", () => {
    // FAIL CLOSED. An unreadable ledger may name the very second owner that
    // makes this file ambiguous, so "I cannot tell" must not read as "there is
    // no other owner". The message path still works — the key simply starts
    // fresh under its own name and the legacy file is untouched.
    writeFileSync(LEDGER(), "{not json");
    const store = newStore();
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    const legacyPath = join(testDir, `${legacy}.jsonl`);
    writeFileSync(legacyPath, JSON.stringify(msg("possibly shared")) + "\n");

    expect(store.get(ALEX_DOT).messages).toEqual([]);
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(legacyPath, "utf-8")).toContain("possibly shared");
    expect(warningsMatching("Could not load the legacy transcript stem ledger").length).toBe(1);
    expect(warningsMatching("an ownership source could not be read").length).toBe(1);

    // Deferred, not settled — so a re-key would be refused too.
    expect(store.migrationStatus().deferred).toEqual([ALEX_DOT]);
    expect(store.migrationStatus().settled).toBe(false);

    // Appending still works, under the new name.
    store.append(ALEX_DOT, msg("mine"));
    expect(readFileSync(join(testDir, `${transcriptFileStem(ALEX_DOT)}.jsonl`), "utf-8")).toContain("mine");
  });

  it("refuses while the registry itself is unreadable", () => {
    writeFileSync(REGISTRY(), "{not json either");
    const store = newStore();
    const legacyPath = seedSharedLegacyFile();

    expect(store.get(ALEX_DOT).messages).toEqual([]);
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(legacyPath, "utf-8")).toContain("mixed history");
    expect(warningsMatching("an ownership source could not be read").length).toBe(1);
    expect(store.migrationStatus().settled).toBe(false);
  });

  it("quarantines an unparseable ledger rather than overwriting it, and refuses meanwhile", () => {
    writeFileSync(LEDGER(), '{"version":1,"stems":{"dm_a":"not-an-array"}}');
    const store = newStore();
    // A forgetting path has to record an owner, which is what triggers the
    // quarantine — the corrupt bytes may be the only record of an owner, so they
    // are moved aside and never rewritten in place.
    store.setChatTitle(ALEX_UNDERSCORE, "Alex");
    store.clearSdkSessionId(ALEX_UNDERSCORE);

    const quarantined = readdirSync(testDir).filter((n) => n.startsWith("_legacy_stems.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(testDir, quarantined[0]), "utf-8")).toContain("not-an-array");
    expect(warningsMatching("was quarantined")).toHaveLength(1);

    // Rebuilt from empty, and the owner we were recording is in it.
    const ledger = JSON.parse(readFileSync(LEDGER(), "utf-8")) as { stems: Record<string, string[]> };
    expect(ledger.stems[legacyTranscriptFileStem(ALEX_UNDERSCORE)]).toEqual([ALEX_UNDERSCORE]);
    expect(ledger.stems.dm_a).toBeUndefined();
  });

  it("keeps a metadata-only stub when its legacy stem ownership cannot be recorded", () => {
    // The ledger's own lock directory, held by a live owner: the write cannot
    // land, so the entry that is the ONLY record of this key must not be dropped.
    const store = newStore();
    store.setChatTitle(ALEX_UNDERSCORE, "Alex");
    const lockDir = join(testDir, "_legacy_stems.json.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.other"),
      `${JSON.stringify({ pid: process.pid, ts: Date.now(), host: hostname() })}\n`,
    );

    store.clearSdkSessionId(ALEX_UNDERSCORE);
    expect(readFileSync(REGISTRY(), "utf-8")).toContain(ALEX_UNDERSCORE);
    expect(warningsMatching("Keeping the metadata-only session entry")).toHaveLength(1);

    rmSync(lockDir, { recursive: true, force: true });
    store.clearSdkSessionId(ALEX_UNDERSCORE);
    expect(readFileSync(REGISTRY(), "utf-8")).not.toContain(ALEX_UNDERSCORE);
  });

  it("writes a collision seen only in this process's session cache straight to the ledger", () => {
    // Neither key is in the registry: the underscore address was touched in
    // memory only. Without persisting it here, the next daemon start sees a
    // single-owner file and adopts it.
    const store = newStore();
    store.get(ALEX_UNDERSCORE);
    const legacyPath = seedSharedLegacyFile();

    expect(store.get(ALEX_DOT).messages).toEqual([]);
    expect(existsSync(legacyPath)).toBe(true);
    const stems = (JSON.parse(readFileSync(LEDGER(), "utf-8")) as { stems: Record<string, string[]> }).stems;
    expect(stems[legacyTranscriptFileStem(ALEX_DOT)].sort()).toEqual([ALEX_DOT, ALEX_UNDERSCORE].sort());

    // And a fresh store with an empty registry still refuses.
    warn.mockClear();
    const second = newStore();
    expect(second.get(ALEX_DOT).messages).toEqual([]);
    expect(warningsMatching("filename collision")).toHaveLength(1);
  });

  it("prunes a ledger row once nothing on disk is named after its stem", () => {
    const store = newStore();
    store.setChatTitle(ALEX_UNDERSCORE, "Alex");
    store.clearSdkSessionId(ALEX_UNDERSCORE);
    const stem = legacyTranscriptFileStem(ALEX_UNDERSCORE);
    expect((JSON.parse(readFileSync(LEDGER(), "utf-8")) as { stems: Record<string, string[]> }).stems[stem])
      .toEqual([ALEX_UNDERSCORE]);

    expect(store.pruneLegacyStemLedger()).toEqual([stem]);
    expect((JSON.parse(readFileSync(LEDGER(), "utf-8")) as { stems: Record<string, string[]> }).stems)
      .toEqual({});
  });

  it("keeps a ledger row whose stem is still a live filename", () => {
    const store = newStore();
    store.append("dm:alice", msg("hello")); // stable stem: dm_alice.jsonl
    store.setChatTitle("dm:alice", "Alice");
    store.clearSdkSessionId("dm:alice");
    expect(store.pruneLegacyStemLedger()).toEqual([]);
    expect((JSON.parse(readFileSync(LEDGER(), "utf-8")) as { stems: Record<string, string[]> }).stems.dm_alice)
      .toEqual(["dm:alice"]);
  });

  it("leaves the everyday keys out of the migration path entirely", () => {
    // `dm:shuai`, `telegram:-100…` and `heartbeat` keep their legacy stem, so
    // the migration has nothing to move for them: no transcript lock is ever
    // taken, nothing is renamed, no sidecar or quarantine file appears, and the
    // ledger is not written. All that runs is the ownership probe — an in-memory
    // scan of the registry and the session cache plus one `stat` of the ledger
    // path, which does not exist on a normal install.
    const store = newStore();
    for (const key of ["dm:shuai", "telegram:-100123", "heartbeat"]) {
      expect(transcriptFileStem(key)).toBe(legacyTranscriptFileStem(key));
      store.append(key, msg(`hello from ${key}`));
      store.append(key, msg(`again from ${key}`));
      expect(store.get(key).messages.map((m) => m.content))
        .toEqual([`hello from ${key}`, `again from ${key}`]);
    }

    expect(readdirSync(testDir).sort()).toEqual([
      "dm_shuai.jsonl", "heartbeat.jsonl", "telegram_-100123.jsonl",
    ]);
    expect(existsSync(join(testDir, "_transcripts.lock"))).toBe(false);
    expect(existsSync(LEDGER())).toBe(false);
    expect(store.migrationStatus())
      .toEqual({ settled: true, deferred: [], ambiguous: [], sidecars: [] });

    // And a second process over the same directory does no work either.
    info.mockClear();
    const second = newStore();
    expect(second.get("dm:shuai").messages).toHaveLength(2);
    expect(info.mock.calls.some((c) => String(c[1] ?? "").includes("collision-free name"))).toBe(false);
    expect(warningsMatching("filename collision")).toHaveLength(0);
  });
});

describe("a deferred transcript migration is retried, never forgotten", () => {
  const T1 = Date.parse("2026-02-01T00:00:00Z");
  const T2 = Date.parse("2026-02-02T00:00:00Z");
  const T3 = Date.parse("2026-02-03T00:00:00Z");

  function seq(content: string, timestamp: number, n: number): string {
    return JSON.stringify({ ...msg(content, timestamp), seq: n }) + "\n";
  }

  /** Another LIVE process inside the transcript critical section. */
  function holdTranscriptLock(): string {
    const lockDir = join(testDir, "_transcripts.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.other"),
      `${JSON.stringify({ pid: process.pid, ts: Date.now(), host: hostname() })}\n`,
    );
    return lockDir;
  }

  function seedLegacyActive(key: string): string {
    const legacy = legacyTranscriptFileStem(key);
    const path = join(testDir, `${legacy}.jsonl`);
    writeFileSync(path, seq("legacy one", T1, 1) + seq("legacy two", T2, 2));
    return path;
  }

  function seqsIn(file: string): number[] {
    return readFileSync(file, "utf-8").trimEnd().split("\n")
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
  }

  function sidecars(): string[] {
    return readdirSync(testDir).filter((n) => /\.legacy-\d{8}-\d{6}(?:-\d+)?\.jsonl$/.test(n)).sort();
  }

  it("recovers the whole history after a lock timeout, an append, and a restart", () => {
    // THE REVIEWER'S REPRODUCTION. The attempt is deferred, the triggering
    // message lands under the new stem, and both files then exist — which the
    // first version of this code read as "leave the legacy file alone", i.e.
    // every older message present on disk and reachable from nothing.
    const legacyPath = seedLegacyActive(ALEX_DOT);
    const stem = transcriptFileStem(ALEX_DOT);
    const newPath = join(testDir, `${stem}.jsonl`);

    const lockDir = holdTranscriptLock();
    const first = newStore();
    first.setSdkSessionId(ALEX_DOT, "sdk-1");
    first.append(ALEX_DOT, msg("arrived while the lock was held", T3));
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(newPath)).toBe(true);
    expect(warningsMatching("another process holds the transcript lock")).toHaveLength(1);

    // The holder finishes and the daemon restarts.
    rmSync(lockDir, { recursive: true, force: true });
    const second = newStore();
    const session = second.get(ALEX_DOT);

    // The legacy file was RENAMED to a sidecar, not merged: nothing was rewritten.
    expect(existsSync(legacyPath)).toBe(false);
    expect(sidecars()).toEqual([expect.stringMatching(/^imessage_.*\.legacy-\d{8}-\d{6}\.jsonl$/)]);
    expect(readFileSync(join(testDir, sidecars()[0]), "utf-8"))
      .toBe(seq("legacy one", T1, 1) + seq("legacy two", T2, 2));

    // …and every reader covers it.
    expect(session.messages.map((m) => m.content))
      .toEqual(["legacy one", "legacy two", "arrived while the lock was held"]);
    expect(session.createdAt).toBe(T1);
    expect(second.searchTranscript(ALEX_DOT, {}).map((m) => m.content))
      .toEqual(["legacy one", "legacy two", "arrived while the lock was held"]);
    expect(second.searchTranscript(ALEX_DOT, { query: "legacy" })).toHaveLength(2);
    expect(second.countRecentUserMessages(ALEX_DOT)).toBe(3);
  });

  it("keeps the active file's seq run to itself: the sidecar seeds nothing", () => {
    // `getLastSeq` must not continue from a sidecar. The sidecar's run and the
    // active file's run are independent, and only the active file's has to stay
    // unique — rotation reads a re-used seq as "already archived" and drops the
    // record, and rotation cannot see sidecars at all.
    const stem = transcriptFileStem(ALEX_DOT);
    const legacyPath = seedLegacyActive(ALEX_DOT);          // seq 1, 2
    const activePath = join(testDir, `${stem}.jsonl`);
    writeFileSync(activePath, seq("post-migration", T3, 1)); // seq 1 again

    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    expect(store.get(ALEX_DOT).messages.map((m) => m.content))
      .toEqual(["legacy one", "legacy two", "post-migration"]);
    expect(existsSync(legacyPath)).toBe(false);

    store.append(ALEX_DOT, msg("next", Date.parse("2026-02-04T00:00:00Z")));
    // 2, not 3: the sidecar's highest seq is invisible here.
    expect(seqsIn(activePath)).toEqual([1, 2]);
    expect(new Set(seqsIn(activePath)).size).toBe(2);
    // The sidecar was not rewritten.
    expect(seqsIn(join(testDir, sidecars()[0]))).toEqual([1, 2]);
  });

  it("hides the sidecar from rotation: an archive name is derived, never matched", () => {
    // A sidecar that looks like an archive (`_archive_<stem>_<M>.legacy-<ts>.jsonl`)
    // is read by search, but rotation appends to `_archive_<stem>_<M>.jsonl` and
    // must never see or rewrite the sidecar.
    const stem = transcriptFileStem(ALEX_DOT);
    const sidecarName = `_archive_${stem}_2026-01.legacy-20260301-120000.jsonl`;
    writeFileSync(join(testDir, sidecarName), seq("archived legacy january", Date.parse("2026-01-05T00:00:00Z"), 9));
    const before = readFileSync(join(testDir, sidecarName), "utf-8");

    // rotateBytes: 1 forces a rotation on the first `get()`.
    const store = new SessionStore(testDir, 20, join(testDir, "sdk-sessions"), { rotateBytes: 1 });
    store.append(ALEX_DOT, msg("january, current", Date.parse("2026-01-20T00:00:00Z")));
    store.append(ALEX_DOT, msg("march", Date.parse("2026-03-02T00:00:00Z")));
    // A fresh store rotates on first access; nothing may be merged into the sidecar.
    const reloaded = new SessionStore(testDir, 20, join(testDir, "sdk-sessions"), { rotateBytes: 1 });
    reloaded.get(ALEX_DOT);

    expect(readFileSync(join(testDir, sidecarName), "utf-8")).toBe(before);
    // Search still covers it, and the rotation archive is a separate file.
    expect(reloaded.searchTranscript(ALEX_DOT, { query: "archived legacy" })).toHaveLength(1);
    expect(existsSync(join(testDir, `_archive_${stem}_2026-01.jsonl`))).toBe(true);
  });

  it("carries the archives across too when the active file has to become a sidecar", () => {
    // Reviewer's item 6: a refused active file used to leave the archives
    // half-adopted. Nothing legacy-named may survive the pass.
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    const stem = transcriptFileStem(ALEX_DOT);
    const legacyPath = seedLegacyActive(ALEX_DOT);
    writeFileSync(join(testDir, `_archive_${legacy}_2026-01.jsonl`), seq("january", Date.parse("2026-01-05T00:00:00Z"), 0));
    writeFileSync(join(testDir, `${stem}.jsonl`), seq("post-migration", T3, 1));

    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    const session = store.get(ALEX_DOT);

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(join(testDir, `_archive_${legacy}_2026-01.jsonl`))).toBe(false);
    expect(existsSync(join(testDir, `_archive_${stem}_2026-01.jsonl`))).toBe(true);
    expect(session.createdAt).toBe(Date.parse("2026-01-05T00:00:00Z"));
    expect(store.searchTranscript(ALEX_DOT, {}).map((m) => m.content))
      .toEqual(["january", "legacy one", "legacy two", "post-migration"]);
  });

  it("sidecars a legacy archive whose month already exists under the new stem", () => {
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    const stem = transcriptFileStem(ALEX_DOT);
    writeFileSync(join(testDir, `_archive_${legacy}_2026-01.jsonl`), seq("legacy january", Date.parse("2026-01-05T00:00:00Z"), 7));
    writeFileSync(join(testDir, `_archive_${stem}_2026-01.jsonl`), seq("new january", Date.parse("2026-01-20T00:00:00Z"), 1));

    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    expect(store.searchTranscript(ALEX_DOT, {}).map((m) => m.content)).toEqual(["legacy january", "new january"]);
    expect(existsSync(join(testDir, `_archive_${legacy}_2026-01.jsonl`))).toBe(false);
    expect(sidecars()).toEqual([
      expect.stringMatching(new RegExp(`^_archive_${stem.replace(".", "\\.")}_2026-01\\.legacy-\\d{8}-\\d{6}\\.jsonl$`)),
    ]);
    // Neither file was renumbered.
    expect(seqsIn(join(testDir, `_archive_${stem}_2026-01.jsonl`))).toEqual([1]);
    expect(seqsIn(join(testDir, sidecars()[0]))).toEqual([7]);
  });

  describe("every crash point converges on re-run", () => {
    /** Seed the full legacy family plus whatever the post-crash state says is
     *  already under the new stem. */
    function seedFamily(): { legacy: string; stem: string } {
      const legacy = legacyTranscriptFileStem(ALEX_DOT);
      writeFileSync(join(testDir, `${legacy}.jsonl`), seq("legacy active", T3, 3));
      writeFileSync(join(testDir, `_archive_${legacy}_2026-01.jsonl`), seq("legacy january", T1, 1));
      writeFileSync(join(testDir, `_archive_${legacy}_2026-02.jsonl`), seq("legacy february", T2, 2));
      return { legacy, stem: transcriptFileStem(ALEX_DOT) };
    }

    /** Finish whatever state the directory is in and assert convergence. */
    function runAndAssert(expected: string[]): void {
      const store = newStore();
      store.setSdkSessionId(ALEX_DOT, "sdk-1");
      store.get(ALEX_DOT);
      const legacy = legacyTranscriptFileStem(ALEX_DOT);
      // Nothing legacy-named survives. Exact on the active file, because the NEW
      // stem is `<legacy>.<hash>` and a prefix test would match it too.
      expect(readdirSync(testDir).filter((n) =>
        n === `${legacy}.jsonl`
        || (n.startsWith(`_archive_${legacy}_`) && /^\d{4}-\d{2}\.jsonl$/.test(n.slice(`_archive_${legacy}_`.length)))))
        .toEqual([]);
      // …every record is readable exactly once…
      const contents = store.searchTranscript(ALEX_DOT, {}).map((m) => m.content);
      expect(contents.sort()).toEqual([...expected].sort());
      expect(new Set(contents).size).toBe(contents.length);
      // …and the pass is settled, so it will not run again.
      expect(store.migrationStatus().settled).toBe(true);
      expect(store.migrationStatus().deferred).toEqual([]);
    }

    const ALL = ["legacy january", "legacy february", "legacy active"];

    it("crash before the first rename", () => {
      seedFamily();
      runAndAssert(ALL);
    });

    it("crash after the active file was renamed", () => {
      const { legacy, stem } = seedFamily();
      renameSync(join(testDir, `${legacy}.jsonl`), join(testDir, `${stem}.jsonl`));
      runAndAssert(ALL);
    });

    it("crash after the active file and one archive were renamed", () => {
      const { legacy, stem } = seedFamily();
      renameSync(join(testDir, `${legacy}.jsonl`), join(testDir, `${stem}.jsonl`));
      renameSync(join(testDir, `_archive_${legacy}_2026-02.jsonl`), join(testDir, `_archive_${stem}_2026-02.jsonl`));
      runAndAssert(ALL);
    });

    it("crash after the active file became a sidecar", () => {
      const { legacy, stem } = seedFamily();
      writeFileSync(join(testDir, `${stem}.jsonl`), seq("post-migration", Date.parse("2026-02-04T00:00:00Z"), 1));
      renameSync(join(testDir, `${legacy}.jsonl`), join(testDir, `${stem}.legacy-20260301-120000.jsonl`));
      runAndAssert([...ALL, "post-migration"]);
    });

    it("crash after the whole family moved (a pure no-op re-run)", () => {
      const { legacy, stem } = seedFamily();
      renameSync(join(testDir, `${legacy}.jsonl`), join(testDir, `${stem}.jsonl`));
      renameSync(join(testDir, `_archive_${legacy}_2026-01.jsonl`), join(testDir, `_archive_${stem}_2026-01.jsonl`));
      renameSync(join(testDir, `_archive_${legacy}_2026-02.jsonl`), join(testDir, `_archive_${stem}_2026-02.jsonl`));
      info.mockClear();
      runAndAssert(ALL);
      expect(info.mock.calls.some((c) => String(c[1] ?? "").includes("collision-free name"))).toBe(false);
    });

    it("crash between the active rename and a sidecar the same pass created", () => {
      // The interesting mixed state: one file moved cleanly, the next had to
      // become a sidecar, and the third never ran.
      const { legacy, stem } = seedFamily();
      renameSync(join(testDir, `${legacy}.jsonl`), join(testDir, `${stem}.jsonl`));
      writeFileSync(join(testDir, `_archive_${stem}_2026-02.jsonl`), seq("new february", T2 + 1000, 1));
      renameSync(
        join(testDir, `_archive_${legacy}_2026-02.jsonl`),
        join(testDir, `_archive_${stem}_2026-02.legacy-20260301-120000.jsonl`),
      );
      runAndAssert([...ALL, "new february"]);
    });
  });

  it("retries inside the same process once the throttle elapses", () => {
    // A deferred attempt must not be recorded as a completed check. Nothing here
    // restarts the store, so only a genuine retry can recover the history.
    const legacyPath = seedLegacyActive(ALEX_DOT);
    const lockDir = holdTranscriptLock();
    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    store.append(ALEX_DOT, msg("arrived while the lock was held", T3));
    expect(store.get(ALEX_DOT).messages.map((m) => m.content)).toEqual(["arrived while the lock was held"]);
    expect(store.migrationStatus().deferred).toEqual([ALEX_DOT]);

    rmSync(lockDir, { recursive: true, force: true });
    // Past TRANSCRIPT_MIGRATION_RETRY_MS. Fake timers only while the lock is
    // free, so nothing waits on a deadline that can no longer be reached.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect(store.get(ALEX_DOT).messages.map((m) => m.content))
        .toEqual(["legacy one", "legacy two", "arrived while the lock was held"]);
    } finally {
      vi.useRealTimers();
    }
    expect(existsSync(legacyPath)).toBe(false);
    expect(store.migrationStatus().settled).toBe(true);
  });

  it("refuses an ambiguous legacy file even when both names exist", () => {
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    const stem = transcriptFileStem(ALEX_DOT);
    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-dot");
    store.setSdkSessionId(ALEX_UNDERSCORE, "sdk-underscore");
    writeFileSync(join(testDir, `${legacy}.jsonl`), seq("mixed history", T1, 1));
    writeFileSync(join(testDir, `${stem}.jsonl`), seq("mine alone", T2, 1));

    expect(store.get(ALEX_DOT).messages.map((m) => m.content)).toEqual(["mine alone"]);
    expect(readFileSync(join(testDir, `${legacy}.jsonl`), "utf-8")).toContain("mixed history");
    expect(sidecars()).toEqual([]);
    expect(warningsMatching("filename collision")).toHaveLength(1);
  });

  it("does not re-key a session whose legacy migration has not settled", () => {
    // `migrateSessionKeyLocked` renames `transcriptPath(oldKey)`, and while the
    // migration is outstanding we do not know which files that is.
    seedLegacyActive(ALEX_DOT);
    const lockDir = holdTranscriptLock();
    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");

    expect(() => store.migrateSessionKey(ALEX_DOT, "dm:alex")).toThrow(/has not settled/);
    expect(readFileSync(join(testDir, "_sessions.json"), "utf-8")).toContain(ALEX_DOT);
    expect(existsSync(join(testDir, "dm_alex.jsonl"))).toBe(false);

    // Once the holder is gone and the throttle elapses, the re-key goes through.
    rmSync(lockDir, { recursive: true, force: true });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      store.migrateSessionKey(ALEX_DOT, "dm:alex");
    } finally {
      vi.useRealTimers();
    }
    expect(store.searchTranscript("dm:alex", {}).map((m) => m.content)).toEqual(["legacy one", "legacy two"]);
  });

  it("sidecars the old key's transcript when the unified name is already in use", () => {
    // `migrateSessionKeyLocked`'s own both-exist hole: it used to require
    // `!existsSync(new)` and otherwise abandon the old file on disk.
    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    store.append(ALEX_DOT, msg("from the channel key", T1));
    store.append("dm:alex", msg("already under the unified key", T2));

    store.migrateSessionKey(ALEX_DOT, "dm:alex");

    expect(existsSync(join(testDir, `${transcriptFileStem(ALEX_DOT)}.jsonl`))).toBe(false);
    expect(sidecars()).toEqual([expect.stringMatching(/^dm_alex\.legacy-\d{8}-\d{6}\.jsonl$/)]);
    expect(store.searchTranscript("dm:alex", {}).map((m) => m.content))
      .toEqual(["from the channel key", "already under the unified key"]);
    expect(store.get("dm:alex").messages.map((m) => m.content))
      .toEqual(["from the channel key", "already under the unified key"]);
    expect(warningsMatching("kept as a read-only sidecar")).toHaveLength(1);
  });

  it("carries an existing sidecar across a re-key", () => {
    // A reader can see a sidecar, so a re-key that cannot would lose history.
    const stem = transcriptFileStem(ALEX_DOT);
    writeFileSync(join(testDir, `${stem}.legacy-20260301-120000.jsonl`), seq("older, sidecarred", T1, 1));
    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    store.append(ALEX_DOT, msg("newer", T2));

    store.migrateSessionKey(ALEX_DOT, "dm:alex");

    expect(sidecars()).toEqual([expect.stringMatching(/^dm_alex\.legacy-\d{8}-\d{6}\.jsonl$/)]);
    expect(store.searchTranscript("dm:alex", {}).map((m) => m.content)).toEqual(["older, sidecarred", "newer"]);
  });
});

describe("a stable-stem key that turns out to share its filename", () => {
  // `dm:a:b` keeps `dm_a_b.jsonl`; `dm:a_b` takes a hash suffix but has the same
  // LEGACY stem, so the stable key is the one sitting on the shared file. The
  // version that skipped the ownership check for stable stems left it reading a
  // mixed transcript forever (codex #2).
  const STABLE = "dm:a:b";
  const SUFFIXED = "dm:a_b";

  function quarantined(): string[] {
    return readdirSync(testDir).filter((n) => /\.ambiguous-\d{8}-\d{6}(?:-\d+)?\.jsonl$/.test(n)).sort();
  }

  it("parks the mixed family under `.ambiguous-` and starts both keys fresh", () => {
    expect(legacyTranscriptFileStem(STABLE)).toBe(legacyTranscriptFileStem(SUFFIXED));
    expect(transcriptFileStem(STABLE)).toBe("dm_a_b");

    const store = newStore();
    store.setSdkSessionId(SUFFIXED, "sdk-underscore"); // the other owner is known
    writeFileSync(join(testDir, "dm_a_b.jsonl"), JSON.stringify(msg("mixed history")) + "\n");
    writeFileSync(
      join(testDir, "_archive_dm_a_b_2026-01.jsonl"),
      JSON.stringify(msg("mixed january", Date.parse("2026-01-05T00:00:00Z"))) + "\n",
    );

    expect(store.get(STABLE).messages).toEqual([]);
    expect(store.searchTranscript(STABLE, {})).toEqual([]);
    expect(existsSync(join(testDir, "dm_a_b.jsonl"))).toBe(false);
    expect(quarantined()).toEqual([
      expect.stringMatching(/^_archive_dm_a_b_2026-01\.ambiguous-\d{8}-\d{6}\.jsonl$/),
      expect.stringMatching(/^dm_a_b\.ambiguous-\d{8}-\d{6}\.jsonl$/),
    ]);
    // Preserved, not deleted.
    expect(readFileSync(join(testDir, quarantined()[1]), "utf-8")).toContain("mixed history");
    expect(warningsMatching("filename collision")).toHaveLength(1);

    // Both keys now write to distinct files, and neither reads the parked one.
    store.append(STABLE, msg("from the colon key"));
    store.append(SUFFIXED, msg("from the underscore key"));
    expect(readFileSync(join(testDir, "dm_a_b.jsonl"), "utf-8")).toContain("from the colon key");
    expect(readFileSync(join(testDir, "dm_a_b.jsonl"), "utf-8")).not.toContain("mixed history");
    expect(store.searchTranscript(STABLE, {}).map((m) => m.content)).toEqual(["from the colon key"]);
    expect(store.searchTranscript(SUFFIXED, {}).map((m) => m.content)).toEqual(["from the underscore key"]);
  });

  it("does not park the fresh file again on the next start", () => {
    // The `.ambiguous-` file IS the record that the decision was taken. Without
    // it, every restart would quarantine the history written since the last one.
    const first = newStore();
    first.setSdkSessionId(SUFFIXED, "sdk-underscore");
    writeFileSync(join(testDir, "dm_a_b.jsonl"), JSON.stringify(msg("mixed history")) + "\n");
    first.get(STABLE);
    first.append(STABLE, msg("mine now"));
    expect(quarantined()).toHaveLength(1);

    const second = newStore();
    expect(second.get(STABLE).messages.map((m) => m.content)).toEqual(["mine now"]);
    expect(quarantined()).toHaveLength(1);
    expect(readFileSync(join(testDir, "dm_a_b.jsonl"), "utf-8")).toContain("mine now");
  });

  it("reports the stem in migrationStatus", () => {
    const store = newStore();
    store.setSdkSessionId(SUFFIXED, "sdk-underscore");
    writeFileSync(join(testDir, "dm_a_b.jsonl"), JSON.stringify(msg("mixed history")) + "\n");
    store.get(STABLE);
    expect(store.migrationStatus().ambiguous).toEqual(["dm_a_b"]);
    // Read off the directory, so a fresh process sees it too.
    expect(newStore().migrationStatus().ambiguous).toEqual(["dm_a_b"]);
  });

  it("leaves a stable key alone when nothing else claims its stem", () => {
    const store = newStore();
    writeFileSync(join(testDir, "dm_alice.jsonl"), JSON.stringify(msg("just mine")) + "\n");
    expect(store.get("dm:alice").messages.map((m) => m.content)).toEqual(["just mine"]);
    expect(quarantined()).toEqual([]);
    expect(warningsMatching("filename collision")).toHaveLength(0);
  });
});

describe("ownership is compared case-folded", () => {
  // APFS and NTFS fold case, so `imessage_A.b`-shaped and `imessage_a.b`-shaped
  // legacy stems are ONE file there. Comparing them verbatim answered "sole
  // owner" for a file two keys share (codex #1).
  const UPPER_KEY = "imessage:A.b";
  const LOWER_KEY = "imessage:a.b";

  it("refuses a legacy file whose other owner differs only in case", () => {
    expect(legacyTranscriptFileStem(UPPER_KEY)).not.toBe(legacyTranscriptFileStem(LOWER_KEY));
    expect(legacyTranscriptFileStem(UPPER_KEY).toLowerCase())
      .toBe(legacyTranscriptFileStem(LOWER_KEY).toLowerCase());

    const store = newStore();
    store.setSdkSessionId(UPPER_KEY, "sdk-upper");
    const legacyPath = join(testDir, `${legacyTranscriptFileStem(LOWER_KEY)}.jsonl`);
    writeFileSync(legacyPath, JSON.stringify(msg("possibly shared")) + "\n");

    expect(store.get(LOWER_KEY).messages).toEqual([]);
    expect(existsSync(legacyPath)).toBe(true);
    const collisions = warningsMatching("filename collision");
    expect(collisions).toHaveLength(1);
    expect((collisions[0][0] as { keys: string[] }).keys).toContain(UPPER_KEY);
  });

  it("finds a case-only partner recorded in the ledger under the other casing", () => {
    const first = newStore();
    first.setChatTitle(UPPER_KEY, "A");
    first.clearSdkSessionId(UPPER_KEY); // stub removed, ownership recorded
    const ledger = JSON.parse(readFileSync(join(testDir, "_legacy_stems.json"), "utf-8")) as
      { stems: Record<string, string[]> };
    expect(Object.keys(ledger.stems)).toEqual([legacyTranscriptFileStem(UPPER_KEY)]);

    const legacyPath = join(testDir, `${legacyTranscriptFileStem(LOWER_KEY)}.jsonl`);
    writeFileSync(legacyPath, JSON.stringify(msg("possibly shared")) + "\n");
    const second = newStore();
    warn.mockClear();
    expect(second.get(LOWER_KEY).messages).toEqual([]);
    expect(existsSync(legacyPath)).toBe(true);
    expect(warningsMatching("filename collision")).toHaveLength(1);
  });
});

describe("writers never see a sidecar or a quarantined file", () => {
  const STEM = () => transcriptFileStem(ALEX_DOT);

  it("does not list a `.legacy-` or `.ambiguous-` name as a rotation archive", () => {
    const store = newStore();
    const stem = STEM();
    // Everything here is named like an archive right up to the strict remainder.
    for (const name of [
      `_archive_${stem}_2026-01.legacy-20260301-120000.jsonl`,
      `_archive_${stem}_2026-01.ambiguous-20260301-120000.jsonl`,
      `_archive_${stem}_2026-01.jsonl.premerge-bak`,
      `_archive_${stem}_2026-1.jsonl`,
      `_archive_${stem}_2026-01-extra.jsonl`,
    ]) {
      writeFileSync(join(testDir, name), JSON.stringify(msg("not an archive")) + "\n");
    }
    writeFileSync(join(testDir, `_archive_${stem}_2026-02.jsonl`), JSON.stringify(msg("a real archive")) + "\n");

    // A re-key renames exactly the writer-side family, so what it moved IS the
    // archive list.
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    store.migrateSessionKey(ALEX_DOT, "dm:alex");

    expect(existsSync(join(testDir, "_archive_dm_alex_2026-02.jsonl"))).toBe(true);
    expect(existsSync(join(testDir, `_archive_${stem}_2026-01.ambiguous-20260301-120000.jsonl`))).toBe(true);
    expect(existsSync(join(testDir, `_archive_${stem}_2026-01.jsonl.premerge-bak`))).toBe(true);
    expect(existsSync(join(testDir, `_archive_${stem}_2026-1.jsonl`))).toBe(true);
    expect(existsSync(join(testDir, `_archive_${stem}_2026-01-extra.jsonl`))).toBe(true);
    // The sidecar IS carried, because readers see it — under the new base.
    expect(existsSync(join(testDir, `_archive_${stem}_2026-01.legacy-20260301-120000.jsonl`))).toBe(false);
    expect(readdirSync(testDir).some((n) => /^_archive_dm_alex_2026-01\.legacy-/.test(n))).toBe(true);
  });

  it("never matches a sidecar as the active file", () => {
    const store = newStore();
    const stem = STEM();
    const sidecarPath = join(testDir, `${stem}.legacy-20260301-120000.jsonl`);
    const sidecarBytes = JSON.stringify(msg("history", Date.parse("2026-02-01T00:00:00Z"))) + "\n";
    writeFileSync(sidecarPath, sidecarBytes);
    store.append(ALEX_DOT, msg("live", Date.parse("2026-03-01T00:00:00Z")));

    // The append went to `<stem>.jsonl`, and the sidecar is byte-for-byte what
    // it was: a writer cannot resolve to it, so nothing can rewrite it.
    expect(readFileSync(join(testDir, `${stem}.jsonl`), "utf-8")).toContain("live");
    expect(readFileSync(join(testDir, `${stem}.jsonl`), "utf-8")).not.toContain("history");
    expect(readFileSync(sidecarPath, "utf-8")).toBe(sidecarBytes);
    // …and a read covers both.
    expect(store.searchTranscript(ALEX_DOT, {}).map((m) => m.content)).toEqual(["history", "live"]);
  });
});

describe("seq allocation over a transcript that is not monotonic", () => {
  it("continues from the highest seq in the tail, not the newest one", () => {
    // A hand-repaired transcript (or one restored from two backups) can leave
    // the tail out of order. Taking the NEWEST record's seq there hands a number
    // out twice — and rotation reads a seq it has already archived as "already
    // archived" and DROPS the record, so a reused seq is data loss rather than
    // cosmetics. Independently correct, which is why it survived the fold it was
    // first written for.
    const key = "dm:shuai";
    const file = join(testDir, "dm_shuai.jsonl");
    writeFileSync(
      file,
      JSON.stringify({ ...msg("older, higher seq", Date.parse("2026-02-01T00:00:00Z")), seq: 5 }) + "\n"
      + JSON.stringify({ ...msg("newer, lower seq", Date.parse("2026-02-02T00:00:00Z")), seq: 3 }) + "\n",
    );

    const store = newStore();
    store.append(key, msg("next", Date.parse("2026-02-03T00:00:00Z")));

    const seqs = readFileSync(file, "utf-8").trimEnd().split("\n")
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual([5, 3, 6]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
