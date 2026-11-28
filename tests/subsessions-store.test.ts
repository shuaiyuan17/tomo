import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportSubsessionsToFile, parseTable, readSubsessionTitles, SUBSESSIONS_EXPORTED_KEY, SubsessionStore, SubsessionStoreError } from "../src/agent/subsessions/store.js";
import { openTomoDb, sharedTomoDb, TomoDb } from "../src/db/index.js";
import { metaValue } from "../src/db/legacy.js";
import * as fsUtils from "../src/fs-utils.js";
import { TRANSITION_LOG_KEEP, appendInput, HARNESS } from "../src/agent/subsessions/types.js";

let dir = "";
let path = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-substore-"));
  path = join(dir, "data", "subsessions.json");
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

/** A table in the old file's format, as a live install left it: `n` tasks with every field an older Tomo wrote. */
function legacyTable(n: number, extra: (i: number) => Record<string, unknown> = () => ({})): Record<string, unknown> {
  const tasks = Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return {
      id: `s${i}`, sessionKey: `task:s${i}`, parentKey: i % 2 ? "dm:owner" : "telegram:-100", title: `Task ${i}`, brief: `Brief ${i}`,
      status: i === 1 ? "active" : i === 2 ? "waiting" : "finished", ...(i === 2 ? { waitingOn: "owner", waitingReason: "asked" } : {}),
      createdAt: 1_000 * i, lastActivityAt: 2_000 * i, activeMs: 5 * i, resumeNeeded: false, startDelivered: true, interruptStreak: 0, failStreak: 0,
      turnsWithoutProgress: 0, restartRequested: false, reportDelivered: i > 2, compactPending: false, postCompactReminder: false,
      pendingInput: i === 1 ? [{ seq: 4, text: "hello", from: "harness" }] : [], nextInputSeq: 5, seenThrough: 3,
      replyMap: [], ownerMessageIds: [], conversation: [{ seq: 1, at: 3, from: "task", text: `said ${i}` }], conversationSeq: 1, mirrorSeenSeq: 1,
      sent: [], transitions: [{ at: 1_000 * i, from: null, to: "queued", event: "spawn" }],
      ...(i > 2 ? { report: `Report ${i}`, reportSeq: 1, endedAt: 9_000 } : {}),
      ...extra(i),
    };
  });
  return { version: 1, nextId: n + 3, tasks };
}
const filesLike = (prefix: string) => readdirSync(join(dir, "data")).filter((f) => f.startsWith(prefix));
function writeLegacy(table: unknown, file = path): string {
  mkdirSync(join(dir, "data"), { recursive: true });
  const text = JSON.stringify(table, null, 2);
  writeFileSync(file, text);
  return text;
}

describe("SubsessionStore", () => {
  it("hands out global ids s1, s2… and keys task:<id>, never reused", () => {
    const store = new SubsessionStore(path, { strictTransitions: true });
    const a = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    const b = store.create({ parentKey: "telegram:-100", title: "c", brief: "d" });
    expect([a.id, a.sessionKey, b.id, b.sessionKey]).toEqual(["s1", "task:s1", "s2", "task:s2"]);
    store.remove([b.id]);
    expect(store.create({ parentKey: "dm:owner", title: "e", brief: "f" }).id).toBe("s3");
  });

  it("keeps the owning scope on the record only", () => {
    const store = new SubsessionStore(path);
    const t = store.create({ parentKey: "telegram:-100", title: "a", brief: "b", quote: ["do it"] });
    expect(store.get(t.id)).toMatchObject({ parentKey: "telegram:-100", status: "queued", quote: ["do it"], startDelivered: false, pendingInput: [] });
  });

  it("persists across instances, in the database beside the old file's path", () => {
    new SubsessionStore(path).create({ parentKey: "dm:owner", title: "a", brief: "b" });
    expect(existsSync(join(dir, "data", "tomo.db"))).toBe(true);
    expect(existsSync(`${path}.bak`)).toBe(false);
    expect(new SubsessionStore(path).list()).toHaveLength(1);
    expect(new SubsessionStore(path).state()).toBe(null);
  });

  it("reads a table never written as empty (missing), and an emptied one as ok", () => {
    const store = new SubsessionStore(path);
    expect(store.list()).toEqual([]);
    expect(store.state()).toBe("missing");
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    store.remove([t.id]);
    const again = new SubsessionStore(path);
    expect(again.list()).toEqual([]);
    expect(again.state()).toBe("ok");
  });

  it("writes only the rows that changed", () => {
    const store = new SubsessionStore(path);
    const a = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    store.create({ parentKey: "dm:owner", title: "c", brief: "d" });
    const db = sharedTomoDb(join(dir, "data", "tomo.db"));
    const before = db.get<{ n: number }>("SELECT total_changes() AS n")!.n;
    store.update(a.id, (r) => { r.activeMs += 1; });
    expect(db.get<{ n: number }>("SELECT total_changes() AS n")!.n - before).toBe(1);
  });

  it("refuses every read and write when a stored row does not parse, instead of reading it as empty", () => {
    const store = new SubsessionStore(path);
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    sharedTomoDb(join(dir, "data", "tomo.db")).run("UPDATE subsessions SET record = json_set(record, '$.status', 'bogus') WHERE id = ?", t.id);
    const again = new SubsessionStore(path);
    expect(() => again.list()).toThrow(SubsessionStoreError);
    expect(again.state()).toBe("unreadable");
    expect(() => again.create({ parentKey: "dm:owner", title: "x", brief: "y" })).toThrow(SubsessionStoreError);
  });

  it("refuses every read and write when the database is damaged, and imports nothing", () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "tomo.db"), "garbage ".repeat(600));
    writeFileSync(path, JSON.stringify(legacyTable(2)));
    const store = new SubsessionStore(path);
    expect(() => store.list()).toThrow(SubsessionStoreError);
    expect(store.state()).toBe("unreadable");
    expect(JSON.parse(readFileSync(path, "utf8")).tasks).toHaveLength(2);
  });

  it("never drops accepted input, and a guard refuses a transition without writing", () => {
    const store = new SubsessionStore(path, { strictTransitions: true });
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    for (let i = 0; i < 30; i++) store.transition(t.id, "relay", { patch: (r) => { appendInput(r, `m${i}`, HARNESS); } });
    expect(store.get(t.id)?.pendingInput).toHaveLength(30);
    const refused = store.transition(t.id, "relay", { guard: () => "full", patch: (r) => { appendInput(r, "x", HARNESS); } });
    expect(refused).toMatchObject({ ok: false, refused: "full" });
    expect(store.get(t.id)?.pendingInput).toHaveLength(30);
  });

  it("reserves ids so a new task never reuses one the registry still holds", () => {
    const store = new SubsessionStore(path);
    store.reserveIdsThrough(4);
    expect(store.create({ parentKey: "dm:owner", title: "a", brief: "b" }).id).toBe("s5");
    store.reserveIdsThrough(2);
    expect(store.create({ parentKey: "dm:owner", title: "a", brief: "b" }).id).toBe("s6");
  });

  it("update() may not change the lifecycle", () => {
    const store = new SubsessionStore(path);
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    expect(() => store.update(t.id, (r) => { r.status = "active"; })).toThrow(/transition/);
    expect(store.get(t.id)?.status).toBe("queued");
  });

  it("a transition patch may not change the status", () => {
    const store = new SubsessionStore(path);
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    expect(() => store.transition(t.id, "start", { patch: (r) => { r.status = "finished"; } })).toThrow(/patch/);
    expect(store.get(t.id)?.status).toBe("queued");
  });

  it("banks active time when a task leaves active", () => {
    let now = 1_000;
    const store = new SubsessionStore(path, { now: () => now });
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    store.transition(t.id, "start");
    now += 5_000;
    store.transition(t.id, "stuck");
    expect(store.get(t.id)).toMatchObject({ activeMs: 5_000 });
    expect(store.get(t.id)?.activeSince).toBeUndefined();
  });

  // 81 locked, fsynced writes: seconds on a slow disk under a full parallel run.
  it("caps the transition log", { timeout: 30_000 }, () => {
    const store = new SubsessionStore(path);
    const t = store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    store.transition(t.id, "start");
    for (let i = 0; i < 40; i++) {
      store.transition(t.id, "stuck");
      store.transition(t.id, "owner_message");
    }
    expect(store.get(t.id)?.transitions).toHaveLength(TRANSITION_LOG_KEEP);
  });

  it("parseTable defaults fields a newer version added and rejects a bad core field", () => {
    const parsed = parseTable({ version: 1, nextId: 2, tasks: [{ id: "s1", sessionKey: "task:s1", parentKey: "dm:o", title: "t", brief: "b", status: "active" }] });
    expect(parsed.tasks[0]).toMatchObject({ resumeNeeded: false, startDelivered: false, pendingInput: [], transitions: [] });
    expect(() => parseTable({ version: 1, nextId: 2, tasks: [{ id: "s1", status: "interrupted" }] })).toThrow();
    expect(() => parseTable({ version: 2, nextId: 1, tasks: [] })).toThrow();
  });
});

describe("importing the old subsessions.json", () => {
  it("imports every task field for field, keeps the file aside, moves .bak aside and leaves a placeholder an older Tomo refuses", () => {
    const table = legacyTable(5);
    const text = writeLegacy(table);
    writeLegacy(table, `${path}.bak`);
    const store = new SubsessionStore(path);
    const read = store.read();
    expect(store.state()).toBe("ok");
    expect(read.nextId).toBe(8);
    expect(read).toEqual(parseTable(table));
    expect(read.untrusted).toBeUndefined();
    // The file: a copy aside, byte for byte; a placeholder at the path.
    const aside = filesLike("subsessions.json.migrated-");
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, "data", aside[0]), "utf8")).toBe(text);
    expect(existsSync(`${path}.bak`)).toBe(false);
    expect(filesLike("subsessions.json.bak.migrated-")).toHaveLength(1);
    const placeholder = JSON.parse(readFileSync(path, "utf8"));
    expect(placeholder.movedToDatabase).toBe(join(dir, "data", "tomo.db"));
    expect(() => parseTable(placeholder)).toThrow();
    // Ids continue from the file's.
    expect(store.create({ parentKey: "dm:owner", title: "n", brief: "b" }).id).toBe("s8");
  });

  it("is idempotent: a second start, and a crash before the placeholder (the same file still there), import nothing again", () => {
    const text = writeLegacy(legacyTable(3));
    const first = new SubsessionStore(path);
    first.update("s1", (r) => { r.activeMs = 999; });
    // A crash between the import's commit and the placeholder leaves the file.
    writeFileSync(path, text);
    const second = new SubsessionStore(path);
    expect(second.get("s1")?.activeMs).toBe(999);
    expect(second.list()).toHaveLength(3);
    expect(filesLike("subsessions.json.migrated-")).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).movedToDatabase).toBeDefined();
    const third = new SubsessionStore(path);
    expect(third.list()).toHaveLength(3);
    expect(third.state()).toBe("ok");
  });

  it("a placeholder that cannot be written keeps sub-sessions off this start; the next start finishes the import", () => {
    writeLegacy(legacyTable(2));
    const real = fsUtils.writeJsonAtomicSync;
    vi.spyOn(fsUtils, "writeJsonAtomicSync").mockImplementation((file, value, o) => {
      if (file === path) throw new Error("EROFS");
      return real(file, value, o);
    });
    const store = new SubsessionStore(path);
    expect(() => store.list()).toThrow(/aside/);
    expect(store.state()).toBe("unreadable");
    vi.restoreAllMocks();
    expect(JSON.parse(readFileSync(path, "utf8")).tasks).toHaveLength(2);
    const next = new SubsessionStore(path);
    expect(next.list()).toHaveLength(2);
    expect(JSON.parse(readFileSync(path, "utf8")).movedToDatabase).toBeDefined();
  });

  it("a .bak that cannot be moved aside keeps sub-sessions off this start; an older Tomo would still see only what was imported", () => {
    const table = legacyTable(2);
    const text = writeLegacy(table);
    writeLegacy(table, `${path}.bak`);
    const real = fsUtils.writeFileAtomicSync;
    vi.spyOn(fsUtils, "writeFileAtomicSync").mockImplementation((file, content, o) => {
      if (String(file).includes(".bak.migrated-")) throw new Error("EIO");
      return real(file, content, o);
    });
    expect(() => new SubsessionStore(path).list()).toThrow(/aside/);
    vi.restoreAllMocks();
    // The file is still the imported table (the placeholder comes last here).
    expect(readFileSync(path, "utf8")).toBe(text);
    const next = new SubsessionStore(path);
    expect(next.list()).toHaveLength(2);
    expect(existsSync(`${path}.bak`)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).movedToDatabase).toBeDefined();
  });

  it("with only a .bak imported, the placeholder lands before the .bak goes (an older Tomo would recover the same table itself)", () => {
    writeLegacy(legacyTable(2), `${path}.bak`);
    writeFileSync(path, "");
    const real = fsUtils.writeFileAtomicSync;
    vi.spyOn(fsUtils, "writeFileAtomicSync").mockImplementation((file, content, o) => {
      if (String(file).includes(".bak.migrated-")) throw new Error("EIO");
      return real(file, content, o);
    });
    expect(() => new SubsessionStore(path).list()).toThrow(/aside/);
    vi.restoreAllMocks();
    expect(JSON.parse(readFileSync(path, "utf8")).movedToDatabase).toBeDefined();
    expect(existsSync(`${path}.bak`)).toBe(true);
    expect(new SubsessionStore(path).list()).toHaveLength(2);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it("a .bak left behind (a stop between the placeholder and moving it) is moved aside next start, never imported again", () => {
    const table = legacyTable(2);
    writeLegacy(table);
    new SubsessionStore(path).update("s1", (r) => { r.activeMs = 77; });
    writeLegacy(table, `${path}.bak`);
    const store = new SubsessionStore(path);
    expect(store.get("s1")?.activeMs).toBe(77);
    expect(store.state()).toBe("ok");
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it("after a rollback export the file wins even with the bytes of the file imported before", () => {
    const text = writeLegacy(legacyTable(2));
    const store = new SubsessionStore(path);
    store.create({ parentKey: "dm:owner", title: "made after the import", brief: "b" });
    const db = openTomoDb(join(dir, "data", "tomo.db"));
    try { exportSubsessionsToFile(db, path, { mark: true }); } finally { db.close(); }
    // The older Tomo (or a restored copy) put back exactly the first file.
    writeFileSync(path, text);
    expect(new SubsessionStore(path).list().map((t) => t.id)).toEqual(["s1", "s2"]);
  });

  it("a fresh install leaves the placeholder and reads as missing", () => {
    const store = new SubsessionStore(path);
    expect(store.list()).toEqual([]);
    expect(store.state()).toBe("missing");
    expect(JSON.parse(readFileSync(path, "utf8")).movedToDatabase).toBeDefined();
  });

  for (const [what, bad] of [["empty", ""], ["half-written", '{"version":1,"nextId":3,"tasks":[{"id":"s1","sessi'], ["not a table", '{"version":2}']] as const) {
    it(`an ${what} file with a good .bak imports the backup, untrusted (recovered), and keeps the bad file`, () => {
      writeLegacy(legacyTable(2), `${path}.bak`);
      writeFileSync(path, bad);
      const store = new SubsessionStore(path);
      const table = store.read();
      expect(store.state()).toBe("recovered");
      expect(table.tasks).toHaveLength(2);
      expect(table.untrusted).toMatchObject({ reason: "recovered" });
      expect(table.tasks.find((t) => t.id === "s1")?.restored).toBe(true);
      expect(filesLike("subsessions.json.corrupt-")).toHaveLength(1);
      expect(readFileSync(join(dir, "data", filesLike("subsessions.json.corrupt-")[0]), "utf8")).toBe(bad);
      // The next start reads the database: clean-looking, but still marked.
      const next = new SubsessionStore(path);
      expect(next.read().untrusted).toBeDefined();
      expect(next.state()).toBe("ok");
    });

    it(`an ${what} file with no usable .bak refuses every call and is left as it is`, () => {
      writeLegacy({}, `${path}.bak`);
      writeFileSync(`${path}.bak`, "{broken");
      writeFileSync(path, bad);
      const store = new SubsessionStore(path);
      expect(() => store.list()).toThrow(SubsessionStoreError);
      expect(store.state()).toBe("unreadable");
      expect(() => store.create({ parentKey: "dm:owner", title: "x", brief: "y" })).toThrow(SubsessionStoreError);
      expect(readFileSync(path, "utf8")).toBe(bad);
      expect(readFileSync(`${path}.bak`, "utf8")).toBe("{broken");
      // Fixed by hand: the next start imports it.
      writeLegacy(legacyTable(1));
      expect(new SubsessionStore(path).list()).toHaveLength(1);
    });
  }

  it("a missing file with a good .bak (a lost write) imports the backup, untrusted", () => {
    writeLegacy(legacyTable(2), `${path}.bak`);
    const store = new SubsessionStore(path);
    expect(store.list()).toHaveLength(2);
    expect(store.state()).toBe("recovered");
  });

  it("a missing file next to an unreadable .bak refuses: there was a table", () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(`${path}.bak`, "{broken");
    const store = new SubsessionStore(path);
    expect(() => store.list()).toThrow(SubsessionStoreError);
    expect(store.state()).toBe("unreadable");
  });

  it("an import that fails half-way leaves the database and the file as they were", () => {
    const text = writeLegacy(legacyTable(4));
    const db = sharedTomoDb(join(dir, "data", "tomo.db"));
    db.exec("CREATE TRIGGER fail_third AFTER INSERT ON subsessions WHEN NEW.id = 's3' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => new SubsessionStore(path).list()).toThrow(SubsessionStoreError);
    db.exec("DROP TRIGGER fail_third");
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM subsessions")!.n).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(new SubsessionStore(path).list()).toHaveLength(4);
  });

  it("refuses a table file the database did not import when the database already has a table, and changes nothing", () => {
    const store = new SubsessionStore(path);
    store.create({ parentKey: "dm:owner", title: "live", brief: "b" });
    const text = writeLegacy(legacyTable(2));
    const again = new SubsessionStore(path);
    expect(() => again.list()).toThrow(/has not imported/);
    expect(again.state()).toBe("unreadable");
    expect(readFileSync(path, "utf8")).toBe(text);
    // Moved aside by the owner: the database's table is back.
    rmSync(path);
    expect(new SubsessionStore(path).list().map((t) => t.title)).toEqual(["live"]);
  });

  it("a broken file beside a database that has the table is not newer: the table stays, the file is kept aside", () => {
    new SubsessionStore(path).create({ parentKey: "dm:owner", title: "live", brief: "b" });
    writeFileSync(path, "{broken");
    const store = new SubsessionStore(path);
    expect(store.list().map((t) => t.title)).toEqual(["live"]);
    expect(store.state()).toBe("ok");
    expect(filesLike("subsessions.json.corrupt-")).toHaveLength(1);
  });
});

describe("the rollback export (tomo db export subsessions)", () => {
  const dbPath = () => join(dir, "data", "tomo.db");

  it("writes the old file format; store calls refuse until the next start imports it back over the rows", () => {
    const store = new SubsessionStore(path);
    store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    store.create({ parentKey: "dm:owner", title: "c", brief: "d" });
    const db = openTomoDb(dbPath());
    try {
      expect(exportSubsessionsToFile(db, path, { mark: true })).toBe(2);
    } finally {
      db.close();
    }
    const exported = JSON.parse(readFileSync(path, "utf8"));
    expect(parseTable(exported).tasks.map((t) => t.title)).toEqual(["a", "c"]);
    expect(() => store.list()).toThrow(/exported for a rollback/);
    // The older Tomo ran on it: it removed s1 and added s3.
    exported.tasks = exported.tasks.filter((t: { id: string }) => t.id !== "s1");
    exported.tasks.push({ ...exported.tasks[0], id: "s3", sessionKey: "task:s3", title: "older" });
    exported.nextId = 4;
    delete exported.exportedAt;
    writeFileSync(path, JSON.stringify(exported));
    const back = new SubsessionStore(path);
    expect(back.list().map((t) => t.id)).toEqual(["s2", "s3"]);
    expect(metaValue(sharedTomoDb(dbPath()), SUBSESSIONS_EXPORTED_KEY)).toBeUndefined();
    expect(back.create({ parentKey: "dm:owner", title: "n", brief: "b" }).id).toBe("s4");
  });

  it("an export reads the state row and the task rows from one snapshot", () => {
    const store = new SubsessionStore(path);
    store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    const db = openTomoDb(dbPath());
    const other = openTomoDb(dbPath());
    const real = TomoDb.prototype.get;
    vi.spyOn(TomoDb.prototype, "get").mockImplementation(function (this: TomoDb, sql: string, ...params) {
      const row = real.call(this, sql, ...params);
      // Another process creates s2 right after the state row was read.
      if (this === db && sql.includes("FROM subsessions_state")) {
        other.transaction(() => {
          other.run("INSERT INTO subsessions (id, record) SELECT 's2', json_set(json_set(record, '$.id', 's2'), '$.sessionKey', 'task:s2') FROM subsessions WHERE id = 's1'");
          other.run("UPDATE subsessions_state SET next_id = 3");
        });
      }
      return row;
    });
    const out = join(dir, "copy.json");
    try {
      exportSubsessionsToFile(db, out, { mark: false });
    } finally {
      vi.restoreAllMocks();
      db.close();
      other.close();
    }
    const copy = JSON.parse(readFileSync(out, "utf8"));
    expect([copy.nextId, copy.tasks.length]).toEqual([2, 1]);
  });

  it("after a rollback export a .bak with the bytes imported before is still the truth when the file will not read", () => {
    const text = writeLegacy(legacyTable(2));
    const store = new SubsessionStore(path);
    store.create({ parentKey: "dm:owner", title: "made after the import", brief: "b" });
    const db = openTomoDb(dbPath());
    try { exportSubsessionsToFile(db, path, { mark: true }); } finally { db.close(); }
    writeFileSync(`${path}.bak`, text);
    writeFileSync(path, "{broken");
    const back = new SubsessionStore(path);
    expect(back.list().map((t) => t.id)).toEqual(["s1", "s2"]);
    expect(back.state()).toBe("recovered");
    expect(metaValue(sharedTomoDb(dbPath()), SUBSESSIONS_EXPORTED_KEY)).toBeUndefined();
  });

  it("refuses a rollback export beside a .bak, or with no table in the database, and marks nothing", () => {
    const db = openTomoDb(dbPath());
    try {
      expect(() => exportSubsessionsToFile(db, path, { mark: true })).toThrow(/no sub-session table/);
      mkdirSync(join(dir, "data"), { recursive: true });
      writeLegacy(legacyTable(3), `${path}.bak`);
      expect(() => exportSubsessionsToFile(db, path, { mark: true })).toThrow(/\.bak is there/);
      expect(metaValue(db, SUBSESSIONS_EXPORTED_KEY)).toBeUndefined();
      expect(existsSync(path)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("an export whose file never landed is undone: the mark goes, the rows stay", () => {
    const store = new SubsessionStore(path);
    store.create({ parentKey: "dm:owner", title: "a", brief: "b" });
    const db = openTomoDb(dbPath());
    vi.spyOn(fsUtils, "writeJsonAtomicSync").mockImplementation(() => { throw new Error("ENOSPC"); });
    try {
      expect(() => exportSubsessionsToFile(db, path, { mark: true })).toThrow("ENOSPC");
    } finally {
      db.close();
      vi.restoreAllMocks();
    }
    expect(metaValue(sharedTomoDb(dbPath()), SUBSESSIONS_EXPORTED_KEY)).toBeUndefined();
    expect(new SubsessionStore(path).list()).toHaveLength(1);
  });

  it("a mark left beside the placeholder (the process died before the file) is cleared at the next start", () => {
    new SubsessionStore(path).create({ parentKey: "dm:owner", title: "a", brief: "b" });
    sharedTomoDb(dbPath()).run("INSERT INTO meta (key, value) VALUES (?, 'x')", SUBSESSIONS_EXPORTED_KEY);
    const store = new SubsessionStore(path);
    expect(store.list()).toHaveLength(1);
    expect(metaValue(sharedTomoDb(dbPath()), SUBSESSIONS_EXPORTED_KEY)).toBeUndefined();
  });

  it("the commit comes before the file: a COMMIT that fails leaves no file behind", () => {
    new SubsessionStore(path).create({ parentKey: "dm:owner", title: "a", brief: "b" });
    const db = openTomoDb(dbPath());
    db.exec(`
      CREATE TABLE commit_guard (ref TEXT REFERENCES missing_parent (id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TABLE missing_parent (id TEXT PRIMARY KEY);
      CREATE TRIGGER fail_commit AFTER INSERT ON meta BEGIN INSERT INTO commit_guard (ref) VALUES ('nope'); END;
    `);
    try {
      expect(() => exportSubsessionsToFile(db, path, { mark: true })).toThrow(/FOREIGN KEY/i);
    } finally {
      db.exec("DROP TRIGGER fail_commit");
      db.close();
    }
    expect(JSON.parse(readFileSync(path, "utf8")).movedToDatabase).toBeDefined();
    expect(new SubsessionStore(path).list()).toHaveLength(1);
  });
});

describe("the web process's read", () => {
  it("reads titles read-only and never imports", () => {
    expect(readSubsessionTitles(join(dir, "data", "tomo.db")).size).toBe(0);
    writeLegacy(legacyTable(2));
    sharedTomoDb(join(dir, "data", "tomo.db"));
    expect(readSubsessionTitles(join(dir, "data", "tomo.db")).size).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).tasks).toHaveLength(2);
    new SubsessionStore(path).list();
    expect([...readSubsessionTitles(join(dir, "data", "tomo.db"))]).toEqual([["s1", "Task 1"], ["s2", "Task 2"]]);
  });
});
