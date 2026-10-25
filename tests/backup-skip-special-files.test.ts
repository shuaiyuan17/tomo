import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyIfExists, isCopyableEntry, workspaceBackupFilter } from "../src/cli/backup.js";

// A long-running helper listening on a Unix socket inside the workspace made
// `tomo backup create` abort: Node's cpSync throws ERR_INTERNAL_ASSERTION on a
// socket. The backup must skip such entries and copy everything else.
describe("backup skips sockets and other special files", () => {
  let root: string;
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function listen(path: string): Promise<void> {
    server = createServer();
    await new Promise<void>((r) => server!.listen(path, () => r()));
  }

  it("reports a live Unix socket as not copyable and a regular file as copyable", async () => {
    root = mkdtempSync(join(tmpdir(), "bk-sock-"));
    const sock = join(root, "s.sock");
    await listen(sock);
    writeFileSync(join(root, "a.md"), "x");
    expect(isCopyableEntry(sock)).toBe(false);
    expect(isCopyableEntry(join(root, "a.md"))).toBe(true);
    expect(isCopyableEntry(root)).toBe(true);
  });

  it("copies a workspace that contains a socket, without the socket", async () => {
    root = mkdtempSync(join(tmpdir(), "bk-sock-"));
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
