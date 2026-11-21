import type { HomeWander } from "../../../src/home/scene.js";
import { WANDER_EVERY_DEFAULT } from "./contract.js";
import { holds, type Conditions } from "./evaluate.js";

/**
 * Wandering, without three.js and without a clock or a die of its own: the
 * caller passes the time (seconds) and a random source, so a fixed seed and
 * a fake clock give the same stroll every time.
 *
 * A character with `wander` strolls between its wander spots while no rule
 * holds and its `wander.when` (if any) does; Tomo only while idle. Under the
 * viewer's reduced-motion setting nobody wanders: a jump to another spot
 * every half minute, for no reason, is a sudden change that says nothing
 * (a rule's jump says "it started working", so that one stays).
 *
 * It stays a random time from `every` at each spot, then walks to another,
 * picked evenly from the rest: never the one it is at, never one another
 * character is at or heading to, never one it cannot walk to from here (the
 * caller's `allowed`). The moment a rule holds, the wander is dropped and the
 * rule's spot is where it goes; when the rule stops, it wanders again,
 * staying once where it is first.
 */

/** A random number in [0, 1). */
export type Random = () => number;

/** A small seeded generator (mulberry32): the same seed, the same numbers. */
export function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where a wander is: at (or walking to) `spot`, leaving for the next at `leaveAt` (seconds on the caller's clock). */
export interface WanderState { spot: string; leaveAt: number }

/** Whether it may walk from one spot to another (it can, and nobody else is there or going there). */
export type Allowed = (from: string, to: string) => boolean;
/** How long the walk from one spot to another takes, seconds. */
export type Travel = (from: string, to: string) => number;

export interface Wanderer {
  /** Its own spot: where it stands when not wandering. */
  spot: string;
  rules?: ReadonlyArray<{ when: string | string[]; spot: string }>;
  wander?: HomeWander;
}

/** The seconds it stays at a spot: even over [shortest, longest]. */
export function stayFor(every: readonly [number, number] | undefined, random: Random): number {
  const [low, high] = every ?? WANDER_EVERY_DEFAULT;
  return low + (high - low) * random();
}

/** The next spot, evenly among the wander spots it may go to from `current` (not `current` itself); none when there is nowhere. */
export function pickNext(spots: readonly string[], current: string | undefined, random: Random, allowed: (to: string) => boolean = () => true): string | undefined {
  const options = [...new Set(spots)].filter((spot) => spot !== current && allowed(spot));
  if (!options.length) return undefined;
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
}

/** Whether it wanders under these conditions (no rule holding is the caller's part). */
export function wanders(character: Wanderer, conditions: Conditions, options: { tomo: boolean; reduced: boolean }): boolean {
  const wander = character.wander;
  if (!wander || options.reduced) return false;
  if (options.tomo && !conditions.has("idle")) return false;
  return wander.when === undefined || holds(wander.when, conditions);
}

/**
 * A wander starting now from `at`. `first` (the page has just opened): it
 * is put straight at one of its wander spots it can get to from `at` (or
 * `at`, if none), with no walk; `allowed(at, at)` says whether `at` itself
 * is free. Either way it then stays there once.
 */
export function startWander(wander: HomeWander, at: string, now: number, random: Random, options: { first?: boolean; allowed?: Allowed } = {}): WanderState {
  const allowed = options.allowed ?? (() => true);
  // Its own spot too only if allowed (someone else may be standing there); none allowed: its own spot, as without wander.
  const spot = options.first ? pickNext(wander.spots, undefined, random, (to) => allowed(at, to)) ?? at : at;
  return { spot, leaveAt: now + stayFor(wander.every, random) };
}

/** The wander at `now`: the same until its stay is over, then off to the next spot (arriving after `travel`, then staying). */
export function stepWander(state: WanderState, wander: HomeWander, now: number, random: Random, options: { allowed?: Allowed; travel?: Travel } = {}): WanderState {
  if (now < state.leaveAt) return state;
  const allowed = options.allowed ?? (() => true);
  const next = pickNext(wander.spots, state.spot, random, (to) => allowed(state.spot, to));
  // Nowhere to go just now (the others are taken): stay another while.
  if (next === undefined) return { spot: state.spot, leaveAt: now + stayFor(wander.every, random) };
  return { spot: next, leaveAt: now + (options.travel?.(state.spot, next) ?? 0) + stayFor(wander.every, random) };
}

export interface Placing {
  /** The spot it should be at, or walking to. */
  spot: string;
  /** Why: a rule holds, it wanders, or it stands at its own spot. */
  by: "rule" | "wander" | "spot";
  /** The wander to keep for next time (null when not wandering). */
  wander: WanderState | null;
}

/**
 * Where a character goes now. The first rule that holds wins (and drops the
 * wander: it goes there at once); otherwise it wanders if it may, else it
 * stands at its own spot. `at` is the spot it is at or heading to now
 * (undefined: it is new on the page, so `first`). `hold`: a wander under
 * way stays as it is (rules still win).
 */
export function placeCharacter(character: Wanderer, conditions: Conditions, previous: WanderState | null, now: number, random: Random,
  options: { tomo: boolean; reduced: boolean; at?: string; allowed?: Allowed; travel?: Travel; hold?: boolean }): Placing {
  const rule = character.rules?.find((r) => holds(r.when, conditions));
  if (rule) return { spot: rule.spot, by: "rule", wander: null };
  if (!character.wander || !wanders(character, conditions, options)) return { spot: character.spot, by: "spot", wander: null };
  const state = previous ?? startWander(character.wander, options.at ?? character.spot, now, random, { first: options.at === undefined, allowed: options.allowed });
  // `hold` (the page is hidden): a wander under way does not move on, however late it is.
  const next = options.hold && previous ? previous : stepWander(state, character.wander, now, random, { allowed: options.allowed, travel: options.travel });
  return { spot: next.spot, by: "wander", wander: next };
}
