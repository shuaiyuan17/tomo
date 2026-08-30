/**
 * The rollup nudge cooldown must survive a daemon restart.
 *
 * `RollupRunner` nudges a due period at most once per 6h. That window used to
 * live in a bare in-memory Map, so every restart re-armed every period.
 * Observed in prod on 2026-08-29: daemon restarted 08:14, runner re-nudged
 * `daily 2026-08-28` at 08:16 — one hour after the 07:15 nudge. Each nudge is a
 * full model turn that rewrites the whole day summary, so the duplicate is not
 * free.
 *
 * A restart is modelled here the way the process does it: throw the runner away
 * and build a NEW one over a NEW store reading the SAME file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
vi.mock("../src/agent/sdk-options.js", () => ({ usesLcmCompact: () => true }));
vi.mock("../src/lcm/blocks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lcm/blocks.js")>()),
  findDuePromotions: () => [{ level: "daily", period: "2026-08-28", childCount: 46 }],
}));

const { RollupRunner } = await import("../src/lcm/runner.js");
const { NudgeCooldownStore, NUDGE_COOLDOWN_RETENTION_MS } =
  await import("../src/lcm/nudge-cooldown-store.js");
const { log } = await import("../src/logger.js");

const TEST_DIR = join(tmpdir(), "tomo-test-rollup-cooldown");
const FILE = join(TEST_DIR, "nudge-cooldown.json");
const SESSION = "dm:owner";
const KEY = `${SESSION}:daily:2026-08-28`;

/** A daemon lifetime: one runner over one store reading `FILE`. */
function bootRunner(): { runner: InstanceType<typeof RollupRunner>; nudges: string[] } {
  const nudges: string[] = [];
  const agent = {
    listActiveSessions: () => [[SESSION, "sdk-session-1"]] as Array<[string, string]>,
    handleCronMessage: async (text: string) => { nudges.push(text); return true; },
  };
  return {
    runner: new RollupRunner(agent as never, new NudgeCooldownStore(FILE)),
    nudges,
  };
}

/** `checkAll` is private; the scheduler is the only production caller. */
const checkAll = (runner: InstanceType<typeof RollupRunner>) =>
  (runner as unknown as { checkAll(): Promise<void> }).checkAll();

describe("rollup nudge cooldown persistence", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    // The runner skips outside 07:00–22:00; pin a daytime clock.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T07:15:00"));
    vi.mocked(log.warn).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("still holds the cooldown after a restart — the 08:14 → 08:16 re-nudge", async () => {
    const first = bootRunner();
    await checkAll(first.runner);
    expect(first.nudges).toHaveLength(1);

    // 08:14: daemon restarts. 08:16: first check of the new process.
    vi.setSystemTime(new Date("2026-08-29T08:16:00"));
    const afterRestart = bootRunner();
    await checkAll(afterRestart.runner);
    expect(afterRestart.nudges).toHaveLength(0);

    // ...and the window still expires normally (07:15 + 6h).
    vi.setSystemTime(new Date("2026-08-29T13:16:00"));
    const later = bootRunner();
    await checkAll(later.runner);
    expect(later.nudges).toHaveLength(1);
  });

  it("treats a corrupt cooldown file as empty, logs once, and keeps nudging", async () => {
    writeFileSync(FILE, "{ this is not json");

    const { runner, nudges } = bootRunner();
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);

    // Empty, not stuck: the period is nudged, and the file is rewritten clean.
    await checkAll(runner);
    expect(nudges).toHaveLength(1);
    expect(JSON.parse(readFileSync(FILE, "utf-8")).nudged[KEY])
      .toBe(new Date("2026-08-29T07:15:00").getTime());

    // A missing file is the same story, without the warning.
    rmSync(FILE);
    vi.mocked(log.warn).mockClear();
    const fresh = bootRunner();
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    await checkAll(fresh.runner);
    expect(fresh.nudges).toHaveLength(1);
  });

  it("prunes entries older than the retention window on write", async () => {
    const now = new Date("2026-08-29T07:15:00").getTime();
    const stale = now - NUDGE_COOLDOWN_RETENTION_MS - 1;
    const recent = now - NUDGE_COOLDOWN_RETENTION_MS + 60_000;
    writeFileSync(FILE, JSON.stringify({
      version: 1,
      nudged: { "dm:owner:daily:2026-08-01": stale, "dm:owner:daily:2026-08-22": recent },
    }));

    const store = new NudgeCooldownStore(FILE);
    expect(store.size()).toBe(2); // load keeps whatever is there
    store.set(KEY, now);

    const onDisk = JSON.parse(readFileSync(FILE, "utf-8")).nudged;
    expect(Object.keys(onDisk).sort()).toEqual(["dm:owner:daily:2026-08-22", KEY].sort());
    expect(store.size()).toBe(2);
  });
});
