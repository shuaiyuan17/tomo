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
});
