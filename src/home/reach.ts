import { placeScene, type Placement, type Vec3 } from "./geometry.js";
import {
  buildNavGrid, cellAt, cellCentre, findRoute, hopBlockers, isFloor, landings, NAV_MAX_HOP, NAV_PERCH_TOLERANCE, NAV_PET, NAV_WALKER,
  type FloorPoint, type Hurdle, type NavGrid, type RouteResult, type WalkerSize,
} from "./nav.js";
import type { HomeScene } from "./scene.js";
import { MAX_WAITING_DRAWN, waitingPosition } from "./waiting.js";

/**
 * Which spots each character can walk to, for home_check's warnings and the
 * floor plan. A character walks from its default spot to each spot its rules
 * name; a visitor from its place in the queue at the overflow spot (where
 * the page stands it: waiting.ts) to each seat. Each at its own size: Tomo
 * and the visitors NAV_WALKER, the pet NAV_PET, as the page does
 * (web/src/home/three/stage.ts). Where it cannot, the page fades it out and
 * back in; this says why, naming what is in the way.
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

/** A move a character makes: from its start spot to another, named at `place` in the scene. */
export interface SpotUse { who: Mover; place: string; from: string; to: string }
/** Where a character starts from: its spot, and for the visitors each place in the queue there (`queue` is the 0-based place). */
export interface StartPoint { at: Vec3; queue?: number }
/** Where a character starts, named at `place`. */
export interface SpotStart { who: Mover; place: string; spot: string; points: StartPoint[] }

/** Each character's start, when it moves at all and the spot is defined (the visitors only move with an overflow spot). */
export function characterStarts(scene: HomeScene): SpotStart[] {
  const c = scene.characters, spots = scene.spots ?? {};
  const out: SpotStart[] = [];
  if (c?.tomo && spots[c.tomo.spot]) out.push({ who: "tomo", place: "characters.tomo.spot", spot: c.tomo.spot, points: [{ at: spots[c.tomo.spot].at }] });
  const overflow = c?.visitors?.overflow;
  if (overflow !== undefined && spots[overflow]) {
    const points: StartPoint[] = [];
    for (let queue = 0; queue < MAX_WAITING_DRAWN; queue++) {
      const at = waitingPosition(spots[overflow], queue, scene.room.size);
      if (!points.some((p) => Math.hypot(p.at[0] - at[0], p.at[2] - at[2]) < 1e-6)) points.push({ at, queue });
    }
    out.push({ who: "visitors", place: "characters.visitors.overflow", spot: overflow, points });
  }
  if (c?.pet && spots[c.pet.spot]) out.push({ who: "pet", place: "characters.pet.spot", spot: c.pet.spot, points: [{ at: spots[c.pet.spot].at }] });
  return out;
}

/** Every move from a start to another defined spot, each target once per character. */
export function characterUses(scene: HomeScene): SpotUse[] {
  const c = scene.characters, spots = scene.spots ?? {};
  const out: SpotUse[] = [];
  const add = (who: Mover, from: string, place: string, to: string) => {
    if (to === from || !spots[to] || out.some((u) => u.who === who && u.to === to)) return;
    out.push({ who, place, from, to });
  };
  for (const start of characterStarts(scene)) {
    if (start.who === "tomo") (c!.tomo!.rules ?? []).forEach((rule, i) => add("tomo", start.spot, `characters.tomo.rules[${i}]`, rule.spot));
    if (start.who === "visitors") c!.visitors!.spots.forEach((spot, i) => add("visitors", start.spot, `characters.visitors.spots[${i}]`, spot));
    if (start.who === "pet") (c!.pet!.rules ?? []).forEach((rule, i) => add("pet", start.spot, `characters.pet.rules[${i}]`, rule.spot));
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
    return landings(grid, to, { regions }).length ? { ok: true } : explain(grid, to, regions, "unreachable");
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
