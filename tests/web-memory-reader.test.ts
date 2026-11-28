import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryReader } from "../src/workspace/memory-reader.js";

/** The Study's Memory tab reads the workspace through MemoryReader (src/workspace/memory-reader.ts). */
let root: string;
let memory: MemoryReader;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-web-memory-")));
  mkdirSync(join(root, "memory", "topics"), { recursive: true });
  memory = new MemoryReader(root);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("memory reader", () => {
  it("lists an index, topic subdirectories and markdown files, and searches literally", async () => {
    writeFileSync(join(root, "memory", "MEMORY.md"), "# Index\n[Topic](topics/topic.md)");
    writeFileSync(join(root, "memory", "TODO-work.md"), "- [x] Done\n- [ ] Next [literal]");
    writeFileSync(join(root, "memory", "topics", "topic.md"), "A topic [literal]");
    writeFileSync(join(root, "memory", "topics", "TODO-nested.md"), "- [ ] Nested");
    expect((await memory.tree()).entries.map((e) => e.path)).toEqual(["MEMORY.md", "TODO-work.md", "topics", "topics/TODO-nested.md", "topics/topic.md"]);
    expect((await memory.search("[literal]")).results).toHaveLength(2);
    expect((await memory.file("MEMORY.md")).content).toContain("# Index");
  });

  it("does not search journal/ folders, at any depth, though it still lists and reads them", async () => {
    mkdirSync(join(root, "memory", "journal"), { recursive: true });
    mkdirSync(join(root, "memory", "topics", "Journal"), { recursive: true });
    writeFileSync(join(root, "memory", "journal", "2026-11-27.md"), "JOURNAL-NEEDLE top");
    writeFileSync(join(root, "memory", "topics", "Journal", "d.md"), "JOURNAL-NEEDLE nested");
    writeFileSync(join(root, "memory", "topics", "journal-notes.md"), "JOURNAL-NEEDLE in a topic file");
    const found = await memory.search("JOURNAL-NEEDLE");
    expect(found.results.map((r) => r.path)).toEqual(["topics/journal-notes.md"]);
    expect((await memory.tree()).entries.map((e) => e.path)).toContain("journal/2026-11-27.md");
    expect((await memory.file("journal/2026-11-27.md")).content).toContain("JOURNAL-NEEDLE");
  });

  it.each(["../outside.md", "/outside.md", "topics/../../outside.md", "topics\\outside.md", "topics/./topic.md", "note.txt"])("rejects an unsafe path %s", async (path) => {
    await expect(memory.file(path)).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("rejects file, directory and root symlinks, plus hard links", async () => {
    writeFileSync(join(root, "outside.md"), "outside content");
    symlinkSync(join(root, "outside.md"), join(root, "memory", "alias.md"));
    symlinkSync(root, join(root, "memory", "escape"));
    linkSync(join(root, "outside.md"), join(root, "memory", "hard.md"));
    await expect(memory.file("alias.md")).rejects.toThrow();
    await expect(memory.file("escape/outside.md")).rejects.toThrow();
    await expect(memory.file("hard.md")).rejects.toThrow();
    expect(JSON.stringify(await memory.search("outside content"))).not.toContain("outside content");
    rmSync(join(root, "memory"), { recursive: true }); symlinkSync(root, join(root, "memory"));
    await expect(memory.tree()).rejects.toThrow();
  });

  it("bounds reads and tells missing memory apart from an empty result", async () => {
    writeFileSync(join(root, "memory", "large.md"), "x".repeat(256 * 1024 + 1));
    await expect(memory.file("large.md")).rejects.toMatchObject({ code: "limit" });
    await expect(memory.file("missing.md")).rejects.toMatchObject({ code: "not_found" });
    rmSync(join(root, "memory"), { recursive: true });
    expect(await memory.tree()).toMatchObject({ missing: true });
  });

  describe("memory/private/ is never served", () => {
    beforeEach(() => {
      mkdirSync(join(root, "memory", "private", "people"), { recursive: true });
      writeFileSync(join(root, "memory", "private", "note.md"), "PRIVATE-NEEDLE owner-only note");
      writeFileSync(join(root, "memory", "private", "TODO.md"), "- [ ] PRIVATE-NEEDLE task");
      writeFileSync(join(root, "memory", "private", "people", "friend.md"), "PRIVATE-NEEDLE person");
      writeFileSync(join(root, "memory", "MEMORY.md"), "# Index\n- [Public](topics/topic.md)\n- [Secret](private/note.md) PRIVATE-NEEDLE\n- [Also](./private/people/friend.md)");
      writeFileSync(join(root, "memory", "topics", "topic.md"), "public topic");
    });

    it("is absent from the tree and search", async () => {
      const tree = await memory.tree();
      expect(tree.entries.map((e) => e.path)).toEqual(["MEMORY.md", "topics", "topics/topic.md"]);
      const found = await memory.search("PRIVATE-NEEDLE");
      expect(found.results).toEqual([]);
      expect(found.unreadable).toBe(0);
    });

    it.each(["private/note.md", "PRIVATE/note.md", "Private/people/friend.md", "private/TODO.md"])("reads %s as not found", async (path) => {
      await expect(memory.file(path)).rejects.toMatchObject({ code: "not_found" });
    });

    it("withholds index lines that link into private/", async () => {
      const index = await memory.file("MEMORY.md");
      expect(index.content).toBe("# Index\n- [Public](topics/topic.md)");
      expect(index.hiddenLines).toBe(2);
    });

    it("does not follow a public-looking symlink into private/", async () => {
      symlinkSync(join(root, "memory", "private"), join(root, "memory", "notes"));
      expect((await memory.tree()).entries.map((e) => e.path)).not.toContain("notes");
      await expect(memory.file("notes/note.md")).rejects.toThrow();
    });

    it("uses the agent's own private-memory fence, not a copy", async () => {
      // A case-insensitive volume would open memory/PRIVATE/ as private/; the
      // shared fence folds case, so the reader refuses it before opening.
      expect(memory.isPrivate("PRIVATE/x.md")).toBe(true);
      expect(memory.isPrivate("privateer.md")).toBe(false);
    });
  });
});
