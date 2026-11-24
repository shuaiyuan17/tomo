import { describe, it, expect } from "vitest";
import { classifyPromptContextChange, MAX_NOTED_LINES, type PromptContextChange } from "../src/workspace/prompt-context-diff.js";

const body = (c: PromptContextChange) => {
  if (c.kind !== "note") throw new Error(`expected a note, got ${c.kind}`);
  return c.body;
};

describe("classifyPromptContextChange", () => {
  const base = { memory: ["## Life", "- [Travel](travel.md) — trips", "- [Work](work.md) — job"], people: ["- Alice"] };

  it("finds nothing when nothing changed (blank lines and trailing spaces do not count)", () => {
    expect(classifyPromptContextChange(base, { memory: [...base.memory, "", "  "], people: ["- Alice  "] }))
      .toEqual({ kind: "none" });
  });

  it("notes added and removed MEMORY.md lines", () => {
    const text = body(classifyPromptContextChange(base, {
      memory: ["## Life", "- [Travel](travel.md) — trips", "- [Coffee](coffee.md) — gear"],
      people: base.people,
    }));
    expect(text).toContain("+ - [Coffee](coffee.md) — gear");
    expect(text).toContain("- - [Work](work.md) — job");
    expect(text).not.toContain("Travel");
    expect(text).not.toContain("People registry");
  });

  it("notes roster changes on their own", () => {
    const text = body(classifyPromptContextChange(base, { memory: base.memory, people: ["- Alice", "- Bob aka: b"] }));
    expect(text).toContain("People registry");
    expect(text).toContain("+ - Bob aka: b");
    expect(text).not.toContain("MEMORY.md (");
  });

  it("a removal in the middle is not a reorder", () => {
    const text = body(classifyPromptContextChange(base, { memory: ["## Life", "- [Work](work.md) — job"], people: base.people }));
    expect(text).toContain("- - [Travel](travel.md) — trips");
  });

  it("retires on reordered lines (an entry moved under another heading) or a duplicated one", () => {
    const before = { memory: ["## Work", "- [A](a.md)", "## Home", "- [B](b.md)"], people: [] };
    expect(classifyPromptContextChange(before, { memory: ["## Work", "## Home", "- [A](a.md)", "- [B](b.md)"], people: [] }))
      .toEqual({ kind: "retire", reason: "reordered" });
    expect(classifyPromptContextChange(before, { memory: [...before.memory, "- [A](a.md)"], people: [] }))
      .toEqual({ kind: "retire", reason: "reordered" });
  });

  it("retires when a heading is added or removed", () => {
    expect(classifyPromptContextChange(base, { memory: ["## Life", "## Trips", ...base.memory.slice(1)], people: base.people }))
      .toEqual({ kind: "retire", reason: "heading" });
    expect(classifyPromptContextChange(base, { memory: base.memory.slice(1), people: base.people }))
      .toEqual({ kind: "retire", reason: "heading" });
  });

  it("notes up to MAX_NOTED_LINES changed lines across both sections, retires past that", () => {
    const added = (n: number) => Array.from({ length: n }, (_, i) => `- [N${i}](n${i}.md)`);
    const atLimit = { memory: [...base.memory, ...added(MAX_NOTED_LINES - 1)], people: [...base.people, "- Bob"] };
    expect(classifyPromptContextChange(base, atLimit).kind).toBe("note");
    const over = { memory: [...base.memory, ...added(MAX_NOTED_LINES)], people: [...base.people, "- Bob"] };
    expect(classifyPromptContextChange(base, over)).toEqual({ kind: "retire", reason: "too-many" });
  });
});
