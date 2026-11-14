// The DM-only memory subtree, as pure constants and predicates. Kept free of
// runtime-path imports so the sandboxed web process (which has no HOME/TOMO_*
// environment) can use the same definitions as the daemon.

/** Subdir for DM-only memories. Files here are filtered out of MEMORY.md for
 *  group sessions and blocked by a PreToolUse hook (see sdk-options.ts). */
export const PRIVATE_MEMORY_SUBDIR = "private";

/** Matches markdown links pointing into the private subdir, with or without a
 *  leading `./`. Used to strip private entries from MEMORY.md in groups. */
const PRIVATE_LINK_RE = /\]\(\s*\.?\/?private\//i;

/** True for a MEMORY.md index line that links into `memory/private/`. */
export function isPrivateIndexLine(line: string): boolean {
  return PRIVATE_LINK_RE.test(line);
}
