import { appendFile, chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const chains = new Map<string, Promise<unknown>>();

/**
 * The existing file's state: does it end without a final newline (torn), and
 * its permission bits. undefined: no file yet.
 */
async function inspect(path: string): Promise<{ torn: boolean; mode: number } | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const { size, mode } = await handle.stat();
    if (size === 0) return { torn: false, mode: mode & 0o777 };
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return { torn: last[0] !== 0x0a, mode: mode & 0o777 };
  } finally {
    await handle.close();
  }
}

export interface AppendModes {
  /** Mode for a file this append creates (an existing file keeps its own). */
  fileMode?: number;
  /** Mode for directories this append creates. */
  dirMode?: number;
}

/**
 * Append to an ndjson file with every write to the same path run one after
 * another, in call order, so lines land in the order they were asked for even
 * when callers do not await. `line` is evaluated when the write's turn comes —
 * a deduplicating caller decides there, against what has actually been
 * written — and returns the text to append (without the newline), or
 * undefined to skip. `onWritten` runs right after a successful write, still
 * inside the chain (before the next write's `line`), so state it updates is
 * always what the file says. Resolves true once written, false when skipped;
 * rejects on a failed write (the chain itself carries on).
 *
 * A file that does not end in a newline — the torn tail of a crash mid-append,
 * by this process or another — gets one first, so the torn fragment stays a
 * line of its own (skipped by readers) instead of swallowing the new line
 * into one unparseable mess. With `modes.fileMode`, an existing file whose
 * permissions are wider is chmod-ed to it first. Checked before every append: one byte read, and
 * a tail torn by another writer since the last check is caught too.
 */
export function appendLineSerial(
  path: string,
  line: () => string | undefined,
  onWritten?: () => void,
  modes: AppendModes = {},
): Promise<boolean> {
  const run = (chains.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const text = line();
    if (text === undefined) return false;
    await mkdir(dirname(path), { recursive: true, ...(modes.dirMode !== undefined ? { mode: modes.dirMode } : {}) });
    const existing = await inspect(path);
    // An existing file wider than `fileMode` (made by an older build, or by
    // hand) is tightened before anything more is written into it.
    if (existing && modes.fileMode !== undefined && (existing.mode & ~modes.fileMode) !== 0) await chmod(path, modes.fileMode);
    const lead = existing?.torn ? "\n" : "";
    await appendFile(path, `${lead}${text}\n`, { encoding: "utf8", ...(modes.fileMode !== undefined ? { mode: modes.fileMode } : {}) });
    onWritten?.();
    return true;
  });
  chains.set(path, run);
  // Drop the entry once idle, so the map does not hold every path forever.
  void run.catch(() => undefined).finally(() => { if (chains.get(path) === run) chains.delete(path); });
  return run;
}
