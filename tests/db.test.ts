import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";

// copyFileSync / unlinkSync can be made to fail for one path (a full disk, an immutable file).
const fsHooks = vi.hoisted(() => ({
  failCopy: null as null | ((from: string) => boolean),
  failUnlink: null as null | ((path: string) => boolean),
  failFsync: false,
}));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  const copyFileSync = (from: string, to: string, mode?: number) => {
    if (fsHooks.failCopy?.(String(from))) throw Object.assign(new Error(`ENOSPC: copy ${from}`), { code: "ENOSPC" });
    return actual.copyFileSync(from, to, mode);
  };
  const unlinkSync = (path: string) => {
    if (fsHooks.failUnlink?.(String(path))) throw Object.assign(new Error(`EPERM: unlink ${path}`), { code: "EPERM" });
    return actual.unlinkSync(path);
  };
  const fsyncSync = (fd: number) => {
    if (fsHooks.failFsync) throw Object.assign(new Error("EIO: fsync"), { code: "EIO" });
    return actual.fsyncSync(fd);
  };
  return { ...actual, default: { ...actual, copyFileSync, unlinkSync, fsyncSync }, copyFileSync, unlinkSync, fsyncSync };
});

import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_BUSY_TIMEOUT_MS, DbDamagedError, DbSchemaTooNewError, isCorruptionError, openTomoDb, repairDb, type Migration } from "../src/db/index.js";
import { TOMO_DB_MIGRATIONS } from "../src/db/schema.js";

vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const ROOT = mkdtempSync(join(tmpdir(), "tomo-db-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const freshDir = (): string => {
  const dir = join(ROOT, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const REPO = fileURLToPath(new URL("..", import.meta.url));
const DB_MODULE = join(REPO, "src", "db", "index.ts");

/** A healthy database with enough rows to span several pages. */
function populated(path: string): void {
  const db = openTomoDb(path);
  db.transaction(() => {
    for (let i = 0; i < 400; i++) db.run("INSERT INTO pending_notes (session_key, position, note) VALUES (?, ?, ?)", `k${i % 7}`, i, "x".repeat(200));
  });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

describe("opening the database", () => {
  it("sets WAL, synchronous=FULL, fullfsync and the busy timeout on every connection", () => {
    const db = openTomoDb(join(freshDir(), "tomo.db"));
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(2);
    expect(db.get<{ fullfsync: number }>("PRAGMA fullfsync")?.fullfsync).toBe(1);
    expect(db.get<{ checkpoint_fullfsync: number }>("PRAGMA checkpoint_fullfsync")?.checkpoint_fullfsync).toBe(1);
    expect(db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout).toBe(DB_BUSY_TIMEOUT_MS);
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    db.close();
  });

  it("creates the directory and runs every migration on a new file", () => {
    const path = join(freshDir(), "nested", "deeper", "tomo.db");
    const db = openTomoDb(path);
    expect(db.schemaVersion()).toBe(TOMO_DB_MIGRATIONS.at(-1)!.version);
    expect(db.all("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map((r) => r.name)).toEqual(["cron_jobs", "meta", "pending_notes", "subsessions", "subsessions_state"]);
    db.close();
  });
});

describe("schema migrations", () => {
  const v1: Migration = { version: 1, up: (db) => db.exec("CREATE TABLE a (x INTEGER) STRICT") };
  const v2: Migration = { version: 2, up: (db) => db.exec("CREATE TABLE b (y INTEGER) STRICT") };

  it("runs only the steps a database has not run yet", () => {
    const path = join(freshDir(), "tomo.db");
    const first = openTomoDb(path, { migrations: [v1] });
    first.run("INSERT INTO a VALUES (1)");
    first.close();
    const up = vi.fn(v1.up);
    const second = openTomoDb(path, { migrations: [{ ...v1, up }, v2] });
    expect(up).not.toHaveBeenCalled();
    expect(second.schemaVersion()).toBe(2);
    expect(second.get("SELECT x FROM a")).toEqual({ x: 1 });
    second.close();
  });

  it("a step that throws is rolled back whole and leaves the version where it was", () => {
    const path = join(freshDir(), "tomo.db");
    openTomoDb(path, { migrations: [v1] }).close();
    const broken: Migration = { version: 2, up: (db) => { db.exec("CREATE TABLE b (y INTEGER)"); throw new Error("step failed half-way"); } };
    expect(() => openTomoDb(path, { migrations: [v1, broken] })).toThrow("step failed half-way");
    const db = openTomoDb(path, { migrations: [v1] });
    expect(db.schemaVersion()).toBe(1);
    expect(db.get("SELECT name FROM sqlite_schema WHERE name = 'b'")).toBeUndefined();
    db.close();
  });

  it("refuses a database newer than this code, and leaves it untouched", () => {
    const path = join(freshDir(), "tomo.db");
    openTomoDb(path, { migrations: [v1, v2] }).close();
    const before = readFileSync(path);
    expect(() => openTomoDb(path, { migrations: [v1] })).toThrow(DbSchemaTooNewError);
    expect(() => openTomoDb(path, { migrations: [v1], readOnly: true })).toThrow(DbSchemaTooNewError);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(join(path, "..")).filter((f) => f.includes("corrupt"))).toEqual([]);
    // `tomo db check` can still look at it.
    const ro = openTomoDb(path, { migrations: [v1], readOnly: true, allowNewerSchema: true });
    expect(ro.schemaVersion()).toBe(2);
    ro.close();
  });
});

describe("snapshots", () => {
  it("reads in a snapshot never see another connection's commit half-way", () => {
    const path = join(freshDir(), "tomo.db");
    const a = openTomoDb(path);
    const b = openTomoDb(path);
    try {
      a.exec("CREATE TABLE t (x INTEGER)");
      const seen = a.snapshot(() => {
        const first = a.get<{ n: number }>("SELECT count(*) AS n FROM t")!.n;
        b.run("INSERT INTO t (x) VALUES (1)");
        const second = a.get<{ n: number }>("SELECT count(*) AS n FROM t")!.n;
        return [first, second];
      });
      expect(seen).toEqual([0, 0]);
      expect(a.get<{ n: number }>("SELECT count(*) AS n FROM t")!.n).toBe(1);
      // Inside a write transaction it just runs.
      expect(a.transaction(() => a.snapshot(() => 7))).toBe(7);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("transactions", () => {
  it("anything thrown inside rolls every write back", () => {
    const db = openTomoDb(join(freshDir(), "tomo.db"));
    db.run("INSERT INTO meta (key, value) VALUES ('kept', '1')");
    expect(() => db.transaction(() => {
      db.run("INSERT INTO meta (key, value) VALUES ('a', '1')");
      db.run("UPDATE meta SET value = '2' WHERE key = 'kept'");
      throw new Error("crash mid-transaction");
    })).toThrow("crash mid-transaction");
    expect(db.all("SELECT key, value FROM meta")).toEqual([{ key: "kept", value: "1" }]);
    // And the connection is usable afterwards.
    db.transaction(() => db.run("INSERT INTO meta (key, value) VALUES ('b', '1')"));
    expect(db.all("SELECT key FROM meta ORDER BY key").map((r) => r.key)).toEqual(["b", "kept"]);
    db.close();
  });

  it("a process killed mid-transaction leaves nothing of it behind", () => {
    const path = join(freshDir(), "tomo.db");
    openTomoDb(path).close();
    const script = `
      import { openTomoDb } from ${JSON.stringify(DB_MODULE)};
      const db = openTomoDb(${JSON.stringify(path)});
      db.transaction(() => {
        db.run("INSERT INTO meta (key, value) VALUES ('half', 'written')");
        process.kill(process.pid, "SIGKILL");
      });
    `;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: REPO, encoding: "utf8" });
    expect(r.signal).toBe("SIGKILL");
    const db = openTomoDb(path);
    expect(db.get("SELECT * FROM meta WHERE key = 'half'")).toBeUndefined();
    db.close();
  });

  it("nests as savepoints: an inner throw undoes only its own writes, and everything commits with the outermost", () => {
    const path = join(freshDir(), "tomo.db");
    const db = openTomoDb(path);
    const other = openTomoDb(path);
    const order: string[] = [];
    try {
      db.transaction(() => {
        db.run("INSERT INTO meta (key, value) VALUES ('outer', '1')");
        expect(() => db.transaction(() => {
          db.run("INSERT INTO meta (key, value) VALUES ('inner-undone', '1')");
          db.afterCommit(() => order.push("undone hook"));
          throw new Error("inner");
        })).toThrow("inner");
        db.transaction(() => {
          db.run("INSERT INTO meta (key, value) VALUES ('inner-kept', '1')");
          db.afterCommit(() => order.push("kept hook"));
        });
        // Nothing is visible to another connection before the outer COMMIT, and no hook has run.
        expect(other.get("SELECT 1 AS x FROM meta WHERE key = 'inner-kept'")).toBeUndefined();
        expect(order).toEqual([]);
      });
      expect(order).toEqual(["kept hook"]);
      expect(other.all<{ key: string }>("SELECT key FROM meta ORDER BY key").map((r) => r.key)).toEqual(["inner-kept", "outer"]);
      // An outer rollback takes the inner writes and their hooks with it.
      expect(() => db.transaction(() => {
        db.transaction(() => {
          db.run("INSERT INTO meta (key, value) VALUES ('rolled', '1')");
          db.afterCommit(() => order.push("rolled hook"));
        });
        throw new Error("outer");
      })).toThrow("outer");
      expect(db.get("SELECT 1 AS x FROM meta WHERE key = 'rolled'")).toBeUndefined();
      expect(order).toEqual(["kept hook"]);
      // Outside a transaction a hook runs at once.
      db.afterCommit(() => order.push("now"));
      expect(order).toEqual(["kept hook", "now"]);
    } finally {
      db.close();
      other.close();
    }
  });

  it("refuses an async callback, and a write transaction inside a snapshot", () => {
    const db = openTomoDb(join(freshDir(), "tomo.db"));
    expect(() => db.snapshot(() => db.transaction(() => 1))).toThrow("inside a snapshot");
    expect(() => db.transaction(() => {
      db.run("INSERT INTO meta (key, value) VALUES ('async', '1')");
      return Promise.resolve();
    })).toThrow("synchronous");
    expect(db.get("SELECT * FROM meta WHERE key = 'async'")).toBeUndefined();
    db.close();
  });
});

describe("a damaged database", () => {
  const corruptAsides = (dir: string) => readdirSync(dir).filter((f) => /^tomo\.db\.corrupt-[\d-]+$/.test(f));

  it("is refused by every open, writable or not, and left exactly as it is, log included", () => {
    const dir = freshDir();
    const path = join(dir, "tomo.db");
    writeFileSync(path, "garbage ".repeat(512));
    writeFileSync(`${path}-wal`, "committed frames only here");
    expect(() => openTomoDb(path)).toThrow(DbDamagedError);
    expect(() => openTomoDb(path)).toThrow(/tomo db repair/);
    expect(() => openTomoDb(path, { readOnly: true })).toThrow();
    expect(readFileSync(path, "utf8")).toBe("garbage ".repeat(512));
    expect(readFileSync(`${path}-wal`, "utf8")).toBe("committed frames only here");
    expect(corruptAsides(dir)).toEqual([]);
  });

  it("whose pages are damaged fails quick_check and is refused", () => {
    const dir = freshDir();
    const path = join(dir, "tomo.db");
    populated(path);
    const fd = openSync(path, "r+");
    // Page 3 onwards (page size 4096): scribble over b-tree pages, keep the header.
    writeSync(fd, Buffer.alloc(4096 * 3, 0xa5), 0, 4096 * 3, 4096 * 2);
    closeSync(fd);
    const before = readFileSync(path);
    expect(() => openTomoDb(path)).toThrow(DbDamagedError);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe("repairDb (tomo db repair, Tomo stopped)", () => {
  const corruptAsides = (dir: string) => readdirSync(dir).filter((f) => /^tomo\.db\.corrupt-[\d-]+$/.test(f));

  it("copies the damaged file and its log aside unchanged and starts a fresh database", () => {
    const dir = freshDir();
    const path = join(dir, "tomo.db");
    writeFileSync(path, "garbage ".repeat(512));
    writeFileSync(`${path}-wal`, "old wal");
    writeFileSync(`${path}-shm`, "old shm");
    const aside = repairDb(path)!;
    expect(aside).toMatch(/tomo\.db\.corrupt-\d{8}-\d{6}$/);
    expect(readFileSync(aside, "utf8")).toBe("garbage ".repeat(512));
    expect(readFileSync(`${aside}-wal`, "utf8")).toBe("old wal");
    // -shm is an index SQLite rebuilds: not copied, and the stale one is gone.
    expect(existsSync(`${aside}-shm`)).toBe(false);
    const db = openTomoDb(path);
    db.run("INSERT INTO meta (key, value) VALUES ('fresh', '1')");
    // The old log was not replayed into the fresh file.
    expect(db.check()).toEqual(["ok"]);
    expect(db.all("SELECT key FROM meta")).toEqual([{ key: "fresh" }]);
    db.close();
  });

  it("leaves a sound database alone", () => {
    const dir = freshDir();
    const path = join(dir, "tomo.db");
    const db = openTomoDb(path);
    db.run("INSERT INTO meta (key, value) VALUES ('keep', '1')");
    db.close();
    expect(repairDb(path)).toBeNull();
    expect(repairDb(join(dir, "missing.db"))).toBeNull();
    expect(corruptAsides(dir)).toEqual([]);
    const again = openTomoDb(path);
    expect(again.get("SELECT value FROM meta WHERE key = 'keep'")).toEqual({ value: "1" });
    again.close();
  });

  it("whose log cannot be copied changes nothing: no partial copy, originals whole", () => {
    const dir = freshDir();
    const path = join(dir, "tomo.db");
    writeFileSync(path, "garbage ".repeat(512));
    writeFileSync(`${path}-wal`, "committed frames only here");
    fsHooks.failCopy = (from) => from.endsWith("tomo.db-wal");
    try {
      expect(() => repairDb(path)).toThrow(/nothing was changed/);
    } finally {
      fsHooks.failCopy = null;
    }
    expect(readFileSync(path, "utf8")).toBe("garbage ".repeat(512));
    expect(readFileSync(`${path}-wal`, "utf8")).toBe("committed frames only here");
    expect(readdirSync(dir).filter((f) => f.includes("corrupt"))).toEqual([]);
  });

  it("whose copy cannot be fsynced changes nothing", () => {
    const dir = freshDir();
    const path = join(dir, "tomo.db");
    writeFileSync(path, "garbage ".repeat(512));
    fsHooks.failFsync = true;
    try {
      expect(() => repairDb(path)).toThrow(/nothing was changed/);
    } finally {
      fsHooks.failFsync = false;
    }
    expect(readFileSync(path, "utf8")).toBe("garbage ".repeat(512));
    expect(readdirSync(dir).filter((f) => f.includes("corrupt"))).toEqual([]);
  });

  it("stopped after the log was removed but before the main file keeps a complete copy, and runs again", () => {
    const dir = freshDir();
    const path = join(dir, "tomo.db");
    writeFileSync(path, "garbage ".repeat(512));
    writeFileSync(`${path}-wal`, "committed frames only here");
    fsHooks.failUnlink = (p) => p === path;
    try {
      expect(() => repairDb(path)).toThrow(/run repair again/);
    } finally {
      fsHooks.failUnlink = null;
    }
    const [first] = corruptAsides(dir);
    expect(readFileSync(join(dir, first), "utf8")).toBe("garbage ".repeat(512));
    expect(readFileSync(join(dir, `${first}-wal`), "utf8")).toBe("committed frames only here");
    // The log went first, so no -wal is left to be replayed into a fresh file.
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(repairDb(path)).not.toBeNull();
    expect(corruptAsides(dir)).toHaveLength(2);
    const db = openTomoDb(path);
    expect(db.check()).toEqual(["ok"]);
    db.close();
  });

  it("is recognised by its SQLite error code", () => {
    expect(isCorruptionError({ errcode: 26 })).toBe(true);
    expect(isCorruptionError({ errcode: 11 })).toBe(true);
    expect(isCorruptionError({ errcode: 5 })).toBe(false); // BUSY is not damage
    expect(isCorruptionError(new Error("x"))).toBe(false);
  });
});

describe("snapshots", () => {
  it("VACUUM INTO copies committed rows still in the WAL, as one standalone file", () => {
    const dir = freshDir();
    const db = openTomoDb(join(dir, "tomo.db"));
    db.run("INSERT INTO meta (key, value) VALUES ('in-wal', '1')");
    expect(existsSync(join(dir, "tomo.db-wal"))).toBe(true);
    db.vacuumInto(join(dir, "copy", "tomo.db"));
    expect(() => db.vacuumInto(join(dir, "copy", "tomo.db"))).toThrow("already exists");
    db.close();
    expect(readdirSync(join(dir, "copy"))).toEqual(["tomo.db"]);
    const copy = openTomoDb(join(dir, "copy", "tomo.db"), { readOnly: true });
    expect(copy.get("SELECT value FROM meta WHERE key = 'in-wal'")).toEqual({ value: "1" });
    copy.close();
  });
});

/** Run a module script under tsx in its own process. */
function child(script: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: REPO });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("several processes", () => {
  it("writing at once all land, none lost and none BUSY, while another holds the write lock", async () => {
    const path = join(freshDir(), "tomo.db");
    const parent = openTomoDb(path);
    parent.run("INSERT INTO meta (key, value) VALUES ('counter', '0')");
    const writer = (id: number) => `
      import { openTomoDb } from ${JSON.stringify(DB_MODULE)};
      const db = openTomoDb(${JSON.stringify(path)});
      for (let i = 0; i < 40; i++) {
        db.transaction(() => {
          // Read-modify-write: lost updates would show as a short counter.
          const n = Number(db.get("SELECT value FROM meta WHERE key = 'counter'").value);
          db.run("UPDATE meta SET value = ? WHERE key = 'counter'", String(n + 1));
          db.run("INSERT INTO pending_notes (session_key, position, note) VALUES (?, ?, ?)", "w${id}", i, "n" + i);
        });
      }
      db.close();
      console.log("done");
    `;
    // The parent holds the write lock while the children start.
    parent.exec("BEGIN IMMEDIATE");
    const runs = [0, 1, 2].map((id) => child(writer(id)));
    await new Promise((r) => setTimeout(r, 300));
    parent.exec("COMMIT");
    const results = await Promise.all(runs);
    for (const r of results) expect(r, r.err).toMatchObject({ code: 0, out: "done\n" });
    expect(parent.get("SELECT value FROM meta WHERE key = 'counter'")).toEqual({ value: "120" });
    expect(parent.get<{ n: number }>("SELECT count(*) AS n FROM pending_notes")?.n).toBe(120);
    expect(parent.check(true)).toEqual(["ok"]);
    parent.close();
  }, 30_000);

  it("loading node:sqlite prints no ExperimentalWarning", async () => {
    const quiet = await child(`
      import { openTomoDb } from ${JSON.stringify(DB_MODULE)};
      openTomoDb(${JSON.stringify(join(freshDir(), "tomo.db"))}).close();
      process.emitWarning("other warnings still print", "ExperimentalWarning");
    `);
    expect(quiet.code).toBe(0);
    expect(quiet.err).not.toMatch(/SQLite is an experimental feature/i);
    expect(quiet.err).toContain("other warnings still print");
  }, 30_000);
});
