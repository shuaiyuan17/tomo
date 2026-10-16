import { withFileLockSync } from "./file-lock.js";

/**
 * ONE advisory lock for every config.json writer: the daemon (group
 * activation, `/model`, owner-session adoption) and the long-lived `tomo
 * config` UI. Each writer re-reads the file under it, so a write can never be
 * based on a snapshot another writer has already replaced.
 */
export function configLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

export function withConfigLockSync<T>(configPath: string, fn: () => T): T {
  return withFileLockSync(configLockPath(configPath), fn);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Field-level three-way merge of a config edit (the same idea as the cron
 * store's merge): `base` is what the editor loaded, `mine` what it wants to
 * write, `theirs` what is on disk now.
 *
 * - a field the editor did not change keeps the disk's current value (so a
 *   concurrent daemon write — say a model override moved by adoption — is
 *   not reverted by a stale snapshot);
 * - a field only the editor changed takes the editor's value;
 * - both changed: plain objects merge recursively, anything else (arrays,
 *   scalars) takes the editor's value — the user's explicit edit wins.
 *
 * `undefined` stands for "absent", so deletions merge the same way.
 */
export function threeWayMerge(base: unknown, mine: unknown, theirs: unknown): unknown {
  if (same(mine, base)) return theirs;
  if (same(theirs, base)) return mine;
  if (isPlainObject(mine) && isPlainObject(theirs)) {
    const b = isPlainObject(base) ? base : {};
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(mine), ...Object.keys(theirs)])) {
      const merged = threeWayMerge(b[key], mine[key], theirs[key]);
      if (merged !== undefined) out[key] = merged;
    }
    return out;
  }
  return mine;
}
