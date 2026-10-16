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
 * Arrays that are SETS of chat ids / handles: concurrent additions on both
 * sides must survive (the menu adds group A while the daemon's group secret
 * activates group B). Other arrays (e.g. an MCP server's `args`) are ordered
 * and stay atomic.
 */
const SET_ARRAY_KEYS = new Set(["allowlist", "passiveGroups", "groupShellAllowlist", "telegram", "imessage"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** theirs, minus what I removed since base, plus what I added since base. */
function mergeStringSet(base: string[], mine: string[], theirs: string[]): string[] {
  const removedByMe = new Set(base.filter((v) => !mine.includes(v)));
  const out = theirs.filter((v) => !removedByMe.has(v));
  for (const v of mine) if (!base.includes(v) && !out.includes(v)) out.push(v);
  return out;
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
 * - both changed: plain objects merge recursively; id-set arrays
 *   (`allowlist`, `passiveGroups`, owner handles, …) merge as set diffs from
 *   `base`, keeping both sides' additions and applying the editor's removals;
 *   anything else takes the editor's value — the user's explicit edit wins.
 *
 * `undefined` stands for "absent", so deletions merge the same way.
 */
export function threeWayMerge(base: unknown, mine: unknown, theirs: unknown, key?: string): unknown {
  if (same(mine, base)) return theirs;
  if (same(theirs, base)) return mine;
  if (isPlainObject(mine) && isPlainObject(theirs)) {
    const b = isPlainObject(base) ? base : {};
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(mine), ...Object.keys(theirs)])) {
      const merged = threeWayMerge(b[k], mine[k], theirs[k], k);
      if (merged !== undefined) out[k] = merged;
    }
    return out;
  }
  if (key !== undefined && SET_ARRAY_KEYS.has(key) && isStringArray(mine) && isStringArray(theirs)) {
    return mergeStringSet(isStringArray(base) ? base : [], mine, theirs);
  }
  return mine;
}
