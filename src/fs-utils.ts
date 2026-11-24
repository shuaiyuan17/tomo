import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteOptions {
  mode?: number;
  /**
   * Called after the temp file is written and immediately before the rename
   * that publishes it. Throwing aborts the write (the temp file is cleaned
   * up and the error propagates) — the hook exists so a caller doing an
   * optimistic read-modify-write can re-check its precondition at the last
   * possible moment, leaving only the rename itself in the race window
   * rather than the whole serialize-and-write.
   */
  beforeRename?: () => void;
  /** fsync the temp file before the rename and the directory after it, so
   *  the new content survives a crash or power loss once this returns. */
  fsync?: boolean;
}

export function writeFileAtomicSync(path: string, content: string, opts?: AtomicWriteOptions): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // Explicit mode wins (e.g. 0600 for secrets, applied even on first write);
  // otherwise preserve the existing file's mode.
  const mode = opts?.mode ?? fileMode(path);
  try {
    if (opts?.fsync) {
      const fd = openSync(tmp, "w", mode ?? 0o666);
      try { writeAllSync(fd, Buffer.from(content, "utf8")); fsyncSync(fd); } finally { closeSync(fd); }
    } else if (mode === undefined) {
      writeFileSync(tmp, content);
    } else {
      writeFileSync(tmp, content, { mode });
    }
    opts?.beforeRename?.();
    renameSync(tmp, path);
    if (mode !== undefined) chmodSync(path, mode);
    if (opts?.fsync) {
      // Advisory on filesystems that refuse a directory fsync.
      try { const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* see above */ }
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/** `writeSync` may write fewer bytes than asked (a full disk, a signal);
 *  keep writing until all of `buf` is out, or let the error throw. */
function writeAllSync(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw Object.assign(new Error(`short write: ${off} of ${buf.length} bytes`), { code: "EIO" });
    off += n;
  }
}

export function writeJsonAtomicSync(path: string, value: unknown, opts?: AtomicWriteOptions): void {
  writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`, opts);
}

export function backupFileIfExistsSync(path: string, backupPath: string, opts?: { mode?: number }): void {
  if (!existsSync(path)) return;
  copyFileSync(path, backupPath);
  if (opts?.mode !== undefined) chmodSync(backupPath, opts.mode);
}

function fileMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** True when a filesystem call failed because the path does not exist. */
export function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
