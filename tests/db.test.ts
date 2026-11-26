import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DB_BUSY_TIMEOUT_MS, DbSchemaTooNewError, clearQuarantinedDbs, dbQuarantineMarkerPath, isCorruptionError, openTomoDb,
  quarantinedDbs, type Migration,
} from "../src/db/index.js";
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
    expect(db.all("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map((r) => r.name)).toEqual(["meta", "pending_notes"]);
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

  it("is not re-entrant and refuses an async callback", () => {
    const db = openTomoDb(join(freshDir(), "tomo.db"));
    expect(() => db.transaction(() => db.transaction(() => 1))).toThrow("not re-entrant");
    expect(() => db.transaction(() => {
      db.run("INSERT INTO meta (key, value) VALUES ('async', '1')");
      return Promise.resolve();
    })).toThrow("synchronous");
    expect(db.get("SELECT * FROM meta WHERE key = 'async'")).toBeUndefined();
    db.close();
  });
});

describe("a damaged database", () => {
  it("that is not a database at all is moved aside with its sidecars, the marker names it, and a fresh one starts", () => {
    const dir = freshDir();
    const path = join(dir, "tomo.db");
    writeFileSync(path, "garbage ".repeat(512));
    writeFileSync(`${path}-wal`, "old wal");
    writeFileSync(`${path}-shm`, "old shm");
    const told: string[] = [];
    const db = openTomoDb(path, { onQuarantined: (aside) => told.push(aside) });
    expect(told).toHaveLength(1);
    const aside = told[0];
    expect(aside).toMatch(/tomo\.db\.corrupt-\d{8}-\d{6}$/);
    expect(readFileSync(aside, "utf8")).toBe("garbage ".repeat(512));
    expect(readFileSync(`${aside}-wal`, "utf8")).toBe("old wal");
    // The -shm is an index SQLite rebuilds from the log (even a reader writes
    // to it); it is moved along so nothing stale sits beside the fresh file.
    expect(existsSync(`${aside}-shm`)).toBe(true);
    expect(existsSync(`${path}-shm`) && readFileSync(`${path}-shm`, "utf8") === "old shm").toBe(false);
    expect(quarantinedDbs(path)).toEqual([aside]);
    // The fresh database works.
    db.run("INSERT INTO meta (key, value) VALUES ('fresh', '1')");
    expect(db.check()).toEqual(["ok"]);
    db.close();
    clearQuarantinedDbs(path, [aside]);
    expect(existsSync(dbQuarantineMarkerPath(path))).toBe(false);
    expect(quarantinedDbs(path)).toBeUndefined();
  });

  it("whose pages are damaged fails quick_check and is moved aside", () => {
    const dir = freshDir();
    const path = join(dir, "tomo.db");
    populated(path);
    const fd = openSync(path, "r+");
    // Page 3 onwards (page size 4096): scribble over b-tree pages, keep the header.
    writeSync(fd, Buffer.alloc(4096 * 3, 0xa5), 0, 4096 * 3, 4096 * 2);
    closeSync(fd);
    const told: string[] = [];
    const db = openTomoDb(path, { onQuarantined: (aside) => told.push(aside) });
    expect(told).toHaveLength(1);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM pending_notes")?.n).toBe(0);
    db.close();
  });

  it("is never moved by a read-only open", () => {
    const path = join(freshDir(), "tomo.db");
    writeFileSync(path, "garbage ".repeat(512));
    expect(() => openTomoDb(path, { readOnly: true })).toThrow();
    expect(readFileSync(path, "utf8")).toBe("garbage ".repeat(512));
    expect(quarantinedDbs(path)).toBeUndefined();
  });

  it.runIf(process.getuid?.() !== 0)("that cannot be moved throws, stays where it is, and leaves no marker", () => {
    const dir = freshDir();
    const path = join(dir, "tomo.db");
    writeFileSync(path, "garbage ".repeat(512));
    chmodSync(dir, 0o555);
    try {
      expect(() => openTomoDb(path)).toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readFileSync(path, "utf8")).toBe("garbage ".repeat(512));
    expect(readdirSync(dir)).toEqual(["tomo.db"]);
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
