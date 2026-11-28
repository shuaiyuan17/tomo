// Old versions of memory files, kept before a write that loses content.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** How long an old version is kept. */
export const MEMORY_HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The directory old versions live in: `<tomoHome>/data/memory-history/`.
 * Inside the harness's data directory on purpose: a group turn can neither
 * read nor write it (`harnessDataDirs`, closed to the file tools and to the
 * Bash sandbox), it is not in any prompt or list, and memory_search does not
 * look there.
 */
export function memoryHistoryDir(tomoHome: string): string {
  return join(tomoHome, "data", "memory-history");
}

/** `20261127T164726123Z`: sortable, and free of characters a filesystem dislikes. */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:.]/g, "");
}

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/;

/** When a kept version was saved, from its name; undefined for a name this module did not write. */
export function keptAt(name: string): number | undefined {
  const m = STAMP_RE.exec(name);
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Keep `content` (the file as it is now, the bytes whose `version` the caller
 * just checked) as `<historyDir>/<relPath>/<time>-<version>.md`, before the
 * caller overwrites, shortens or deletes it.
 *
 * Synchronous, and THROWS on any failure: the caller runs it in the same
 * synchronous stretch as the write and refuses the write when it throws, so
 * nothing is lost without a copy. Written with `wx` and fsynced. A file of
 * the same name that already holds exactly these bytes counts as kept; one
 * that doesn't (a partial copy a failed attempt could not remove) is left,
 * and the copy goes under the next free name.
 */
export function keepOldVersion(historyDir: string, relPath: string, content: Buffer, version: string, now: number): string {
  const dir = join(historyDir, ...relPath.split("/"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let path = "";
  let fd: number | undefined;
  for (let n = 1; fd === undefined; n++) {
    path = join(dir, `${stamp(now)}-${version}${n > 1 ? `-${n}` : ""}.md`);
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n >= 20) throw err;
      // Kept already only if it holds exactly these bytes: a partial copy
      // left by a failed attempt is not a copy.
      if (readFileSync(path).equals(content)) return path;
    }
  }
  try {
    let off = 0;
    while (off < content.length) off += writeSync(fd, content, off, content.length - off);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(path); } catch { /* best effort: a partial copy is no copy */ }
    throw err;
  }
  closeSync(fd);
  return path;
}

/**
 * Delete kept versions older than {@link MEMORY_HISTORY_DAYS} days, and the
 * folders that leaves empty. Age comes from the name; a file whose name this
 * module did not write falls back to its mtime. Never follows a symlink.
 * Returns how many files it removed. Best effort: an entry it cannot read or
 * remove is skipped, not fatal.
 */
export function sweepMemoryHistory(historyDir: string, now: number, days = MEMORY_HISTORY_DAYS): number {
  const cutoff = now - days * DAY_MS;
  let removed = 0;
  const walk = (dir: string, depth: number): boolean => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return false; }
    let left = entries.length;
    for (const name of entries) {
      const path = join(dir, name);
      let st;
      try { st = lstatSync(path); } catch { continue; }
      if (st.isDirectory()) {
        if (depth < 32 && walk(path, depth + 1)) {
          try { rmdirSync(path); left--; } catch { /* not empty after all */ }
        }
        continue;
      }
      if (!st.isFile()) continue;
      const at = keptAt(name) ?? st.mtimeMs;
      if (at >= cutoff) continue;
      try { unlinkSync(path); removed++; left--; } catch { /* next sweep */ }
    }
    return left === 0;
  };
  walk(historyDir, 0);
  return removed;
}
