import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("tolerates a mangled ledger instead of failing the message path", () => {
    writeFileSync(LEDGER(), "{not json");
    const store = newStore();
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    writeFileSync(join(testDir, `${legacy}.jsonl`), JSON.stringify(msg("only owner")) + "\n");

    // Unreadable ledger, no other known owner → the file is adopted, loudly
    // rather than fatally.
    expect(store.get(ALEX_DOT).messages.map((m) => m.content)).toEqual(["only owner"]);
    expect(warningsMatching("Could not load the legacy transcript stem ledger").length).toBeGreaterThan(0);
  });

  it("leaves the everyday keys out of the migration path entirely", () => {
    const store = newStore();
    store.append("dm:shuai", msg("hello"));
    expect(existsSync(join(testDir, "dm_shuai.jsonl"))).toBe(true);
    expect(store.get("dm:shuai").messages.map((m) => m.content)).toEqual(["hello"]);
  });
});

describe("a deferred transcript migration is retried, never forgotten", () => {
  const T1 = Date.parse("2026-02-01T00:00:00Z");
  const T2 = Date.parse("2026-02-02T00:00:00Z");

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

  it("recovers the whole history after a lock timeout, an append, and a restart", () => {
    // THE REVIEWER'S REPRODUCTION. The attempt is deferred, the triggering
    // message lands under the new stem, and both files then exist — which the
    // first version of this code read as "leave the legacy file alone", i.e.
    // every older message present on disk and reachable from nothing.
    const legacyPath = seedLegacyActive(ALEX_DOT);
    const newPath = join(testDir, `${transcriptFileStem(ALEX_DOT)}.jsonl`);

    const lockDir = holdTranscriptLock();
    const first = newStore();
    first.setSdkSessionId(ALEX_DOT, "sdk-1");
    first.append(ALEX_DOT, msg("arrived while the lock was held", Date.parse("2026-02-03T00:00:00Z")));
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(newPath)).toBe(true);
    expect(warningsMatching("another process holds the transcript lock")).toHaveLength(1);

    // The holder finishes and the daemon restarts.
    rmSync(lockDir, { recursive: true, force: true });
    const second = newStore();
    const session = second.get(ALEX_DOT);

    expect(session.messages.map((m) => m.content))
      .toEqual(["legacy one", "legacy two", "arrived while the lock was held"]);
    expect(session.createdAt).toBe(T1);
    expect(second.searchTranscript(ALEX_DOT, {}).map((m) => m.content))
      .toEqual(["legacy one", "legacy two", "arrived while the lock was held"]);
    expect(second.searchTranscript(ALEX_DOT, { query: "legacy" })).toHaveLength(2);
    expect(second.countRecentUserMessages(ALEX_DOT)).toBe(3);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${newPath}.premerge-bak`)).toBe(false);

    // One increasing, duplicate-free seq run, so the next append cannot reuse
    // a number rotation already treats as archived.
    const seqs = seqsIn(newPath);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    second.append(ALEX_DOT, msg("after the fold", Date.parse("2026-02-04T00:00:00Z")));
    const after = seqsIn(newPath);
    expect(after[after.length - 1]).toBe(Math.max(...seqs) + 1);
  });

  it("retries inside the same process once the throttle elapses", () => {
    // The (a) half on its own: a deferred attempt must not be recorded as a
    // completed check. Nothing here restarts the store, so only a genuine
    // retry can recover the history.
    const legacyPath = seedLegacyActive(ALEX_DOT);
    const lockDir = holdTranscriptLock();
    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    store.append(ALEX_DOT, msg("arrived while the lock was held", Date.parse("2026-02-03T00:00:00Z")));
    expect(store.get(ALEX_DOT).messages.map((m) => m.content)).toEqual(["arrived while the lock was held"]);

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
  });

  it("carries the archives across too when the active file has to be folded", () => {
    // Reviewer's item 6: a refused active file used to leave the archives
    // half-adopted. Nothing legacy-named may survive the pass.
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    const stem = transcriptFileStem(ALEX_DOT);
    const legacyPath = seedLegacyActive(ALEX_DOT);
    writeFileSync(join(testDir, `_archive_${legacy}_2026-01.jsonl`), seq("january", Date.parse("2026-01-05T00:00:00Z"), 0));
    writeFileSync(join(testDir, `${stem}.jsonl`), seq("post-migration", Date.parse("2026-02-03T00:00:00Z"), 1));

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

  it("folds the legacy archive into an archive of the same month", () => {
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    const stem = transcriptFileStem(ALEX_DOT);
    writeFileSync(join(testDir, `_archive_${legacy}_2026-01.jsonl`), seq("legacy january", Date.parse("2026-01-05T00:00:00Z"), 7));
    writeFileSync(join(testDir, `_archive_${stem}_2026-01.jsonl`), seq("new january", Date.parse("2026-01-20T00:00:00Z"), 1));

    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    expect(store.searchTranscript(ALEX_DOT, {}).map((m) => m.content)).toEqual(["legacy january", "new january"]);
    expect(existsSync(join(testDir, `_archive_${legacy}_2026-01.jsonl`))).toBe(false);
    const seqs = seqsIn(join(testDir, `_archive_${stem}_2026-01.jsonl`));
    expect(seqs).toEqual([7, 8]);
  });

  it("does not fold twice when a crash left the legacy file behind", () => {
    // A pass that died between the atomic rename and the unlink: the target
    // already carries the legacy bytes at its head.
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    const stem = transcriptFileStem(ALEX_DOT);
    const legacyText = seq("legacy one", T1, 1) + seq("legacy two", T2, 2);
    writeFileSync(join(testDir, `${legacy}.jsonl`), legacyText);
    writeFileSync(join(testDir, `${stem}.jsonl`), legacyText + seq("post-migration", Date.parse("2026-02-03T00:00:00Z"), 3));

    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-1");
    expect(store.get(ALEX_DOT).messages.map((m) => m.content))
      .toEqual(["legacy one", "legacy two", "post-migration"]);
    expect(existsSync(join(testDir, `${legacy}.jsonl`))).toBe(false);
  });

  it("refuses to fold an ambiguous legacy file, even when both names exist", () => {
    const legacy = legacyTranscriptFileStem(ALEX_DOT);
    const stem = transcriptFileStem(ALEX_DOT);
    const store = newStore();
    store.setSdkSessionId(ALEX_DOT, "sdk-dot");
    store.setSdkSessionId(ALEX_UNDERSCORE, "sdk-underscore");
    writeFileSync(join(testDir, `${legacy}.jsonl`), seq("mixed history", T1, 1));
    writeFileSync(join(testDir, `${stem}.jsonl`), seq("mine alone", T2, 1));

    expect(store.get(ALEX_DOT).messages.map((m) => m.content)).toEqual(["mine alone"]);
    expect(readFileSync(join(testDir, `${legacy}.jsonl`), "utf-8")).toContain("mixed history");
    expect(warningsMatching("filename collision")).toHaveLength(1);
  });
});

describe("seq allocation over a transcript that is not monotonic", () => {
  it("continues from the highest seq in the tail, not the newest one", () => {
    // A fold puts OLDER records back into the active file, and a fold that
    // only partly applied (or was interrupted before its target's archives
    // were reconciled) can leave the tail out of order. Taking the NEWEST
    // record's seq there hands a number out twice — and rotation reads a seq
    // it has already archived as "already archived" and DROPS the record, so a
    // reused seq is data loss rather than cosmetics.
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
