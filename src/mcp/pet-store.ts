import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeFileAtomicSync } from "../fs-utils.js";

const DEFAULT_PET_PATH = path.join(os.homedir(), ".tomo", "data", "pet.json");

export type PetStage = "egg" | "baby" | "child" | "teen" | "adult" | "elder";
export type PetMood =
  | "sleeping"
  | "recovering"
  | "blissful"
  | "happy"
  | "content"
  | "bored"
  | "sad"
  | "miserable"
  | "sick"
  | "hungry";

export interface PetState {
  name: string;
  species: string;
  born_at: string;
  stage: PetStage;
  hunger: number;
  happiness: number;
  energy: number;
  health: number;
  affection: number;
  care_mistakes: number;
  last_care_mistake_at: string | null;
  neglect_started_at: string | null;
  recovering: boolean;
  sleeping: boolean;
  sleep_until: string | null;
  last_tick: string;
  diary: string[];
}

interface CareStats {
  hunger: number;
  happiness: number;
  energy: number;
  health: number;
}

const STAGE_ORDER: PetStage[] = ["egg", "baby", "child", "teen", "adult", "elder"];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HUNGER_DECAY_PER_HOUR = 2;
const RECOVERY_EXIT_HEALTH = 25;
const CARE_MISTAKE_INTERVAL_MS = 6 * HOUR_MS;
const CARE_MISTAKE_AFFECTION_PENALTY = 5;

// Thresholds to reach this stage (affection points + minimum age)
const STAGE_THRESHOLDS: Partial<Record<PetStage, { affection: number; ageMs: number }>> = {
  baby:  { affection: 0,   ageMs: 1   * DAY_MS },
  child: { affection: 20,  ageMs: 7   * DAY_MS },
  teen:  { affection: 60,  ageMs: 14  * DAY_MS },
  adult: { affection: 150, ageMs: 30  * DAY_MS },
  elder: { affection: 600, ageMs: 180 * DAY_MS },
};

export class PetStore {
  private petPath: string;

  constructor(petPath?: string) {
    this.petPath = petPath ?? DEFAULT_PET_PATH;
  }

  exists(): boolean {
    return fs.existsSync(this.petPath);
  }

  load(): PetState | null {
    if (!this.exists()) return null;
    try {
      const state = JSON.parse(fs.readFileSync(this.petPath, "utf-8")) as PetState;
      return this.normalize(state);
    } catch {
      return null;
    }
  }

  save(state: PetState): void {
    fs.mkdirSync(path.dirname(this.petPath), { recursive: true });
    // Atomic: load() treats corrupt JSON as "no pet", and pet_status then
    // steers the user toward pet_hatch, which overwrites the file — a torn
    // write would turn a crash into permanent pet loss.
    writeFileAtomicSync(this.petPath, JSON.stringify(state, null, 2));
  }

  create(name: string, species: string): PetState {
    const now = new Date().toISOString();
    const state: PetState = {
      name,
      species,
      born_at: now,
      stage: "egg",
      hunger: 100,
      happiness: 70,
      energy: 100,
      health: 100,
      affection: 0,
      care_mistakes: 0,
      last_care_mistake_at: null,
      neglect_started_at: null,
      recovering: false,
      sleeping: false,
      sleep_until: null,
      last_tick: now,
      diary: [`${name} appeared as a tiny egg.`],
    };
    this.save(state);
    return state;
  }

  // Apply time-based decay since last_tick. Skips if < 6 minutes elapsed.
  //
  // Time is split correctly for two offline-gap cases:
  // 1. Sleep expired mid-interval: slept hours get energy recovery, remaining
  //    awake hours get hunger/happiness/energy decay.
  // 2. Starvation started mid-interval: health penalty only covers the time
  //    actually spent at hunger=0, not the full elapsed window.
  tick(state: PetState): PetState {
    state = this.normalize(state);
    const now = Date.now();
    const last = new Date(state.last_tick).getTime();
    const elapsedHours = (now - last) / (1000 * 60 * 60);

    if (elapsedHours < 0.1) return this.checkEvolution(this.updateRecovery(state));

    if (state.stage === "egg") {
      state.last_tick = new Date().toISOString();
      return this.checkEvolution(state);
    }

    let awakeHours: number;
    let awakeStartMs = last;
    let careBefore: CareStats | null = null;

    if (state.sleeping) {
      if (state.sleep_until && now >= new Date(state.sleep_until).getTime()) {
        // Sleep expired during the interval — split into slept + awake portions.
        const sleepUntilMs = new Date(state.sleep_until).getTime();
        const sleptHours = Math.max(0, (sleepUntilMs - last) / (1000 * 60 * 60));
        awakeHours = Math.max(0, elapsedHours - sleptHours);
        awakeStartMs = Math.max(last, sleepUntilMs);
        state.energy = Math.min(100, state.energy + sleptHours * 15);
        state = this.recoverHealth(state, sleptHours, 3);
        state.sleeping = false;
        state.sleep_until = null;
        state = this.addDiary(state, `${state.name} woke up refreshed.`);
      } else {
        // Still sleeping for the entire interval.
        state.energy = Math.min(100, state.energy + elapsedHours * 15);
        state = this.recoverHealth(state, elapsedHours, 3);
        awakeHours = 0;
      }
    } else {
      awakeHours = elapsedHours;
    }

    if (awakeHours > 0) {
      careBefore = this.careSnapshot(state);
      const hungerBefore = state.hunger;
      state.hunger    = Math.max(0, state.hunger    - awakeHours * HUNGER_DECAY_PER_HOUR);
      state.happiness = Math.max(0, state.happiness - awakeHours * 3);
      state.energy    = Math.max(0, state.energy    - awakeHours * 4);

      // Health: penalize only for the time actually spent at hunger=0.
      // If hunger was > 0 at the start, starvation began once hunger decayed to zero.
      const starvingHours = hungerBefore > 0
        ? Math.max(0, awakeHours - hungerBefore / HUNGER_DECAY_PER_HOUR)
        : awakeHours;

      if (starvingHours > 0) {
        state.health = Math.max(0, state.health - starvingHours * 8);
      } else if (state.hunger > 60 && state.health < 100) {
        state = this.recoverHealth(state, awakeHours, 2);
      }
    }

    state = this.updateRecovery(state);
    state = this.updateCareMistakes(state, now, awakeStartMs, careBefore);
    state.last_tick = new Date().toISOString();
    return this.checkEvolution(state);
  }

  // Check whether the pet qualifies for the next stage and apply if so.
  checkEvolution(state: PetState): PetState {
    state = this.normalize(state);
    if (state.recovering) return state;

    const currentIdx = STAGE_ORDER.indexOf(state.stage);
    if (currentIdx >= STAGE_ORDER.length - 1) return state;

    const nextStage = STAGE_ORDER[currentIdx + 1];
    const threshold = STAGE_THRESHOLDS[nextStage];
    if (!threshold) return state;

    const ageMs = Date.now() - new Date(state.born_at).getTime();
    const effectiveAffection = this.effectiveAffection(state);
    if (effectiveAffection >= threshold.affection && ageMs >= threshold.ageMs) {
      state.stage = nextStage;
      const entry = nextStage === "baby"
        ? `${state.name} hatched into a baby ${state.species}!`
        : `✨ ${state.name} evolved into a ${nextStage}!`;
      state = this.addDiary(state, entry);
    }
    return state;
  }

  computeMood(state: PetState): PetMood {
    state = this.normalize(state);
    if (state.sleeping) return "sleeping";
    if (state.recovering) return "recovering";
    if (state.health < 40) return "sick";
    if (state.hunger < 20) return "hungry";
    const score =
      state.hunger    * 0.35 +
      state.happiness * 0.35 +
      state.energy    * 0.20 +
      state.health    * 0.10;
    if (score >= 90) return "blissful";
    if (score >= 70) return "happy";
    if (score >= 50) return "content";
    if (score >= 35) return "bored";
    if (score >= 20) return "sad";
    return "miserable";
  }

  addDiary(state: PetState, entry: string): PetState {
    state.diary = [entry, ...state.diary].slice(0, 10);
    return state;
  }

  effectiveAffection(state: PetState): number {
    state = this.normalize(state);
    return Math.max(0, state.affection - state.care_mistakes * CARE_MISTAKE_AFFECTION_PENALTY);
  }

  private normalize(state: PetState): PetState {
    return {
      ...state,
      care_mistakes: state.care_mistakes ?? 0,
      last_care_mistake_at: state.last_care_mistake_at ?? null,
      neglect_started_at: state.neglect_started_at ?? null,
      recovering: state.recovering ?? state.health <= 0,
    };
  }

  private recoverHealth(state: PetState, hours: number, rate: number): PetState {
    if (hours > 0 && state.hunger > 60 && state.health < 100) {
      state.health = Math.min(100, state.health + hours * rate);
    }
    return state;
  }

  private updateRecovery(state: PetState): PetState {
    if (state.health <= 0 && !state.recovering) {
      state.recovering = true;
      state.care_mistakes += 3;
      state.last_care_mistake_at = new Date().toISOString();
      state.neglect_started_at = null;
      return this.addDiary(state, `${state.name} collapsed and needs recovery care.`);
    }

    if (state.recovering && state.health >= RECOVERY_EXIT_HEALTH) {
      state.recovering = false;
      state.last_care_mistake_at = new Date().toISOString();
      state.neglect_started_at = null;
      return this.addDiary(state, `${state.name} is out of recovery.`);
    }

    return state;
  }

  private updateCareMistakes(
    state: PetState,
    nowMs: number,
    awakeStartMs: number,
    before: CareStats | null,
  ): PetState {
    if (state.stage === "egg" || state.recovering || state.sleeping || !before) {
      state.neglect_started_at = null;
      return state;
    }

    const neglected = this.isNeglected(this.careSnapshot(state));

    if (!neglected) {
      state.neglect_started_at = null;
      return state;
    }

    if (!state.neglect_started_at) {
      const startedAt = this.estimateNeglectStartMs(before, awakeStartMs, nowMs);
      state.neglect_started_at = new Date(startedAt).toISOString();
    }

    const neglectStartedAt = new Date(state.neglect_started_at).getTime();
    const lastMistake = state.last_care_mistake_at
      ? new Date(state.last_care_mistake_at).getTime()
      : neglectStartedAt;
    const windowStart = Math.max(neglectStartedAt, lastMistake);
    const elapsedWindows = Math.floor((nowMs - windowStart) / CARE_MISTAKE_INTERVAL_MS);

    if (elapsedWindows > 0) {
      state.care_mistakes += elapsedWindows;
      state.last_care_mistake_at = new Date(
        windowStart + elapsedWindows * CARE_MISTAKE_INTERVAL_MS,
      ).toISOString();

      const entry = elapsedWindows === 1
        ? `${state.name} needed care and was left waiting.`
        : `${state.name} needed care through ${elapsedWindows} neglect windows.`;
      return this.addDiary(state, entry);
    }

    return state;
  }

  private careSnapshot(state: PetState): CareStats {
    return {
      hunger: state.hunger,
      happiness: state.happiness,
      energy: state.energy,
      health: state.health,
    };
  }

  private isNeglected(stats: CareStats): boolean {
    return (
      stats.hunger < 20 ||
      stats.happiness < 20 ||
      stats.energy < 10 ||
      stats.health < 40
    );
  }

  private estimateNeglectStartMs(before: CareStats, awakeStartMs: number, nowMs: number): number {
    if (this.isNeglected(before)) return awakeStartMs;

    const hoursUntilNeglect = [
      before.hunger <= 20 ? 0 : (before.hunger - 20) / HUNGER_DECAY_PER_HOUR,
      before.happiness <= 20 ? 0 : (before.happiness - 20) / 3,
      before.energy <= 10 ? 0 : (before.energy - 10) / 4,
    ];

    const earliestMs = awakeStartMs + Math.min(...hoursUntilNeglect) * HOUR_MS;
    return Math.min(nowMs, earliestMs);
  }
}
