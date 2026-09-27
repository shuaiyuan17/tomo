import { join } from "node:path";
import { MODEL_ALIASES, modelLabel } from "../../models.js";
import * as p from "@clack/prompts";
import { isDeepStrictEqual } from "node:util";
import { FileLockTimeoutError } from "../../file-lock.js";
import { ConfigStore, ConfigConflictError } from "../../config/store.js";
import { defaultRuntimePaths } from "../../runtime-paths.js";

const paths = defaultRuntimePaths;
export const TOMO_HOME = paths.tomoHome;
export const CONFIG_PATH = paths.configPath;
export const CONFIG_BACKUP_PATH = paths.configBackupPath;
export const SESSIONS_DIR = paths.sessionsDir;
export const SDK_SESSIONS_DIR = paths.sdkSessionsDir;
export const LOG_PATH = join(paths.logsDir, "tomo.log");

export const MODELS = MODEL_ALIASES;

// No path argument: callers/tests must isolate runtime paths BEFORE import.
// A previous test passed an ignored path argument and overwrote a real config.
const store = new ConfigStore(CONFIG_PATH, CONFIG_BACKUP_PATH, 1_000);
const revisions = new WeakMap<Record<string, unknown>, string>();
const originals = new WeakMap<Record<string, unknown>, Record<string, unknown>>();
export function loadConfig(): Record<string, unknown> {
  const { value, revision } = store.read(); revisions.set(value, revision); originals.set(value, structuredClone(value)); return value;
}
export function saveConfig(cfg: Record<string, unknown>): void {
  const result = store.update(() => cfg, revisions.get(cfg)); revisions.set(cfg, result.revision); originals.set(cfg, structuredClone(cfg));
}
export { ConfigReadError, backupConfigIfParseableSync } from "../../config/store.js";
export { modelLabel };

export class ConfigSaveCancelled extends Error {}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
/** Reapply only this editor's delta. Arrays are atomic; unrelated latest fields survive. */
function rebase(base: unknown, draft: unknown, latest: unknown, path: string[], conflicts: string[]): unknown {
  if (isDeepStrictEqual(base, draft)) return latest;
  if (record(base) && record(draft) && record(latest)) {
    return Object.fromEntries([...new Set([...Object.keys(latest), ...Object.keys(base), ...Object.keys(draft)])]
      .map((key) => [key, rebase(Object.hasOwn(base, key) ? base[key] : undefined,
        Object.hasOwn(draft, key) ? draft[key] : undefined, Object.hasOwn(latest, key) ? latest[key] : undefined, [...path, key], conflicts)])
      .filter(([, value]) => value !== undefined));
  }
  if (!isDeepStrictEqual(base, latest) && !isDeepStrictEqual(draft, latest)) conflicts.push(path.join("."));
  return draft;
}
/** Preserve references held by a submenu (e.g. Sessions' overrides object). */
function syncDraft(target: Record<string, unknown>, saved: Record<string, unknown>): void {
  for (const key of Object.keys(target)) if (!Object.hasOwn(saved, key)) delete target[key];
  for (const [key, value] of Object.entries(saved)) {
    if (Object.hasOwn(target, key) && record(target[key]) && record(value)) syncDraft(target[key], value);
    else if (Array.isArray(target[key]) && Array.isArray(value)) target[key].splice(0, target[key].length, ...structuredClone(value));
    else Object.defineProperty(target, key, { value: structuredClone(value), writable: true, enumerable: true, configurable: true });
  }
}
/** Keep the draft and submenu alive while the user resolves a write collision. */
export async function saveConfigInteractive(cfg: Record<string, unknown>): Promise<void> {
  let candidate = cfg;
  let revision = revisions.get(cfg);
  const original = originals.get(cfg);
  for (;;) {
    try {
      const result = store.update(() => candidate, revision);
      syncDraft(cfg, result.value);
      revisions.set(cfg, result.revision); originals.set(cfg, structuredClone(cfg));
      return;
    } catch (error) {
      if (error instanceof FileLockTimeoutError) {
        p.log.warn("Config is busy in another process. Your unsaved edits are still held here.");
        const retry = await p.confirm({ message: "Retry saving your edits? (No discards this action.)", initialValue: true });
        if (p.isCancel(retry) || !retry) throw new ConfigSaveCancelled();
        continue;
      }
      if (!(error instanceof ConfigConflictError)) throw error;
      const latest = store.read(); const conflicts: string[] = [];
      // Production submenus always load first; never replace an untracked file.
      if (!original) throw error;
      candidate = rebase(original, cfg, latest.value, [], conflicts) as Record<string, unknown>;
      p.log.warn("Config changed in another process. Your unsaved edits are still held here.");
      if (conflicts.length) p.log.warn(`Both editors changed: ${conflicts.join(", ")}. Values are hidden.`);
      const apply = await p.confirm({ message: conflicts.length
        ? "Apply your edits to the latest config, replacing those conflicting fields? (No discards this action.)"
        : "Apply your edits while keeping the other process's changes? (No discards this action.)", initialValue: false });
      if (p.isCancel(apply) || !apply) throw new ConfigSaveCancelled();
      revision = latest.revision;
    }
  }
}
