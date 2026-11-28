// The memory files list: which files exist, their description and version.
// One set of data for memory_list now and the generated prompt list later.
// Pure fs + path: no runtime-path or config imports.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { foldPath, isInside } from "../agent/permission-paths.js";
import { landsInPrivate } from "../agent/private-memory-reach.js";
import { transcriptFileStem } from "../sessions/transcript-names.js";
import { PRIVATE_MEMORY_SUBDIR } from "./private-memory.js";

/**
 * Sizes, as lines or UTF-8 bytes, whichever is reached first (KB = 1024).
 * The two cores (MEMORY.md, private/MEMORY.md) have a soft budget and a hard
 * limit; every other memory file has a hard limit only.
 */
export const MEMORY_SOFT_LINES = 200;
export const MEMORY_SOFT_KB = 16;
export const MEMORY_HARD_LINES = 400;
export const MEMORY_HARD_KB = 32;
export const MEMORY_FILE_HARD_KB = 64;
export const DESCRIPTION_MAX_CHARS = 200;

/** A file's version: the first 12 hex characters of the sha256 of its bytes. */
export function memoryVersion(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** Path segments, case- and Unicode-folded the way the private-memory guard compares them. */
function folded(rel: string): string[] {
  return foldPath(rel).split("/");
}

/** At or under `memory/private/`, by the folded first segment. */
export function isPrivateMemoryPath(rel: string): boolean {
  return folded(rel)[0] === PRIVATE_MEMORY_SUBDIR;
}

/** Where group chats save: one folder per group, `groups/<dir>/`. */
export const GROUPS_MEMORY_SUBDIR = "groups";

/**
 * The folder a group's turns save to, relative to memory/:
 * `groups/<transcript file stem of the group's session key>`. The stem is
 * injective up to case folding (see transcriptFileStem), so two groups never
 * share a folder, on a case-insensitive filesystem either.
 */
export function groupMemoryDir(groupKey: string): string {
  return `${GROUPS_MEMORY_SUBDIR}/${transcriptFileStem(groupKey)}`;
}

/**
 * The group folder `rel` belongs to (its folded name under groups/), "" for a
 * file lying directly in groups/ (no group's), or undefined outside groups/
 * and for groups/ itself. `folder`: `rel` names a folder, not a file.
 */
function groupFolderOf(rel: string, folder: boolean): string | undefined {
  const f = folded(rel);
  if (f[0] !== GROUPS_MEMORY_SUBDIR || f.length < 2) return undefined;
  if (f.length === 2 && !folder) return "";
  return f[1];
}

/**
 * On a turn a group steers: is `rel` in some group's folder other than
 * `ownDir` (from {@link groupMemoryDir}; undefined when the turn has no single
 * group, so every group's folder is someone else's)? A file directly under
 * groups/ is no group's, so it counts as another's too. groups/ itself does
 * not: listing it shows the turn's own folder.
 */
export function isOtherGroupMemoryPath(rel: string, ownDir: string | undefined, folder = false): boolean {
  const g = groupFolderOf(rel, folder);
  if (g === undefined) return false;
  const own = ownDir === undefined ? undefined : groupFolderOf(ownDir, true);
  return own === undefined || g !== own;
}

/**
 * Strictly inside the folder `dir` (relative, no trailing slash), spelled
 * exactly: on a case-sensitive filesystem `groups/A/` and `groups/a/` are
 * two folders, and only the one named is the turn's.
 */
export function isInsideMemoryFolder(rel: string, dir: string): boolean {
  const f = rel.split("/");
  const d = dir.split("/");
  return f.length > d.length && d.every((part, i) => f[i] === part);
}

/** `MEMORY.md` or `private/MEMORY.md`. */
export function isCoreMemoryPath(rel: string): boolean {
  const f = folded(rel);
  return (f.length === 1 && f[0] === "memory.md") || (f.length === 2 && f[0] === PRIVATE_MEMORY_SUBDIR && f[1] === "memory.md");
}

/** The people registry (`people/`, `private/people/`): written by upsert_person, not the memory tools. */
export function isPeopleMemoryPath(rel: string): boolean {
  const f = folded(rel);
  return f[0] === "people" || (f[0] === PRIVATE_MEMORY_SUBDIR && f[1] === "people");
}

/** Inbound attachments (`incoming-images/`, `incoming-files/`, ...): not memory notes. */
export function isIncomingMemoryPath(rel: string): boolean {
  return folded(rel)[0].startsWith("incoming-");
}

/** Under a `journal/` folder at any depth. */
export function isJournalMemoryPath(rel: string): boolean {
  return folded(rel).slice(0, -1).includes("journal");
}

/** Under an `archive/` folder at any depth. */
export function isArchiveMemoryPath(rel: string): boolean {
  return folded(rel).slice(0, -1).includes("archive");
}

/**
 * Does this file belong in the memory files list? Not the two cores (they
 * are in the prompt whole), nothing under `journal/` or `archive/`, not the
 * people registry, not attachments. The audience filter (private/ for a group
 * turn) is separate: see {@link collectMemoryFiles}.
 */
export function isListedMemoryPath(rel: string): boolean {
  return !isCoreMemoryPath(rel) && !isJournalMemoryPath(rel) && !isArchiveMemoryPath(rel)
    && !isPeopleMemoryPath(rel) && !isIncomingMemoryPath(rel);
}

/**
 * The frontmatter `description:` of a Markdown file, or undefined when there
 * is no frontmatter or no description in it. Frontmatter is a `---` first
 * line through the next `---` line. A folded or literal block (`>`, `|`)
 * reads as its lines joined by spaces; surrounding quotes are dropped.
 */
export function parseDescription(text: string): string | undefined {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  // A frontmatter block that is never closed is not frontmatter.
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (close === -1) return undefined;
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    const m = /^description\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[1].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      for (let j = i + 1; j < close && /^\s+\S/.test(lines[j]); j++) parts.push(lines[j].trim());
      value = parts.join(" ");
    }
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1).trim();
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/** The frontmatter block's text, or "" when there is none. */
function frontmatterOf(text: string): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return "";
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return close === -1 ? "" : lines.slice(1, close).join("\n");
}

/** What is wrong with a file's description, or null when it has a usable one. */
export function descriptionProblem(text: string): "missing" | "multi-line" | "too-long" | null {
  const d = parseDescription(text);
  if (d === undefined) return "missing";
  // The tools take a one-line description only: a YAML block (`>`, `|`) can
  // run past what this parser reads, and past the limit with it.
  if (/^description\s*:\s*[>|]/m.test(frontmatterOf(text))) return "multi-line";
  return Array.from(d).length > DESCRIPTION_MAX_CHARS ? "too-long" : null;
}

/** Why {@link readMemoryFile} refused a file. */
export type UnreadableReason = "link" | "not-plain" | "outside" | "private" | "other-group" | "moved";

/**
 * Read one memory file safely: never through a symlink in its last part
 * (`O_NOFOLLOW`), only a regular file with one name (a hard link is a second
 * name for the same bytes), and, after opening, only when the file's real
 * location is inside `memoryDir` (and not under private/ when
 * `excludePrivate`) and is the very file that was opened. The last check is
 * what makes a swap between checking a path and reading it harmless: a
 * folder or file replaced by a link into private/ is refused, not read.
 * Returns null when the file doesn't exist; throws on other I/O errors.
 */
export function readMemoryFile(abs: string, memoryDir: string, excludePrivate: boolean, ownGroupDir?: string):
  { bytes: Buffer } | { refused: UnreadableReason } | null {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "ELOOP") return { refused: "link" };
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return { refused: "not-plain" };
    const real = realpathSync(abs);
    if (!isInside(real, memoryDir)) return { refused: "outside" };
    if (excludePrivate && landsInPrivate(real, { cwd: memoryDir, memoryDir, privateDir: join(memoryDir, PRIVATE_MEMORY_SUBDIR) })) return { refused: "private" };
    // With private/ closed, so is every group's folder but the turn's own: by where the file really is.
    if (excludePrivate && isOtherGroupMemoryPath(relative(memoryDir, real).split(sep).join("/"), ownGroupDir)) return { refused: "other-group" };
    const now = statSync(real);
    if (now.ino !== st.ino || now.dev !== st.dev) return { refused: "moved" };
    return { bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

export interface MemoryFileEntry {
  /** Relative to memory/, `/`-separated. */
  path: string;
  description?: string;
  version: string;
  bytes: number;
  /** Would the memory files list show it (see {@link isListedMemoryPath}). */
  listed: boolean;
  /** The bytes the version was taken from, when asked for (`withContent`). */
  content?: Buffer;
}

export interface CollectOptions {
  /** The memory root (an absolute, real directory). */
  memoryDir: string;
  /** Leave out everything under private/ (a group turn), and every group's folder under groups/ but `ownGroupDir`. */
  excludePrivate: boolean;
  /** With `excludePrivate`: the one group folder the turn may see (groupMemoryDir); undefined, none. */
  ownGroupDir?: string;
  /** Only paths under this folder (relative, no leading or trailing slash). */
  prefix?: string;
  /** Include files the list leaves out (journal/, archive/). People and attachments are never included. */
  includeUnlisted?: boolean;
  /** Include MEMORY.md and private/MEMORY.md (memory_search looks in them; the list does not). */
  includeCores?: boolean;
  /** Keep each file's bytes on its entry. */
  withContent?: boolean;
  /** Stop after this many files (default 5000). */
  maxFiles?: number;
  /** Stop after this long (default 500 ms). */
  budgetMs?: number;
  /** Skip reading files above this size: they get no description (default 1 MiB). */
  maxFileBytes?: number;
  now?: () => number;
}

/**
 * Every memory file this audience may see, sorted by path. Synchronous.
 * Never follows a symlink (a linked file or folder is skipped), only `.md`
 * files count, and a file it cannot read is skipped. Sorting by path, not by
 * modification time, keeps the list stable when an old file changes.
 */
export function collectMemoryFiles(opts: CollectOptions): { entries: MemoryFileEntry[]; truncated: boolean } {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? 500);
  const maxFiles = opts.maxFiles ?? 5000;
  const maxBytes = opts.maxFileBytes ?? 1024 * 1024;
  const prefix = opts.prefix ? foldPath(opts.prefix.replace(/\/+$/, "")) : "";
  const entries: MemoryFileEntry[] = [];
  let truncated = false;
  const skipped = (rel: string, folder: boolean): boolean => (opts.excludePrivate
      && (isPrivateMemoryPath(rel) || isOtherGroupMemoryPath(rel, opts.ownGroupDir, folder)))
    || isPeopleMemoryPath(rel) || isIncomingMemoryPath(rel);
  const underPrefix = (rel: string): boolean => {
    if (!prefix) return true;
    const f = foldPath(rel);
    return f === prefix || f.startsWith(`${prefix}/`) || prefix.startsWith(`${f}/`);
  };
  const walk = (relDir: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(relDir ? join(opts.memoryDir, relDir) : opts.memoryDir); } catch { return; }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      if (entries.length >= maxFiles || now() > deadline) { truncated = true; return; }
      if (name.startsWith(".")) continue;
      const rel = relDir ? `${relDir}/${name}` : name;
      if (!underPrefix(rel)) continue;
      let st;
      try { st = lstatSync(join(opts.memoryDir, rel)); } catch { continue; }
      if (st.isSymbolicLink() || skipped(rel, st.isDirectory())) continue;
      if (st.isDirectory()) {
        if (depth < 8) walk(rel, depth + 1);
        continue;
      }
      if (!st.isFile() || !/\.md$/i.test(name)) continue;
      if (isCoreMemoryPath(rel) && !opts.includeCores) continue;
      const listed = isListedMemoryPath(rel);
      if (!listed && !opts.includeUnlisted && !(opts.includeCores && isCoreMemoryPath(rel))) continue;
      if (prefix && foldPath(rel) !== prefix && !foldPath(rel).startsWith(`${prefix}/`)) continue;
      let content: Buffer;
      try {
        const read = readMemoryFile(join(opts.memoryDir, rel), opts.memoryDir, opts.excludePrivate, opts.ownGroupDir);
        if (read === null || "refused" in read) continue;
        content = read.bytes;
      } catch { continue; }
      const description = content.length <= maxBytes ? parseDescription(content.toString("utf8")) : undefined;
      entries.push({
        path: rel,
        ...(description !== undefined ? { description } : {}),
        version: memoryVersion(content),
        bytes: content.length,
        listed,
        ...(opts.withContent ? { content } : {}),
      });
    }
  };
  walk("", 0);
  return { entries, truncated };
}
