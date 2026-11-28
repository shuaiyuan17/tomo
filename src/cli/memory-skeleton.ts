import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two memory cores of a new install: MEMORY.md (shared, loaded into
 * every conversation) and private/MEMORY.md (the owner's private
 * conversation only), each with its headings already in place. A live
 * session is rebuilt when a heading in a core is added or removed, so
 * starting with them avoids that while the model fills them in. Topic files
 * are listed in the prompt by the harness; MEMORY.md holds no pointers.
 *
 * private/MEMORY.md ends with `## Don't keep`: the subjects the owner asked
 * to forget, in a few neutral words, which no write or memory pass saves.
 *
 * MEMORY.md is replaced only when it is missing, or `overwrite` (the owner
 * agreed); private/MEMORY.md only when missing. Returns what it wrote.
 */
/** Today as a local YYYY-MM-DD: a core line's date is the owner's day, not UTC's. */
function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function writeMemoryCores(memoryDir: string, personality: { userName: string; agentName: string } | null, overwrite: boolean): string[] {
  const written: string[] = [];
  mkdirSync(join(memoryDir, "private"), { recursive: true });
  const shared = join(memoryDir, "MEMORY.md");
  if (!existsSync(shared) || overwrite) {
    const owner = personality
      ? [`- ${localDate()} [said] ${personality.userName} set up ${personality.agentName}; call them ${personality.userName}.`]
      : [];
    writeFileSync(shared, ["## Owner", ...owner, "", "## Rules", "", "## Preferences", "", "## Ongoing", ""].join("\n"));
    written.push("MEMORY.md");
  }
  const priv = join(memoryDir, "private", "MEMORY.md");
  if (!existsSync(priv)) {
    writeFileSync(priv, ["## Private", "", "## Don't keep", ""].join("\n"));
    written.push("private/MEMORY.md");
  }
  return written;
}
