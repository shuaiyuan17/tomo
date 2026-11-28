import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeMemoryCores } from "../src/cli/memory-skeleton.js";

// `tomo init` starts a new install on the new layout: two cores, with their headings.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "tomo-skeleton-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("tomo init: the memory skeleton", () => {
  it("writes MEMORY.md and private/MEMORY.md with their headings, and no pointer files", () => {
    const mem = join(ROOT, "a");
    expect(writeMemoryCores(mem, { userName: "Alex", agentName: "Tomo" }, false)).toEqual(["MEMORY.md", "private/MEMORY.md"]);
    const shared = readFileSync(join(mem, "MEMORY.md"), "utf8");
    for (const h of ["## Owner", "## Rules", "## Preferences", "## Ongoing"]) expect(shared).toContain(`${h}\n`);
    expect(shared).toContain("Alex set up Tomo");
    expect(shared).not.toContain("](");
    expect(readFileSync(join(mem, "private", "MEMORY.md"), "utf8")).toBe("## Private\n");
  });

  it("without a personality, writes the bare headings", () => {
    const mem = join(ROOT, "b");
    writeMemoryCores(mem, null, false);
    expect(readFileSync(join(mem, "MEMORY.md"), "utf8")).toBe("## Owner\n\n## Rules\n\n## Preferences\n\n## Ongoing\n");
  });

  it("keeps an existing MEMORY.md unless told to replace it, and never replaces private/MEMORY.md", () => {
    const mem = join(ROOT, "c");
    mkdirSync(join(mem, "private"), { recursive: true });
    writeFileSync(join(mem, "MEMORY.md"), "mine\n");
    writeFileSync(join(mem, "private", "MEMORY.md"), "private mine\n");
    expect(writeMemoryCores(mem, null, false)).toEqual([]);
    expect(readFileSync(join(mem, "MEMORY.md"), "utf8")).toBe("mine\n");
    expect(writeMemoryCores(mem, null, true)).toEqual(["MEMORY.md"]);
    expect(readFileSync(join(mem, "private", "MEMORY.md"), "utf8")).toBe("private mine\n");
  });
});
