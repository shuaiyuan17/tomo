import { describe, it, expect } from "vitest";
import { nudgeText } from "../src/lcm/runner.js";

const promo = (level: "daily" | "weekly", replacesExistingBlock = false) => ({
  level,
  period: level === "daily" ? "2026-08-23" : "2026-W34",
  childCount: 42,
  replacesExistingBlock,
}) as Parameters<typeof nudgeText>[0];

describe("rollup nudge text", () => {
  it("tells the writer to pair an interval with the date when duration is load-bearing", () => {
    const text = nudgeText(promo("daily"), "sess-1", "dm:someone");
    // The guidance itself...
    expect(text).toMatch(/elapsed interval carries meaning/);
    // ...and the worked example, which is what actually gets imitated.
    expect(text).toContain('"opened 8/7, sat 17 days"');
    // The reason, without which this reads as "add more words".
    expect(text).toMatch(/arithmetic they will not actually do/);
  });

  it("also tells the writer when NOT to, so it does not become an every-line tic", () => {
    const text = nudgeText(promo("daily"), "sess-1", "dm:someone");
    expect(text).toMatch(/Skip it where duration is not load-bearing/);
  });

  it("carries the guidance at every level, not just daily", () => {
    // A weekly rollup is where intervals matter most — it spans the longest gaps.
    const weekly = nudgeText(promo("weekly"), "sess-1", "dm:someone");
    expect(weekly).toMatch(/elapsed interval carries meaning/);
  });

  it("warns that a rebuild replaces the existing block and requires a whole-period summary", () => {
    const text = nudgeText(promo("daily", true), "sess-1", "dm:someone");
    expect(text).toContain("already has a rollup block");
    expect(text).toContain("REPLACES that block; it does not append");
    expect(text).toContain("fresh summary covering the WHOLE period");
    expect(text).toContain("Preserve the existing block's important content");
  });

  it("does not show the replacement warning for a first-time rollup", () => {
    const text = nudgeText(promo("daily"), "sess-1", "dm:someone");
    expect(text).not.toContain("REPLACES that block");
  });

  it("warns that running a rollup interrupts a working subagent, and to defer if one is running", () => {
    const text = nudgeText(promo("daily"), "sess-1", "dm:someone");
    expect(text).toContain("interrupt any subagent");
    expect(text).toContain("DEFER this rollup until it finishes");
    // The caveat must precede the command so it is read before the rollup is run.
    expect(text.indexOf("interrupt any subagent")).toBeLessThan(text.indexOf("tomo lcm daily"));
  });
});

describe("the memory step of a rollup nudge (§4.2, §15.2 of the memory design)", () => {
  const today = "2026-11-30";
  const said = (n: number, more = 0) => ({
    lines: Array.from({ length: n }, (_, i) => ({ path: "MEMORY.md", line: i + 2, text: `- 2026-11-24 [said] Rule ${i + 1}.` })),
    more,
    truncated: false,
  });
  const weekly = (pass: Parameters<typeof nudgeText>[3]) => nudgeText(promo("weekly"), "sess-1", "dm:someone", pass);

  it("daily on the owner's DM: the pass names that day, comes before the command, and asks for the memory line", () => {
    const text = nudgeText(promo("daily"), "sess-1", "dm:someone", { today });
    expect(text).toContain("Before the rollup: the memory pass for 2026-08-23.");
    expect(text).toContain("A new line's leading date is when it was said, 2026-08-23, not today.");
    expect(text).toContain("If memory already reflects that day (an earlier attempt at this rollup did it), change nothing.");
    expect(text).toContain("Skip subjects under `## Don't keep`");
    expect(text).toContain("never as `said` and never in either MEMORY.md");
    expect(text).toContain("Don't change scheduled jobs here");
    expect(text).toContain("`memory: <files you changed, or none>`");
    expect(text).toContain("run the rollup anyway");
    expect(text.indexOf("memory pass for")).toBeLessThan(text.indexOf("tomo lcm daily"));
    // After the subagent warning: deferring is decided before any memory work.
    expect(text.indexOf("DEFER this rollup")).toBeLessThan(text.indexOf("memory pass for"));
    expect(text).not.toContain("memory upkeep");
  });

  it("weekly on the owner's DM: the shrink steps, the core sizes and the week's said lines", () => {
    const text = weekly({ today, coreStatus: "private/MEMORY.md is 3 lines / 0.1 KB and MEMORY.md is 9 lines / 0.4 KB (budget 200 lines or 16 KB each).", said: said(2) });
    expect(text).toContain("Before the rollup: memory upkeep for 2026-W34. private/MEMORY.md is 3 lines");
    expect(text).toContain("Move topic files about finished or dropped subjects into archive/ with memory_move.");
    expect(text).toContain("If a shared file holds something on the private list (Layout), move it under private/.");
    expect(text).toContain("Then check that week's `said` lines");
    expect(text).toContain("- MEMORY.md:2: - 2026-11-24 [said] Rule 1.");
    expect(text).toContain("- MEMORY.md:3: - 2026-11-24 [said] Rule 2.");
    expect(text).toContain('(no source found, checked 2026-11-30)');
    expect(text).toContain("rewrite it as \"agreed to <what> (my proposal)\"");
    expect(text).toContain("said check: <n> checked, <a> misquoted, <b> overstated, <c> unsourced");
    expect(text).not.toContain("more `said`");
    expect(text.indexOf("memory upkeep")).toBeLessThan(text.indexOf("tomo lcm weekly"));
  });

  it("counts the lines past the cap, and leaves them", () => {
    expect(weekly({ today, said: said(20, 7) })).toContain("7 more `said` lines from that week are not listed; leave them.");
  });

  it("has no said block, and no said counts in the memory line, when the week has no said lines", () => {
    const text = weekly({ today, said: said(0) });
    expect(text).toContain("memory upkeep for 2026-W34");
    expect(text).not.toContain("check that week's `said` lines");
    expect(text).not.toContain("said check:");
    expect(text).not.toContain("not checked this time");
  });

  it("says the said lines are not checked when the scan failed or there is no room, without listing any", () => {
    expect(weekly({ today })).toContain("This week's `said` lines could not be listed this time; leave them.");
    const full = weekly({ today, saidSkipped: "the context is too full" });
    expect(full).toContain("not checked this time: the context is too full");
    expect(full).not.toContain("said check:");
  });

  it("a skipped step still asks for the memory line, and keeps the rollup", () => {
    const text = nudgeText(promo("daily"), "sess-1", "dm:someone", { skip: "the context is too full" });
    expect(text).toContain("No memory pass this time: the context is too full.");
    expect(text).toContain("`memory: skipped (the context is too full)`");
    expect(text).not.toContain("memory pass for");
    expect(text).toContain("tomo lcm daily --session-id sess-1");
  });

  it.each([
    ["a group session", "telegram:-1001234567"],
    ["a task", "task:abc"],
  ])("never on %s, whatever the caller passed", (_what, key) => {
    for (const level of ["daily", "weekly"] as const) {
      const text = nudgeText(promo(level), "sess-1", key, { today, said: said(3) });
      expect(text).not.toContain("memory pass");
      expect(text).not.toContain("memory upkeep");
      expect(text).not.toContain("[said] Rule");
      expect(text).not.toContain("`memory:");
    }
  });

  it("never on a monthly or yearly rollup", () => {
    const monthly = { level: "monthly", period: "2026-08", childCount: 4, replacesExistingBlock: false } as Parameters<typeof nudgeText>[0];
    const text = nudgeText(monthly, "sess-1", "dm:someone", { today });
    expect(text).not.toContain("memory pass");
    expect(text).not.toContain("memory upkeep");
    expect(text).not.toContain("`memory:");
  });

  it("a group nudge's scope line sits after the warning, not inside the replace block or between Run: and the command", () => {
    for (const replaces of [false, true]) {
      const text = nudgeText(promo("daily", replaces), "sess-1", "telegram:-1001234567");
      const lines = text.split("\n");
      const scope = lines.findIndex((l) => l.startsWith("Group scope:"));
      const run = lines.findIndex((l) => l.endsWith("Run:"));
      expect(scope).toBeGreaterThan(lines.findIndex((l) => l.includes("DEFER this rollup")));
      expect(lines[run + 1]).toMatch(/^ {2}tomo lcm daily/);
      if (replaces) expect(scope).toBeLessThan(lines.findIndex((l) => l.startsWith("IMPORTANT:")));
    }
  });
});
