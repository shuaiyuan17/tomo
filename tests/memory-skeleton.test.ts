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
    // The owner's line is a core fact like any other: dated (local date), with its source.
    expect(shared).toMatch(/^- \d{4}-\d{2}-\d{2} \[said\] Alex set up Tomo; call them Alex\.$/m);
    const d = new Date();
    expect(shared).toContain(`- ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} [said]`);
    expect(shared).not.toContain("](");
    // `## Don't keep` is there from the start (adding a heading later would rebuild a live session), at the top: a core cut at its hard limit loses its bottom, not this.
    expect(readFileSync(join(mem, "private", "MEMORY.md"), "utf8")).toBe("## Don't keep\n\n## Private\n");
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
