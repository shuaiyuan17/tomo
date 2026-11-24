import { describe, it, expect } from "vitest";
import { describePromptContextChange, MAX_CONTEXT_DIFF_LINES } from "../src/workspace/prompt-context-diff.js";

describe("describePromptContextChange", () => {
  const base = { memory: ["- [Travel](travel.md) — trips", "- [Work](work.md) — job"], people: ["- Alice"] };

  it("says nothing when nothing changed (blank lines and trailing spaces do not count)", () => {
    expect(describePromptContextChange(base, { memory: [...base.memory, "", "  "], people: ["- Alice  "] })).toBeUndefined();
  });

  it("lists added and removed MEMORY.md lines", () => {
    const body = describePromptContextChange(base, {
      memory: ["- [Travel](travel.md) — trips", "- [Coffee](coffee.md) — gear"],
      people: base.people,
    })!;
    expect(body).toContain("+ - [Coffee](coffee.md) — gear");
    expect(body).toContain("- - [Work](work.md) — job");
    expect(body).not.toContain("Travel");
    expect(body).not.toContain("People registry");
  });

  it("lists roster changes on their own", () => {
    const body = describePromptContextChange(base, { memory: base.memory, people: ["- Alice", "- Bob aka: b"] })!;
    expect(body).toContain("People registry");
    expect(body).toContain("+ - Bob aka: b");
    expect(body).not.toContain("MEMORY.md (");
  });

  it("points at the file instead of listing a large rewrite", () => {
    const rewritten = Array.from({ length: MAX_CONTEXT_DIFF_LINES + 5 }, (_, i) => `- [N${i}](n${i}.md)`);
    const body = describePromptContextChange(base, { memory: rewritten, people: base.people })!;
    expect(body).toContain("changed substantially");
    expect(body).toContain("Read memory/MEMORY.md");
    expect(body).not.toContain("n3.md");
  });

  it("says so when unchanged lines only moved (an entry now under another heading)", () => {
    const before = { memory: ["## Work", "- [A](a.md)", "## Home", "- [B](b.md)"], people: [] };
    const after = { memory: ["## Work", "## Home", "- [A](a.md)", "- [B](b.md)"], people: [] };
    const body = describePromptContextChange(before, after)!;
    expect(body).toContain("MEMORY.md: existing lines were reordered");
    expect(body).toContain("Read memory/MEMORY.md");
  });

  it("counts a duplicated line as a change", () => {
    const before = { memory: ["- [A](a.md)"], people: [] };
    expect(describePromptContextChange(before, { memory: ["- [A](a.md)", "- [A](a.md)"], people: [] })).toBeDefined();
  });

  it("mentions a reorder next to added lines, and stays quiet when only a removal shifts positions", () => {
    const before = { memory: ["- x", "- y", "- z"], people: [] };
    const both = describePromptContextChange(before, { memory: ["- z", "- y", "- x", "- new"], people: [] })!;
    expect(both).toContain("+ - new");
    expect(both).toContain("also reordered");
    const removal = describePromptContextChange(before, { memory: ["- x", "- z"], people: [] })!;
    expect(removal).toContain("- - y");
    expect(removal).not.toContain("reordered");
  });

  it("never points a group session at the raw MEMORY.md (it holds the private lines its prompt filters out)", () => {
    const before = { memory: ["## Work", "- [A](a.md)", "## Home", "- [B](b.md)"], people: [] };
    const reordered = { memory: ["## Work", "## Home", "- [A](a.md)", "- [B](b.md)"], people: [] };
    const rewritten = { memory: Array.from({ length: MAX_CONTEXT_DIFF_LINES + 5 }, (_, i) => `- [N${i}](n${i}.md)`), people: [] };
    for (const after of [reordered, rewritten]) {
      expect(describePromptContextChange(before, after)).toContain("memory/MEMORY.md");
      const group = describePromptContextChange(before, after, { isGroup: true })!;
      expect(group).not.toContain("memory/MEMORY.md");
      expect(group).toContain("out of date");
    }
  });
});
