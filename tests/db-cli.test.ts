import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// `tomo db check / dump / export` against a database in a temp home, and the
// rollback path: export writes the file an older Tomo reads, and this version
// imports it again.
// ---------------------------------------------------------------------------

const paths = vi.hoisted(() => {
  const { mkdtempSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join: j } = process.getBuiltinModule("node:path");
  const home = mkdtempSync(j(tmpdir(), "tomo-db-cli-"));
  return { home, tomoHome: j(home, ".tomo"), pidFile: j(home, ".tomo", "tomo.pid") };
});

vi.mock("../src/config.js", () => ({
  config: {
    tomoHome: paths.tomoHome,
    sessionsDir: join(paths.tomoHome, "data", "sessions"),
    dbPath: join(paths.tomoHome, "data", "tomo.db"),
  },
}));
vi.mock("../src/runtime-paths.js", async (orig) => {
  const actual = await orig<typeof import("../src/runtime-paths.js")>();
  return { ...actual, defaultRuntimePaths: { ...actual.defaultRuntimePaths, tomoHome: paths.tomoHome, pidFile: paths.pidFile } };
});

const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { dbCommand } = await import("../src/cli/db.js");
const { makeSessionStore } = await import("./helpers/session-store-fixtures.js");
const { runBackupCommand } = await import("./helpers/backup-cli.js");
const { parsePendingNotesFile } = await import("../src/sessions/pending-notes-store.js");

const sessionsDir = join(paths.tomoHome, "data", "sessions");
const dbPath = join(paths.tomoHome, "data", "tomo.db");
const legacyFile = join(sessionsDir, "_pending_notes.json");
const run = (argv: string[]) => runBackupCommand(dbCommand, (s) => s, argv);
const store = () => makeSessionStore(sessionsDir, { dbPath });

afterAll(() => rmSync(paths.home, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(paths.tomoHome, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });
  vi.unstubAllEnvs();
});

describe("tomo db check", () => {
  it("prints the schema version and row counts, and passes a sound database", async () => {
    store().setPendingNotes("dm:alice", ["a", "b"]);
    const r = await run(["check"]);
    expect(r.exitCodes).toEqual([]);
    expect(r.logs.join("\n")).toMatch(/Schema version: 1/);
    expect(r.logs.join("\n")).toContain("pending_notes: 2 row(s)");
    expect(r.logs.join("\n")).toContain("integrity_check: ok");
  });

  it("fails on a file that is not a database, and leaves it where it is", async () => {
    mkdirSync(join(paths.tomoHome, "data"), { recursive: true });
    writeFileSync(dbPath, "garbage ".repeat(600));
    const r = await run(["check"]);
    expect(r.exitCodes).toEqual([1]);
    expect(readFileSync(dbPath, "utf8")).toBe("garbage ".repeat(600));
  });

  it("says there is no database yet", async () => {
    const r = await run(["check"]);
    expect(r.exitCodes).toEqual([1]);
    expect(r.errors.join("\n")).toContain("No database");
  });
});

describe("tomo db dump", () => {
  it("prints a table's rows, and refuses a table it does not know", async () => {
    store().setPendingNotes("dm:alice", ["hello"]);
    const json = await run(["dump", "pending_notes", "--json"]);
    expect(JSON.parse(json.logs.join("\n"))).toEqual([{ session_key: "dm:alice", position: 0, note: "hello" }]);
    const bad = await run(["dump", "sqlite_schema; drop table meta"]);
    expect(bad.exitCodes).toEqual([1]);
  });

  it("from an agent's shell, shows a group session only its own notes", async () => {
    const s = store();
    s.setPendingNotes("dm:alice", ["owner's private note"]);
    s.setPendingNotes("telegram:-9", ["the group's note"]);
    vi.stubEnv("TOMO_SESSION_KEY", "telegram:-9");
    const r = await run(["dump", "pending_notes", "--json"]);
    expect(JSON.parse(r.logs.join("\n")).map((row: { note: string }) => row.note)).toEqual(["the group's note"]);
  });
});

describe("tomo db export pending-notes (the rollback path)", () => {
  it("moves the notes into the old file format, which this version imports back unchanged", async () => {
    const s = store();
    s.setPendingNotes("dm:alice", ["a1", "a2"]);
    s.setPendingNotes("telegram:-9", ["g1"]);
    const r = await run(["export", "pending-notes"]);
    expect(r.exitCodes).toEqual([]);
    expect(parsePendingNotesFile(readFileSync(legacyFile))).toEqual({ "dm:alice": ["a1", "a2"], "telegram:-9": ["g1"] });
    expect(JSON.parse(readFileSync(legacyFile, "utf8")).version).toBe(1);
    // Moved, not copied: the database no longer holds them.
    const after = await run(["dump", "pending_notes", "--json"]);
    expect(JSON.parse(after.logs.join("\n"))).toEqual([]);

    // An older Tomo ran on it (delivered alice's), then this version starts again.
    writeFileSync(legacyFile, JSON.stringify({ version: 1, notes: { "telegram:-9": ["g1"] } }));
    const again = store();
    expect(again.getPendingNotes("dm:alice")).toEqual([]);
    expect(again.getPendingNotes("telegram:-9")).toEqual(["g1"]);
  });

  it("an older Tomo that delivers every note and deletes the file leaves nothing to deliver again after an upgrade", async () => {
    store().setPendingNotes("dm:alice", ["deliver once"]);
    expect((await run(["export", "pending-notes"])).exitCodes).toEqual([]);
    rmSync(legacyFile); // the older Tomo drained its last note
    expect(store().getPendingNotes("dm:alice")).toEqual([]);
  });

  it("will not overwrite an existing file, run while Tomo is up, or run from an agent's shell", async () => {
    store().setPendingNotes("dm:alice", ["a1"]);
    writeFileSync(legacyFile, "keep me");
    expect((await run(["export", "pending-notes"])).exitCodes).toEqual([1]);
    expect(readFileSync(legacyFile, "utf8")).toBe("keep me");
    rmSync(legacyFile);

    writeFileSync(paths.pidFile, `${process.pid}\n`);
    try {
      const up = await run(["export", "pending-notes"]);
      expect(up.exitCodes).toEqual([1]);
      expect(up.errors.join("\n")).toContain("Tomo is running");
    } finally {
      rmSync(paths.pidFile, { force: true });
    }
    expect(existsSync(legacyFile)).toBe(false);

    vi.stubEnv("TOMO_SESSION_KEY", "dm:alice");
    expect((await run(["export", "pending-notes"])).exitCodes).toEqual([1]);
    expect(existsSync(legacyFile)).toBe(false);
  });

  it("copies (never empties) a database named with --from, or into a file named with --out", async () => {
    store().setPendingNotes("dm:alice", ["rescued"]);
    const out = join(paths.home, "rescued.json");
    const r = await run(["export", "pending-notes", "--from", dbPath, "--out", out]);
    expect(r.exitCodes).toEqual([]);
    expect(parsePendingNotesFile(readFileSync(out))).toEqual({ "dm:alice": ["rescued"] });
    rmSync(out);
    expect((await run(["export", "pending-notes", "--out", out])).exitCodes).toEqual([]);
    expect(store().getPendingNotes("dm:alice")).toEqual(["rescued"]);
  });
});
