/**
 * The other half of the cooldown-persistence guarantee: that PRODUCTION wires
 * it up. `rollup-cooldown.test.ts` injects a store, so it would still pass if
 * `new RollupRunner(agent)` quietly went back to an in-memory map — which is
 * exactly the bug (daemon up 08:14, `daily 2026-08-28` re-nudged 08:16, an hour
 * after the 07:15 nudge).
 *
 * So this file constructs the runner the way `src/cli/start.ts` does — no store
 * argument, just a temp `tomoHome` — and restarts the *module graph* between the
 * two runners (`vi.resetModules()`), which is as close to a process restart as a
 * test gets: fresh module state, same disk. It deliberately imports nothing from
 * the new store module, so on unchanged main it fails at the assertion rather
 * than at module resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
vi.mock("../src/agent/sdk-options.js", () => ({ usesLcmCompact: () => true }));
vi.mock("../src/lcm/blocks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lcm/blocks.js")>()),
  findDuePromotions: () => [{ level: "daily", period: "2026-08-28", childCount: 46 }],
}));

const TOMO_HOME = join(tmpdir(), "tomo-test-rollup-cooldown-wiring");
const EXPECTED_FILE = join(TOMO_HOME, "data", "lcm", "nudge-cooldown.json");
const SESSION = "dm:owner";

/**
 * Start a "daemon": fresh modules, same `tomoHome` on disk, runner built with
 * no injected store. Returns the nudges that runner emitted for one check.
 */
async function bootAndCheck(): Promise<string[]> {
  vi.resetModules();
  // resetModules also re-creates the mock helper module, so re-apply the temp
  // home to the fresh mockConfig the config mock will hand the runner.
  const { mockConfig } = await import("./helpers/agent-mocks.js");
  mockConfig.tomoHome = TOMO_HOME;

  const { RollupRunner } = await import("../src/lcm/runner.js");
  const nudges: string[] = [];
  const agent = {
    listActiveSessions: () => [[SESSION, "sdk-session-1"]] as Array<[string, string]>,
    handleCronMessage: async (text: string) => { nudges.push(text); return true; },
  };
  const runner = new RollupRunner(agent as never); // production wiring: no store
  await (runner as unknown as { checkAll(): Promise<void> }).checkAll();
  return nudges;
}

describe("rollup nudge cooldown — default wiring", () => {
  beforeEach(() => {
    rmSync(TOMO_HOME, { recursive: true, force: true });
    mkdirSync(TOMO_HOME, { recursive: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T07:15:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(TOMO_HOME, { recursive: true, force: true });
  });

  it("a runner built with no store persists under tomoHome and holds the cooldown across a restart", async () => {
    expect(await bootAndCheck()).toHaveLength(1);

    // 08:14 restart, 08:16 first check — the pair that shipped a duplicate.
    vi.setSystemTime(new Date("2026-08-29T08:16:00"));
    expect(await bootAndCheck()).toHaveLength(0);

    // ...and it did it through the file, at the documented path.
    expect(existsSync(EXPECTED_FILE)).toBe(true);
  });
});
