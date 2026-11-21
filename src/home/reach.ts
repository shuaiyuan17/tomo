import { placeScene, type Placement, type Vec3 } from "./geometry.js";
import {
  buildNavGrid, cellAt, cellCentre, findRoute, hopBlockers, isFloor, landings, NAV_MAX_HOP, NAV_PERCH_TOLERANCE, NAV_PET, NAV_WALKER,
  type FloorPoint, type Hurdle, type NavGrid, type RouteResult, type WalkerSize,
} from "./nav.js";
import type { HomeScene } from "./scene.js";
import { MAX_WAITING_DRAWN, waitingPosition } from "./waiting.js";

/**
 * Which places each character can walk between, for home_check's warnings
 * and the floor plan. A character can be at its default spot, at any spot
 * its rules name, and a visitor at any seat or any place in the queue at the
 * overflow spot (where the page stands it: waiting.ts). It may have to walk
 * from any of these to any other, so every ordered pair is checked, at the
 * character's own size: Tomo and the visitors NAV_WALKER, the pet NAV_PET,
 * as the page does (web/src/home/three/stage.ts). Where it cannot, the page
 * fades it out and back in; this says why, naming what is in the way.
 *
 * Whether a place can be reached needs only the grid's regions and the
 * landings (as findRoute decides it before its search), so the check never
 * searches a path; the floor plan does, for the lengths it prints.
 */

export type Mover = "tomo" | "visitors" | "pet";
export const MOVER_NAMES: Record<Mover, string> = { tomo: "Tomo", visitors: "a visitor", pet: "the pet" };

export function walkerOf(who: Mover): WalkerSize {
  return who === "pet" ? NAV_PET : NAV_WALKER;
}

/** A place a character can be: a spot, or (`queue`, 0-based) a place in the visitors' queue at one; `place` is where the scene names it. */
export interface CharacterPlace { who: Mover; spot: string; at: Vec3; place: string; queue?: number }

/** Every place each character can be, in the scene's order, each once (defined spots only). */
export function characterPlaces(scene: HomeScene): Map<Mover, CharacterPlace[]> {
  const c = scene.characters, spots = scene.spots ?? {};
  const out = new Map<Mover, CharacterPlace[]>();
  const add = (who: Mover, spot: string, place: string, at: Vec3 | undefined = spots[spot]?.at, queue?: number) => {
    if (!at) return;
    const list = out.get(who) ?? [];
    if (list.some((p) => Math.hypot(p.at[0] - at[0], p.at[1] - at[1], p.at[2] - at[2]) < 1e-6)) return;
    list.push({ who, spot, at, place, ...(queue !== undefined ? { queue } : {}) });
    out.set(who, list);
  };
  if (c?.tomo) {
    add("tomo", c.tomo.spot, "characters.tomo.spot");
    (c.tomo.rules ?? []).forEach((rule, i) => add("tomo", rule.spot, `characters.tomo.rules[${i}]`));
  }
  if (c?.visitors) {
    c.visitors.spots.forEach((spot, i) => add("visitors", spot, `characters.visitors.spots[${i}]`));
    const overflow = c.visitors.overflow;
    if (overflow !== undefined && spots[overflow]) {
      for (let queue = 0; queue < MAX_WAITING_DRAWN; queue++) add("visitors", overflow, "characters.visitors.overflow", waitingPosition(spots[overflow], queue, scene.room.size), queue);
    }
  }
  if (c?.pet) {
    add("pet", c.pet.spot, "characters.pet.spot");
    (c.pet.rules ?? []).forEach((rule, i) => add("pet", rule.spot, `characters.pet.rules[${i}]`));
  }
  return out;
}

/** What a character cannot do: the places it cannot leave, and for each other place it cannot walk to, from where (merged by spot). */
export interface CharacterReach {
  who: Mover;
  places: CharacterPlace[];
  stuck: { at: CharacterPlace; found: Unreachable }[];
  /** Per target spot: the first place there it cannot walk to, every place it cannot walk to it from, and why (for the first pair). */
  cut: { to: CharacterPlace; from: CharacterPlace[]; found: Unreachable }[];
  /** The places in each area of the floor they share (an area is a set of grid regions), for places that can get to the floor. */
  areas: CharacterPlace[][];
}

export function characterReach(reach: SceneReach, scene: HomeScene): CharacterReach[] {
  const out: CharacterReach[] = [];
  for (const [who, places] of characterPlaces(scene)) {
    const walker = walkerOf(who);
    const stuck: CharacterReach["stuck"] = [];
    const free: CharacterPlace[] = [];
    for (const at of places) {
      const found = reach.leave(at.at, walker);
      if (found.ok) free.push(at); else stuck.push({ at, found });
    }
    const cut: CharacterReach["cut"] = [];
    for (const to of free) {
      for (const from of free) {
        if (from === to) continue;
        const found = reach.reach(from.at, to.at, walker);
        if (found.ok) continue;
        const entry = cut.find((c) => c.to.spot === to.spot);
        if (!entry) cut.push({ to, from: [from], found });
        else if (!entry.from.includes(from)) entry.from.push(from);
      }
    }
    const areas = new Map<string, CharacterPlace[]>();
    for (const at of free) {
      const key = reach.regions(at.at, walker).join();
      areas.set(key, [...(areas.get(key) ?? []), at]);
    }
    out.push({ who, places, stuck, cut, areas: [...areas.values()] });
  }
  return out;
}

/** Why a place cannot be reached (or left). */
export interface Unreachable {
  ok: false;
  /** `stuck`: no floor to step or hop down to from the start. `unreachable`: the target is cut off. */
  reason: "stuck" | "unreachable";
  /** How far the nearest floor the character can stand on is from the place it cannot reach (or leave). */
  nearest: number;
  /**
   * `outside`: the place is outside the room.
   * `hop`: there is floor within a hop, but the hop crosses `blockers`.
   * `far`: no such floor within NAV_MAX_HOP; `blockers` is the nearest thing in the way.
   * `crowded`: a floor place too close to `blockers` (none: the wall) for a walker this size.
   * `walled`: a floor place whose floor is cut off; `blockers` is the nearest thing in the way.
   */
  why: "outside" | "hop" | "far" | "crowded" | "walled";
  blockers: Hurdle[];
}
export type Reach = { ok: true } | Unreachable;

/** Reachability in one scene: a grid per walker size, built when first asked for. */
export class SceneReach {
  readonly placement: Placement;
  private grids = new Map<WalkerSize, NavGrid>();
  private regionsOf = new Map<string, number[]>();
  private landsIn = new Map<string, boolean>();
  constructor(readonly scene: HomeScene, placement?: Placement) {
    this.placement = placement ?? placeScene(scene);
  }
  grid(walker: WalkerSize): NavGrid {
    let grid = this.grids.get(walker);
    if (!grid) { grid = buildNavGrid(this.scene, { walker, placement: this.placement }); this.grids.set(walker, grid); }
    return grid;
  }
  spotAt(spot: string): Vec3 { return this.scene.spots![spot].at; }

  /** The regions a walker standing at `at` can walk in (none: it cannot get to the floor). */
  regions(at: Vec3, walker: WalkerSize): number[] {
    const key = `${walker.radius}/${walker.headroom}/${at.join(",")}`;
    let regions = this.regionsOf.get(key);
    if (!regions) {
      const grid = this.grid(walker);
      regions = [...new Set(landings(grid, at).map((l) => grid.region[l.cell]))].sort((a, b) => a - b);
      this.regionsOf.set(key, regions);
    }
    return regions;
  }
  /** Whether a walker at `at` can get to the floor at all, or why not. */
  leave(at: Vec3, walker: WalkerSize): Reach {
    return this.regions(at, walker).length ? { ok: true } : explain(this.grid(walker), at, undefined, "stuck");
  }
  /** Whether a walker at `from` can walk to `to`, or why not: findRoute's test, without the search. */
  reach(from: Vec3, to: Vec3, walker: WalkerSize): Reach {
    const regions = this.regions(from, walker);
    if (!regions.length) return explain(this.grid(walker), from, undefined, "stuck");
    const grid = this.grid(walker);
    // Whether `to` has a landing in these regions: the same for every start in them.
    const key = `${walker.radius}/${walker.headroom}/${to.join(",")}/${regions.join(",")}`;
    let lands = this.landsIn.get(key);
    if (lands === undefined) { lands = landings(grid, to, { regions }).length > 0; this.landsIn.set(key, lands); }
    return lands ? { ok: true } : explain(grid, to, regions, "unreachable");
  }
  /** The way itself, for the floor plan's lengths. */
  route(from: Vec3, to: Vec3, walker: WalkerSize): RouteResult {
    return findRoute(this.grid(walker), from, to);
  }
}

function explain(grid: NavGrid, at: Vec3, regions: readonly number[] | undefined, reason: Unreachable["reason"]): Unreachable {
  const allowed = (k: number) => grid.region[k] >= 0 && (!regions || regions.includes(grid.region[k]));
  let nearest: { point: FloorPoint; d: number } | undefined;
  for (let k = 0; k < grid.blocked.length; k++) {
    if (!allowed(k)) continue;
    const point = cellCentre(grid, k);
    const d = Math.hypot(point[0] - at[0], point[1] - at[2]);
    if (!nearest || d < nearest.d) nearest = { point, d };
  }
  const distance = nearest?.d ?? Infinity;
  if (Math.abs(at[0]) > grid.room[0] / 2 || Math.abs(at[2]) > grid.room[1] / 2) return { ok: false, reason, nearest: distance, why: "outside", blockers: [] };
  const standing = grid.hurdles.filter((h) => h.bottom < grid.headroom);
  if (isFloor(at)) {
    const k = cellAt(grid, at[0], at[2]);
    if (k >= 0 && grid.blocked[k]) {
      // Too close to something (within the walker's radius of its cell), or else to the wall.
      const close = nearestOf(standing, at, []).filter((h) => gap(h, at) < grid.radius + grid.cell);
      return { ok: false, reason, nearest: distance, why: "crowded", blockers: close };
    }
    return { ok: false, reason, nearest: distance, why: "walled", blockers: nearestOf(standing, at, []) };
  }
  // A perch: floor within a hop, but every such hop is blocked (by what, all told); else too far.
  if (nearest && nearest.d <= NAV_MAX_HOP) {
    const blockers = new Map<string, Hurdle>();
    for (let k = 0; k < grid.blocked.length; k++) {
      if (!allowed(k)) continue;
      const point = cellCentre(grid, k);
      if (Math.hypot(point[0] - at[0], point[1] - at[2]) > NAV_MAX_HOP) continue;
      for (const h of hopBlockers(grid, at, point)) blockers.set(`${h.object}:${h.leaf}`, h);
    }
    if (blockers.size) return { ok: false, reason, nearest: distance, why: "hop", blockers: [...blockers.values()].sort((a, b) => a.object - b.object || a.leaf - b.leaf) };
  }
  const under = standing.filter((h) => Math.abs(h.top - at[1]) <= NAV_PERCH_TOLERANCE && at[0] >= h.min[0] && at[0] <= h.max[0] && at[2] >= h.min[1] && at[2] <= h.max[1]);
  return { ok: false, reason, nearest: distance, why: "far", blockers: nearestOf(standing, at, under) };
}

/** How far `at` is from an obstacle, seen from above. */
function gap(h: Hurdle, at: Vec3): number {
  return Math.hypot(Math.max(h.min[0] - at[0], 0, at[0] - h.max[0]), Math.max(h.min[1] - at[2], 0, at[2] - h.max[1]));
}
/** The obstacle nearest to `at` (seen from above), leaving out `skip` (what a perch is on) and the rest of the objects those belong to. */
function nearestOf(hurdles: readonly Hurdle[], at: Vec3, skip: readonly Hurdle[]): Hurdle[] {
  const own = new Set(skip.map((h) => h.object));
  let best: Hurdle | undefined, bestD = Infinity;
  for (const h of hurdles) {
    if (own.has(h.object)) continue;
    const d = gap(h, at);
    if (d < bestD) { best = h; bestD = d; }
  }
  return best ? [best] : [];
}
