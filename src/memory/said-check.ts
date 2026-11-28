// What the weekly memory upkeep is handed: the week's `said` lines to check
// against the conversation (§6.3 of the memory design), and the two cores'
// sizes. Synchronous and bounded: it runs in the rollup runner, on the
// daemon's event loop, right before the nudge is sent.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { isoWeekTag } from "../lcm/blocks.js";
import {
  collectMemoryFiles,
  isCoreMemoryPath,
  MEMORY_FILE_HARD_KB,
  MEMORY_SOFT_KB,
  MEMORY_SOFT_LINES,
  readMemoryFile,
} from "../workspace/memory-index.js";

/** At most this many lines are listed for one week; the rest are counted, not carried over. */
export const SAID_CHECK_MAX_LINES = 20;
/** The topic files' scan time limit: the same as memory_search's. */
export const SAID_SCAN_BUDGET_MS = 300;
/**
 * The most of one file that is read. Every write tool keeps a topic file
 * under MEMORY_FILE_HARD_KB and a core under half that, so this covers any
 * file the tools wrote; one an editor grew past it is read up to here, and
 * one slow read cannot hold the event loop for a whole file.
 */
const SAID_READ_MAX_BYTES = 4 * MEMORY_FILE_HARD_KB * 1024;
/** A listed line is cut to this many characters (code points): the nudge stays small whatever a line holds. */
const SAID_LINE_MAX_CHARS = 300;
const CORES = ["MEMORY.md", "private/MEMORY.md"] as const;

/** `- YYYY-MM-DD [said] …` (or `*`), the per-line provenance prefix. */
const SAID_LINE_RE = /^\s*[-*]\s+(\d{4})-(\d{2})-(\d{2})\s+\[said\]\s/;
/**
 * A line an earlier check already turned `inferred` carries this note, so it
 * no longer matches; the note is matched too, so a line someone marked back
 * by hand is not checked twice in one week.
 */
const ALREADY_CHECKED_RE = /no source found, checked \d{4}-\d{2}-\d{2}/i;

export interface SaidLine {
  /** Relative to memory/. */
  path: string;
  /** 1-based. */
  line: number;
  text: string;
}

export interface SaidLines {
  lines: SaidLine[];
  /** Lines of that week past the cap: not listed. */
  more: number;
  /** The scan ran out of time: some topic files were not read. */
  truncated: boolean;
}

/** The ISO week (`YYYY-Www`) a local `YYYY-MM-DD` falls in, or undefined for a date that isn't one. */
function weekOfLocalDate(y: string, m: string, d: string): string | undefined {
  const date = new Date(Number(y), Number(m) - 1, Number(d), 12);
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return undefined;
  return isoWeekTag(date);
}

/**
 * The lines to check for `week` (`YYYY-Www`): each line with the per-line
 * prefix `YYYY-MM-DD [said]` whose date (a local date) is in that ISO week.
 * The two cores first, read before the time-limited walk so a slow tree
 * can't crowd them out; then topic files by path. Not journal/ or archive/
 * folders (collectMemoryFiles skips them without includeUnlisted), not
 * groups/ (members' words are never `said`; not even read), not the people
 * registry, not attachments. private/ is included: the list only ever goes
 * to the owner's own DM session, and only while no group is summoned into it.
 */
export function collectSaidLines(memoryDir: string, week: string, opts: { max?: number; budgetMs?: number; now?: () => number } = {}): SaidLines {
  const max = opts.max ?? SAID_CHECK_MAX_LINES;
  // collectMemoryFiles compares real paths: the root must be one too.
  let root: string;
  try { root = realpathSync(memoryDir); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], more: 0, truncated: false };
    throw err;
  }
  const files: Array<{ path: string; content: Buffer }> = [];
  for (const core of CORES) {
    let read: ReturnType<typeof readMemoryFile>;
    try { read = readMemoryFile(join(root, core), root, false, undefined, SAID_READ_MAX_BYTES); } catch { continue; }
    if (read !== null && !("refused" in read)) files.push({ path: core, content: read.bytes });
  }
  const topics = collectMemoryFiles({
    memoryDir: root,
    excludePrivate: false,
    skipGroups: true,
    withContent: true,
    headBytes: SAID_READ_MAX_BYTES,
    maxFiles: Number.POSITIVE_INFINITY,
    budgetMs: opts.budgetMs ?? SAID_SCAN_BUDGET_MS,
    now: opts.now,
  });
  for (const e of topics.entries) if (!isCoreMemoryPath(e.path) && e.content) files.push({ path: e.path, content: e.content });
  const lines: SaidLine[] = [];
  let more = 0;
  for (const file of files) {
    const text = file.content.toString("utf8").split("\n");
    for (let i = 0; i < text.length; i++) {
      const m = SAID_LINE_RE.exec(text[i]);
      if (!m || weekOfLocalDate(m[1], m[2], m[3]) !== week || ALREADY_CHECKED_RE.test(text[i])) continue;
      if (lines.length >= max) { more++; continue; }
      const chars = Array.from(text[i].trim());
      lines.push({ path: file.path, line: i + 1, text: chars.length <= SAID_LINE_MAX_CHARS ? chars.join("") : `${chars.slice(0, SAID_LINE_MAX_CHARS - 1).join("")}…` });
    }
  }
  return { lines, more, truncated: topics.truncated };
}

/**
 * A core's size the way the prompt measures it (trimmed, then split): read
 * like every memory file (no links, regular files only, nonblocking) and only
 * up to the read bound. Null when it doesn't exist or can't be read; `over`
 * when it is past the bound.
 */
function coreSize(root: string, rel: string): { lines: number; bytes: number } | "over" | null {
  let read: ReturnType<typeof readMemoryFile>;
  try { read = readMemoryFile(join(root, rel), root, false, undefined, SAID_READ_MAX_BYTES); } catch { return null; }
  if (read === null || "refused" in read) return null;
  if (read.partial) return "over";
  const trimmed = read.bytes.toString("utf8").trim();
  return trimmed ? { lines: trimmed.split("\n").length, bytes: Buffer.byteLength(trimmed, "utf8") } : { lines: 0, bytes: 0 };
}

/** One sentence: both cores' sizes against their soft budget (the weekly upkeep's `coreStatus`). */
export function coreStatusLine(memoryDir: string): string {
  let root: string | undefined;
  try { root = realpathSync(memoryDir); } catch { root = undefined; }
  const one = (file: string): string => {
    const s = root === undefined ? null : coreSize(root, file);
    if (s === null) return `${file} doesn't exist yet or can't be read`;
    if (s === "over") return `${file} is over ${SAID_READ_MAX_BYTES / 1024} KB`;
    return `${file} is ${s.lines} lines / ${(s.bytes / 1024).toFixed(1)} KB`;
  };
  return `${one("private/MEMORY.md")} and ${one("MEMORY.md")} (budget ${MEMORY_SOFT_LINES} lines or ${MEMORY_SOFT_KB} KB each).`;
}
