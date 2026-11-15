import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../fs-utils.js";
import { renderSkillTemplate } from "../home/skill.js";

/**
 * Copies the bundled skills (`defaults/skills/<name>/`) into the workspace as
 * `.claude/skills/tomo-<name>/`, overwriting so upgrades take effect, and
 * prunes retired `tomo-` skills. The SDK loads them on demand (`skills:
 * "all"`). Markdown files are rendered first: `{{home:<name>}}` placeholders
 * are filled from the home's scene format (home/skill.ts), so a skill that
 * lists the format's conditions or limits cannot drift from the code.
 */
export function syncBundledSkills(defaultSkillsDir: string, targetSkillsDir: string): void {
  if (!existsSync(defaultSkillsDir)) return;
  mkdirSync(targetSkillsDir, { recursive: true });
  const expected = new Set<string>();
  for (const skill of readdirSync(defaultSkillsDir, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    expected.add(`tomo-${skill.name}`);
    const destDir = join(targetSkillsDir, `tomo-${skill.name}`);
    mkdirSync(destDir, { recursive: true });
    for (const file of readdirSync(join(defaultSkillsDir, skill.name))) {
      const from = join(defaultSkillsDir, skill.name, file);
      if (file.endsWith(".md")) writeFileAtomicSync(join(destDir, file), renderSkillTemplate(readFileSync(from, "utf8")));
      else copyFileSync(from, join(destDir, file));
    }
  }
  // Prune retired tomo- skills (built-ins removed in an upgrade). Only touch
  // `tomo-` directories — the prefix is reserved for built-ins; users are
  // told to avoid it for custom skills, which therefore stay untouched here.
  for (const entry of readdirSync(targetSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("tomo-") || expected.has(entry.name)) continue;
    rmSync(join(targetSkillsDir, entry.name), { recursive: true, force: true });
  }
}
