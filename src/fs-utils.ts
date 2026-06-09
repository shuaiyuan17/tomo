import { chmodSync, copyFileSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function writeFileAtomicSync(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const existingMode = fileMode(path);
  try {
    if (existingMode === undefined) {
      writeFileSync(tmp, content);
    } else {
      writeFileSync(tmp, content, { mode: existingMode });
    }
    renameSync(tmp, path);
    if (existingMode !== undefined) chmodSync(path, existingMode);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export function writeJsonAtomicSync(path: string, value: unknown): void {
  writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function backupFileIfExistsSync(path: string, backupPath: string): void {
  if (!existsSync(path)) return;
  copyFileSync(path, backupPath);
}

function fileMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}
