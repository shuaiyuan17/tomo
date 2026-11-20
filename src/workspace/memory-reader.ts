import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { landsInPrivate } from "../agent/private-memory-reach.js";
import { isPrivateIndexLine, PRIVATE_MEMORY_SUBDIR } from "./private-memory.js";
import { isEnoent } from "../fs-utils.js";

export class MemoryReadError extends Error {
  constructor(readonly code: "invalid_path" | "not_found" | "unavailable" | "limit") { super(code); }
}
export interface MemoryEntry { path: string; kind: "directory" | "file" }
export interface MemoryFile { path: string; content: string; modifiedAt: number; /** Lines linking into memory/private/, withheld. */ hiddenLines: number }
const MAX_FILE = 256 * 1024;

/**
 * Read-only, bounded access to the workspace memory tree for the web Study.
 * Never writes memory or follows links.
 *
 * `memory/private/` is NEVER served, listed or searched — not even to the
 * owner's browser. The containment test is the one the agent's PreToolUse
 * guard uses (`landsInPrivate`: lexical, real-path and case-folded), not a
 * second copy of the rule. A private path reads as "not found", so the
 * browser cannot even learn whether a private file exists. Index lines that
 * link into `private/` are withheld the same way group prompts withhold them.
 */
export class MemoryReader {
  root: string;
  private canonical = false;
  constructor(private readonly workspaceDir: string) { this.root = resolve(workspaceDir, "memory"); }
  private async canonicalize(): Promise<void> {
    if (!this.canonical) { this.root = join(await realpath(this.workspaceDir), "memory"); this.canonical = true; }
  }
  /** The shared private-memory fence, rooted at this reader's memory dir. */
  isPrivate(relativePath: string): boolean {
    const memoryDir = this.root;
    return landsInPrivate(join(memoryDir, relativePath), { cwd: memoryDir, memoryDir, privateDir: join(memoryDir, PRIVATE_MEMORY_SUBDIR) });
  }
  private parts(path: string): string[] {
    if (isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.length > 1024) throw new MemoryReadError("invalid_path");
    const parts = path.split("/");
    if (parts.some((p) => !p || p === "." || p === "..") || parts.length > 9) throw new MemoryReadError("invalid_path");
    return parts;
  }
  private async ancestors(parts: string[]) {
    const paths = [this.root, ...parts.slice(0, -1).map((_, i) => join(this.root, ...parts.slice(0, i + 1)))];
    return Promise.all(paths.map(async (path) => {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new MemoryReadError("invalid_path");
      return { path, dev: stat.dev, ino: stat.ino };
    }));
  }
  async file(path: string): Promise<MemoryFile> {
    const parts = this.parts(path);
    if (!/\.md$/i.test(path)) throw new MemoryReadError("invalid_path");
    try {
      await this.canonicalize();
      if (this.isPrivate(path)) throw new MemoryReadError("not_found");
      const before = await this.ancestors(parts);
      const candidate = join(this.root, ...parts);
      const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        // nlink: a hard link would let a public name read a private file's bytes.
        if (!stat.isFile() || stat.nlink !== 1) throw new MemoryReadError("invalid_path");
        if (stat.size > MAX_FILE) throw new MemoryReadError("limit");
        const after = await this.ancestors(parts);
        const current = await lstat(candidate);
        if (before.some((item, i) => item.dev !== after[i].dev || item.ino !== after[i].ino)
          || current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink()) throw new MemoryReadError("invalid_path");
        // Checked again after open: the real path of what was opened, too.
        if (this.isPrivate(path)) throw new MemoryReadError("not_found");
        // A bounded read even if an agent grows the file after stat().
        const bytes = Buffer.alloc(MAX_FILE + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_FILE) throw new MemoryReadError("limit");
        const lines = bytes.subarray(0, bytesRead).toString("utf8").split("\n");
        const shown = lines.filter((line) => !isPrivateIndexLine(line));
        return { path, content: shown.join("\n"), modifiedAt: stat.mtimeMs, hiddenLines: lines.length - shown.length };
      } finally { await file.close(); }
    } catch (error) {
      if (error instanceof MemoryReadError) throw error;
      throw new MemoryReadError(isEnoent(error) ? "not_found" : "unavailable");
    }
  }
  async tree(): Promise<{ entries: MemoryEntry[]; truncated: boolean; missing: boolean }> {
    const entries: MemoryEntry[] = []; let truncated = false; const deadline = Date.now() + 500;
    try {
      await this.canonicalize();
      await this.ancestors(["index.md"]);
      const walk = async (relative: string, depth: number): Promise<void> => {
        if (depth > 8 || entries.length >= 1000 || Date.now() > deadline) { truncated = true; return; }
        await this.ancestors([...relative.split("/").filter(Boolean), "index.md"]);
        const directory = await readdir(join(this.root, relative), { withFileTypes: true });
        directory.sort((a, b) => a.name === "MEMORY.md" ? -1 : b.name === "MEMORY.md" ? 1 : a.name.localeCompare(b.name));
        for (const item of directory) {
          if (entries.length >= 1000 || Date.now() > deadline) { truncated = true; return; }
          const path = relative ? `${relative}/${item.name}` : item.name;
          if (item.isSymbolicLink() || this.isPrivate(path)) continue;
          if (item.isDirectory()) { entries.push({ path, kind: "directory" }); await walk(path, depth + 1); }
          else if (item.isFile() && /\.md$/i.test(item.name)) entries.push({ path, kind: "file" });
        }
      };
      await walk("", 0);
      return { entries, truncated, missing: false };
    } catch (error) {
      if (isEnoent(error)) return { entries: [], truncated: false, missing: true };
      if (error instanceof MemoryReadError) throw error;
      throw new MemoryReadError("unavailable");
    }
  }
  /** Literal, case-insensitive search over the public tree, bounded in bytes, time and hits. */
  async search(query: string) {
    if (!query.trim() || query.length > 200) throw new MemoryReadError("invalid_path");
    const tree = await this.tree(); const results: Array<{ path: string; line: number; text: string }> = [];
    const needle = query.toLocaleLowerCase(); const deadline = Date.now() + 500; let bytes = 0; let truncated = tree.truncated; let unreadable = 0;
    for (const entry of tree.entries) {
      if (entry.kind !== "file") continue;
      if (bytes > 4 * 1024 * 1024 || Date.now() > deadline || results.length >= 100) { truncated = true; break; }
      try {
        const file = await this.file(entry.path); bytes += Buffer.byteLength(file.content);
        for (const [i, line] of file.content.split("\n").entries()) {
          const at = line.toLocaleLowerCase().indexOf(needle);
          if (at >= 0) results.push({ path: entry.path, line: i + 1, text: line.slice(Math.max(0, at - 80), at + 240) });
          if (results.length >= 100) { truncated = true; break; }
        }
      } catch { unreadable++; }
    }
    return { results, truncated, unreadable, missing: tree.missing };
  }
}
