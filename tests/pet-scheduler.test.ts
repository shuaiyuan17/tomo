import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every path under test derives from $HOME (PetStore's default pet.json lives
// at ~/.tomo/data/pet.json), so point HOME at a scratch dir BEFORE the modules
// that compute those paths are imported. Nothing here ever touches the real
// home directory, and no test writes to disk: PetStore is stubbed at the
// prototype.
let home = "";

async function loadModules() {
  vi.resetModules();
  vi.stubEnv("HOME", home);
  const [{ PetScheduler }, { PetStore }] = await Promise.all([
    import("../src/mcp/pet-scheduler.js"),
    import("../src/mcp/pet-store.js"),
  ]);
  return { PetScheduler, PetStore };
}

type PetStoreModule = Awaited<ReturnType<typeof loadModules>>["PetStore"];
type PetState = ReturnType<InstanceType<PetStoreModule>["create"]>;

function petState(): PetState {
  return {
    name: "Blip",
    species: "slime",
    born_at: "2026-08-01T00:00:00.000Z",
    stage: "baby",
    hunger: 80,
    happiness: 80,
    energy: 80,
    health: 80,
    affection: 10,
    care_mistakes: 0,
    last_care_mistake_at: null,
    neglect_started_at: null,
    recovering: false,
    sleeping: false,
    sleep_until: null,
    last_tick: "2026-08-01T00:00:00.000Z",
    diary: [],
  } as PetState;
}

/** Minimal stand-in for the Agent the scheduler notifies. */
function fakeAgent() {
  return { sendNotification: vi.fn(async () => {}) };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tomo-pet-sched-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

describe("PetScheduler resilience", () => {
  it("survives a PetStore write failure at startup instead of taking the daemon down", async () => {
    const { PetScheduler, PetStore } = await loadModules();
    vi.spyOn(PetStore.prototype, "load").mockReturnValue(petState());
    vi.spyOn(PetStore.prototype, "save").mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });

    const scheduler = new PetScheduler(fakeAgent() as never);
    // start() ticks synchronously; an unguarded throw here escapes into
    // startForeground and kills daemon startup.
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it("survives a PetStore write failure inside the interval callback", async () => {
    vi.useFakeTimers();
    const { PetScheduler, PetStore } = await loadModules();
    const load = vi.spyOn(PetStore.prototype, "load").mockReturnValue(petState());
    const save = vi.spyOn(PetStore.prototype, "save").mockImplementation(() => {
      throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    });

    const scheduler = new PetScheduler(fakeAgent() as never);
    scheduler.start();
    save.mockClear();
    load.mockClear();

    // A throw out of a setInterval callback has no handler above it in the
    // daemon (there is no process-level unhandledException net), so it ends
    // the process. It must not escape the scheduler.
    expect(() => vi.advanceTimersByTime(60 * 60 * 1000)).not.toThrow();
    expect(save).toHaveBeenCalledTimes(1);

    // ...and the scheduler keeps ticking afterwards rather than wedging.
    expect(() => vi.advanceTimersByTime(60 * 60 * 1000)).not.toThrow();
    expect(save).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("does not hold the event loop open with its hourly timer", async () => {
    const { PetScheduler, PetStore } = await loadModules();
    // No pet hatched: tick() returns early, so this test only observes the timer.
    vi.spyOn(PetStore.prototype, "load").mockReturnValue(null);

    const scheduler = new PetScheduler(fakeAgent() as never);
    scheduler.start();
    const timer = (scheduler as unknown as { timer: NodeJS.Timeout }).timer;
    expect(timer.hasRef()).toBe(false);
    scheduler.stop();
  });
});
