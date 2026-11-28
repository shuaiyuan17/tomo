/**
 * The weekly `said` check's list (§6.3 of the memory design): the harness, not
 * the model, picks which lines get checked against the conversation.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSaidLines, coreStatusLine, SAID_CHECK_MAX_LINES } from "../src/memory/said-check.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "said-check-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}
const topic = (lines: string[]) => ["---", "description: a topic", "---", ...lines, ""].join("\n");

// 2026-W48 is Mon 2026-11-23 .. Sun 2026-11-29.
const WEEK = "2026-W48";

describe("collectSaidLines", () => {
  it("lists only per-line `[said]` lines dated in that ISO week", () => {
    put("MEMORY.md", [
      "## Rules",
      "- 2026-11-24 [said] No calls before 9.",
      "- 2026-11-24 [inferred] Usually up by 8.",
      "- 2026-11-24 [from:group] The group meets Fridays.",
      "- 2026-11-16 [said] Last week's rule.",
      "- 2026-11-30 [said] Next week's rule.",
      "- Undated: [said] in the middle doesn't count.",
      "",
    ].join("\n"));
    const { lines, more } = collectSaidLines(dir, WEEK);
    expect(lines).toEqual([{ path: "MEMORY.md", line: 2, text: "- 2026-11-24 [said] No calls before 9." }]);
    expect(more).toBe(0);
  });

  it("goes by the local date: a Sunday line belongs to the week that Sunday ends, a Monday line to the next", () => {
    put("MEMORY.md", ["- 2026-11-22 [said] Sunday of W47.", "- 2026-11-23 [said] Monday of W48.", "- 2026-11-29 [said] Sunday of W48."].join("\n"));
    expect(collectSaidLines(dir, "2026-W47").lines.map((l) => l.text)).toEqual(["- 2026-11-22 [said] Sunday of W47."]);
    expect(collectSaidLines(dir, WEEK).lines.map((l) => l.text)).toEqual(["- 2026-11-23 [said] Monday of W48.", "- 2026-11-29 [said] Sunday of W48."]);
  });

  it("puts the two cores before topic files, then topic files by path", () => {
    put("a-topic.md", topic(["- 2026-11-25 [said] From a topic."]));
    put("private/MEMORY.md", "- 2026-11-25 [said] From the private core.\n");
    put("MEMORY.md", "- 2026-11-25 [said] From the shared core.\n");
    put("private/health.md", topic(["- 2026-11-25 [said] From a private topic."]));
    expect(collectSaidLines(dir, WEEK).lines.map((l) => l.path)).toEqual(["MEMORY.md", "private/MEMORY.md", "a-topic.md", "private/health.md"]);
  });

  it("leaves out journal/, archive/, groups/, the people registry and a date that isn't one", () => {
    const line = "- 2026-11-25 [said] Should not be listed.";
    put("private/journal/2026-11-25.md", `${line}\n`);
    put("journal/2026-11-25.md", `${line}\n`);
    put("archive/old.md", topic([line]));
    put("work/archive/old.md", topic([line]));
    put("groups/telegram_-100123/notes.md", topic([line]));
    put("people/alex.md", topic([line]));
    put("private/people/sam.md", topic([line]));
    put("MEMORY.md", "- 2026-11-31 [said] Not a date.\n");
    expect(collectSaidLines(dir, WEEK).lines).toEqual([]);
  });

  it(`lists at most ${SAID_CHECK_MAX_LINES} lines and counts the rest`, () => {
    const many = Array.from({ length: SAID_CHECK_MAX_LINES + 3 }, (_, i) => `- 2026-11-26 [said] Rule ${i + 1}.`);
    put("MEMORY.md", many.join("\n"));
    const { lines, more } = collectSaidLines(dir, WEEK);
    expect(lines).toHaveLength(SAID_CHECK_MAX_LINES);
    expect(lines[0].text).toBe("- 2026-11-26 [said] Rule 1.");
    expect(more).toBe(3);
  });

  it("skips a line an earlier check already marked as having no source", () => {
    put("MEMORY.md", "- 2026-11-26 [said] Rule (no source found, checked 2026-11-30).\n- 2026-11-26 [said] Rule two.\n");
    expect(collectSaidLines(dir, WEEK).lines.map((l) => l.line)).toEqual([2]);
  });

  it("cuts a very long line, so the nudge stays small", () => {
    put("MEMORY.md", `- 2026-11-26 [said] ${"x".repeat(1000)}\n`);
    const [l] = collectSaidLines(dir, WEEK).lines;
    expect(Array.from(l.text)).toHaveLength(300);
    expect(l.text.endsWith("…")).toBe(true);
  });

  it("reads the cores before the time-limited walk, so a slow tree can't crowd them out", () => {
    put("aaa/big.md", topic(["- 2026-11-25 [said] From an early topic."]));
    put("private/MEMORY.md", "- 2026-11-25 [said] From the private core.\n");
    put("MEMORY.md", "- 2026-11-25 [said] From the shared core.\n");
    const { lines, truncated } = collectSaidLines(dir, WEEK, { budgetMs: -1 });
    expect(truncated).toBe(true);
    expect(lines.map((l) => l.path)).toEqual(["MEMORY.md", "private/MEMORY.md"]);
  });

  it("reads a file only up to a bound, however large an editor made it", () => {
    put("huge.md", topic(["x".repeat(300 * 1024), "- 2026-11-25 [said] Past the bound."]));
    put("MEMORY.md", `${"y".repeat(300 * 1024)}\n- 2026-11-25 [said] Past the bound too.\n`);
    expect(collectSaidLines(dir, WEEK).lines).toEqual([]);
  });

  it("finds nothing in a memory folder that doesn't exist", () => {
    expect(collectSaidLines(join(dir, "missing"), WEEK)).toEqual({ lines: [], more: 0, truncated: false });
  });
});

describe("coreStatusLine", () => {
  it("gives both cores' sizes against the budget, and says when one doesn't exist", () => {
    put("MEMORY.md", "## Owner\n- one\n");
    expect(coreStatusLine(dir)).toBe("private/MEMORY.md doesn't exist yet or can't be read and MEMORY.md is 2 lines / 0.0 KB (budget 200 lines or 16 KB each).");
  });
});

describe("reads that cannot hold the event loop", () => {
  it("a core that is a FIFO is neither read nor waited on", () => {
    mkdirSync(join(dir, "private"), { recursive: true });
    execFileSync("mkfifo", [join(dir, "MEMORY.md")]);
    expect(coreStatusLine(dir)).toContain("MEMORY.md doesn't exist yet or can't be read (budget");
    expect(collectSaidLines(dir, WEEK).lines).toEqual([]);
  });

  it("a core past the read bound is reported as over it", () => {
    put("MEMORY.md", "z".repeat(300 * 1024));
    expect(coreStatusLine(dir)).toContain("MEMORY.md is over 256 KB");
  });
});
