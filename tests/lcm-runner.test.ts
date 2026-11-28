/**
 * RollupRunner: which due period a tick nudges, the gates in front of it, and
 * that the nudge turn is silent.
 *
 * (Cooldown persistence is rollup-cooldown.test.ts; the default store's
 * wiring is rollup-cooldown-wiring.test.ts.)
 *
 * LCM rollup nudge turns are silent by CONSTRUCTION.
 *
 * The rollup prompt ends with "After the rollup finishes, reply NO_REPLY so we
 * don't send a user-facing message for this housekeeping turn". Under #292's
 * end-of-turn delivery that was enough: the turn was joined into one response
 * and the trailing token suppressed all of it.
 *
 * With per-block delivery the token comes too late to stop an earlier
 * narration block ("Rolling up 2026-08-27…"), which is already on the owner's
 * phone. So the nudge sets `suppressDelivery` unconditionally rather than
 * trusting the model to say the right word — and, crucially, it does so for
 * DM sessions too. It used to pass `isGroupSessionKey(sessionKey)`, which is
 * exactly `false` for the owner's DM: the one session that leaked.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
// What the two collaborators answer, per test: by default every session is on
// LCM compaction and one daily period is due.
const fixture = vi.hoisted(() => ({
  lcm: ((_key: string) => true) as (key: string) => boolean,
  due: [] as Array<{ level: "daily" | "weekly" | "monthly" | "yearly"; period: string; childCount: number }>,
  dueCalls: 0,
  rollupLands: true,
}));
vi.mock("../src/agent/sdk-options.js", () => ({ usesLcmCompact: (key: string) => fixture.lcm(key) }));
vi.mock("../src/lcm/blocks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lcm/blocks.js")>()),
  findDuePromotions: () => { fixture.dueCalls++; return fixture.due; },
}));

const { RollupRunner } = await import("../src/lcm/runner.js");
const { NudgeCooldownStore } = await import("../src/lcm/nudge-cooldown-store.js");

interface Nudge { text: string; sessionKey: string; options: { suppressDelivery?: boolean; dropIf?: () => boolean } }

function runnerFor(sessionKey: string, summoned: () => boolean = () => false, memory?: ConstructorParameters<typeof RollupRunner>[2], turnOk: () => boolean = () => true): {
  runner: InstanceType<typeof RollupRunner>;
  nudges: Nudge[];
  cooldowns: InstanceType<typeof NudgeCooldownStore>;
} {
  const nudges: Nudge[] = [];
  const agent = {
    listActiveSessions: () => [[sessionKey, "sdk-session-1"]] as Array<[string, string]>,
    hasBackgroundWork: () => false,
    hasActiveSummonInto: (key: string) => key === sessionKey && summoned(),
    handleCronMessage: async (text: string, key: string, options: Nudge["options"]) => {
      nudges.push({ text, sessionKey: key, options });
      // As the agent does: asked when the turn is about to run.
      if (options.dropIf?.()) return false;
      if (!turnOk()) return false;
      // The turn ran the rollup: its period is no longer due (unless a test says the command never ran).
      if (fixture.rollupLands) {
        const m = /name="(\w+) ([^"]+)"/.exec(text);
        if (m) fixture.due = fixture.due.filter((d) => !(d.level === m[1] && d.period === m[2]));
      }
      return true;
    },
  };
  // In-memory cooldown (null path): these cases nudge the same period, and
  // a shared file would let the first one's cooldown suppress the second.
  const cooldowns = new NudgeCooldownStore(null);
  return { runner: new RollupRunner(agent as never, cooldowns, { memoryDir: () => "/nonexistent-memory-root", maxTurns: () => 0, ...memory }), nudges, cooldowns };
}

/** `checkAll` is private; the scheduler is the only production caller. */
const checkAll = (runner: InstanceType<typeof RollupRunner>) =>
  (runner as unknown as { checkAll(): Promise<void> }).checkAll();

beforeEach(() => {
  // The runner skips outside 07:00–22:00; pin a daytime clock (local time,
  // which is what the runner reads).
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-28T12:00:00"));
  fixture.lcm = () => true;
  fixture.due = [{ level: "daily", period: "2026-08-27", childCount: 5 }];
  fixture.dueCalls = 0;
  fixture.rollupLands = true;
});
afterEach(() => { vi.useRealTimers(); });

describe("rollup nudge delivery suppression", () => {
  // "dm:owner" is the session that used to leak.
  it.each(["dm:owner", "telegram:-1001234567"])("suppresses delivery for the rollup turn of %s", async (sessionKey) => {
    const { runner, nudges } = runnerFor(sessionKey);
    await checkAll(runner);

    expect(nudges).toHaveLength(1);
    expect(nudges[0].options.suppressDelivery).toBe(true);
  });
});

describe("while a group is summoned into the session", () => {
  it("defers the rollup without arming its cooldown, and asks on the first tick after the summon ends", async () => {
    let summoned = true;
    const { runner, nudges, cooldowns } = runnerFor("dm:owner", () => summoned);

    await checkAll(runner);
    vi.setSystemTime(new Date("2026-08-28T13:00:00"));
    await checkAll(runner);
    expect(nudges).toHaveLength(0);
    // Not even looked up, and nothing armed: a deferral must not cost the 6h debounce.
    expect(fixture.dueCalls).toBe(0);
    expect(cooldowns.get("dm:owner:daily:2026-08-27", Date.now())).toBeUndefined();

    summoned = false;
    vi.setSystemTime(new Date("2026-08-28T14:00:00"));
    await checkAll(runner);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatchObject({ sessionKey: "dm:owner" });
    expect(nudges[0].text).toContain('name="daily 2026-08-27"');
  });
});

describe("which period a tick nudges", () => {
  // findDuePromotions answers in no particular order; the runner picks ONE per
  // tick (two `tomo lcm` runs back to back race the SDK's in-memory state),
  // lowest level first and, within a level, the oldest period first, so the
  // chain drains bottom-up: a week is only complete once its days are rolled.
  it.each([
    ["the lowest level wins over an older period of a higher level", [
      { level: "monthly", period: "2026-06", childCount: 4 },
      { level: "weekly", period: "2026-W30", childCount: 7 },
      { level: "daily", period: "2026-08-26", childCount: 9 },
      { level: "yearly", period: "2025", childCount: 12 },
    ], "daily 2026-08-26"],
    ["within a level, the oldest period first", [
      { level: "daily", period: "2026-08-27", childCount: 5 },
      { level: "daily", period: "2026-08-25", childCount: 5 },
      { level: "daily", period: "2026-08-26", childCount: 5 },
    ], "daily 2026-08-25"],
    ["weekly before monthly before yearly", [
      { level: "yearly", period: "2025", childCount: 12 },
      { level: "monthly", period: "2026-07", childCount: 4 },
      { level: "weekly", period: "2026-W34", childCount: 7 },
    ], "weekly 2026-W34"],
  ] as const)("%s", async (_label, due, picked) => {
    fixture.due = due.map((d) => ({ ...d }));
    const { runner, nudges, cooldowns } = runnerFor("dm:owner");

    await checkAll(runner);

    expect(nudges).toHaveLength(1);
    expect(nudges[0].text).toContain(`name="${picked}"`);
    // Only the picked one is armed; the rest stay due for the next tick.
    const now = Date.now();
    for (const d of due) {
      const armed = cooldowns.get(`dm:owner:${d.level}:${d.period}`, now) !== undefined;
      expect(armed, `${d.level} ${d.period}`).toBe(`${d.level} ${d.period}` === picked);
    }
  });

  it("the next tick skips the armed period and picks the next one", async () => {
    fixture.due = [
      { level: "daily", period: "2026-08-26", childCount: 5 },
      { level: "daily", period: "2026-08-27", childCount: 5 },
    ];
    const { runner, nudges } = runnerFor("dm:owner");
    await checkAll(runner);
    // Within the 6h cooldown the first is skipped, so the second is asked for
    // at once on the next tick.
    vi.setSystemTime(new Date("2026-08-28T13:00:00"));
    await checkAll(runner);

    expect(nudges.map((n) => /name="([^"]+)"/.exec(n.text)?.[1])).toEqual(["daily 2026-08-26", "daily 2026-08-27"]);
  });
});

describe("the gates in front of a nudge", () => {
  it("skips a session on SDK auto-compact without reading its blocks", async () => {
    fixture.lcm = (key) => key !== "telegram:-1001234567";
    const { runner, nudges, cooldowns } = runnerFor("telegram:-1001234567");

    await checkAll(runner);

    expect(nudges).toEqual([]);
    expect(fixture.dueCalls).toBe(0);
    expect(cooldowns.get("telegram:-1001234567:daily:2026-08-27", Date.now())).toBeUndefined();
  });

  it.each([
    ["03:00, before the day starts", "2026-08-28T03:00:00"],
    ["06:59, a minute before 07:00", "2026-08-28T06:59:00"],
    ["22:00, the end of the day", "2026-08-28T22:00:00"],
  ])("does nothing at %s: no check, no nudge, no cooldown", async (_label, at) => {
    vi.setSystemTime(new Date(at));
    const { runner, nudges, cooldowns } = runnerFor("dm:owner");

    await checkAll(runner);

    expect(nudges).toEqual([]);
    expect(fixture.dueCalls).toBe(0);
    expect(cooldowns.get("dm:owner:daily:2026-08-27", Date.now())).toBeUndefined();
  });

  it("runs at 07:00, the first daytime hour", async () => {
    vi.setSystemTime(new Date("2026-08-28T07:00:00"));
    const { runner, nudges } = runnerFor("dm:owner");
    await checkAll(runner);
    expect(nudges).toHaveLength(1);
  });
});

describe("the memory step never costs the rollup (§4.2)", () => {
  let memDir: string;
  beforeEach(() => {
    memDir = mkdtempSync(join(tmpdir(), "runner-memory-"));
    writeFileSync(join(memDir, "MEMORY.md"), "## Rules\n- 2026-08-18 [said] No calls before 9.\n- 2026-08-10 [said] An older week's rule.\n");
    fixture.due = [{ level: "weekly", period: "2026-W34", childCount: 7 }];
  });
  afterEach(() => { rmSync(memDir, { recursive: true, force: true }); });

  it("a DM weekly nudge carries the harness's list of that week's said lines", async () => {
    const { runner, nudges } = runnerFor("dm:owner", undefined, { memoryDir: () => memDir });
    await checkAll(runner);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].text).toContain("- MEMORY.md:2: - 2026-08-18 [said] No calls before 9.");
    expect(nudges[0].text).not.toContain("An older week's rule");
    expect(nudges[0].text).toContain("MEMORY.md is 3 lines");
  });

  it("when the memory root can't be resolved, the nudge still goes out with the rollup command", async () => {
    const { runner, nudges, cooldowns } = runnerFor("dm:owner", undefined, { memoryDir: () => { throw new Error("boom"); } });
    await checkAll(runner);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].text).toContain("tomo lcm weekly --session-id sdk-session-1 --week 2026-W34");
    expect(nudges[0].text).toContain("could not be listed this time");
    expect(cooldowns.get("dm:owner:weekly:2026-W34", Date.now())).toBeDefined();
  });

  it("when the context usage can't be read, it assumes room rather than dropping the nudge", async () => {
    const { runner, nudges } = runnerFor("dm:owner", undefined, { memoryDir: () => memDir, contextUsage: () => { throw new Error("boom"); } });
    await checkAll(runner);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].text).toContain("No calls before 9.");
  });

  it("near the forced-compaction line the said check is left out, and nearer still the whole step", async () => {
    fixture.rollupLands = false; // several runners read the same due list: only the text is under test
    const at = (used: number) => runnerFor("dm:owner", undefined, { memoryDir: () => memDir, contextUsage: () => ({ used, max: 1_000_000 }), forceCompactAtPct: () => 95 });
    const roomy = at(500_000);
    await checkAll(roomy.runner);
    expect(roomy.nudges[0].text).toContain("No calls before 9.");

    const tight = at(950_000 - 100_000);
    await checkAll(tight.runner);
    expect(tight.nudges[0].text).toContain("memory upkeep for 2026-W34");
    expect(tight.nudges[0].text).toContain("not checked this time: the context is too full");
    expect(tight.nudges[0].text).not.toContain("No calls before 9.");

    const full = at(950_000 - 10_000);
    await checkAll(full.runner);
    expect(full.nudges[0].text).toContain("`memory: skipped (the context is too full)`");
    expect(full.nudges[0].text).not.toContain("memory upkeep for");
    expect(full.nudges[0].text).toContain("tomo lcm weekly --session-id sdk-session-1");
  });

  it("under a tool-round limit the list is cut to leave the rollup its rounds, and a tiny limit drops the step", async () => {
    fixture.rollupLands = false; // several runners read the same due list: only the text is under test
    writeFileSync(join(memDir, "MEMORY.md"), Array.from({ length: 20 }, (_, i) => `- 2026-08-18 [said] Rule ${i + 1}.`).join("\n"));
    const withTurns = (maxTurns: number) => runnerFor("dm:owner", undefined, { memoryDir: () => memDir, maxTurns: () => maxTurns });
    const fifty = withTurns(50);
    await checkAll(fifty.runner);
    expect(fifty.nudges[0].text).toContain("Rule 12.");
    expect(fifty.nudges[0].text).not.toContain("Rule 13.");
    expect(fifty.nudges[0].text).toContain("8 more `said` lines from that week are not listed");
    const unlimited = withTurns(0);
    await checkAll(unlimited.runner);
    expect(unlimited.nudges[0].text).toContain("Rule 20.");
    const tiny = withTurns(10);
    await checkAll(tiny.runner);
    expect(tiny.nudges[0].text).toContain("`memory: skipped (a turn here has too few tool rounds)`");
    expect(tiny.nudges[0].text).toContain("tomo lcm weekly --session-id sdk-session-1");
  });

  it("a nudge with the step is dropped when a group was summoned in while it waited, and asked again later with the step", async () => {
    let summonedAtRun = false;
    // The summon starts between the check (which saw none) and the turn.
    const late = runnerFor("dm:owner", () => summonedAtRun, { memoryDir: () => memDir });
    const original = late.nudges.push.bind(late.nudges);
    late.nudges.push = (...items: Nudge[]) => { summonedAtRun = true; return original(...items); };
    await checkAll(late.runner);
    expect(late.nudges).toHaveLength(1);
    // Not delivered: no cooldown, so the first tick after the summon asks again...
    expect(late.cooldowns.get("dm:owner:weekly:2026-W34", Date.now())).toBeUndefined();
    summonedAtRun = false;
    late.nudges.push = original;
    await checkAll(late.runner);
    // ...with the step still in it: a summon is not the step's failure.
    expect(late.nudges[1].text).toContain("No calls before 9.");
  });

  it("a nudge without the step is never dropped at run time", async () => {
    const { runner, nudges } = runnerFor("telegram:-1001234567", undefined, { memoryDir: () => memDir });
    await checkAll(runner);
    expect(nudges[0].options.dropIf).toBeUndefined();
  });

  it("after a nudge with the step fails, the period is asked again without it, then with it once a rollup lands", async () => {
    let ok = false;
    const { runner, nudges, cooldowns } = runnerFor("dm:owner", undefined, { memoryDir: () => memDir }, () => ok);
    await checkAll(runner);
    expect(nudges[0].text).toContain("No calls before 9.");
    expect(cooldowns.get("dm:owner:weekly:2026-W34", Date.now())).toBeUndefined();
    ok = true;
    await checkAll(runner);
    expect(nudges[1].text).toContain("`memory: skipped (the last attempt at this rollup did not finish)`");
    expect(nudges[1].text).not.toContain("No calls before 9.");
    expect(nudges[1].text).toContain("tomo lcm weekly --session-id sdk-session-1 --week 2026-W34");
    // That one landed: a later nudge for the period (a rebuild) has the step again.
    fixture.due = [{ level: "weekly", period: "2026-W34", childCount: 7 }];
    cooldowns.clear("dm:owner:weekly:2026-W34");
    await checkAll(runner);
    expect(nudges[2].text).toContain("No calls before 9.");
  });

  it("a turn that completed without the rollup landing is asked again, after the usual cooldown, without the step", async () => {
    fixture.rollupLands = false;
    const { runner, nudges, cooldowns } = runnerFor("dm:owner", undefined, { memoryDir: () => memDir });
    await checkAll(runner);
    expect(nudges[0].text).toContain("No calls before 9.");
    // The cooldown is untouched: a completed turn holds it as before.
    expect(cooldowns.get("dm:owner:weekly:2026-W34", Date.now())).toBeDefined();
    cooldowns.clear("dm:owner:weekly:2026-W34");
    fixture.rollupLands = true;
    await checkAll(runner);
    expect(nudges[1].text).toContain("`memory: skipped (the last attempt at this rollup did not finish)`");
    expect(cooldowns.get("dm:owner:weekly:2026-W34", Date.now())).toBeDefined();
  });

  it("a nudge without the step keeps the old behaviour: a completed turn holds the cooldown even if still due", async () => {
    fixture.rollupLands = false;
    const { runner, cooldowns } = runnerFor("telegram:-1001234567", undefined, { memoryDir: () => memDir });
    await checkAll(runner);
    expect(cooldowns.get("telegram:-1001234567:weekly:2026-W34", Date.now())).toBeDefined();
  });

  it("with forced compaction off (0 or 100), room is measured to the window, not to zero", async () => {
    fixture.rollupLands = false; // several runners read the same due list: only the text is under test
    for (const pct of [0, 100]) {
      const { runner, nudges } = runnerFor("dm:owner", undefined, { memoryDir: () => memDir, contextUsage: () => ({ used: 100_000, max: 1_000_000 }), forceCompactAtPct: () => pct });
      await checkAll(runner);
      expect(nudges[0].text).toContain("No calls before 9.");
    }
  });

  it("a group session's nudge has no memory step and no said lines", async () => {
    const { runner, nudges } = runnerFor("telegram:-1001234567", undefined, { memoryDir: () => memDir });
    await checkAll(runner);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].text).not.toContain("memory upkeep");
    expect(nudges[0].text).not.toContain("No calls before 9.");
  });
});
