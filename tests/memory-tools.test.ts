import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "tomo-test-memory-tools-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const { buildMemoryTools, MEMORY_TOOL_NAMES } = await import("../src/mcp/memory-tools.js");
const { MemoryStore, SEARCH_MAX_RESULTS } = await import("../src/memory/store.js");
const { keptAt, keepOldVersion, sweepMemoryHistory } = await import("../src/memory/history.js");
const { memoryVersion, readMemoryFile, parseDescription } = await import("../src/workspace/memory-index.js");

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
interface ToolHandle { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> }

const OWNER = { privateBarred: false, canWrite: true, canWriteCore: true };
const GROUP = { privateBarred: true, canWrite: true, canWriteCore: false, groupDir: "groups/telegram_-100" };

let mem: string;
let hist: string;
let now: number;
beforeEach(() => {
  const dir = join(ROOT, `c-${Math.random().toString(36).slice(2)}`);
  mem = join(dir, "workspace", "memory");
  hist = join(dir, "data", "memory-history");
  mkdirSync(mem, { recursive: true });
  now = Date.UTC(2026, 10, 27, 12, 0, 0);
});

function tools(access = OWNER, readOnly = false) {
  const store = new MemoryStore({ memoryDir: mem, historyDir: hist, now: () => now });
  const list = buildMemoryTools({ store: () => store, access: () => access, readOnly }) as unknown as ToolHandle[];
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = list.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    const r = await t.handler(args, {});
    return { text: r.content[0].text, error: r.isError === true };
  };
  return { names: list.map((t) => t.name), call };
}

const topic = (desc: string, body = "- a fact\n") => `---\ndescription: ${desc}\n---\n${body}`;
const put = (rel: string, text: string) => {
  mkdirSync(join(mem, rel, ".."), { recursive: true });
  writeFileSync(join(mem, rel), text);
};
const get = (rel: string) => readFileSync(join(mem, rel), "utf8");
const v = (rel: string) => memoryVersion(readFileSync(join(mem, rel)));
/** Every kept version, as `<rel>/<file>` → content. */
function kept(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(join(dir, name.name), r);
      else out[r] = readFileSync(join(dir, name.name), "utf8");
    }
  };
  walk(hist, "");
  return out;
}

describe("memory tools: the set", () => {
  it("are eight, and a sub-session gets only the three reading ones", () => {
    expect(tools().names).toEqual([...MEMORY_TOOL_NAMES]);
    expect(MEMORY_TOOL_NAMES).toHaveLength(8);
    expect(tools(OWNER, true).names).toEqual(["memory_list", "memory_read", "memory_search"]);
  });
});

describe("memory_write", () => {
  it("creates with \"new\" and returns the version", async () => {
    const r = await tools().call("memory_write", { path: "travel.md", content: topic("Trips."), if_version: "new" });
    expect(r.error).toBe(false);
    expect(get("travel.md")).toBe(topic("Trips."));
    expect(r.text).toContain(`version ${v("travel.md")}`);
  });

  it("refuses \"new\" when the file exists, and names its version", async () => {
    put("travel.md", topic("Trips."));
    const r = await tools().call("memory_write", { path: "travel.md", content: topic("Other."), if_version: "new" });
    expect(r.error).toBe(true);
    expect(r.text).toContain("already exists");
    expect(r.text).toContain(v("travel.md"));
    expect(get("travel.md")).toBe(topic("Trips."));
  });

  it("refuses a stale version and gives only the new one", async () => {
    put("travel.md", topic("Trips."));
    const old = v("travel.md");
    put("travel.md", topic("Trips, edited elsewhere."));
    const r = await tools().call("memory_write", { path: "travel.md", content: topic("Mine."), if_version: old });
    expect(r.error).toBe(true);
    expect(r.text).toBe(`memory_write failed: travel.md changed since you read it (now version ${v("travel.md")}). Read it again with memory_read and retry.`);
    expect(get("travel.md")).toBe(topic("Trips, edited elsewhere."));
  });

  it("replaces with the current version, keeping the old content first", async () => {
    put("travel.md", topic("Trips.", "- old line\n"));
    const old = v("travel.md");
    const r = await tools().call("memory_write", { path: "travel.md", content: topic("Trips.", "- new line\n"), if_version: old });
    expect(r.error).toBe(false);
    expect(get("travel.md")).toContain("new line");
    const copies = kept();
    expect(Object.keys(copies)).toEqual([`travel.md/20261127T120000000Z-${old}.md`]);
    expect(Object.values(copies)[0]).toContain("old line");
  });

  it("refuses a version on a file that doesn't exist", async () => {
    const r = await tools().call("memory_write", { path: "nope.md", content: topic("x"), if_version: "abc" });
    expect(r.error).toBe(true);
    expect(r.text).toContain('if_version "new"');
  });

  it("requires a description of at most 200 characters on a listed file", async () => {
    const t = tools();
    const none = await t.call("memory_write", { path: "a.md", content: "# no frontmatter\n", if_version: "new" });
    expect(none.error).toBe(true);
    expect(none.text).toContain("needs frontmatter with a description: line");
    const long = await t.call("memory_write", { path: "a.md", content: topic("x".repeat(201)), if_version: "new" });
    expect(long.error).toBe(true);
    expect((await t.call("memory_write", { path: "a.md", content: topic("x".repeat(200)), if_version: "new" })).error).toBe(false);
    // Unlisted places need none: a journal, an archive, the core.
    expect((await t.call("memory_write", { path: "journal/2026-11-27.md", content: "# J\n", if_version: "new" })).error).toBe(false);
    expect((await t.call("memory_write", { path: "archive/old.md", content: "old\n", if_version: "new" })).error).toBe(false);
    expect((await t.call("memory_write", { path: "MEMORY.md", content: "# Memory\n", if_version: "new" })).error).toBe(false);
  });

  it("refuses paths outside memory/, links, people and non-Markdown", async () => {
    const t = tools();
    mkdirSync(join(mem, "..", "outside"), { recursive: true });
    symlinkSync(join(mem, "..", "outside"), join(mem, "linked"));
    writeFileSync(join(mem, "..", "outside", "t.md"), topic("x"));
    symlinkSync(join(mem, "..", "outside", "t.md"), join(mem, "file-link.md"));
    const cases: Array<[string, string]> = [
      ["../escape.md", "not a path inside memory/"],
      ["a/../../escape.md", "not a path inside memory/"],
      [join(mem, "abs.md"), "not a path inside memory/"],
      ["~/x.md", "not a path inside memory/"],
      ["memory/x.md", "Paths are relative to memory/"],
      ["linked/t.md", "is a link or not a folder"],
      ["file-link.md", "is a link"],
      ["people/kevin.md", "upsert_person"],
      ["private/people/kevin.md", "upsert_person"],
      ["Private/People/kevin.md", "upsert_person"],
      ["notes.txt", "ends in .md"],
      [".hidden.md", "hidden from memory_list"],
      [".secret/x.md", "hidden from memory_list"],
    ];
    for (const [path, msg] of cases) {
      const r = await t.call("memory_write", { path, content: topic("x"), if_version: "new" });
      expect(r.error, path).toBe(true);
      expect(r.text, path).toContain(msg);
      const read = await t.call("memory_read", { path });
      expect(read.error, `read ${path}`).toBe(true);
    }
    expect(readFileSync(join(mem, "..", "outside", "t.md"), "utf8")).toBe(topic("x"));
  });

  it("refuses a hard-linked file", async () => {
    put("a.md", topic("a"));
    linkSync(join(mem, "a.md"), join(mem, "b.md"));
    const r = await tools().call("memory_read", { path: "b.md" });
    expect(r.error).toBe(true);
    expect(r.text).toContain("hard link");
  });

  it("refuses to grow a file past its hard limit, lets it shrink, and reminds over the core's soft budget", async () => {
    const t = tools();
    const big = topic("Big.", `${"x".repeat(70 * 1024)}\n- drop me\n`);
    put("big.md", big);
    const grow = await t.call("memory_str_replace", { path: "big.md", old: "Big.", new: "Bigger." });
    expect(grow.error).toBe(true);
    expect(grow.text).toContain("over its 64 KB limit");
    const shrink = await t.call("memory_str_replace", { path: "big.md", old: "- drop me\n", new: "" });
    expect(shrink.error).toBe(false);

    const core = Array.from({ length: 399 }, (_, i) => `- line ${i}`).join("\n");
    put("MEMORY.md", `${core}\n`);
    const over = await t.call("memory_append", { path: "MEMORY.md", content: "- one\n- two" });
    expect(over.error).toBe(true);
    expect(over.text).toContain("would be 401 lines, over its 400-line limit");
    const soft = await t.call("memory_append", { path: "MEMORY.md", content: "- one" });
    expect(soft.error).toBe(false);
    expect(soft.text).toContain("over its 200-line / 16 KB budget");
    // Shortening a core that is over the hard limit is always allowed.
    put("MEMORY.md", `${Array.from({ length: 450 }, (_, i) => `- line ${i}`).join("\n")}\n`);
    expect((await t.call("memory_str_replace", { path: "MEMORY.md", old: "- line 449\n", new: "" })).error).toBe(false);
  });
});

describe("memory_str_replace", () => {
  it("needs `old` exactly once", async () => {
    put("a.md", topic("a", "- x\n- x\n- y\n"));
    const t = tools();
    expect((await t.call("memory_str_replace", { path: "a.md", old: "- z", new: "q" })).text).toContain("does not appear");
    expect((await t.call("memory_str_replace", { path: "a.md", old: "- x", new: "q" })).text).toContain("more than once");
    expect((await t.call("memory_str_replace", { path: "a.md", old: "- y", new: "- why" })).error).toBe(false);
    expect(get("a.md")).toContain("- why");
  });

  it("counts an overlapping second occurrence", async () => {
    put("a.md", topic("a", "aaa\n"));
    expect((await tools().call("memory_str_replace", { path: "a.md", old: "aa", new: "b" })).text).toContain("more than once");
  });

  it("can't remove the description, or make it too long", async () => {
    put("a.md", topic("Keep me."));
    const t = tools();
    expect((await t.call("memory_str_replace", { path: "a.md", old: "description: Keep me.\n", new: "" })).text).toContain("needs frontmatter");
    expect((await t.call("memory_str_replace", { path: "a.md", old: "Keep me.", new: "y".repeat(201) })).error).toBe(true);
    expect(get("a.md")).toBe(topic("Keep me."));
  });

  it("keeps the old content when it shortens the file, not when it grows it", async () => {
    put("a.md", topic("a", "- long line here\n"));
    const t = tools();
    await t.call("memory_str_replace", { path: "a.md", old: "- long line here", new: "- longer line here, now" });
    expect(Object.keys(kept())).toEqual([]);
    const before = v("a.md");
    now += 1000;
    await t.call("memory_str_replace", { path: "a.md", old: "- longer line here, now", new: "- short" });
    const copies = kept();
    expect(Object.keys(copies)).toEqual([`a.md/20261127T120001000Z-${before}.md`]);
    expect(Object.values(copies)[0]).toContain("longer line here, now");
  });
});

describe("memory_append", () => {
  it("adds on a new line", async () => {
    put("a.md", topic("a", "- one"));
    await tools().call("memory_append", { path: "a.md", content: "- two" });
    expect(get("a.md")).toBe(topic("a", "- one\n- two\n"));
  });

  it("creates only under a journal/ folder", async () => {
    const t = tools();
    const outside = await t.call("memory_append", { path: "notes.md", content: "x", create: true });
    expect(outside.text).toBe("memory_append failed: Create notes.md with memory_write, with a description in its frontmatter.");
    expect(existsSync(join(mem, "notes.md"))).toBe(false);
    const missing = await t.call("memory_append", { path: "notes.md", content: "x" });
    expect(missing.error).toBe(true);
    const journal = await t.call("memory_append", { path: "private/journal/2026-11-27.md", content: "### 10:00\nok", create: true });
    expect(journal.error).toBe(false);
    expect(get("private/journal/2026-11-27.md")).toBe("### 10:00\nok\n");
    expect(Object.keys(kept())).toEqual([]);
  });
});

describe("memory_move", () => {
  it("moves, and refuses an existing destination", async () => {
    put("a.md", topic("a"));
    put("b.md", topic("b"));
    const t = tools();
    const clash = await t.call("memory_move", { from: "a.md", to: "b.md" });
    expect(clash.text).toBe("memory_move failed: b.md already exists. Pick another name, or merge the two with memory_read and memory_write.");
    expect((await t.call("memory_move", { from: "a.md", to: "archive/a.md" })).error).toBe(false);
    expect(existsSync(join(mem, "a.md"))).toBe(false);
    expect(get("archive/a.md")).toBe(topic("a"));
    expect(Object.keys(kept())).toEqual([]);
  });

  it("can't move a core or people, and needs a description out of journal/", async () => {
    put("MEMORY.md", "# M\n");
    put("journal/day.md", "no frontmatter\n");
    const t = tools();
    expect((await t.call("memory_move", { from: "MEMORY.md", to: "old.md" })).text).toContain("can't be moved");
    expect((await t.call("memory_move", { from: "journal/day.md", to: "private/MEMORY.md" })).text).toContain("can't be moved");
    expect((await t.call("memory_move", { from: "journal/day.md", to: "people/x.md" })).text).toContain("upsert_person");
    expect((await t.call("memory_move", { from: "journal/day.md", to: "day.md" })).text).toContain("needs frontmatter");
    expect((await t.call("memory_move", { from: "journal/day.md", to: "archive/day.md" })).error).toBe(false);
  });
});

describe("memory_delete", () => {
  it("needs the current version, and keeps the content first", async () => {
    put("a.md", topic("a", "- secret-ish\n"));
    const t = tools();
    expect((await t.call("memory_delete", { path: "a.md", if_version: "000000000000" })).text).toContain("changed since you read it");
    expect(existsSync(join(mem, "a.md"))).toBe(true);
    const version = v("a.md");
    const r = await t.call("memory_delete", { path: "a.md", if_version: version });
    expect(r.error).toBe(false);
    expect(r.text).toContain("kept for 30 days");
    expect(existsSync(join(mem, "a.md"))).toBe(false);
    expect(kept()[`a.md/20261127T120000000Z-${version}.md`]).toContain("secret-ish");
  });

  it("can't delete a core", async () => {
    put("MEMORY.md", "# M\n");
    expect((await tools().call("memory_delete", { path: "MEMORY.md", if_version: v("MEMORY.md") })).error).toBe(true);
    expect(existsSync(join(mem, "MEMORY.md"))).toBe(true);
  });
});

describe("old versions: a copy that fails refuses the write", () => {
  it.skipIf(process.getuid?.() === 0)("leaves the file as it was when the history folder is unwritable", async () => {
    put("a.md", topic("a", "- original\n"));
    mkdirSync(hist, { recursive: true });
    chmodSync(hist, 0o500);
    try {
      const t = tools();
      const write = await t.call("memory_write", { path: "a.md", content: topic("a", "- replaced\n"), if_version: v("a.md") });
      expect(write.error).toBe(true);
      expect(write.text).toMatch(/^memory_write failed: a\.md was not changed: its current content could not be kept first \(E[A-Z]+\)\.$/);
      const del = await t.call("memory_delete", { path: "a.md", if_version: v("a.md") });
      expect(del.error).toBe(true);
      const shrink = await t.call("memory_str_replace", { path: "a.md", old: "- original", new: "" });
      expect(shrink.error).toBe(true);
      expect(get("a.md")).toBe(topic("a", "- original\n"));
      // Writes that lose nothing don't need a copy.
      expect((await t.call("memory_append", { path: "a.md", content: "- more" })).error).toBe(false);
    } finally {
      chmodSync(hist, 0o700);
    }
  });

  it("refuses when the history path is blocked by a file", async () => {
    put("a.md", topic("a"));
    mkdirSync(join(hist, ".."), { recursive: true });
    writeFileSync(hist, "not a folder");
    const r = await tools().call("memory_delete", { path: "a.md", if_version: v("a.md") });
    expect(r.error).toBe(true);
    expect(r.text).toContain("could not be kept first");
    expect(existsSync(join(mem, "a.md"))).toBe(true);
  });
});

describe("old versions: the 30-day sweep", () => {
  it("removes versions older than 30 days and the folders left empty", () => {
    const t0 = Date.UTC(2026, 9, 1);
    keepOldVersion(hist, "a.md", Buffer.from("old"), "aaaaaaaaaaaa", t0);
    keepOldVersion(hist, "private/b.md", Buffer.from("old"), "bbbbbbbbbbbb", t0);
    const fresh = keepOldVersion(hist, "a.md", Buffer.from("new"), "cccccccccccc", t0 + 25 * 86_400_000);
    expect(keptAt(fresh.split("/").pop()!)).toBe(t0 + 25 * 86_400_000);
    const removed = sweepMemoryHistory(hist, t0 + 31 * 86_400_000);
    expect(removed).toBe(2);
    expect(Object.keys(kept())).toEqual([`a.md/${fresh.split("/").pop()}`]);
    expect(existsSync(join(hist, "private"))).toBe(false);
  });

  it("falls back to the mtime for a name it did not write", () => {
    mkdirSync(join(hist, "x.md"), { recursive: true });
    writeFileSync(join(hist, "x.md", "copied-by-hand.md"), "x");
    const old = new Date(Date.UTC(2026, 0, 1));
    utimesSync(join(hist, "x.md", "copied-by-hand.md"), old, old);
    expect(sweepMemoryHistory(hist, Date.UTC(2026, 10, 27))).toBe(1);
  });

  it("is fine with no history folder", () => {
    expect(sweepMemoryHistory(join(hist, "missing"), Date.now())).toBe(0);
  });
});

describe("memory_read", () => {
  it("returns content and version, and reads a range", async () => {
    put("a.md", "l1\nl2\nl3\nl4\n");
    const t = tools();
    const all = await t.call("memory_read", { path: "a.md" });
    expect(all.text).toBe(`a.md (version ${v("a.md")}, 5 lines)\n\nl1\nl2\nl3\nl4\n`);
    const part = await t.call("memory_read", { path: "a.md", offset: 2, limit: 2 });
    expect(part.text).toBe(`a.md (version ${v("a.md")}), lines 2–3 of 5; continue with offset 4\n\nl2\nl3`);
    expect((await t.call("memory_read", { path: "missing.md" })).text).toContain("doesn't exist");
  });
});

describe("memory_search", () => {
  it("is literal and case-insensitive, with path and line", async () => {
    put("MEMORY.md", "# M\n- Aisle seats\n");
    put("travel.md", topic("t", "- no red-eye\n- AISLE please\n"));
    const r = await tools().call("memory_search", { query: "aisle" });
    expect(r.text.split("\n")).toEqual(["MEMORY.md:2: - Aisle seats", "travel.md:5: - AISLE please"]);
  });

  it(`stops at ${SEARCH_MAX_RESULTS} matches`, async () => {
    put("many.md", topic("m", Array.from({ length: 80 }, () => "- hit").join("\n")));
    const lines = (await tools().call("memory_search", { query: "hit" })).text.split("\n");
    expect(lines.filter((l) => l.startsWith("many.md:"))).toHaveLength(SEARCH_MAX_RESULTS);
    expect(lines.at(-1)).toContain("stopped at");
  });

  it("does not search people or attachments", async () => {
    put("people/kevin.md", "needle\n");
    put("incoming-files/doc.md", "needle\n");
    expect((await tools().call("memory_search", { query: "needle" })).text).toBe('No match for "needle".');
  });
});

describe("memory_list", () => {
  it("lists topic files with description and version, by path", async () => {
    put("b.md", topic("Bee."));
    put("a.md", "# no description\n");
    put("MEMORY.md", "# M\n");
    put("journal/d.md", "x\n");
    put("archive/old.md", topic("Old."));
    put("people/k.md", topic("K."));
    put("incoming-files/f.md", topic("F."));
    const t = tools();
    const r = await t.call("memory_list", {});
    expect(r.text.split("\n")).toEqual([
      `- a.md — ⚠ no description yet: add one next time you touch this file (version ${v("a.md")})`,
      `- b.md — Bee. (version ${v("b.md")})`,
      "(2 more under journal/ and archive/ folders: pass their folder as prefix)",
    ]);
    const j = await t.call("memory_list", { prefix: "journal/" });
    expect(j.text).toBe(`- journal/d.md — ⚠ no description yet: add one next time you touch this file (version ${v("journal/d.md")})`);
  });
});

describe("audience: a group turn", () => {
  beforeEach(() => {
    put("MEMORY.md", "# M\n- [Health](private/health.md) — private pointer\n- shared line\n");
    put("private/health.md", topic("Health.", "- needle private\n"));
    put("shared.md", topic("Shared.", "- needle shared\n"));
  });

  it("can't read, write, list or search private/", async () => {
    const t = tools(GROUP);
    for (const path of ["private/health.md", "PRIVATE/health.md", "private/new.md"]) {
      const read = await t.call("memory_read", { path });
      expect(read.error, path).toBe(true);
      expect(read.text, path).toContain("not available on this turn");
      expect((await t.call("memory_write", { path, content: topic("x"), if_version: "new" })).error, path).toBe(true);
    }
    expect((await t.call("memory_append", { path: "private/journal/d.md", content: "x", create: true })).error).toBe(true);
    expect((await t.call("memory_move", { from: "shared.md", to: "private/shared.md" })).error).toBe(true);
    expect((await t.call("memory_list", { prefix: "private/" })).error).toBe(true);
    expect((await t.call("memory_list", {})).text).not.toContain("private/");
    const s = await t.call("memory_search", { query: "needle" });
    expect(s.text).toBe("shared.md:4: - needle shared");
    expect(existsSync(join(mem, "private", "new.md"))).toBe(false);
  });

  it("can't reach private/ through a link either", async () => {
    symlinkSync(join(mem, "private"), join(mem, "innocent"));
    const r = await tools(GROUP).call("memory_read", { path: "innocent/health.md" });
    expect(r.error).toBe(true);
  });

  it("can't change MEMORY.md, and reads it without the private pointers", async () => {
    const t = tools(GROUP);
    expect((await t.call("memory_append", { path: "MEMORY.md", content: "- from the group" })).text).toContain("owner's own conversation");
    expect((await t.call("memory_str_replace", { path: "MEMORY.md", old: "- shared line", new: "- x" })).error).toBe(true);
    expect(get("MEMORY.md")).not.toContain("from the group");
    const read = await t.call("memory_read", { path: "MEMORY.md" });
    expect(read.text).not.toContain("private pointer");
    expect(read.text).toContain("1 lines that point into private/ are not shown");
    expect((await t.call("memory_search", { query: "private pointer" })).text).toBe('No match for "private pointer".');
  });

  it("writes in its own group folder, not a shared topic file", async () => {
    expect((await tools(GROUP).call("memory_write", { path: "groups-note.md", content: topic("From a group."), if_version: "new" })).error).toBe(true);
    expect((await tools(GROUP).call("memory_write", { path: "groups/telegram_-100/note.md", content: topic("From a group."), if_version: "new" })).error).toBe(false);
  });

  it("the owner reaches all of it", async () => {
    const t = tools(OWNER);
    expect((await t.call("memory_read", { path: "private/health.md" })).error).toBe(false);
    expect((await t.call("memory_search", { query: "needle" })).text).toContain("private/health.md");
  });
});

describe("audience: a sub-session", () => {
  it("has no writing tools, and a group-scoped one doesn't see private/", async () => {
    put("private/p.md", topic("P."));
    const scoped = tools({ privateBarred: true, canWrite: false, canWriteCore: false }, true);
    expect(scoped.names).not.toContain("memory_write");
    expect((await scoped.call("memory_read", { path: "private/p.md" })).error).toBe(true);
    const owners = tools({ privateBarred: false, canWrite: false, canWriteCore: false }, true);
    expect((await owners.call("memory_read", { path: "private/p.md" })).error).toBe(false);
  });

  it("is refused by the store when it calls a write anyway", () => {
    const store = new MemoryStore({ memoryDir: mem, historyDir: hist });
    expect(() => store.writeFile({ privateBarred: false, canWrite: false, canWriteCore: false }, "a.md", topic("a"), "new")).toThrow(/read-only/);
  });
});

describe("history lives outside memory/", () => {
  it("is not searched or listed", async () => {
    put("a.md", topic("a", "- needle\n"));
    await tools().call("memory_delete", { path: "a.md", if_version: v("a.md") });
    expect(Object.keys(kept())).toHaveLength(1);
    const t = tools();
    expect((await t.call("memory_search", { query: "needle" })).text).toBe('No match for "needle".');
    expect((await t.call("memory_list", {})).text).toBe("(no topic files yet)");
  });
});

describe("review fixes", () => {
  it("an unclosed frontmatter block has no description", async () => {
    expect(parseDescription("---\ndescription: Trips\nbody\n")).toBeUndefined();
    expect((await tools().call("memory_write", { path: "a.md", content: "---\ndescription: Trips\nbody\n", if_version: "new" })).error).toBe(true);
  });

  it("a partial copy left under the same name is not taken for a kept version", () => {
    const content = Buffer.from("the whole old file");
    const first = keepOldVersion(hist, "a.md", Buffer.from("the who"), "aaaaaaaaaaaa", now);
    const second = keepOldVersion(hist, "a.md", content, "aaaaaaaaaaaa", now);
    expect(second).not.toBe(first);
    expect(readFileSync(second)).toEqual(content);
    // The same bytes again count as kept.
    expect(keepOldVersion(hist, "a.md", content, "aaaaaaaaaaaa", now)).toBe(second);
  });

  it("keeps the old bytes before rewriting a file that isn't valid UTF-8", async () => {
    mkdirSync(mem, { recursive: true });
    const bytes = Buffer.concat([Buffer.from("---\ndescription: d\n---\n- caf"), Buffer.from([0xe9]), Buffer.from("\n")]);
    writeFileSync(join(mem, "latin1.md"), bytes);
    const r = await tools().call("memory_append", { path: "latin1.md", content: "- more" });
    expect(r.error).toBe(false);
    const copies = Object.keys(kept());
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(hist, copies[0]))).toEqual(bytes);
  });

  it("refuses to read through a folder that leads into private/ on a barred turn, checked after opening", () => {
    put("private/health.md", topic("H.", "- secret\n"));
    symlinkSync(join(mem, "private"), join(mem, "innocent"));
    // Opened by name (the last part is no link), then found to be private by its real path.
    expect(readMemoryFile(join(mem, "innocent", "health.md"), mem, true)).toEqual({ refused: "private" });
    expect(readMemoryFile(join(mem, "innocent", "health.md"), mem, false)).toMatchObject({ bytes: expect.any(Buffer) });
    mkdirSync(join(mem, "..", "elsewhere"), { recursive: true });
    writeFileSync(join(mem, "..", "elsewhere", "x.md"), "x");
    symlinkSync(join(mem, "..", "elsewhere"), join(mem, "out"));
    expect(readMemoryFile(join(mem, "out", "x.md"), mem, false)).toEqual({ refused: "outside" });
  });
});

describe("the share reminder (§8.2): a new file outside private/, or new lines in MEMORY.md", () => {
  const SHARED_FILE = "is shared: group chats can read it. If this is private (see Layout), move it under private/.";
  const SHARED_CORE = "MEMORY.md is shared: group chats have it in every prompt. If what you added is private (see Layout), put it in private/MEMORY.md instead.";

  it("is said when the owner creates a shared file, and not for a private one", async () => {
    const t = tools(OWNER);
    expect((await t.call("memory_write", { path: "travel.md", content: topic("Trips."), if_version: "new" })).text).toContain(`travel.md ${SHARED_FILE}`);
    expect((await t.call("memory_append", { path: "journal/d.md", content: "x", create: true })).text).toContain(SHARED_FILE);
    expect((await t.call("memory_write", { path: "private/health.md", content: topic("Health."), if_version: "new" })).text).not.toContain("is shared");
    expect((await t.call("memory_append", { path: "private/journal/d.md", content: "x", create: true })).text).not.toContain("is shared");
  });

  it("is not said for a change to an existing shared topic file", async () => {
    put("travel.md", topic("Trips."));
    const t = tools(OWNER);
    expect((await t.call("memory_str_replace", { path: "travel.md", old: "- a fact", new: "- another fact" })).text).not.toContain("is shared");
    expect((await t.call("memory_append", { path: "travel.md", content: "- more" })).text).not.toContain("is shared");
    expect((await t.call("memory_write", { path: "travel.md", content: topic("Trips!"), if_version: v("travel.md") })).text).not.toContain("is shared");
  });

  it("is said when lines are added to MEMORY.md, not when one is only removed, nor for private/MEMORY.md", async () => {
    put("MEMORY.md", "## Owner\n- one\n- two\n");
    put("private/MEMORY.md", "## Private\n");
    const t = tools(OWNER);
    expect((await t.call("memory_append", { path: "MEMORY.md", content: "- three" })).text).toContain(SHARED_CORE);
    expect((await t.call("memory_str_replace", { path: "MEMORY.md", old: "- two\n", new: "" })).text).not.toContain("is shared");
    expect((await t.call("memory_str_replace", { path: "MEMORY.md", old: "- one", new: "- one, corrected" })).text).toContain(SHARED_CORE);
    expect((await t.call("memory_append", { path: "private/MEMORY.md", content: "- secret" })).text).not.toContain("is shared");
    // A line copied under a second heading is a line added.
    expect((await t.call("memory_append", { path: "MEMORY.md", content: "## Elsewhere\n- three" })).text).toContain(SHARED_CORE);
  });

  it("is said when a file moves out of private/ into a shared place", async () => {
    put("private/p.md", topic("P."));
    put("private/q.md", topic("Q."));
    const t = tools(OWNER);
    expect((await t.call("memory_move", { from: "private/p.md", to: "p.md" })).text).toContain(`p.md ${SHARED_FILE}`);
    expect((await t.call("memory_move", { from: "private/q.md", to: "private/archive/q.md" })).text).not.toContain("is shared");
  });

  it("is never said on a group's turn, which writes in its own folder", async () => {
    const r = await tools(GROUP).call("memory_write", { path: "groups/telegram_-100/n.md", content: topic("N."), if_version: "new" });
    expect(r.error).toBe(false);
    expect(r.text).not.toContain("is shared");
  });
});

describe("the provenance reminder (§6.1): a fact line added to a core without its source", () => {
  const NO_SOURCE = "no source: write each fact as `- YYYY-MM-DD [said|inferred|from:<source>] <fact>` (see Provenance).";

  it("is said for an added core line without the prefix, and counts them", async () => {
    put("MEMORY.md", "## Rules\n");
    put("private/MEMORY.md", "## Private\n");
    const t = tools(OWNER);
    expect((await t.call("memory_append", { path: "MEMORY.md", content: "- No calls before 9." })).text).toContain(`A new line in MEMORY.md has ${NO_SOURCE}`);
    expect((await t.call("memory_append", { path: "private/MEMORY.md", content: "- one\n- two" })).text).toContain(`2 new lines in private/MEMORY.md have ${NO_SOURCE}`);
    const r = await t.call("memory_str_replace", { path: "MEMORY.md", old: "- No calls before 9.", new: "- 2026-11-24 No calls before 9." });
    expect(r.error).toBe(false);
    expect(r.text).toContain(NO_SOURCE);
  });

  it("is not said for prefixed lines, headings, removals, or topic files; and never refuses", async () => {
    put("MEMORY.md", "## Rules\n- old line\n");
    put("travel.md", topic("Trips."));
    const t = tools(OWNER);
    for (const line of ["- 2026-11-24 [said] No calls before 9.", "- 2026-11-24 [inferred] Up by 8.", "* 2026-11-24 [from:group] Meets Fridays.", "- 2026-11-24 [from:email] Trip booked.", "## Ongoing"]) {
      const r = await t.call("memory_append", { path: "MEMORY.md", content: line });
      expect(r.error, line).toBe(false);
      expect(r.text, line).not.toContain("no source");
    }
    expect((await t.call("memory_str_replace", { path: "MEMORY.md", old: "- old line\n", new: "" })).text).not.toContain("no source");
    // A subject under Don't keep, added without reading the file (the shared variant's way), is not a fact.
    put("private/MEMORY.md", "## Don't keep\n\n## Private\n- 2026-11-01 [said] x\n");
    const dk = await t.call("memory_str_replace", { path: "private/MEMORY.md", old: "## Don't keep\n", new: "## Don't keep\n- a medical matter\n" });
    expect(dk.error).toBe(false);
    expect(dk.text).not.toContain("no source");
    expect((await t.call("memory_append", { path: "travel.md", content: "- unprefixed in a topic file" })).text).not.toContain("no source");
    for (const bad of ["- 2026-11-24 [said]", "- 2026-11-24 [from:] x", "- [said] 2026-11-24 x"]) {
      const r = await t.call("memory_append", { path: "MEMORY.md", content: bad });
      expect(r.error, bad).toBe(false);
      expect(r.text, bad).toContain("no source");
    }
  });
});
