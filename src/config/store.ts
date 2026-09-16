import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { backupFileIfExistsSync, writeJsonAtomicSync } from "../fs-utils.js";
import { withFileLockSync } from "../file-lock.js";

export class ConfigReadError extends Error {
  constructor(readonly path: string, cause: unknown) { super(`config file could not be read: ${path}`, { cause }); this.name = "ConfigReadError"; }
}
export class ConfigConflictError extends Error { constructor() { super("Configuration changed; reload before saving"); } }
export function configRevision(value: Record<string, unknown>): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function readConfigFile(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw new ConfigReadError(path, err); }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config root is not a JSON object");
    return value as Record<string, unknown>;
  } catch (err) { throw new ConfigReadError(path, err); }
}
export function backupConfigIfParseableSync(path: string, backupPath: string): boolean {
  try { if (readConfigFile(path) === undefined) return false; } catch { return false; }
  backupFileIfExistsSync(path, backupPath, { mode: 0o600 }); return true;
}
export class ConfigStore {
  // Daemon writers fail promptly on contention; only the isolated UI process waits.
  constructor(readonly path: string, readonly backupPath: string = `${path}.bak`, private readonly lockTimeoutMs = 0) {}
  read() { const value = readConfigFile(this.path) ?? {}; return { value, revision: configRevision(value) }; }
  update(edit: (value: Record<string, unknown>) => Record<string, unknown>, expectedRevision?: string,
    validate?: (value: Record<string, unknown>) => void): ReturnType<ConfigStore["read"]> {
    return withFileLockSync(`${this.path}.lock`, () => {
      const current = this.read();
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new ConfigConflictError();
      const value = edit(current.value); validate?.(value);
      mkdirSync(dirname(this.path), { recursive: true });
      backupConfigIfParseableSync(this.path, this.backupPath);
      writeJsonAtomicSync(this.path, value, { mode: 0o600 });
      return { value, revision: configRevision(value) };
    }, { timeoutMs: this.lockTimeoutMs });
  }
  /** Explicit recovery/init path: do not rotate an unreadable original into the good backup. */
  replace(value: Record<string, unknown>, backup = true): void {
    withFileLockSync(`${this.path}.lock`, () => {
      mkdirSync(dirname(this.path), { recursive: true });
      if (backup) backupConfigIfParseableSync(this.path, this.backupPath);
      writeJsonAtomicSync(this.path, value, { mode: 0o600 });
    }, { timeoutMs: this.lockTimeoutMs });
  }
}
