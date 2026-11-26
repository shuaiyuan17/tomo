import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTomoDb, TomoDb } from "../src/db/index.js";
import { PendingNotesQueue } from "../src/agent/pending-notes-queue.js";
import { makeSessionStore } from "./helpers/session-store-fixtures.js";

// ---------------------------------------------------------------------------
// Pending notes as rows in tomo.db (src/sessions/pending-notes-store.ts):
// the one-time import of _pending_notes.json, per-session writes, re-keys,
// rollback of a write that fails half-way, and a damaged database.
// ---------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), "tomo-pending-db-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
let n = 0;
function freshDir(): string {
  const dir = join(ROOT, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const legacy = (dir: string) => join(dir, "_pending_notes.json");
const filesLike = (dir: string, prefix: string) => readdirSync(dir).filter((f) => f.startsWith(prefix));
function writeLegacy(dir: string, notes: Record<string, string[]>): string {
  const text = JSON.stringify({ version: 1, notes });
  writeFileSync(legacy(dir), text);
  return text;
}
/** Rows as stored, read straight from the database. */
function rows(dir: string): Array<{ session_key: string; position: number; note: string }> {
  const db = openTomoDb(join(dir, "tomo.db"), { readOnly: true });
  try {
    return db.all("SELECT session_key, position, note FROM pending_notes ORDER BY session_key, position");
  } finally {
    db.close();
  }
}

describe("importing _pending_notes.json", () => {
  it("imports every session's notes in order, renames the file, and never reads it again", () => {
    const dir = freshDir();
    const text = writeLegacy(dir, { "dm:alice": ["a1", "a2"], "telegram:-9": ["g1"] });
    const store = makeSessionStore(dir);
    expect(store.getPendingNotes("dm:alice")).toEqual(["a1", "a2"]);
    expect(store.getPendingNotes("telegram:-9")).toEqual(["g1"]);
    expect(existsSync(legacy(dir))).toBe(false);
    const migrated = filesLike(dir, "_pending_notes.json.migrated-");
    expect(migrated).toHaveLength(1);
    expect(readFileSync(join(dir, migrated[0]), "utf8")).toBe(text);
    // Writes go to the database only: no file appears again (no dual write).
    store.setPendingNotes("dm:alice", ["a1"]);
    expect(existsSync(legacy(dir))).toBe(false);
    expect(makeSessionStore(dir).getPendingNotes("dm:alice")).toEqual(["a1"]);
  });

  it("a crash after the import committed but before the rename imports nothing twice", () => {
    const dir = freshDir();
    writeLegacy(dir, { "dm:alice": ["only once"] });
    const first = makeSessionStore(dir);
    // The rename fails (a crash at that point leaves the same state).
    const proto = Object.getPrototypeOf(first) as { moveWithoutClobber(from: string, to: string): string };
    const spy = vi.spyOn(proto, "moveWithoutClobber").mockImplementation(() => { throw new Error("EIO"); });
    expect(first.getPendingNotes("dm:alice")).toEqual(["only once"]);
    expect(existsSync(legacy(dir))).toBe(true);
    // The note was delivered and settled before the restart.
    first.setPendingNotes("dm:alice", []);
    spy.mockRestore();

    const second = makeSessionStore(dir);
    expect(second.getPendingNotes("dm:alice")).toEqual([]);
    expect(existsSync(legacy(dir))).toBe(false);
    expect(filesLike(dir, "_pending_notes.json.migrated-")).toHaveLength(1);
  });

  it("a file written later (an older Tomo ran after a rollback) replaces the table", () => {
    const dir = freshDir();
    writeLegacy(dir, { "dm:alice": ["from the first upgrade"] });
    makeSessionStore(dir).getPendingNotes("dm:alice");
    // The older Tomo read its exported file, delivered that note and queued another.
    writeLegacy(dir, { "dm:bob": ["queued by the older Tomo"] });
    const store = makeSessionStore(dir);
    expect(store.getPendingNotes("dm:alice")).toEqual([]);
    expect(store.getPendingNotes("dm:bob")).toEqual(["queued by the older Tomo"]);
    expect(filesLike(dir, "_pending_notes.json.migrated-")).toHaveLength(2);
  });

  it("a later file with the same bytes as an earlier import is still imported", () => {
    const dir = freshDir();
    writeLegacy(dir, { "dm:alice": ["same"] });
    const store = makeSessionStore(dir);
    expect(store.getPendingNotes("dm:alice")).toEqual(["same"]);
    store.setPendingNotes("dm:alice", []); // delivered
    // After a rollback an older Tomo happens to write the very same file again.
    writeLegacy(dir, { "dm:alice": ["same"] });
    expect(makeSessionStore(dir).getPendingNotes("dm:alice")).toEqual(["same"]);
  });

  it("an import that fails half-way leaves the table and the file as they were", () => {
    const dir = freshDir();
    makeSessionStore(dir).setPendingNotes("dm:carol", ["already here"]);
    writeLegacy(dir, { "dm:alice": ["a1", "a2"], "dm:bob": ["b1"] });
    const real = TomoDb.prototype.run;
    let inserts = 0;
    vi.spyOn(TomoDb.prototype, "run").mockImplementation(function (this: TomoDb, sql: string, ...params) {
      if (sql.startsWith("INSERT INTO pending_notes") && ++inserts === 3) throw new Error("disk full");
      return real.call(this, sql, ...params);
    });
    expect(() => makeSessionStore(dir).getPendingNotes("dm:alice")).toThrow("disk full");
    vi.restoreAllMocks();
    expect(rows(dir)).toEqual([{ session_key: "dm:carol", position: 0, note: "already here" }]);
    expect(existsSync(legacy(dir))).toBe(true);
    // Retried on the next start, whole.
    const store = makeSessionStore(dir);
    expect(store.getPendingNotes("dm:alice")).toEqual(["a1", "a2"]);
    expect(store.getPendingNotes("dm:bob")).toEqual(["b1"]);
  });

  it("an unreadable file is moved aside unchanged and the owner told; nothing is imported", () => {
    const dir = freshDir();
    writeFileSync(legacy(dir), '{"version":1,"notes":{"dm:alice":["trunc');
    const store = makeSessionStore(dir);
    const told: string[] = [];
    store.onPendingNotesQuarantined = (aside) => told.push(aside);
    expect(store.getPendingNotes("dm:alice")).toEqual([]);
    const asides = filesLike(dir, "_pending_notes.json.corrupt-");
    expect(asides).toHaveLength(1);
    expect(told).toEqual([join(dir, asides[0])]);
    expect(store.quarantinedPendingNotes()).toEqual([join(dir, asides[0])]);
    expect(readFileSync(join(dir, asides[0]), "utf8")).toBe('{"version":1,"notes":{"dm:alice":["trunc');
  });
});

describe("outside the daemon (no maintenance)", () => {
  it("a store that finds the old file not yet imported refuses, and leaves the file for the daemon", () => {
    const dir = freshDir();
    const text = writeLegacy(dir, { "dm:alice": ["not yet imported"] });
    const cli = makeSessionStore(dir, { dbMaintenance: false });
    expect(() => cli.getPendingNotes("dm:alice")).toThrow(/has not been imported/);
    expect(() => cli.setPendingNotes("dm:alice", [])).toThrow(/has not been imported/);
    expect(readFileSync(legacy(dir), "utf8")).toBe(text);
    // The daemon's store imports it.
    expect(makeSessionStore(dir).getPendingNotes("dm:alice")).toEqual(["not yet imported"]);
    expect(makeSessionStore(dir, { dbMaintenance: false }).getPendingNotes("dm:alice")).toEqual(["not yet imported"]);
  });

});

describe("one row per note", () => {
  it("a write for one session never touches another's (#649)", () => {
    const dir = freshDir();
    const store = makeSessionStore(dir);
    store.setPendingNotes("dm:alice", ["a1"]);
    store.setPendingNotes("telegram:-9", ["g1", "g2"]);
    store.setPendingNotes("dm:alice", []);
    store.setPendingNotes("dm:alice", ["a2"]);
    expect(rows(dir)).toEqual([
      { session_key: "dm:alice", position: 0, note: "a2" },
      { session_key: "telegram:-9", position: 0, note: "g1" },
      { session_key: "telegram:-9", position: 1, note: "g2" },
    ]);
  });

  it("a write that fails half-way is rolled back: the session keeps its previous notes", () => {
    const dir = freshDir();
    const store = makeSessionStore(dir);
    store.setPendingNotes("dm:alice", ["old1", "old2"]);
    const real = TomoDb.prototype.run;
    let inserts = 0;
    vi.spyOn(TomoDb.prototype, "run").mockImplementation(function (this: TomoDb, sql: string, ...params) {
      if (sql.startsWith("INSERT INTO pending_notes") && ++inserts === 2) throw new Error("crash mid-write");
      return real.call(this, sql, ...params);
    });
    expect(() => store.setPendingNotes("dm:alice", ["new1", "new2", "new3"])).toThrow("crash mid-write");
    vi.restoreAllMocks();
    expect(makeSessionStore(dir).getPendingNotes("dm:alice")).toEqual(["old1", "old2"]);
  });

  it("the queue keeps a note in memory when the write fails, and writes it with the next one", () => {
    const dir = freshDir();
    const store = makeSessionStore(dir);
    const queue = new PendingNotesQueue(store);
    const real = TomoDb.prototype.run;
    const spy = vi.spyOn(TomoDb.prototype, "run").mockImplementation(function (this: TomoDb, sql: string, ...params) {
      if (sql.startsWith("INSERT INTO pending_notes")) throw new Error("busy");
      return real.call(this, sql, ...params);
    });
    expect(queue.queueNote("dm:alice", "first")).toBe(false);
    spy.mockRestore();
    expect(queue.queueNote("dm:alice", "second")).toBe(true);
    expect(makeSessionStore(dir).getPendingNotes("dm:alice")).toEqual(["first", "second"]);
  });
});

describe("re-keying a session", () => {
  function linked(dir: string) {
    const store = makeSessionStore(dir);
    store.setSdkSessionId("telegram:111", "session-old");
    store.append("telegram:111", { role: "user", content: "before", timestamp: Date.now() });
    return store;
  }

  it("moves the old key's notes after the new key's, in one transaction", () => {
    const dir = freshDir();
    const store = linked(dir);
    store.setPendingNotes("dm:alice", ["already queued for alice"]);
    store.setPendingNotes("telegram:111", ["from telegram 1", "from telegram 2"]);
    store.setPendingNotes("dm:bob", ["bob's"]);
    store.migrateSessionKey("telegram:111", "dm:alice");
    const fresh = makeSessionStore(dir);
    expect(fresh.getPendingNotes("telegram:111")).toEqual([]);
    expect(fresh.getPendingNotes("dm:alice")).toEqual(["already queued for alice", "from telegram 1", "from telegram 2"]);
    expect(fresh.getPendingNotes("dm:bob")).toEqual(["bob's"]);
  });

  it("a move that fails half-way leaves both keys' notes as they were", () => {
    const dir = freshDir();
    const store = linked(dir);
    store.setPendingNotes("dm:alice", ["alice's"]);
    store.setPendingNotes("telegram:111", ["t1", "t2"]);
    const real = TomoDb.prototype.run;
    let inserts = 0;
    vi.spyOn(TomoDb.prototype, "run").mockImplementation(function (this: TomoDb, sql: string, ...params) {
      // The third insert: alice's and t1 are already rewritten under dm:alice.
      if (sql.startsWith("INSERT INTO pending_notes") && ++inserts === 3) throw new Error("crash mid-move");
      return real.call(this, sql, ...params);
    });
    expect(() => store.migrateSessionKey("telegram:111", "dm:alice")).toThrow("crash mid-move");
    vi.restoreAllMocks();
    const fresh = makeSessionStore(dir);
    expect(fresh.getPendingNotes("dm:alice")).toEqual(["alice's"]);
    expect(fresh.getPendingNotes("telegram:111")).toEqual(["t1", "t2"]);
  });

  it("is refused before anything moves when the database cannot be opened", () => {
    const dir = freshDir();
    const store = linked(dir);
    // A newer Tomo's database: refused, never read or written.
    const db = openTomoDb(join(dir, "tomo.db"), { migrations: [{ version: 99, up: () => {} }] });
    db.close();
    expect(() => store.migrateSessionKey("telegram:111", "dm:alice")).toThrow(/newer than this Tomo/);
    const fresh = makeSessionStore(dir);
    expect(fresh.getEntry("telegram:111")?.sdkSessionId).toBe("session-old");
    expect(fresh.getEntry("dm:alice")).toBeUndefined();
    expect(fresh.loadTranscript("telegram:111").map((m) => m.content)).toEqual(["before"]);
  });
});

describe("a damaged database", () => {
  it("is never moved or written: every call throws, the store says why, and the queue holds notes in memory", () => {
    for (const maintenance of [true, false]) {
      const dir = freshDir();
      writeFileSync(join(dir, "tomo.db"), "not a database ".repeat(300));
      const store = makeSessionStore(dir, { dbMaintenance: maintenance });
      expect(store.pendingNotesDbDamage()).toBeNull();
      store.preparePendingNotes(); // the daemon's start: logs, never throws
      expect(store.pendingNotesDbDamage()?.path).toBe(join(dir, "tomo.db"));
      expect(() => store.getPendingNotes("dm:alice")).toThrow(/tomo db repair/);
      const queue = new PendingNotesQueue(store);
      expect(queue.queueNote("dm:alice", "kept in memory")).toBe(false);
      expect(queue.peekNotes("dm:alice")).toEqual(["kept in memory"]);
      expect(readFileSync(join(dir, "tomo.db"), "utf8")).toBe("not a database ".repeat(300));
      expect(filesLike(dir, "tomo.db.corrupt-")).toEqual([]);
    }
  });
});
