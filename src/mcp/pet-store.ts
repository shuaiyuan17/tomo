import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_PET_PATH = path.join(os.homedir(), ".tomo", "data", "pet.json");

export type PetStage = "egg" | "baby" | "child" | "teen" | "adult" | "elder";
export type PetMood =
  | "sleeping"
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
  sleeping: boolean;
  sleep_until: string | null;
  last_tick: string;
  diary: string[];
}

const STAGE_ORDER: PetStage[] = ["egg", "baby", "child", "teen", "adult", "elder"];

// Thresholds to reach this stage (affection points + minimum age)
const STAGE_THRESHOLDS: Partial<Record<PetStage, { affection: number; ageMs: number }>> = {
  baby:  { affection: 1,   ageMs: 0 },
  child: { affection: 20,  ageMs: 1  * 24 * 60 * 60 * 1000 },
  teen:  { affection: 60,  ageMs: 3  * 24 * 60 * 60 * 1000 },
  adult: { affection: 150, ageMs: 7  * 24 * 60 * 60 * 1000 },
  elder: { affection: 0,   ageMs: 30 * 24 * 60 * 60 * 1000 },
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
      return JSON.parse(fs.readFileSync(this.petPath, "utf-8")) as PetState;
    } catch {
      return null;
    }
  }

  save(state: PetState): void {
    fs.mkdirSync(path.dirname(this.petPath), { recursive: true });
    fs.writeFileSync(this.petPath, JSON.stringify(state, null, 2), "utf-8");
  }

  create(name: string, species: string): PetState {
    const now = new Date().toISOString();
    const state: PetState = {
      name,
      species,
      born_at: now,
      stage: "baby",
      hunger: 80,
      happiness: 70,
      energy: 90,
      health: 100,
      affection: 1,
      sleeping: false,
      sleep_until: null,
      last_tick: now,
      diary: [`${name} hatched!`],
    };
    this.save(state);
    return state;
  }

  // Apply time-based decay since last_tick. Skips if < 6 minutes elapsed.
  tick(state: PetState): PetState {
    const now = Date.now();
    const last = new Date(state.last_tick).getTime();
    const elapsedHours = (now - last) / (1000 * 60 * 60);

    if (elapsedHours < 0.1) return this.checkEvolution(state);

    if (state.sleeping) {
      // Check if sleep timer expired
      if (state.sleep_until && now >= new Date(state.sleep_until).getTime()) {
        state.sleeping = false;
        state.sleep_until = null;
        state.energy = Math.min(100, state.energy + elapsedHours * 15);
        state = this.addDiary(state, `${state.name} woke up refreshed.`);
      } else {
        state.energy = Math.min(100, state.energy + elapsedHours * 15);
      }
    } else {
      state.hunger    = Math.max(0, state.hunger    - elapsedHours * 5);
      state.happiness = Math.max(0, state.happiness - elapsedHours * 3);
      state.energy    = Math.max(0, state.energy    - elapsedHours * 4);
    }

    if (state.hunger === 0) {
      state.health = Math.max(0, state.health - elapsedHours * 8);
    } else if (state.hunger > 60 && state.health < 100) {
      state.health = Math.min(100, state.health + elapsedHours * 2);
    }

    state.last_tick = new Date().toISOString();
    return this.checkEvolution(state);
  }

  // Check whether the pet qualifies for the next stage and apply if so.
  checkEvolution(state: PetState): PetState {
    const currentIdx = STAGE_ORDER.indexOf(state.stage);
    if (currentIdx >= STAGE_ORDER.length - 1) return state;

    const nextStage = STAGE_ORDER[currentIdx + 1];
    const threshold = STAGE_THRESHOLDS[nextStage];
    if (!threshold) return state;

    const ageMs = Date.now() - new Date(state.born_at).getTime();
    if (state.affection >= threshold.affection && ageMs >= threshold.ageMs) {
      state.stage = nextStage;
      state = this.addDiary(state, `✨ ${state.name} evolved into a ${nextStage}!`);
    }
    return state;
  }

  computeMood(state: PetState): PetMood {
    if (state.sleeping) return "sleeping";
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
}
