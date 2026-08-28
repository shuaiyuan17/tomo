/**
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
vi.mock("../src/agent/sdk-options.js", () => ({ usesLcmCompact: () => true }));
vi.mock("../src/lcm/blocks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lcm/blocks.js")>()),
  findDuePromotions: () => [{ level: "daily", period: "2026-08-27", childCount: 5 }],
}));

const { RollupRunner } = await import("../src/lcm/runner.js");

interface Nudge { sessionKey: string; options: { suppressDelivery?: boolean } }

function runnerFor(sessionKey: string): { runner: InstanceType<typeof RollupRunner>; nudges: Nudge[] } {
  const nudges: Nudge[] = [];
  const agent = {
    listActiveSessions: () => [[sessionKey, "sdk-session-1"]] as Array<[string, string]>,
    handleCronMessage: async (_text: string, key: string, options: Nudge["options"]) => {
      nudges.push({ sessionKey: key, options });
      return true;
    },
  };
  return { runner: new RollupRunner(agent as never), nudges };
}

/** `checkAll` is private; the scheduler is the only production caller. */
const checkAll = (runner: InstanceType<typeof RollupRunner>) =>
  (runner as unknown as { checkAll(): Promise<void> }).checkAll();

describe("rollup nudge delivery suppression", () => {
  beforeEach(() => {
    // The runner skips outside 07:00–22:00; pin a daytime clock.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("suppresses delivery for a DM rollup turn — the session that used to leak", async () => {
    const { runner, nudges } = runnerFor("dm:owner");
    await checkAll(runner);

    expect(nudges).toHaveLength(1);
    expect(nudges[0].options.suppressDelivery).toBe(true);
  });

  it("suppresses delivery for a group rollup turn too", async () => {
    const { runner, nudges } = runnerFor("telegram:-1001234567");
    await checkAll(runner);

    expect(nudges).toHaveLength(1);
    expect(nudges[0].options.suppressDelivery).toBe(true);
  });
});
