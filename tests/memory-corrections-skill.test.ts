/**
 * The memory-corrections skill (§15.5 of the memory design): bundled under
 * defaults/skills/, synced at startup as `tomo-memory-corrections`, and the
 * name the memory prompt points to.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncBundledSkills } from "../src/workspace/bundled-skills.js";

const DEFAULTS = join(import.meta.dirname, "..", "defaults", "skills");
const target = mkdtempSync(join(tmpdir(), "tomo-skills-"));
afterAll(() => rmSync(target, { recursive: true, force: true }));

/** The frontmatter fields the SDK's skill loader reads. */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return {};
  return Object.fromEntries(m[1].split("\n").map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter((x): x is RegExpExecArray => !!x).map((x) => [x[1], x[2]]));
}

describe("the tomo-memory-corrections skill", () => {
  syncBundledSkills(DEFAULTS, target);
  const text = readFileSync(join(target, "tomo-memory-corrections", "SKILL.md"), "utf8");

  it("is synced under its tomo- name, with a name matching its folder and a description saying when to use it", () => {
    const fm = frontmatter(text);
    expect(fm.name).toBe("tomo-memory-corrections");
    expect(fm.description).toMatch(/^Use when the owner disputes or corrects a fact you stored/);
  });

  it("holds the two cases and the follow-through", () => {
    expect(text).toContain("# The latest correction wins");
    expect(text).toContain("## When the owner gives a new value");
    expect(text).toContain("Update the record now; don't ask them to confirm it.");
    expect(text).toContain("## When the owner only disputes, or isn't sure");
    expect(text).toContain("Ask one short question that names the competing values");
    expect(text).toContain("Find other copies with memory_search");
    expect(text).toContain('"the 14th (not the 15th)"');
  });
});
