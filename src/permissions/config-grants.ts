import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { withConfigLockSync } from "../config-file.js";
import { backupFileIfExistsSync, writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";
import type { GroupSandboxConfig, GroupSandboxEntry } from "../agent/group-fs-policy.js";
import type { PermissionAccess } from "./broker.js";

/**
 * Writes an "Always allow" into config.json and takes it back.
 *
 * Same discipline as every other daemon-side config writer (model-switch.ts,
 * group activation): the shared config lock, the file re-read inside it, a
 * backup, an atomic 0600 write. The live config object is updated after the
 * file, so the next tool call's `groupSandbox` getter sees the change; a
 * failed write leaves both untouched.
 *
 * A group still running on the legacy `groupShellAllowlist` (no entry in
 * `groupSandbox.groups`) keeps `unsandboxed: true` when an entry is created
 * for it, so writing a grant can never quietly sandbox a trusted group.
 */
export interface GrantTarget {
  configPath: string;
  backupPath: string;
  /** The live config: `groupSandbox` and the legacy list it is read with. */
  live: { groupSandbox: GroupSandboxConfig; groupShellAllowlist?: readonly string[] };
}

type RawEntry = Partial<GroupSandboxEntry> & Record<string, unknown>;

function readConfig(path: string): Record<string, unknown> {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown> : {};
}

function groupsOf(cfg: Record<string, unknown>): Record<string, RawEntry> {
  const sandbox = (cfg.groupSandbox ?? {}) as { groups?: Record<string, RawEntry> };
  sandbox.groups ??= {};
  cfg.groupSandbox = sandbox;
  return sandbox.groups;
}

function update(target: GrantTarget, edit: (groups: Record<string, RawEntry>, legacy: readonly string[]) => boolean): boolean {
  try {
    mkdirSync(dirname(target.configPath), { recursive: true });
    let changed = false;
    withConfigLockSync(target.configPath, () => {
      const cfg = readConfig(target.configPath);
      const legacy = Array.isArray(cfg.groupShellAllowlist) ? cfg.groupShellAllowlist as string[] : [];
      changed = edit(groupsOf(cfg), legacy);
      if (!changed) return;
      backupFileIfExistsSync(target.configPath, target.backupPath, { mode: 0o600 });
      writeJsonAtomicSync(target.configPath, cfg, { mode: 0o600 });
    });
    // The file is the record; the live object follows it either way, so a
    // grant already on disk (hand-edited) still takes effect now.
    edit(target.live.groupSandbox.groups as Record<string, RawEntry>, target.live.groupShellAllowlist ?? []);
    return true;
  } catch (err) {
    log.error({ err }, "Could not update groupSandbox in config.json");
    return false;
  }
}

/** Add `path` to the group's `extraRead` (read) or `extraWrite` (write). */
export function persistGroupGrant(groupKey: string, access: PermissionAccess, path: string, target: GrantTarget): boolean {
  return update(target, (groups, legacy) => {
    const entry = groups[groupKey] ??= { extraRead: [], extraWrite: [], unsandboxed: legacy.includes(groupKey) };
    const field = access === "write" ? "extraWrite" : "extraRead";
    const list = Array.isArray(entry[field]) ? entry[field] as string[] : [];
    entry[field] = list;
    if (!Array.isArray(entry.extraRead)) entry.extraRead = [];
    if (!Array.isArray(entry.extraWrite)) entry.extraWrite = [];
    if (typeof entry.unsandboxed !== "boolean") entry.unsandboxed = false;
    if (list.includes(path)) return false;
    list.push(path);
    return true;
  });
}

/** Remove `path` from the group's `extraRead` and `extraWrite`. */
export function revokeGroupGrant(groupKey: string, path: string, target: GrantTarget): boolean {
  return update(target, (groups) => {
    const entry = groups[groupKey];
    if (!entry) return false;
    let changed = false;
    for (const field of ["extraRead", "extraWrite"] as const) {
      const list = entry[field];
      if (!Array.isArray(list) || !list.includes(path)) continue;
      entry[field] = list.filter((p) => p !== path);
      changed = true;
    }
    return changed;
  });
}
