import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS, copyIfExists, isBackupName, isCopyableEntry, resolveRetentionDays,
  workspaceBackupFilter,
} from "../src/cli/backup.js";

/**
 * The pure pieces of `tomo backup` (src/cli/backup.ts), no command run and
 * nothing mocked. The commands themselves are driven end to end in
 * backup-commands.test.ts and backup-restore.test.ts.
 */

describe("resolveRetentionDays", () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it("uses the default silently when the variable is unset", () => {
    expect(resolveRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["1", "14", String(MAX_RETENTION_DAYS)])("accepts %s days, the boundaries included", (raw) => {
    expect(resolveRetentionDays(raw)).toBe(Number(raw));
    expect(warn).not.toHaveBeenCalled();
  });

  // Each rejection falls back to the default AND says so once, naming the
  // variable, so the override is not silently ignored.
  it.each([
    // `export TOMO_BACKUP_RETENTION_DAYS=` is how a shell profile most often
    // "unsets" a variable, and it is worth distinguishing from never setting
    // it: someone meant to configure this and did not.
    ["set but empty", ""],
    // Number("7d") is NaN; the cutoff becomes NaN and every `date < NaN`
    // comparison is false, so nothing is ever pruned and nothing says so.
    ["a typo with a unit", "7d"],
    ["words", "a week"],
    // 0 puts the cutoff at now; the just-created backup's own timestamp is
    // minute-granular and therefore strictly older, so it is pruned too.
    ["zero, which would delete the backup it just made", "0"],
    ["negative", "-1"],
    // An upper bound matters for the same reason the lower one does: a units
    // mix-up (ms, seconds) or a stray zero disables pruning just as silently
    // and just as completely as NaN did.
    ["past any plausible policy", String(MAX_RETENTION_DAYS + 1)],
    ["a week in milliseconds", "604800000"],
  ])("falls back on %s (%j) and warns once", (_label, raw) => {
    expect(resolveRetentionDays(raw)).toBe(DEFAULT_RETENTION_DAYS);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("TOMO_BACKUP_RETENTION_DAYS");
  });
});

describe("isBackupName", () => {
  it("accepts the timestamp() shape", () => {
    expect(isBackupName("2026-08-30_0142")).toBe(true);
  });

  it.each([
    // traversal
    "..", "../../..", "../2026-08-30_0142",
    // an absolute path
    "/Users/someone/Documents",
    // near-miss shapes
    "2026-08-30", "2026-08-30_014", "2026-08-30_0142x",
  ])("rejects %j", (name) => {
    expect(isBackupName(name)).toBe(false);
  });
});

// A long-running helper listening on a Unix socket inside the workspace made
// `tomo backup create` abort: Node's cpSync throws ERR_INTERNAL_ASSERTION on a
// socket. The backup must skip such entries and copy everything else.
describe("backup skips sockets and other special files", () => {
  let root: string;
  let server: Server | undefined;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bk-sock-")); });
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  async function listen(path: string): Promise<void> {
    server = createServer();
    await new Promise<void>((r) => server!.listen(path, () => r()));
  }

  it("reports a live Unix socket as not copyable and a regular file as copyable", async () => {
    const sock = join(root, "s.sock");
    await listen(sock);
    writeFileSync(join(root, "a.md"), "x");
    expect(isCopyableEntry(sock)).toBe(false);
    expect(isCopyableEntry(join(root, "a.md"))).toBe(true);
    expect(isCopyableEntry(root)).toBe(true);
  });

  it("copies a workspace that contains a socket, without the socket", async () => {
    const ws = join(root, "w");
    mkdirSync(join(ws, "hub"), { recursive: true });
    writeFileSync(join(ws, "hub", "state.db"), "x");
    await listen(join(ws, "hub", "t.sock"));
    const dest = join(root, "out");
    // Through the real backup copy helper, with and without a caller filter.
    expect(() => copyIfExists(ws, dest, { filter: workspaceBackupFilter(ws) })).not.toThrow();
    const dest2 = join(root, "out2");
    expect(() => copyIfExists(ws, dest2)).not.toThrow();
    expect(existsSync(join(dest2, "hub", "t.sock"))).toBe(false);
    expect(existsSync(join(dest, "hub", "state.db"))).toBe(true);
    expect(existsSync(join(dest, "hub", "t.sock"))).toBe(false);
  });
});

describe("workspaceBackupFilter", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "backup-filter-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function file(path: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
  }

  it("copies the workspace without its top-level tmp/ or .claude/, keeping nested tmp folders", () => {
    const ws = join(root, "workspace");
    file(join(ws, "memory", "MEMORY.md"));
    file(join(ws, "tmp", "derived", "huge.bin"));
    file(join(ws, "tmp", "worktree", "src", "a.ts"));
    file(join(ws, ".claude", "settings.json"));
    file(join(ws, "projects", "tmp", "keep.md"));
    file(join(ws, "tmpnotes.md"));

    const dest = join(root, "out");
    cpSync(ws, dest, { recursive: true, filter: workspaceBackupFilter(ws) });

    expect(existsSync(join(dest, "memory", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(dest, "projects", "tmp", "keep.md"))).toBe(true);
    expect(existsSync(join(dest, "tmpnotes.md"))).toBe(true);
    expect(existsSync(join(dest, "tmp"))).toBe(false);
    expect(existsSync(join(dest, ".claude"))).toBe(false);
  });

  it("skips a top-level scratch directory whatever its case", () => {
    const ws = join(root, "workspace");
    file(join(ws, "TMP", "huge.bin"));
    file(join(ws, "memory", "a.md"));
    const keep = workspaceBackupFilter(ws);
    expect(keep(join(ws, "TMP"))).toBe(false);
    expect(keep(join(ws, "TMP", "huge.bin"))).toBe(false);
    expect(keep(join(ws, "Tmp"))).toBe(false);
    expect(keep(ws)).toBe(true);
    expect(keep(join(ws, "memory", "a.md"))).toBe(true);
  });
});
