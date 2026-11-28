import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bundled defaults that used to write memory files directly. With the store
// guard on, those writes are refused, so new installs must not ask for them.
const defaults = join(import.meta.dirname, "..", "defaults");
const read = (rel: string) => readFileSync(join(defaults, rel), "utf8");

describe("bundled defaults and the memory store guard", () => {
  it("a new install's heartbeat keeps its journal under private/journal/, never a path the guard refuses", () => {
    const continuity = read("CONTINUITY.md");
    expect(continuity).toContain("`private/journal/YYYY-MM-DD.md`");
    expect(continuity).not.toMatch(/memory\/[^\s`]*\.md/);
  });

  it("the lcm skill writes the journal with memory_append under private/journal/, in the owner's DM only", () => {
    for (const file of ["skills/lcm/DAILY.md", "skills/lcm/COMPACT.md"]) {
      const text = read(file);
      expect(text, file).toContain("memory_append");
      expect(text, file).toContain("private/journal/YYYY-MM-DD.md");
      expect(text, file).toMatch(/group chat/);
      expect(text, file).not.toMatch(/`memory\/(journal\/)?YYYY-MM-DD\.md`/);
    }
  });
});

describe("stage 3 defaults", () => {
  it("a new install's heartbeat no longer checks memory: that is the rollup's memory pass", () => {
    // The journal step names where the journal lives ("in memory"); nothing else mentions memory.
    expect(read("CONTINUITY.md").replace("journal in memory", "")).not.toMatch(/memory/i);
  });
});
