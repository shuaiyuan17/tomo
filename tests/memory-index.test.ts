import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectMemoryFiles, descriptionProblem, isListedMemoryPath, memoryVersion, parseDescription } from "../src/workspace/memory-index.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "tomo-test-memory-index-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("parseDescription", () => {
  it.each<[string, string | undefined]>([
    ["---\ndescription: Trips.\n---\nbody", "Trips."],
    ["---\nname: x\ndescription: \"Quoted\"\n---\n", "Quoted"],
    ["---\ndescription: >\n  folded\n  text\n---\n", "folded text"],
    ["---\ndescription:\n---\n", undefined],
    ["# no frontmatter\ndescription: not this", undefined],
    ["---\nname: x\n---\ndescription: after the frontmatter", undefined],
  ])("%j", (text, want) => {
    expect(parseDescription(text)).toBe(want);
  });

  it("counts characters, not bytes, against the 200 limit", () => {
    expect(descriptionProblem(`---\ndescription: ${"旅".repeat(200)}\n---\n`)).toBeNull();
    expect(descriptionProblem(`---\ndescription: ${"旅".repeat(201)}\n---\n`)).toBe("too-long");
  });
});

describe("isListedMemoryPath", () => {
  it.each<[string, boolean]>([
    ["travel.md", true],
    ["private/health.md", true],
    ["work/a/b.md", true],
    ["MEMORY.md", false],
    ["private/MEMORY.md", false],
    ["journal/2026-11-27.md", false],
    ["private/journal/x.md", false],
    ["work/Archive/old.md", false],
    ["people/k.md", false],
    ["private/people/k.md", false],
    ["incoming-files/doc.md", false],
  ])("%s → %s", (rel, want) => {
    expect(isListedMemoryPath(rel)).toBe(want);
  });
});

describe("collectMemoryFiles", () => {
  const mem = join(ROOT, "memory");
  const put = (rel: string, text: string) => { mkdirSync(join(mem, rel, ".."), { recursive: true }); writeFileSync(join(mem, rel), text); };
  put("b.md", "---\ndescription: B.\n---\n");
  put("a/z.md", "x");
  put("private/p.md", "---\ndescription: P.\n---\n");
  put("Private/q.md", "q"); // the same folder on a case-insensitive volume; another one elsewhere
  put("journal/j.md", "j");
  put("notes.txt", "not markdown");
  mkdirSync(join(ROOT, "elsewhere"), { recursive: true });
  writeFileSync(join(ROOT, "elsewhere", "e.md"), "e");
  symlinkSync(join(ROOT, "elsewhere"), join(mem, "linked"));

  it("is sorted by path, skips links and non-Markdown, and carries description and version", () => {
    const { entries } = collectMemoryFiles({ memoryDir: mem, excludePrivate: false });
    expect(entries.map((e) => e.path)).toEqual(expect.arrayContaining(["a/z.md", "b.md", "private/p.md"]));
    expect(entries.map((e) => e.path)).not.toContain("linked/e.md");
    expect(entries.map((e) => e.path)).not.toContain("journal/j.md");
    const paths = entries.map((e) => e.path);
    expect([...paths].sort()).toEqual(paths);
    const b = entries.find((e) => e.path === "b.md")!;
    expect(b).toMatchObject({ description: "B.", version: memoryVersion("---\ndescription: B.\n---\n"), listed: true });
  });

  it("leaves out private/ in any case for a group audience", () => {
    const { entries } = collectMemoryFiles({ memoryDir: mem, excludePrivate: true, includeUnlisted: true });
    expect(entries.some((e) => e.path.toLowerCase().startsWith("private/"))).toBe(false);
    expect(entries.map((e) => e.path)).toContain("journal/j.md");
  });

  it("narrows to a prefix", () => {
    const { entries } = collectMemoryFiles({ memoryDir: mem, excludePrivate: false, prefix: "a/" });
    expect(entries.map((e) => e.path)).toEqual(["a/z.md"]);
  });
});
