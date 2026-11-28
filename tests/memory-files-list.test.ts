import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectMemoryFiles,
  LIST_BUDGET_KB,
  LIST_FOLD_FILES,
  NO_TOPIC_FILES,
  renderMemoryFilesList,
  type MemoryFileEntry,
} from "../src/workspace/memory-index.js";
import { classifyPromptContextChange } from "../src/workspace/prompt-context-diff.js";

// The memory files list the prompt carries (§5.1 of the memory design):
// which files, how folders fold, where it is cut, and that it stays stable.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "tomo-files-list-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let mem: string;
beforeEach(() => {
  mem = join(ROOT, `m-${Math.random().toString(36).slice(2)}`);
  mkdirSync(mem, { recursive: true });
});
const put = (rel: string, text: string) => {
  mkdirSync(join(mem, rel, ".."), { recursive: true });
  writeFileSync(join(mem, rel), text);
};
const topic = (d: string) => `---\ndescription: ${d}\n---\nx\n`;
const list = (audience: "full" | "shared", groupLabel?: (dir: string) => string | undefined) =>
  renderMemoryFilesList(collectMemoryFiles({ memoryDir: mem, excludePrivate: audience === "shared", reportUnreadable: true }).entries, { audience, ...(groupLabel ? { groupLabel } : {}) });
const entry = (path: string, description?: string): MemoryFileEntry => ({ path, version: "v", bytes: 1, listed: true, ...(description ? { description } : {}) });
const files = (dir: string, n: number) => Array.from({ length: n }, (_, i) => entry(`${dir}/f${String(i).padStart(2, "0")}.md`, `File ${i}.`));

describe("what the list holds", () => {
  it("lists each topic file with its description, and marks one without", () => {
    put("travel.md", topic("Trips."));
    put("notes/old.md", "no frontmatter\n");
    expect(list("full")).toEqual([
      "- notes/old.md — ⚠ no description yet: add one next time you touch this file",
      "- travel.md — Trips.",
    ]);
  });

  it("leaves out the cores, journal/, archive/, people/ and attachments", () => {
    put("MEMORY.md", "# M\n");
    put("private/MEMORY.md", "# P\n");
    put("journal/2026-11-27.md", "x");
    put("private/journal/2026-11-27.md", "x");
    put("work/archive/old.md", topic("Old."));
    put("people/kevin.md", "---\nname: Kevin\n---\n");
    put("incoming-files/doc.md", "x");
    put("kept.md", topic("Kept."));
    expect(list("full")).toEqual(["- kept.md — Kept."]);
  });

  it("says so when there is nothing", () => {
    expect(list("full")).toEqual([NO_TOPIC_FILES]);
  });

  it("keeps a file it can't read as a line that says so, rather than dropping it", () => {
    put("locked.md", topic("Locked."));
    chmodSync(join(mem, "locked.md"), 0o000);
    try {
      expect(list("full")).toEqual(["- locked.md — ⚠ could not be read just now"]);
    } finally { chmodSync(join(mem, "locked.md"), 0o644); }
  });

  it("the shared list (a group chat may see it) has no private/ and no groups/; the full one has both", () => {
    put("shared.md", topic("Shared."));
    put("private/health.md", topic("Health."));
    put("groups/telegram_-100/plans.md", topic("Plans."));
    expect(list("shared")).toEqual(["- shared.md — Shared."]);
    expect(list("full")).toEqual([
      "- groups/telegram_-100/ — 1 file a group chat saved (its members' words)",
      "- private/health.md — Health.",
      "- shared.md — Shared.",
    ]);
  });

  it("each group's folder is one line in the full list, with the chat's name when known", () => {
    for (let i = 0; i < 3; i++) put(`groups/telegram_-100/n${i}.md`, topic("N."));
    put("groups/telegram_-200/n.md", topic("N."));
    const lines = list("full", (dir) => (dir === "groups/telegram_-100" ? 'Book "club"\nnight' : undefined));
    expect(lines).toEqual([
      "- groups/telegram_-100/ — \"Book club night\": 3 files a group chat saved (its members' words)",
      "- groups/telegram_-200/ — 1 file a group chat saved (its members' words)",
    ]);
  });
});

describe("folding", () => {
  it(`folds a folder with more than ${LIST_FOLD_FILES} files into one line with its README's description`, () => {
    const entries = [...files("work", LIST_FOLD_FILES + 1), entry("work/README.md", "Work projects.")];
    expect(renderMemoryFilesList(entries, { audience: "full" })).toEqual([`- work/ — ${LIST_FOLD_FILES + 2} files: Work projects.`]);
    expect(renderMemoryFilesList(files("work", LIST_FOLD_FILES + 1), { audience: "full" })).toEqual([`- work/ — ${LIST_FOLD_FILES + 1} files`]);
  });

  it(`lists a folder of ${LIST_FOLD_FILES} files file by file`, () => {
    expect(renderMemoryFilesList(files("work", LIST_FOLD_FILES), { audience: "full" })).toHaveLength(LIST_FOLD_FILES);
  });

  it("counts subfolders into their top folder, and folds under private/ the same way", () => {
    const entries = [...files("private/work/a", 7), ...files("private/work/b", 7)];
    expect(renderMemoryFilesList(entries, { audience: "full" })).toEqual(["- private/work/ — 14 files"]);
  });

  it("never folds the memory root or private/ itself", () => {
    const loose = [...Array.from({ length: 20 }, (_, i) => entry(`n${String(i).padStart(2, "0")}.md`, "N.")),
      ...Array.from({ length: 20 }, (_, i) => entry(`private/p${String(i).padStart(2, "0")}.md`, "P."))];
    expect(renderMemoryFilesList(loose, { audience: "full" })).toHaveLength(40);
  });
});

describe("the size cut", () => {
  it(`past ${LIST_BUDGET_KB} KB it is cut in path order, and the rest is counted with the folder they share`, () => {
    const long = "d".repeat(180);
    const entries = Array.from({ length: 60 }, (_, i) => entry(`private/n${String(i).padStart(2, "0")}.md`, long));
    const lines = renderMemoryFilesList(entries, { audience: "full" });
    expect(Buffer.byteLength(lines.join("\n"))).toBeLessThanOrEqual(LIST_BUDGET_KB * 1024);
    const shown = lines.length - 1;
    expect(lines[lines.length - 1]).toBe(`(${60 - shown} more files under private/ not listed: memory_list shows them)`);
    expect(lines[shown - 1]).toBe(`- private/n${String(shown - 1).padStart(2, "0")}.md — ${long}`);
  });

  it("an install with 600 files stays inside the budget", () => {
    const entries = [
      ...Array.from({ length: 40 }, (_, i) => entry(`loose-${String(i).padStart(3, "0")}.md`, i % 2 ? undefined : "A loose topic file with a description of ordinary length.")),
      ...["projects", "research", "notes", "health", "work"].flatMap((d) => files(d, 60)),
      ...files("private/journal-like", 120),
      ...Array.from({ length: 140 }, (_, i) => entry(`private/p-${String(i).padStart(3, "0")}.md`)),
    ];
    expect(entries.length).toBe(600);
    const t0 = performance.now();
    const lines = renderMemoryFilesList(entries, { audience: "full" });
    expect(performance.now() - t0).toBeLessThan(200);
    expect(Buffer.byteLength(lines.join("\n"))).toBeLessThanOrEqual(LIST_BUDGET_KB * 1024);
    expect(lines.at(-1)).toMatch(/^\(\d+ more files under private\/ not listed: memory_list shows them\)$/);
  });
});

describe("stability: what a live session is told", () => {
  const snap = (lines: string[]) => ({ memory: [], files: lines, people: [] });
  const render = (entries: MemoryFileEntry[]) => renderMemoryFilesList(entries, { audience: "full" });

  it("a new topic file is a one-line note, and it says which list changed", () => {
    const before = render([entry("a.md", "A."), entry("c.md", "C.")]);
    const after = render([entry("a.md", "A."), entry("b.md", "B."), entry("c.md", "C.")]);
    const change = classifyPromptContextChange(snap(before), snap(after));
    expect(change.kind).toBe("note");
    expect(change.kind === "note" && change.body).toContain("Memory files (+ added, - removed):\n+ - b.md — B.");
  });

  it("a folder folds once (12 → 13 retires), then each further file only changes its count line", () => {
    const at = (n: number) => render([entry("a.md", "A."), ...files("work", n), entry("z.md", "Z.")]);
    expect(classifyPromptContextChange(snap(at(12)), snap(at(13))).kind).toBe("retire");
    const next = classifyPromptContextChange(snap(at(13)), snap(at(14)));
    expect(next.kind).toBe("note");
    expect(next.kind === "note" && next.body).toContain("- - work/ — 13 files");
  });

  it("a private/MEMORY.md change is told under its own name", () => {
    const change = classifyPromptContextChange(
      { memory: [], privateMemory: ["## Private"], people: [] },
      { memory: [], privateMemory: ["## Private", "- a private fact"], people: [] },
    );
    expect(change.kind === "note" && change.body).toContain("private/MEMORY.md (+ added, - removed):\n+ - a private fact   (under \"## Private\")");
  });
});
