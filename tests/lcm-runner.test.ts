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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
// What the two collaborators answer, per test: by default every session is on
// LCM compaction and one daily period is due.
const fixture = vi.hoisted(() => ({
  lcm: ((_key: string) => true) as (key: string) => boolean,
  due: [] as Array<{ level: "daily" | "weekly" | "monthly" | "yearly"; period: string; childCount: number }>,
  dueCalls: 0,
}));
vi.mock("../src/agent/sdk-options.js", () => ({ usesLcmCompact: (key: string) => fixture.lcm(key) }));
vi.mock("../src/lcm/blocks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lcm/blocks.js")>()),
  findDuePromotions: () => { fixture.dueCalls++; return fixture.due; },
}));

const { RollupRunner } = await import("../src/lcm/runner.js");
const { NudgeCooldownStore } = await import("../src/lcm/nudge-cooldown-store.js");

interface Nudge { text: string; sessionKey: string; options: { suppressDelivery?: boolean } }

function runnerFor(sessionKey: string): {
  runner: InstanceType<typeof RollupRunner>;
  nudges: Nudge[];
  cooldowns: InstanceType<typeof NudgeCooldownStore>;
} {
  const nudges: Nudge[] = [];
  const agent = {
    listActiveSessions: () => [[sessionKey, "sdk-session-1"]] as Array<[string, string]>,
    hasBackgroundWork: () => false,
    handleCronMessage: async (text: string, key: string, options: Nudge["options"]) => {
      nudges.push({ text, sessionKey: key, options });
      return true;
    },
  };
  // In-memory cooldown (null path): these cases nudge the same period, and
  // a shared file would let the first one's cooldown suppress the second.
  const cooldowns = new NudgeCooldownStore(null);
  return { runner: new RollupRunner(agent as never, cooldowns), nudges, cooldowns };
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

  it("the next tick, past the cooldown, picks the next one", async () => {
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
