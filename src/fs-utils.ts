import { chmodSync, copyFileSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
}

export function writeFileAtomicSync(path: string, content: string, opts?: AtomicWriteOptions): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // Explicit mode wins (e.g. 0600 for secrets, applied even on first write);
  // otherwise preserve the existing file's mode.
  const mode = opts?.mode ?? fileMode(path);
  try {
    if (mode === undefined) {
      writeFileSync(tmp, content);
    } else {
      writeFileSync(tmp, content, { mode });
    }
    opts?.beforeRename?.();
    renameSync(tmp, path);
    if (mode !== undefined) chmodSync(path, mode);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
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
