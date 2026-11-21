import { placeScene, type Placement, type Vec3 } from "./geometry.js";
import {
  buildNavGrid, cellCentre, findRoute, hopBlockers, isFloor, landings, NAV_MAX_HOP, NAV_PERCH_TOLERANCE, NAV_PET, NAV_WALKER,
  type FloorPoint, type Hurdle, type NavGrid, type NavRoute, type WalkerSize,
} from "./nav.js";
import type { HomeScene } from "./scene.js";

/**
 * Which spots each character can walk to, for home_check's warnings and the
 * floor plan. A character walks from its default spot (the visitors from
 * their overflow spot, where they wait for a seat) to each spot its rules
 * name, at its own size: Tomo and the visitors NAV_WALKER, the pet NAV_PET,
 * as the page does (web/src/home/three/stage.ts). Where it cannot, the page
 * fades it out and back in; this says why, naming what is in the way.
 */

export type Mover = "tomo" | "visitors" | "pet";
export const MOVER_NAMES: Record<Mover, string> = { tomo: "Tomo", visitors: "a visitor", pet: "the pet" };

export function walkerOf(who: Mover): WalkerSize {
  return who === "pet" ? NAV_PET : NAV_WALKER;
}

/** A move a character makes: from its start spot to another, named at `place` in the scene. */
export interface SpotUse { who: Mover; place: string; from: string; to: string }
/** Where a character starts, named at `place`. */
export interface SpotStart { who: Mover; place: string; spot: string }

/** Each character's start, when it moves at all and the spot is defined (the visitors only move with an overflow spot). */
export function characterStarts(scene: HomeScene): SpotStart[] {
  const c = scene.characters, spots = scene.spots ?? {};
  const out: SpotStart[] = [];
  if (c?.tomo && spots[c.tomo.spot]) out.push({ who: "tomo", place: "characters.tomo.spot", spot: c.tomo.spot });
  if (c?.visitors?.overflow !== undefined && spots[c.visitors.overflow]) out.push({ who: "visitors", place: "characters.visitors.overflow", spot: c.visitors.overflow });
  if (c?.pet && spots[c.pet.spot]) out.push({ who: "pet", place: "characters.pet.spot", spot: c.pet.spot });
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

/** Why a spot cannot be reached (or left). */
export interface Unreachable {
  ok: false;
  /** `stuck`: no floor to hop down to from the start. `unreachable`: the target is cut off. */
  reason: "stuck" | "unreachable";
  /** How far the nearest floor the character can stand on is from the spot it cannot reach (or leave). */
  nearest: number;
  /**
   * `hop`: there is floor within a hop, but the hop crosses `blockers`.
   * `far`: no such floor within NAV_MAX_HOP; `blockers` is the nearest thing in the way.
   * `crowded`: a floor spot too close to `blockers` for a walker this size.
   * `walled`: a floor spot whose floor is cut off; `blockers` is the nearest thing in the way.
   */
  why: "hop" | "far" | "crowded" | "walled";
  blockers: Hurdle[];
}
export type Reach = { ok: true; route: NavRoute } | Unreachable;

/** Reachability in one scene: a grid per walker size, built when first asked for. */
export class SceneReach {
  readonly placement: Placement;
  private grids = new Map<WalkerSize, NavGrid>();
  constructor(readonly scene: HomeScene, placement?: Placement) {
    this.placement = placement ?? placeScene(scene);
  }
  grid(walker: WalkerSize): NavGrid {
    let grid = this.grids.get(walker);
    if (!grid) { grid = buildNavGrid(this.scene, { walker, placement: this.placement }); this.grids.set(walker, grid); }
    return grid;
  }
  private at(spot: string): Vec3 { return this.scene.spots![spot].at; }

  /** The way between two spots for this walker, or why there is none. */
  reach(from: string, to: string, walker: WalkerSize): Reach {
    const grid = this.grid(walker);
    const found = findRoute(grid, this.at(from), this.at(to));
    if (found.ok) return found;
    if (found.reason === "stuck") return explain(grid, this.at(from), undefined, "stuck");
    const regions = [...new Set(landings(grid, this.at(from)).map((l) => grid.region[l.cell]))];
    return explain(grid, this.at(to), regions, "unreachable");
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
  const standing = grid.hurdles.filter((h) => h.bottom < grid.headroom);
  if (isFloor(at)) {
    const k = Math.floor((at[2] - grid.origin[1]) / grid.cell) * grid.cols + Math.floor((at[0] - grid.origin[0]) / grid.cell);
    const crowded = k >= 0 && k < grid.blocked.length && grid.blocked[k] === 1;
    return { ok: false, reason, nearest: distance, why: crowded ? "crowded" : "walled", blockers: nearestOf(standing, at, []) };
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

/** The obstacle nearest to `at` (seen from above), leaving out `skip` (what a perch is on) and the rest of the objects those belong to. */
function nearestOf(hurdles: readonly Hurdle[], at: Vec3, skip: readonly Hurdle[]): Hurdle[] {
  const own = new Set(skip.map((h) => h.object));
  let best: Hurdle | undefined, bestD = Infinity;
  for (const h of hurdles) {
    if (own.has(h.object)) continue;
    const dx = Math.max(h.min[0] - at[0], 0, at[0] - h.max[0]);
    const dz = Math.max(h.min[1] - at[2], 0, at[2] - h.max[1]);
    const d = Math.hypot(dx, dz);
    if (d < bestD) { best = h; bestD = d; }
  }
  return best ? [best] : [];
}
