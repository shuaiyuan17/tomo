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
 *
 * (The store is injected in this file so the store's own contracts can be
 * exercised directly. `rollup-cooldown-wiring.test.ts` covers the other half:
 * that production actually wires the default store up.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const {
  NudgeCooldownStore,
  nudgeCooldownStore,
  resetNudgeCooldownStores,
  NUDGE_COOLDOWN_RETENTION_MS,
  NUDGE_COOLDOWN_FUTURE_SLACK_MS,
} = await import("../src/lcm/nudge-cooldown-store.js");
const { log } = await import("../src/logger.js");

const TEST_DIR = join(tmpdir(), "tomo-test-rollup-cooldown");
const FILE = join(TEST_DIR, "nudge-cooldown.json");
const SESSION = "dm:owner";
const KEY = `${SESSION}:daily:2026-08-28`;
const T0715 = new Date("2026-08-29T07:15:00").getTime();

type Store = InstanceType<typeof NudgeCooldownStore>;

/** A daemon lifetime: one runner over one store. */
function bootRunner(
  store: Store,
  opts: { deliver?: boolean } = {},
): { runner: InstanceType<typeof RollupRunner>; nudges: string[] } {
  const nudges: string[] = [];
  const agent = {
    listActiveSessions: () => [[SESSION, "sdk-session-1"]] as Array<[string, string]>,
    // `false` is how handleCronMessage reports a turn that never happened —
    // no deliverable target, an error result, a throw inside the queue. It
    // does not reject.
    handleCronMessage: async (text: string) => { nudges.push(text); return opts.deliver ?? true; },
  };
  return { runner: new RollupRunner(agent as never, store), nudges };
}

/** `checkAll` is private; the scheduler is the only production caller. */
const checkAll = (runner: InstanceType<typeof RollupRunner>) =>
  (runner as unknown as { checkAll(): Promise<void> }).checkAll();

const onDisk = (): Record<string, number> => JSON.parse(readFileSync(FILE, "utf-8")).nudged;

describe("rollup nudge cooldown persistence", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    resetNudgeCooldownStores();
    // The runner skips outside 07:00–22:00; pin a daytime clock.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0715));
    vi.mocked(log.warn).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetNudgeCooldownStores();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("still holds the cooldown after a restart — the 08:14 → 08:16 re-nudge", async () => {
    const first = bootRunner(new NudgeCooldownStore(FILE));
    await checkAll(first.runner);
    expect(first.nudges).toHaveLength(1);

    // 08:14: daemon restarts. 08:16: first check of the new process.
    vi.setSystemTime(new Date("2026-08-29T08:16:00"));
    const afterRestart = bootRunner(new NudgeCooldownStore(FILE));
    await checkAll(afterRestart.runner);
    expect(afterRestart.nudges).toHaveLength(0);

    // ...and the window still expires normally (07:15 + 6h).
    vi.setSystemTime(new Date("2026-08-29T13:16:00"));
    const later = bootRunner(new NudgeCooldownStore(FILE));
    await checkAll(later.runner);
    expect(later.nudges).toHaveLength(1);
  });

  it("arms no cooldown when the nudge turn never ran", async () => {
    const store = new NudgeCooldownStore(FILE);
    const failed = bootRunner(store, { deliver: false });
    await checkAll(failed.runner);

    // It asked...
    expect(failed.nudges).toHaveLength(1);
    // ...but the ask did not land, so nothing is debounced: a 6h cooldown here
    // buys a 6h hole in which the rollup is due, un-nudged, and skipped by
    // every heartbeat.
    expect(store.size()).toBe(0);
    expect(existsSync(FILE)).toBe(false);

    // The very next hourly check — well inside the 6h window — tries again.
    vi.setSystemTime(new Date("2026-08-29T08:15:00"));
    const retry = bootRunner(store);
    await checkAll(retry.runner);
    expect(retry.nudges).toHaveLength(1);
    expect(store.size()).toBe(1);
  });

  it("shares one store per path, so two runners in one process share one cooldown", async () => {
    expect(nudgeCooldownStore(FILE)).toBe(nudgeCooldownStore(FILE));

    const first = bootRunner(nudgeCooldownStore(FILE));
    await checkAll(first.runner);
    expect(first.nudges).toHaveLength(1);

    // No reload involved — the second runner reads the same live map.
    const second = bootRunner(nudgeCooldownStore(FILE));
    await checkAll(second.runner);
    expect(second.nudges).toHaveLength(0);
  });

  it("merges on write, so a second store over the same path can't erase the first's entries", () => {
    const a = new NudgeCooldownStore(FILE);
    const b = new NudgeCooldownStore(FILE); // independent snapshot, loaded empty

    a.set("dm:owner:daily:2026-08-27", T0715 - 1000);
    b.set(KEY, T0715); // b never saw a's entry; a naive rewrite would drop it

    expect(Object.keys(onDisk()).sort()).toEqual(["dm:owner:daily:2026-08-27", KEY].sort());

    // ...and the merge is symmetric: a's next write picks up b's entry.
    a.set("dm:owner:daily:2026-08-26", T0715);
    expect(Object.keys(onDisk()).sort())
      .toEqual(["dm:owner:daily:2026-08-26", "dm:owner:daily:2026-08-27", KEY].sort());
    expect(a.size()).toBe(3);

    // Newest timestamp per key wins, never the last writer's stale copy.
    b.set(KEY, T0715 + 60_000);
    a.set(KEY, T0715);
    expect(onDisk()[KEY]).toBe(T0715 + 60_000);
  });

  it("treats a corrupt cooldown file as empty, warns once per process, and keeps nudging", async () => {
    writeFileSync(FILE, "{ this is not json");

    // Two runners, one shared store: the file is parsed once, so one warning.
    const first = bootRunner(nudgeCooldownStore(FILE));
    const second = bootRunner(nudgeCooldownStore(FILE));
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);

    // Empty, not stuck: the period is nudged, and the file is rewritten clean.
    await checkAll(first.runner);
    expect(first.nudges).toHaveLength(1);
    expect(onDisk()[KEY]).toBe(T0715);
    await checkAll(second.runner);
    expect(second.nudges).toHaveLength(0);

    // A missing file is the same story, without the warning.
    rmSync(FILE);
    resetNudgeCooldownStores();
    vi.mocked(log.warn).mockClear();
    const fresh = bootRunner(nudgeCooldownStore(FILE));
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    await checkAll(fresh.runner);
    expect(fresh.nudges).toHaveLength(1);
  });

  it("treats valid JSON of the wrong shape as corrupt too, not as a healthy empty store", async () => {
    // Another version, or a `nudged` that is not a record: reading either as
    // empty would silently re-nudge and then overwrite the file as version 1.
    for (const wrong of ['{"version":2,"entries":{}}', '{"version":1,"nudged":[]}', '[]']) {
      writeFileSync(FILE, wrong);
      resetNudgeCooldownStores();
      vi.mocked(log.warn).mockClear();
      const { runner, nudges } = bootRunner(nudgeCooldownStore(FILE));
      expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
      await checkAll(runner);
      expect(nudges).toHaveLength(1);
      expect(onDisk()[KEY]).toBe(T0715);
    }
  });

  it("ignores and drops future-dated entries — a backward clock correction can't suppress for years", async () => {
    // Written by a clock that was days fast; the clock has since been fixed.
    // `now - last` is negative, so a naive check suppresses until it catches up.
    writeFileSync(FILE, JSON.stringify({
      version: 1,
      nudged: { [KEY]: T0715 + 3 * 24 * 60 * 60 * 1000 },
    }));

    const { runner, nudges } = bootRunner(new NudgeCooldownStore(FILE));
    await checkAll(runner);
    expect(nudges).toHaveLength(1);
    expect(onDisk()[KEY]).toBe(T0715); // replaced by a sane stamp, not kept

    // Ordinary small skew is still honoured as a cooldown.
    const skewed = T0715 + NUDGE_COOLDOWN_FUTURE_SLACK_MS - 1000;
    writeFileSync(FILE, JSON.stringify({ version: 1, nudged: { [KEY]: skewed } }));
    const tolerant = bootRunner(new NudgeCooldownStore(FILE));
    await checkAll(tolerant.runner);
    expect(tolerant.nudges).toHaveLength(0);
  });

  it("prunes entries older than the retention window", () => {
    const stale = T0715 - NUDGE_COOLDOWN_RETENTION_MS - 1;
    const recent = T0715 - NUDGE_COOLDOWN_RETENTION_MS + 60_000;
    writeFileSync(FILE, JSON.stringify({
      version: 1,
      nudged: { "dm:owner:daily:2026-08-01": stale, "dm:owner:daily:2026-08-22": recent },
    }));

    const store = new NudgeCooldownStore(FILE);
    expect(store.size()).toBe(1); // the stale one never makes it into memory
    store.set(KEY, T0715);

    expect(Object.keys(onDisk()).sort()).toEqual(["dm:owner:daily:2026-08-22", KEY].sort());
    expect(store.size()).toBe(2);
    expect(existsSync(FILE)).toBe(true);
  });

  it("works purely in memory with a null path", async () => {
    const { runner, nudges } = bootRunner(new NudgeCooldownStore(null));
    await checkAll(runner);
    expect(nudges).toHaveLength(1);
    expect(existsSync(FILE)).toBe(false);
  });
});
