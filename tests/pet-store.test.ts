import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PetStore } from "../src/mcp/pet-store.js";
import { buildPetTools } from "../src/mcp/pet-tools.js";

const TEST_DIR = join(tmpdir(), "tomo-test-pet");
const TEST_PATH = join(TEST_DIR, "pet.json");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function runPetTool(name: string, args: Record<string, unknown> = {}) {
  const tool = buildPetTools(TEST_PATH).find((t) => t.name === name);
  if (!tool) throw new Error(`Missing pet tool ${name}`);
  return tool.handler(args as never, {});
}

describe("PetStore", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("starts pets as eggs and hatches after one day without stat decay", () => {
    const store = new PetStore(TEST_PATH);
    let pet = store.create("Mochi", "star");

    expect(pet.stage).toBe("egg");
    expect(pet.affection).toBe(0);
    expect(pet.hunger).toBe(100);

    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    pet = store.tick(pet);

    expect(pet.stage).toBe("baby");
    expect(pet.hunger).toBe(100);
    expect(pet.diary[0]).toContain("hatched into a baby");
  });

  it("uses slow age and affection gates for later stages", () => {
    const store = new PetStore(TEST_PATH);
    const pet = store.create("Mochi", "star");

    vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
    pet.stage = "baby";
    pet.born_at = new Date(Date.now() - 7 * DAY_MS).toISOString();
    pet.affection = 19;
    expect(store.checkEvolution(pet).stage).toBe("baby");

    pet.affection = 20;
    expect(store.checkEvolution(pet).stage).toBe("child");

    pet.stage = "teen";
    pet.born_at = new Date(Date.now() - 30 * DAY_MS).toISOString();
    pet.affection = 149;
    pet.care_mistakes = 0;
    expect(store.checkEvolution(pet).stage).toBe("teen");

    pet.affection = 150;
    expect(store.checkEvolution(pet).stage).toBe("adult");

    pet.stage = "teen";
    pet.affection = 150;
    pet.care_mistakes = 1;
    expect(store.checkEvolution(pet).stage).toBe("teen");

    pet.affection = 155;
    expect(store.checkEvolution(pet).stage).toBe("adult");

    pet.stage = "adult";
    pet.born_at = new Date(Date.now() - 180 * DAY_MS).toISOString();
    pet.affection = 599;
    pet.care_mistakes = 0;
    expect(store.checkEvolution(pet).stage).toBe("adult");

    pet.affection = 600;
    expect(store.checkEvolution(pet).stage).toBe("elder");
  });

  it("puts a zero-health pet into recovery and blocks evolution", () => {
    const store = new PetStore(TEST_PATH);
    let pet = store.create("Mochi", "star");
    pet.stage = "adult";
    pet.born_at = new Date(Date.now() - 180 * DAY_MS).toISOString();
    pet.affection = 600;
    pet.hunger = 0;
    pet.health = 4;
    pet.last_tick = new Date(Date.now() - HOUR_MS).toISOString();

    pet = store.tick(pet);

    expect(pet.health).toBe(0);
    expect(pet.recovering).toBe(true);
    expect(pet.care_mistakes).toBe(3);
    expect(store.computeMood(pet)).toBe("recovering");
    expect(pet.stage).toBe("adult");
  });

  it("leaves recovery after health recovers above the threshold", () => {
    const store = new PetStore(TEST_PATH);
    let pet = store.create("Mochi", "star");
    pet.stage = "adult";
    pet.recovering = true;
    pet.hunger = 80;
    pet.health = 24;
    pet.last_tick = new Date(Date.now() - HOUR_MS).toISOString();

    pet = store.tick(pet);

    expect(pet.health).toBe(26);
    expect(pet.recovering).toBe(false);
    expect(pet.diary[0]).toContain("out of recovery");
  });

  it("decays hunger by two points per awake hour before starvation damage", () => {
    const store = new PetStore(TEST_PATH);
    let pet = store.create("Mochi", "star");
    pet.stage = "baby";
    pet.hunger = 6;
    pet.health = 100;
    pet.last_tick = new Date(Date.now() - 4 * HOUR_MS).toISOString();

    pet = store.tick(pet);

    expect(pet.hunger).toBe(0);
    expect(pet.health).toBe(92);
  });

  it("counts each elapsed care-mistake window during offline neglect", () => {
    const store = new PetStore(TEST_PATH);
    let pet = store.create("Mochi", "star");
    pet.stage = "baby";
    pet.hunger = 100;
    pet.happiness = 10;
    pet.energy = 100;
    pet.health = 100;
    pet.last_tick = new Date(Date.now() - 12 * HOUR_MS).toISOString();

    pet = store.tick(pet);

    expect(pet.care_mistakes).toBe(2);
    expect(pet.last_care_mistake_at).toBe(new Date(Date.now()).toISOString());
    expect(pet.diary[0]).toContain("2 neglect windows");
  });

  it("does not reset the care-mistake throttle when stats recover briefly", () => {
    const store = new PetStore(TEST_PATH);
    const t0 = Date.now();
    let pet = store.create("Mochi", "star");
    pet.stage = "baby";
    pet.care_mistakes = 1;
    pet.last_care_mistake_at = new Date(t0).toISOString();
    pet.hunger = 50;
    pet.happiness = 50;
    pet.energy = 50;
    pet.health = 100;
    pet.last_tick = new Date(t0).toISOString();

    vi.setSystemTime(new Date(t0 + HOUR_MS));
    pet = store.tick(pet);

    expect(pet.care_mistakes).toBe(1);
    expect(pet.last_care_mistake_at).toBe(new Date(t0).toISOString());
    expect(pet.neglect_started_at).toBeNull();

    pet.hunger = 80;
    pet.happiness = 10;
    pet.energy = 80;
    pet.health = 100;
    vi.setSystemTime(new Date(t0 + 2 * HOUR_MS));
    pet = store.tick(pet);

    expect(pet.care_mistakes).toBe(1);
    expect(pet.neglect_started_at).toBe(new Date(t0 + HOUR_MS).toISOString());

    vi.setSystemTime(new Date(t0 + 7 * HOUR_MS));
    pet = store.tick(pet);

    expect(pet.care_mistakes).toBe(2);
    expect(pet.last_care_mistake_at).toBe(new Date(t0 + 7 * HOUR_MS).toISOString());
  });

  it("does not grant feed affection when full or recovering", async () => {
    const store = new PetStore(TEST_PATH);
    let pet = store.create("Mochi", "star");
    pet.stage = "baby";
    pet.hunger = 95;
    pet.affection = 0;
    store.save(pet);

    await runPetTool("pet_feed");
    pet = store.load()!;
    expect(pet.hunger).toBe(95);
    expect(pet.affection).toBe(0);

    pet.hunger = 45;
    store.save(pet);
    await runPetTool("pet_feed");
    pet = store.load()!;
    expect(pet.hunger).toBe(75);
    expect(pet.affection).toBe(1);

    pet.hunger = 45;
    pet.health = 0;
    pet.recovering = true;
    store.save(pet);
    await runPetTool("pet_feed");
    pet = store.load()!;
    expect(pet.hunger).toBe(75);
    expect(pet.affection).toBe(1);
    expect(pet.recovering).toBe(true);
  });
});
