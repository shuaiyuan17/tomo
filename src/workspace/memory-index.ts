// The memory files list: which files exist, their description and version.
// One set of data for memory_list now and the generated prompt list later.
// Pure fs + path: no runtime-path or config imports.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
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
  const parts = rel.split("/");
  if (folded(rel)[0] !== GROUPS_MEMORY_SUBDIR || parts.length < 2) return undefined;
  if (parts.length === 2 && !folder) return "";
  return parts[1];
}

/**
 * On a turn a group steers: is `rel` in some group's folder other than
 * `ownDir` (from {@link groupMemoryDir}; undefined when the turn has no single
 * group, so every group's folder is someone else's)? groups/ is recognised
 * in any case, the turn's own folder only as spelled: on a case-sensitive
 * disk a case variant of it is another folder. A file directly under
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
export function readMemoryFile(abs: string, memoryDir: string, excludePrivate: boolean, ownGroupDir?: string, headBytes?: number):
  { bytes: Buffer; partial?: true } | { refused: UnreadableReason } | null {
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
    if (headBytes !== undefined && st.size > headBytes) {
      // The first part only (the frontmatter is at the top): bounded, whatever the file's size.
      const head = Buffer.alloc(headBytes);
      const n = readSync(fd, head, 0, headBytes, 0);
      return { bytes: head.subarray(0, n), partial: true };
    }
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
  /** It exists but could not be read just now (`reportUnreadable`): no description, no version. */
  unreadable?: true;
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
  /** Keep a file that exists but could not be read (an I/O error) as an entry marked `unreadable`, instead of skipping it. */
  reportUnreadable?: boolean;
  /** Read only this many bytes from the top of each file, enough for its frontmatter: the version is then not known (""). For the prompt's list. */
  headBytes?: number;
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
export function collectMemoryFiles(opts: CollectOptions): { entries: MemoryFileEntry[]; truncated: boolean; unreadableDirs: string[] } {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? 500);
  const maxFiles = opts.maxFiles ?? 5000;
  const maxBytes = opts.maxFileBytes ?? 1024 * 1024;
  const prefix = opts.prefix ? foldPath(opts.prefix.replace(/\/+$/, "")) : "";
  const entries: MemoryFileEntry[] = [];
  const unreadableDirs: string[] = [];
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
    try { names = readdirSync(relDir ? join(opts.memoryDir, relDir) : opts.memoryDir); } catch (err) {
      // A folder that can't be read is not an empty one: say so, so it doesn't read as its files being deleted.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") unreadableDirs.push(relDir);
      return;
    }
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
      let partial: boolean;
      try {
        const read = readMemoryFile(join(opts.memoryDir, rel), opts.memoryDir, opts.excludePrivate, opts.ownGroupDir, opts.headBytes);
        if (read === null || "refused" in read) continue;
        content = read.bytes;
        partial = read.partial === true;
      } catch {
        if (opts.reportUnreadable) entries.push({ path: rel, version: "", bytes: 0, listed, unreadable: true });
        continue;
      }
      const description = content.length <= maxBytes ? parseDescription(content.toString("utf8")) : undefined;
      entries.push({
        path: rel,
        ...(description !== undefined ? { description } : {}),
        version: opts.headBytes !== undefined ? "" : memoryVersion(content),
        bytes: partial ? st.size : content.length,
        listed,
        ...(opts.withContent ? { content } : {}),
      });
    }
  };
  walk("", 0);
  // By whole path (a folder's walk would put work/a.md before work.md).
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, truncated, unreadableDirs };
}

// ------------------------------------------------------------ the prompt list

/** A folder holding more listable files than this (its subfolders included) is folded into one line. */
export const LIST_FOLD_FILES = 12;
/** The list's size, as rendered, past which it is cut (by path order) and the rest counted. */
export const LIST_BUDGET_KB = 8;

export const MEMORY_FILES_HEADER =
  "Path and description of each topic file. Read one with memory_read when its description bears on the task; memory_list with a folder shows a folded one.";
export const NO_TOPIC_FILES = "(no topic files yet)";
const NO_DESCRIPTION = "⚠ no description yet: add one next time you touch this file";

export interface MemoryFilesListOptions {
  /**
   * `full`: the owner's private conversation: everything, private/ included,
   * each group's folder one line. `shared`: what a group chat may see (a
   * group session, the DM session's shared variant): no private/ and no
   * groups/ (a group's own folder is named in its session block).
   */
  audience: "full" | "shared";
  /** A group folder's display name (`groups/<dir>` → the chat's title), when known. */
  groupLabel?: (dir: string) => string | undefined;
}

/** One line of text, at most 80 characters: a title is data, not a prompt line. */
function oneLine(text: string, max = 80): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is stripped
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029"]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Where a file is folded, if its folder is: a folder right under the memory
 * root or right under private/ (the root and private/ themselves are never
 * folded: folded, nothing in them would be seen). A folder below those is
 * part of its top folder's count, so a folder crosses the line once.
 */
function foldKey(path: string): string | undefined {
  const parts = path.split("/");
  const isPrivate = folded(path)[0] === PRIVATE_MEMORY_SUBDIR;
  const depth = isPrivate ? 2 : 1;
  return parts.length > depth ? parts.slice(0, depth).join("/") : undefined;
}

/** The `groups/<dir>` a file is in, or undefined (a file lying directly in groups/ is listed as itself). */
function groupKeyOfPath(path: string): string | undefined {
  const parts = path.split("/");
  return folded(path)[0] === GROUPS_MEMORY_SUBDIR && parts.length > 2 ? parts.slice(0, 2).join("/") : undefined;
}

/**
 * The memory files list's lines (§5.1 of the design), from the listed files
 * of this audience in path order. Stable on purpose: sorted by path; a
 * folder folds by its own file count, not by the list's total size, so
 * adding a file changes a line or two, and a folder folds once.
 *
 * - A folder right under the root or private/ with more than LIST_FOLD_FILES
 *   files is one line: `work/ — 42 files: <its README.md description>`.
 * - `full`: each group's folder is one line, with the chat's name.
 * - A file with no description says so (⚠); one that could not be read is
 *   kept as a line saying that, rather than dropped (dropped, it would read
 *   as deleted).
 * - Past LIST_BUDGET_KB the list is cut in path order and the rest counted.
 */
export function renderMemoryFilesList(entries: readonly MemoryFileEntry[], opts: MemoryFilesListOptions): string[] {
  const shown = entries.filter((e) => e.listed && !(opts.audience === "shared"
    && (isPrivateMemoryPath(e.path) || folded(e.path)[0] === GROUPS_MEMORY_SUBDIR)));
  const groupCounts = new Map<string, number>();
  const foldCounts = new Map<string, number>();
  // Per folded line: how many of its files could not be read, so a folded line still says so.
  const unreadableIn = new Map<string, number>();
  for (const e of shown) {
    const g = groupKeyOfPath(e.path);
    const k = g ?? foldKey(e.path);
    if (k !== undefined && e.unreadable) unreadableIn.set(k, (unreadableIn.get(k) ?? 0) + 1);
    if (g !== undefined) { groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1); continue; }
    if (k !== undefined) foldCounts.set(k, (foldCounts.get(k) ?? 0) + 1);
  }
  const unreadableNote = (k: string): string => {
    const n = unreadableIn.get(k);
    return n ? ` (⚠ ${n} could not be read just now)` : "";
  };
  const readme = (dir: string): string | undefined =>
    shown.find((e) => foldPath(e.path) === foldPath(`${dir}/README.md`))?.description;
  // Each item: its line and how many files it stands for.
  const items: Array<{ line: string; files: number; dir: string }> = [];
  const emitted = new Set<string>();
  for (const e of shown) {
    const g = groupKeyOfPath(e.path);
    if (g !== undefined) {
      if (emitted.has(g)) continue;
      emitted.add(g);
      const n = groupCounts.get(g)!;
      const label = opts.groupLabel?.(g);
      const what = `${n} ${n === 1 ? "file" : "files"} a group chat saved (its members' words)`;
      items.push({ line: `- ${g}/ — ${label ? `"${oneLine(label)}": ` : ""}${what}${unreadableNote(g)}`, files: n, dir: GROUPS_MEMORY_SUBDIR });
      continue;
    }
    const k = foldKey(e.path);
    if (k !== undefined && foldCounts.get(k)! > LIST_FOLD_FILES) {
      if (emitted.has(k)) continue;
      emitted.add(k);
      const n = foldCounts.get(k)!;
      const d = readme(k);
      items.push({ line: `- ${k}/ — ${n} files${d ? `: ${d}` : ""}${unreadableNote(k)}`, files: n, dir: k.split("/").slice(0, -1).join("/") });
      continue;
    }
    const text = e.unreadable ? "⚠ could not be read just now" : e.description ?? NO_DESCRIPTION;
    items.push({ line: `- ${e.path} — ${text}`, files: 1, dir: e.path.split("/").slice(0, -1).join("/") });
  }
  if (items.length === 0) return [NO_TOPIC_FILES];
  // The cut leaves room for its own line.
  const budget = LIST_BUDGET_KB * 1024 - 120;
  let bytes = 0;
  let count = 0;
  for (const item of items) {
    const next = bytes + Buffer.byteLength(item.line, "utf8") + (count > 0 ? 1 : 0);
    if (next > budget) break;
    bytes = next;
    count++;
  }
  const lines = items.slice(0, count).map((i) => i.line);
  if (count === items.length) return lines;
  const rest = items.slice(count);
  const n = rest.reduce((sum, i) => sum + i.files, 0);
  // The folder all the unlisted ones share, if any.
  const dirs = rest.map((i) => i.dir.split("/").filter(Boolean));
  const common: string[] = [];
  for (let i = 0; dirs.every((d) => d.length > i && d[i] === dirs[0][i]); i++) common.push(dirs[0][i]);
  const where = common.length > 0 ? ` under ${common.join("/")}/` : "";
  lines.push(`(${n} more ${n === 1 ? "file" : "files"}${where} not listed: memory_list shows them)`);
  return lines;
}
