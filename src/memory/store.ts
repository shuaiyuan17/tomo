// The memory tools' operations: synchronous read → check → keep → write.
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomicSync } from "../fs-utils.js";
import { landsInPrivate } from "../agent/private-memory-reach.js";
import { isInside, isInsideExact } from "../agent/permission-paths.js";
import {
  collectMemoryFiles,
  descriptionProblem,
  DESCRIPTION_MAX_CHARS,
  isCoreMemoryPath,
  isInsideMemoryFolder,
  isJournalMemoryPath,
  isOtherGroupMemoryPath,
  isListedMemoryPath,
  isPeopleMemoryPath,
  isPrivateMemoryPath,
  memoryVersion,
  readMemoryFile,
  MEMORY_FILE_HARD_KB,
  MEMORY_HARD_KB,
  MEMORY_HARD_LINES,
  MEMORY_SOFT_KB,
  MEMORY_SOFT_LINES,
  type MemoryFileEntry,
} from "../workspace/memory-index.js";
import { isPrivateIndexLine, PRIVATE_MEMORY_SUBDIR } from "../workspace/private-memory.js";
import { keepOldVersion, MEMORY_HISTORY_DAYS } from "./history.js";

/** A refusal the model should read: the message says what to do instead. */
export class MemoryToolError extends Error {}

/**
 * What the turn in flight may do. Resolved per call by the caller (see
 * internal-server.ts): a dm: session's audience changes turn to turn.
 */
export interface MemoryAccess {
  /** memory/private/ is closed: a group session, a summoned or mixed turn, a group-scoped task. */
  privateBarred: boolean;
  /** Writes at all (false for a sub-session). */
  canWrite: boolean;
  /** MEMORY.md and private/MEMORY.md: the owner's own turns only. */
  canWriteCore: boolean;
  /**
   * With `privateBarred`: the one group folder the turn belongs to
   * (`groups/<dir>`, see groupMemoryDir). A barred turn writes only inside it
   * and, among groups/, reads only it. Undefined on a barred turn no single
   * group can be held to (a batch spanning several chats): no group's folder
   * is its own, and it writes nowhere. Ignored when not barred.
   */
  groupDir?: string;
}

export interface MemoryStoreOptions {
  memoryDir: string;
  historyDir: string;
  now?: () => number;
}

const KB = 1024;
const MAX_PATH = 1024;
const MAX_DEPTH = 9;
export const SEARCH_MAX_RESULTS = 50;
export const SEARCH_BUDGET_MS = 300;
export const LIST_MAX_ENTRIES = 300;
const READ_DEFAULT_LINES = 2000;
const READ_MAX_CHARS = 100_000;

export const PEOPLE_PATH_REFUSAL = "People records are written with upsert_person.";
export const PRIVATE_BARRED_REFUSAL =
  `memory/${PRIVATE_MEMORY_SUBDIR}/ is not available on this turn: a group is part of this conversation. Ask again in the owner's own conversation.`;
export const CORE_WRITE_REFUSAL =
  "MEMORY.md can only be changed in the owner's own conversation, not while a group is part of it.";
/** A barred turn writing outside its group's folder. */
export function groupWriteRefusal(groupDir: string): string {
  return `While a group is part of the conversation, memory can only be written under ${groupDir}/. Something every conversation needs is for the owner to ask for in private.`;
}
export const MIXED_WRITE_REFUSAL =
  "This turn's messages come from more than one chat, so nothing can be saved to memory from it. Save it on a turn from a single chat.";
export const OTHER_GROUP_REFUSAL =
  "That folder holds what another group chat saved; it is not available on this turn.";
export const READ_ONLY_REFUSAL =
  "Memory is read-only here. Put what should be saved in your report; the main conversation decides what to keep.";

/** Lines and bytes the way the prompt measures a core (trimmed, then split). */
function coreSize(text: string): { lines: number; bytes: number } {
  const trimmed = text.trim();
  if (!trimmed) return { lines: 0, bytes: 0 };
  return { lines: trimmed.split("\n").length, bytes: Buffer.byteLength(trimmed, "utf8") };
}

function kb(bytes: number): string {
  return `${(bytes / KB).toFixed(1)} KB`;
}

interface Resolved {
  rel: string;
  abs: string;
}

interface Current {
  bytes: Buffer;
  text: string;
  version: string;
  /** The bytes are valid UTF-8: rewriting from `text` loses nothing. */
  lossless: boolean;
}

/**
 * Memory files, read and written only through here by the memory tools.
 *
 * Every operation is one synchronous stretch, with no `await` between the
 * read, the version check, keeping the old version and the write, so two
 * calls in this process cannot interleave. Writers outside the process (the
 * owner's editor) change the version and are caught by `if_version`, and
 * again right before the rename or unlink. There is no file lock (by design):
 * an outside write that lands in the instant between that last check and the
 * rename can still be lost, as can a folder swapped for a link in that
 * instant redirect the write. Closing that needs `openat`-style calls Node
 * does not have.
 */
export class MemoryStore {
  private readonly now: () => number;
  constructor(private readonly opts: MemoryStoreOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The real memory root. Created when missing. */
  private root(): string {
    mkdirSync(this.opts.memoryDir, { recursive: true });
    return realpathSync(this.opts.memoryDir);
  }

  /**
   * Check a model-supplied path: relative to memory/, `.md`, no `..`, no
   * symlink anywhere along it, not the people registry, and allowed for this
   * turn. Throws {@link MemoryToolError} with the reason.
   */
  private resolve(path: unknown, access: MemoryAccess, mode: "read" | "write"): Resolved {
    if (typeof path !== "string" || !path.trim()) throw new MemoryToolError("A path is required, relative to memory/, e.g. \"travel.md\".");
    let rel = path.trim().replace(/^(\.\/)+/, "");
    if (rel.length > MAX_PATH || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/") || rel.startsWith("~")) {
      throw new MemoryToolError(`${path} is not a path inside memory/. Give it relative to memory/, e.g. "travel.md" or "private/health.md".`);
    }
    if (/^memory\//i.test(rel)) {
      throw new MemoryToolError(`Paths are relative to memory/: write "${rel.slice("memory/".length)}", not "${rel}".`);
    }
    const parts = rel.split("/");
    if (parts.some((p) => !p || p === "." || p === "..") || parts.length > MAX_DEPTH) {
      throw new MemoryToolError(`${path} is not a path inside memory/: no "..", empty or "." parts, at most ${MAX_DEPTH} levels.`);
    }
    // Hidden names are skipped by memory_list and memory_search, so a file there would be lost to them.
    if (parts.some((p) => p.startsWith("."))) {
      throw new MemoryToolError(`${path}: names starting with "." are hidden from memory_list and memory_search; pick a name without the dot.`);
    }
    rel = parts.join("/");
    if (!/\.md$/i.test(rel)) throw new MemoryToolError(`${rel}: memory files are Markdown, so the path ends in .md.`);
    if (isPeopleMemoryPath(rel)) throw new MemoryToolError(PEOPLE_PATH_REFUSAL);
    const root = this.root();
    const abs = join(root, ...parts);
    if (access.privateBarred && (isPrivateMemoryPath(rel)
      || landsInPrivate(abs, { cwd: root, memoryDir: root, privateDir: join(root, PRIVATE_MEMORY_SUBDIR) }))) {
      throw new MemoryToolError(PRIVATE_BARRED_REFUSAL);
    }
    if (mode === "write" && access.canWrite && access.privateBarred && access.groupDir === undefined) throw new MemoryToolError(MIXED_WRITE_REFUSAL);
    if (access.privateBarred && isOtherGroupMemoryPath(rel, access.groupDir)) throw new MemoryToolError(OTHER_GROUP_REFUSAL);
    if (mode === "write") {
      if (!access.canWrite) throw new MemoryToolError(READ_ONLY_REFUSAL);
      if (isCoreMemoryPath(rel) && !access.canWriteCore) throw new MemoryToolError(CORE_WRITE_REFUSAL);
      if (access.privateBarred) {
        if (access.groupDir === undefined) throw new MemoryToolError(MIXED_WRITE_REFUSAL);
        if (!isInsideMemoryFolder(rel, access.groupDir)) throw new MemoryToolError(groupWriteRefusal(access.groupDir));
      }
    }
    // No symlink anywhere: each existing folder along the way, then the file.
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      let st;
      try { st = lstatSync(dir); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
        throw err;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new MemoryToolError(`${rel}: ${dir.slice(root.length + 1)} is a link or not a folder; memory tools don't follow links.`);
    }
    return { rel, abs };
  }

  /**
   * The file's bytes, or null when it doesn't exist. Refuses a link, a
   * non-file, a hard-linked file, and one whose real location is outside
   * memory/ (or under private/ on a barred turn) — checked after opening, so
   * swapping a path for a link while a call runs reads nothing it shouldn't.
   */
  private current(r: Resolved, access: MemoryAccess): Current | null {
    const read = readMemoryFile(r.abs, this.root(), access.privateBarred, access.groupDir);
    if (read === null) return null;
    if ("refused" in read) {
      if (read.refused === "private") throw new MemoryToolError(PRIVATE_BARRED_REFUSAL);
      if (read.refused === "other-group") throw new MemoryToolError(OTHER_GROUP_REFUSAL);
      if (read.refused === "not-plain") throw new MemoryToolError(`${r.rel} is not a plain file (a folder, a device or a hard link).`);
      if (read.refused === "moved") throw new MemoryToolError(`${r.rel} changed while it was being read. Try again.`);
      throw new MemoryToolError(`${r.rel} is a link or leads outside memory/; memory tools don't follow links.`);
    }
    const text = read.bytes.toString("utf8");
    return { bytes: read.bytes, text, version: memoryVersion(read.bytes), lossless: Buffer.from(text, "utf8").equals(read.bytes) };
  }

  /**
   * Throws unless the file is still what this call read (`cur`, or absent
   * when null). Run at the last moment before the write lands, so an outside
   * writer (the owner's editor) that changed the file during the call is
   * caught rather than overwritten.
   */
  private unchanged(r: Resolved, cur: Current | null): void {
    let now: Buffer | null;
    try { now = readFileSync(r.abs); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      now = null;
    }
    if (cur === null && now === null) return;
    if (cur !== null && now !== null && memoryVersion(now) === cur.version) return;
    throw now === null
      ? new MemoryToolError(`${r.rel} was removed while this call ran. Check with memory_list and retry.`)
      : new MemoryToolError(`${r.rel} changed since you read it (now version ${memoryVersion(now)}). Read it again with memory_read and retry.`);
  }

  private stale(rel: string, cur: Current): MemoryToolError {
    return new MemoryToolError(`${rel} changed since you read it (now version ${cur.version}). Read it again with memory_read and retry.`);
  }

  /** Keep the current content before a write that loses some; a failure refuses the write. */
  private keep(r: Resolved, cur: Current): void {
    try {
      keepOldVersion(this.opts.historyDir, r.rel, cur.bytes, cur.version, this.now());
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message ?? String(err);
      throw new MemoryToolError(`${r.rel} was not changed: its current content could not be kept first (${reason}).`);
    }
  }

  /**
   * The size rules. A write that does not make the file bigger on a dimension
   * is never refused for it, so an over-limit file can always be shortened.
   * Returns the soft-budget reminder for a core, if any.
   */
  private checkSize(rel: string, before: string | null, after: string): string | undefined {
    if (isCoreMemoryPath(rel)) {
      const a = coreSize(after);
      const b = before === null ? { lines: 0, bytes: 0 } : coreSize(before);
      if (a.lines > MEMORY_HARD_LINES && a.lines > b.lines) {
        throw new MemoryToolError(`${rel} would be ${a.lines} lines, over its ${MEMORY_HARD_LINES}-line limit. Write this to a topic file instead, or shorten ${rel} first.`);
      }
      if (a.bytes > MEMORY_HARD_KB * KB && a.bytes > b.bytes) {
        throw new MemoryToolError(`${rel} would be ${kb(a.bytes)}, over its ${MEMORY_HARD_KB} KB limit. Write this to a topic file instead, or shorten ${rel} first.`);
      }
      if (a.lines > MEMORY_SOFT_LINES || a.bytes > MEMORY_SOFT_KB * KB) {
        return `${rel} is now ${a.lines} lines / ${kb(a.bytes)}, over its ${MEMORY_SOFT_LINES}-line / ${MEMORY_SOFT_KB} KB budget: move details into topic files when you can.`;
      }
      return undefined;
    }
    const a = Buffer.byteLength(after, "utf8");
    const b = before === null ? 0 : Buffer.byteLength(before, "utf8");
    if (a > MEMORY_FILE_HARD_KB * KB && a > b) {
      throw new MemoryToolError(`${rel} would be ${kb(a)}, over its ${MEMORY_FILE_HARD_KB} KB limit. Write this to a topic file instead, or shorten ${rel} first.`);
    }
    return undefined;
  }

  private missingDescription(rel: string): MemoryToolError {
    return new MemoryToolError(`${rel} needs frontmatter with a description: line (at most ${DESCRIPTION_MAX_CHARS} characters) saying when to read this file.`);
  }

  /** Write `text` over what this call read as `cur` (null: a new file), unless it changed meanwhile. */
  private write(r: Resolved, access: MemoryAccess, cur: Current | null, text: string): string {
    this.placeOk(r, access);
    mkdirSync(dirname(r.abs), { recursive: true });
    this.placeOk(r, access);
    writeFileAtomicSync(r.abs, text, { beforeRename: () => { this.placeOk(r, access); this.unchanged(r, cur); } });
    return memoryVersion(Buffer.from(text, "utf8"));
  }

  /**
   * The folder a write lands in, by its real path: inside memory/, and not
   * under private/ on a barred turn. Checked again right before the write
   * lands, so a folder swapped for a link after resolve() does not carry a
   * group's write into private/ or out of memory/.
   */
  private placeOk(r: Resolved, access: MemoryAccess): void {
    const root = this.root();
    // The nearest folder that exists, so this can run before mkdir creates the rest.
    let dir = dirname(r.abs);
    const missing: string[] = [basename(r.abs)];
    for (;;) {
      try { lstatSync(dir); break; } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT" || dir === root || dirname(dir) === dir) throw err;
        missing.unshift(basename(dir));
        dir = dirname(dir);
      }
    }
    const real = join(realpathSync(dir), ...missing);
    if (!isInside(real, root)) throw new MemoryToolError(`${r.rel} leads outside memory/; memory tools don't follow links.`);
    if (access.privateBarred && landsInPrivate(real, { cwd: root, memoryDir: root, privateDir: join(root, PRIVATE_MEMORY_SUBDIR) })) {
      throw new MemoryToolError(PRIVATE_BARRED_REFUSAL);
    }
    // The real place, not the spelled one, inside the turn's own group folder.
    if (access.privateBarred && (access.groupDir === undefined || !isInsideExact(real, join(root, access.groupDir)))) {
      throw new MemoryToolError(access.groupDir === undefined ? MIXED_WRITE_REFUSAL : groupWriteRefusal(access.groupDir));
    }
  }

  private saved(rel: string, version: string, note?: string): string {
    return `Saved ${rel} (version ${version}).${note ? ` ${note}` : ""}`;
  }

  // ---------------------------------------------------------------- reads

  list(access: MemoryAccess, prefix?: string): { entries: MemoryFileEntry[]; truncated: boolean; unlisted: number } {
    let folder: string | undefined;
    if (prefix !== undefined && prefix.trim() && prefix.trim() !== "/" && prefix.trim() !== ".") {
      folder = prefix.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
      if (folder.startsWith("/") || folder.split("/").some((p) => !p || p === "." || p === "..") || /^memory$/i.test(folder.split("/")[0])) {
        throw new MemoryToolError(`${prefix} is not a folder inside memory/. Give it relative to memory/, e.g. "private/work/".`);
      }
      if (access.privateBarred && isPrivateMemoryPath(folder)) throw new MemoryToolError(PRIVATE_BARRED_REFUSAL);
      if (access.privateBarred && isOtherGroupMemoryPath(folder, access.groupDir, true)) throw new MemoryToolError(OTHER_GROUP_REFUSAL);
    }
    const root = this.root();
    const all = collectMemoryFiles({ memoryDir: root, excludePrivate: access.privateBarred, ownGroupDir: access.groupDir, prefix: folder, includeUnlisted: true, now: this.now });
    // Without a folder: what the memory files list shows. With one: everything in it.
    const entries = folder ? all.entries : all.entries.filter((e) => e.listed);
    return { entries, truncated: all.truncated, unlisted: all.entries.length - entries.length };
  }

  read(access: MemoryAccess, path: unknown, offset?: number, limit?: number): string {
    const r = this.resolve(path, access, "read");
    const cur = this.current(r, access);
    if (!cur) throw new MemoryToolError(`${r.rel} doesn't exist. memory_list shows what does; create it with memory_write and if_version "new".`);
    let lines = cur.text.split("\n");
    let withheld = 0;
    // A group turn sees MEMORY.md the way its prompt shows it: without the lines that point into private/.
    if (access.privateBarred && isCoreMemoryPath(r.rel)) {
      const kept = lines.filter((line) => !isPrivateIndexLine(line));
      withheld = lines.length - kept.length;
      lines = kept;
    }
    const total = lines.length;
    const start = Math.max(1, Math.floor(offset ?? 1));
    const want = Math.max(1, Math.floor(limit ?? READ_DEFAULT_LINES));
    const out: string[] = [];
    let chars = 0;
    let i = start - 1;
    for (; i < total && out.length < want; i++) {
      if (chars + lines[i].length + 1 > READ_MAX_CHARS && out.length > 0) break;
      out.push(lines[i]);
      chars += lines[i].length + 1;
    }
    const end = start - 1 + out.length;
    const whole = start === 1 && end >= total;
    const head = whole
      ? `${r.rel} (version ${cur.version}, ${total} lines)`
      : `${r.rel} (version ${cur.version}), lines ${start}–${end} of ${total}${end < total ? `; continue with offset ${end + 1}` : ""}`;
    const note = withheld ? `\n(${withheld} lines that point into ${PRIVATE_MEMORY_SUBDIR}/ are not shown on this turn)` : "";
    if (start > total) return `${r.rel} (version ${cur.version}) has ${total} lines; offset ${start} is past the end.`;
    return `${head}${note}\n\n${out.join("\n")}`;
  }

  search(access: MemoryAccess, query: string): { hits: Array<{ path: string; line: number; text: string }>; truncated: boolean } {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) throw new MemoryToolError("memory_search needs a query.");
    if (needle.length > 200) throw new MemoryToolError("The query is too long: search for a few distinctive words.");
    const all = collectMemoryFiles({
      memoryDir: this.root(),
      excludePrivate: access.privateBarred,
      ownGroupDir: access.groupDir,
      includeUnlisted: true,
      includeCores: true,
      withContent: true,
      // Bounded by time, not by a file count, so no part of a large tree is out of reach for good.
      maxFiles: Number.POSITIVE_INFINITY,
      budgetMs: SEARCH_BUDGET_MS,
      now: this.now,
    });
    // The cores first: they are what every conversation holds.
    const files = [...all.entries.filter((e) => isCoreMemoryPath(e.path)), ...all.entries.filter((e) => !isCoreMemoryPath(e.path))];
    const hits: Array<{ path: string; line: number; text: string }> = [];
    let truncated = all.truncated;
    // The budget bounds the reading (collectMemoryFiles); what was read is always searched.
    outer: for (const file of files) {
      const lines = (file.content ?? Buffer.alloc(0)).toString("utf8").split("\n");
      const barredCore = access.privateBarred && isCoreMemoryPath(file.path);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const at = line.toLocaleLowerCase().indexOf(needle);
        if (at < 0 || (barredCore && isPrivateIndexLine(line))) continue;
        if (hits.length >= SEARCH_MAX_RESULTS) { truncated = true; break outer; }
        const text = line.length <= 300 ? line : `${at > 80 ? "…" : ""}${line.slice(Math.max(0, at - 80), at + 220)}…`;
        hits.push({ path: file.path, line: i + 1, text });
      }
    }
    return { hits, truncated };
  }

  // --------------------------------------------------------------- writes

  writeFile(access: MemoryAccess, path: unknown, content: string, ifVersion: string): string {
    const r = this.resolve(path, access, "write");
    const cur = this.current(r, access);
    if (ifVersion === "new") {
      if (cur) throw new MemoryToolError(`${r.rel} already exists (version ${cur.version}). Read it with memory_read, then replace it with that version, or pick another name.`);
    } else if (!cur) {
      throw new MemoryToolError(`${r.rel} doesn't exist. To create it, pass if_version "new".`);
    } else if (cur.version !== ifVersion) {
      throw this.stale(r.rel, cur);
    }
    if (isListedMemoryPath(r.rel) && descriptionProblem(content) !== null) throw this.missingDescription(r.rel);
    const note = this.checkSize(r.rel, cur?.text ?? null, content);
    if (cur) this.keep(r, cur);
    return this.saved(r.rel, this.write(r, access, cur, content), note);
  }

  strReplace(access: MemoryAccess, path: unknown, oldText: string, newText: string): string {
    const r = this.resolve(path, access, "write");
    const cur = this.current(r, access);
    if (!cur) throw new MemoryToolError(`${r.rel} doesn't exist. memory_list shows what does.`);
    if (!oldText) throw new MemoryToolError("`old` is empty: give the exact text to change.");
    const at = cur.text.indexOf(oldText);
    if (at < 0) throw new MemoryToolError(`\`old\` does not appear in ${r.rel}. Read the file with memory_read and copy the text exactly.`);
    if (cur.text.indexOf(oldText, at + 1) >= 0) throw new MemoryToolError(`\`old\` appears more than once in ${r.rel}. Widen it with nearby text until it appears exactly once.`);
    const next = cur.text.slice(0, at) + newText + cur.text.slice(at + oldText.length);
    if (isListedMemoryPath(r.rel) && descriptionProblem(cur.text) === null && descriptionProblem(next) !== null) throw this.missingDescription(r.rel);
    const note = this.checkSize(r.rel, cur.text, next);
    // A replacement that shortens the file is the one that loses content worth
    // keeping; so is any rewrite of bytes that weren't valid UTF-8.
    if (Buffer.byteLength(next, "utf8") < cur.bytes.length || !cur.lossless) this.keep(r, cur);
    return this.saved(r.rel, this.write(r, access, cur, next), note);
  }

  append(access: MemoryAccess, path: unknown, content: string, create = false): string {
    const r = this.resolve(path, access, "write");
    if (!content.trim()) throw new MemoryToolError("Nothing to append.");
    const cur = this.current(r, access);
    if (!cur && !(create && isJournalMemoryPath(r.rel))) {
      throw new MemoryToolError(create
        ? `Create ${r.rel} with memory_write, with a description in its frontmatter.`
        : `${r.rel} doesn't exist. Create it with memory_write (or, under a journal/ folder, memory_append with create: true).`);
    }
    const body = content.endsWith("\n") ? content : `${content}\n`;
    const before = cur?.text ?? "";
    const next = before === "" || before.endsWith("\n") ? before + body : `${before}\n${body}`;
    const note = this.checkSize(r.rel, cur?.text ?? null, next);
    // The file is rewritten from its decoded text: bytes that weren't UTF-8 would be lost.
    if (cur && !cur.lossless) this.keep(r, cur);
    return this.saved(r.rel, this.write(r, access, cur, next), note);
  }

  move(access: MemoryAccess, from: unknown, to: unknown): string {
    const a = this.resolve(from, access, "write");
    const b = this.resolve(to, access, "write");
    if (isCoreMemoryPath(a.rel) || isCoreMemoryPath(b.rel)) throw new MemoryToolError("MEMORY.md files can't be moved, and nothing can be moved onto them.");
    const cur = this.current(a, access);
    if (!cur) throw new MemoryToolError(`${a.rel} doesn't exist. memory_list shows what does.`);
    const exists = new MemoryToolError(`${b.rel} already exists. Pick another name, or merge the two with memory_read and memory_write.`);
    try { lstatSync(b.abs); throw exists; } catch (err) {
      if (err === exists) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (isListedMemoryPath(b.rel) && !isListedMemoryPath(a.rel) && descriptionProblem(cur.text) !== null) throw this.missingDescription(b.rel);
    this.placeOk(a, access);
    this.placeOk(b, access);
    mkdirSync(dirname(b.abs), { recursive: true });
    this.placeOk(b, access);
    // link + unlink, not rename: link refuses an existing destination
    // atomically, so a file created there meanwhile is never overwritten.
    try { linkSync(a.abs, b.abs); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw exists;
      throw err;
    }
    // Unlink the source only while it is still the file just linked: one an
    // editor saved over it meanwhile stays, and the new name is taken back.
    // The bytes linked must be the ones checked above (an editor may have saved over the source).
    const src = lstatSync(a.abs);
    const dst = lstatSync(b.abs);
    if (src.ino !== dst.ino || src.dev !== dst.dev || memoryVersion(readFileSync(b.abs)) !== cur.version) {
      unlinkSync(b.abs);
      throw new MemoryToolError(`${a.rel} changed while it was being moved, so it was left where it was. Read it again and retry.`);
    }
    try { unlinkSync(a.abs); } catch (err) {
      // Leave one name, not two: a file with two names is refused by every memory tool.
      try { unlinkSync(b.abs); } catch { /* the error below says what failed */ }
      const reason = (err as NodeJS.ErrnoException).code ?? String(err);
      throw new MemoryToolError(`${a.rel} could not be moved (${reason}); it was left where it was.`);
    }
    return `Moved ${a.rel} to ${b.rel} (version ${cur.version}).`;
  }

  delete(access: MemoryAccess, path: unknown, ifVersion: string): string {
    const r = this.resolve(path, access, "write");
    if (isCoreMemoryPath(r.rel)) throw new MemoryToolError("MEMORY.md files can't be deleted. Change what they hold with memory_str_replace or memory_write.");
    const cur = this.current(r, access);
    if (!cur) throw new MemoryToolError(`${r.rel} doesn't exist. memory_list shows what does.`);
    if (cur.version !== ifVersion) throw this.stale(r.rel, cur);
    this.keep(r, cur);
    this.placeOk(r, access);
    this.unchanged(r, cur);
    unlinkSync(r.abs);
    return `Deleted ${r.rel}. Its content is kept for ${MEMORY_HISTORY_DAYS} days in Tomo's own data, outside memory.`;
  }
}
