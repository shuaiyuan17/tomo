import { placeScene, type Placement, type Vec3 } from "./geometry.js";
import type { HomeScene } from "./scene.js";

/**
 * Where a character can walk in a scene, and the way from one place to
 * another without going through the furniture. Pure, no dependencies beyond
 * geometry.ts (so the daemon's home_check and the web page can both use this
 * one implementation and never disagree about what is reachable).
 *
 * The model:
 * - the floor is a grid of NAV_CELL squares over the room (x right, z toward
 *   the viewer, as in the scene);
 * - an obstacle is a solid leaf (a shape; pictures, signs and windows are
 *   flat panels) whose world box reaches above NAV_STEP and starts below
 *   NAV_HEADROOM: rugs and a pet bed can be walked on, a wall shelf or a
 *   window sill is overhead, a desk top blocks (nobody walks under it). Its
 *   footprint is its box seen from above, so round parts count as squares;
 * - a cell is blocked when any part of it is nearer than the walker's
 *   radius to an obstacle's footprint or to a wall (the open front of the
 *   room counts as a wall too), so everywhere on a free cell keeps the
 *   radius, not just its centre. What is hidden by a reaction still blocks:
 *   the grid is static;
 * - free cells are grouped into regions (4-neighbour connected). Walking is
 *   8-neighbour, but a diagonal step needs both cells beside it free, so it
 *   never squeezes between two blocked corners and regions are exactly what
 *   a walk can reach.
 *
 * A place at most NAV_STEP high is floor: it is walked to (its cell must be
 * free and in the walker's region) or it is unreachable, never hopped to. A
 * place higher than that is a perch (a seat, a cushion): it must be inside
 * the room, the walk ends on a landing cell near it, and the character hops
 * the rest, at most NAV_MAX_HOP, in a straight line that crosses no obstacle
 * but the one it lands on (see clearHop). The landing is looked for in the
 * walker's own region, among every free cell within NAV_APPROACH_SLACK of
 * the nearest one, and the search picks whichever makes the whole trip
 * shortest (a hop weighing NAV_HOP_COST times a walk). The same holds for a
 * start: on the floor it must be on a free cell, on a perch it hops down.
 */

export const NAV_CELL = 0.1;
/** Taller than this is in the way; lower can be stepped over. */
export const NAV_STEP = 0.12;
/** Starting at or above this is overhead; a character walks under it. */
export const NAV_HEADROOM = 0.9;
/** A character's footprint radius when the scene does not say. */
export const NAV_RADIUS = 0.25;
/** The longest hop (horizontal) between a perch and the floor. */
export const NAV_MAX_HOP = 1.2;
/** Landing cells considered beyond the nearest one. */
export const NAV_APPROACH_SLACK = 0.3;
/**
 * What a metre hopped costs, in metres walked, when choosing a landing. A
 * little over 1, so that of two landings on the same straight line the walk
 * goes on to the nearer one instead of hopping from further out.
 */
export const NAV_HOP_COST = 1.5;
/** An obstacle is what a perch is on when its top is within this of the perch's height (and its footprint holds it). */
export const NAV_PERCH_TOLERANCE = 0.15;

/** A point on the floor: [x, z]. */
export type FloorPoint = [number, number];
/** An obstacle seen from above. */
export interface Footprint { min: FloorPoint; max: FloorPoint }
/** An obstacle, with the height of its top. */
export interface Hurdle extends Footprint { top: number }

export interface NavGrid {
  cell: number;
  radius: number;
  cols: number;
  rows: number;
  /** [x, z] of the outer corner of cell 0 (the room's back left corner). */
  origin: FloorPoint;
  /** 1 where blocked, row-major (index = row * cols + col; a row is a z band). */
  blocked: Uint8Array;
  /** The region of each free cell, -1 where blocked. */
  region: Int32Array;
  /** Cells in each region. */
  regionSizes: number[];
  /** Every obstacle (what navObstacles finds), with its top: what a hop may not cross. */
  hurdles: Hurdle[];
  /** The room's width and depth, centred on the origin. */
  room: FloorPoint;
}

/** A free cell to hop to or from, and how far the hop is. */
export interface Landing { cell: number; point: FloorPoint; hop: number }

export interface NavRoute {
  /** The walk, straightened: from the floor point it starts at to the one it ends at. */
  points: FloorPoint[];
  /** Length of the walk (not counting hops). */
  length: number;
  /** Hop from the start down to points[0]: 0 when the start is on the floor. */
  hopOff: number;
  /** Hop from the last point up to the target: 0 when the target is on the floor. */
  hopOn: number;
}

export type RouteResult =
  | { ok: true; route: NavRoute }
  /**
   * `stuck`: the start has no floor within a clear hop. `unreachable`: the
   * target is free floor in another region, or no floor the start's regions
   * hold is within a clear hop of it; `nearest` is how far the nearest such
   * floor is (Infinity when there is none).
   */
  | { ok: false; reason: "stuck" | "unreachable"; nearest: number };

export interface NavOptions {
  /** Footprint radius of the walker, metres. Default NAV_RADIUS. */
  radius?: number;
  /** Cell size, metres. Default NAV_CELL. */
  cell?: number;
  /** A placement already computed for this scene. */
  placement?: Placement;
}

/** The footprints of everything in the way (see the model above). */
export function navObstacles(scene: HomeScene, placement: Placement = placeScene(scene)): Footprint[] {
  return obstacles(placement).map(({ min, max }) => ({ min, max }));
}
function obstacles(placement: Placement): Hurdle[] {
  const out: Hurdle[] = [];
  for (const object of placement.objects) {
    for (const leaf of object.leaves) {
      if (!leaf.solid || leaf.box.max[1] <= NAV_STEP || leaf.box.min[1] >= NAV_HEADROOM) continue;
      out.push({ min: [leaf.box.min[0], leaf.box.min[2]], max: [leaf.box.max[0], leaf.box.max[2]], top: leaf.box.max[1] });
    }
  }
  return out;
}

export function buildNavGrid(scene: HomeScene, options: NavOptions = {}): NavGrid {
  const cell = options.cell ?? NAV_CELL;
  const radius = Math.max(0, options.radius ?? NAV_RADIUS);
  const [w, , d] = scene.room.size;
  const cols = Math.max(1, Math.ceil(w / cell - 1e-9));
  const rows = Math.max(1, Math.ceil(d / cell - 1e-9));
  const origin: FloorPoint = [-w / 2, -d / 2];
  const blocked = new Uint8Array(cols * rows);
  // A cell's sides: x from x0(c) to x0(c + 1), z likewise.
  const x0 = (c: number) => origin[0] + c * cell;
  const z0 = (r: number) => origin[1] + r * cell;
  const EPS = 1e-9;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (x0(c) < origin[0] + radius - EPS || x0(c + 1) > w / 2 - radius + EPS || z0(r) < origin[1] + radius - EPS || z0(r + 1) > d / 2 - radius + EPS) blocked[r * cols + c] = 1;
    }
  }
  const found = obstacles(options.placement ?? placeScene(scene));
  for (const { min, max } of found) {
    const c0 = Math.max(0, Math.floor((min[0] - radius - origin[0]) / cell));
    const c1 = Math.min(cols - 1, Math.floor((max[0] + radius - origin[0]) / cell));
    const r0 = Math.max(0, Math.floor((min[1] - radius - origin[1]) / cell));
    const r1 = Math.min(rows - 1, Math.floor((max[1] + radius - origin[1]) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        // Nearest gap between the cell's square and the footprint (0 when they touch or overlap).
        const dx = Math.max(min[0] - x0(c + 1), 0, x0(c) - max[0]);
        const dz = Math.max(min[1] - z0(r + 1), 0, z0(r) - max[1]);
        const overlaps = min[0] < x0(c + 1) - EPS && max[0] > x0(c) + EPS && min[1] < z0(r + 1) - EPS && max[1] > z0(r) + EPS;
        if (overlaps || dx * dx + dz * dz < radius * radius) blocked[r * cols + c] = 1;
      }
    }
  }

  const region = new Int32Array(cols * rows).fill(-1);
  const regionSizes: number[] = [];
  for (let start = 0; start < blocked.length; start++) {
    if (blocked[start] || region[start] >= 0) continue;
    const id = regionSizes.length;
    let size = 0;
    const stack = [start];
    region[start] = id;
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      const r = Math.floor(k / cols), c = k % cols;
      for (const [nr, nc] of [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]]) {
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const j = nr * cols + nc;
        if (!blocked[j] && region[j] < 0) { region[j] = id; stack.push(j); }
      }
    }
    regionSizes.push(size);
  }
  return { cell, radius, cols, rows, origin, blocked, region, regionSizes, hurdles: found, room: [w, d] };
}

/** The cell under a floor point, or -1 outside the grid. */
export function cellAt(grid: NavGrid, x: number, z: number): number {
  const c = Math.floor((x - grid.origin[0]) / grid.cell);
  const r = Math.floor((z - grid.origin[1]) / grid.cell);
  return c < 0 || r < 0 || c >= grid.cols || r >= grid.rows ? -1 : r * grid.cols + c;
}
export function cellCentre(grid: NavGrid, cell: number): FloorPoint {
  return [grid.origin[0] + ((cell % grid.cols) + 0.5) * grid.cell, grid.origin[1] + (Math.floor(cell / grid.cols) + 0.5) * grid.cell];
}
function isFree(grid: NavGrid, c: number, r: number): boolean {
  return c >= 0 && r >= 0 && c < grid.cols && r < grid.rows && !grid.blocked[r * grid.cols + c];
}

/** Whether `at` is a floor place (at most NAV_STEP high): walked to, never hopped to. */
export function isFloor(at: Vec3): boolean {
  return at[1] <= NAV_STEP;
}
/** Whether `at` is a floor place on a free cell. */
export function onFloor(grid: NavGrid, at: Vec3): boolean {
  const cell = cellAt(grid, at[0], at[2]);
  return isFloor(at) && cell >= 0 && !grid.blocked[cell];
}
/** Whether a floor point is inside the room's walls (and its open front). */
function inRoom(grid: NavGrid, x: number, z: number): boolean {
  return Math.abs(x) <= grid.room[0] / 2 && Math.abs(z) <= grid.room[1] / 2;
}

/**
 * Whether the straight hop between the perch `at` and a floor point crosses
 * no obstacle except what the perch is on: one whose footprint holds `at`
 * and whose top is within NAV_PERCH_TOLERANCE of its height. Both ends are
 * inside the room (the room is a rectangle), so the hop is too.
 */
export function clearHop(grid: NavGrid, at: Vec3, point: FloorPoint): boolean {
  if (!inRoom(grid, at[0], at[2]) || !inRoom(grid, point[0], point[1])) return false;
  const under = (h: Hurdle) => Math.abs(h.top - at[1]) <= NAV_PERCH_TOLERANCE
    && at[0] >= h.min[0] && at[0] <= h.max[0] && at[2] >= h.min[1] && at[2] <= h.max[1];
  return grid.hurdles.every((h) => under(h) || !segmentMeetsBox([at[0], at[2]], point, h));
}
/** Whether segment a–b meets the inside of a footprint (Liang–Barsky; grazing an edge does not count). */
function segmentMeetsBox(a: FloorPoint, b: FloorPoint, box: Footprint): boolean {
  const EPS = 1e-9;
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 2; k++) {
    const d = b[k] - a[k];
    const lo = box.min[k] + EPS, hi = box.max[k] - EPS;
    if (Math.abs(d) < 1e-15) {
      if (a[k] <= lo || a[k] >= hi) return false;
      continue;
    }
    let ta = (lo - a[k]) / d, tb = (hi - a[k]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 >= t1) return false;
  }
  return true;
}

/**
 * The free cells to hop between the perch `at` and the floor: for each
 * region (only `regions`, when given), every cell within `slack` of that
 * region's nearest with a clear hop (clearHop), and none further than
 * `maxHop`. A floor place lands on its own cell (hop 0) when that is free
 * and in an allowed region, and has no landings otherwise.
 */
export function landings(grid: NavGrid, at: Vec3, options: { regions?: readonly number[]; slack?: number; maxHop?: number } = {}): Landing[] {
  const slack = options.slack ?? NAV_APPROACH_SLACK;
  const maxHop = options.maxHop ?? NAV_MAX_HOP;
  const allowed = (region: number) => region >= 0 && (!options.regions || options.regions.includes(region));
  const own = cellAt(grid, at[0], at[2]);
  if (isFloor(at)) return own >= 0 && allowed(grid.region[own]) ? [{ cell: own, point: [at[0], at[2]], hop: 0 }] : [];
  if (!inRoom(grid, at[0], at[2])) return [];
  const near = new Map<number, number>();
  const all: Landing[] = [];
  for (let k = 0; k < grid.blocked.length; k++) {
    const region = grid.region[k];
    if (!allowed(region)) continue;
    const point = cellCentre(grid, k);
    const hop = Math.hypot(point[0] - at[0], point[1] - at[2]);
    if (hop > maxHop + slack || !clearHop(grid, at, point)) continue;
    all.push({ cell: k, point, hop });
    near.set(region, Math.min(near.get(region) ?? Infinity, hop));
  }
  return all.filter((l) => l.hop <= maxHop && l.hop <= near.get(grid.region[l.cell])! + slack);
}

/** The nearest free cell to `at` (in `regions`, when given), at any distance. */
export function nearestFloor(grid: NavGrid, at: Vec3, regions?: readonly number[]): Landing | undefined {
  let best: Landing | undefined;
  for (let k = 0; k < grid.blocked.length; k++) {
    if (grid.region[k] < 0 || (regions && !regions.includes(grid.region[k]))) continue;
    const point = cellCentre(grid, k);
    const hop = Math.hypot(point[0] - at[0], point[1] - at[2]);
    if (!best || hop < best.hop) best = { cell: k, point, hop };
  }
  return best;
}

/**
 * Whether the straight segment a–b crosses only free cells. Every cell it
 * touches counts: along a grid line, the cells on both sides; through a
 * corner, both cells beside it (the same rule as a diagonal step). It is
 * walked twice, nudged a hair to either side, so a line exactly on a cell
 * edge sees both cells.
 */
export function clearLine(grid: NavGrid, a: FloorPoint, b: FloorPoint): boolean {
  const e = grid.cell * 1e-6;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const offsets: FloorPoint[] = len > 0 ? [[(-(b[1] - a[1]) / len) * e, ((b[0] - a[0]) / len) * e]] : [[e, e], [e, -e]];
  for (const [ox, oz] of offsets) {
    if (!traverse(grid, [a[0] + ox, a[1] + oz], [b[0] + ox, b[1] + oz])) return false;
    if (!traverse(grid, [a[0] - ox, a[1] - oz], [b[0] - ox, b[1] - oz])) return false;
  }
  return true;
}
function traverse(grid: NavGrid, a: FloorPoint, b: FloorPoint): boolean {
  const u0 = (a[0] - grid.origin[0]) / grid.cell, v0 = (a[1] - grid.origin[1]) / grid.cell;
  const u1 = (b[0] - grid.origin[0]) / grid.cell, v1 = (b[1] - grid.origin[1]) / grid.cell;
  let c = Math.floor(u0), r = Math.floor(v0);
  const cEnd = Math.floor(u1), rEnd = Math.floor(v1);
  if (!isFree(grid, c, r)) return false;
  const du = u1 - u0, dv = v1 - v0;
  const sc = Math.sign(du), sr = Math.sign(dv);
  const deltaC = sc ? 1 / Math.abs(du) : Infinity, deltaR = sr ? 1 / Math.abs(dv) : Infinity;
  let tC = sc > 0 ? (c + 1 - u0) / du : sc < 0 ? (u0 - c) / -du : Infinity;
  let tR = sr > 0 ? (r + 1 - v0) / dv : sr < 0 ? (v0 - r) / -dv : Infinity;
  for (let guard = Math.abs(cEnd - c) + Math.abs(rEnd - r) + 2; (c !== cEnd || r !== rEnd) && guard > 0; guard--) {
    if (Math.abs(tC - tR) < 1e-9) {
      if (!isFree(grid, c + sc, r) || !isFree(grid, c, r + sr)) return false;
      c += sc; r += sr; tC += deltaC; tR += deltaR;
    } else if (tC < tR) { c += sc; tC += deltaC; } else { r += sr; tR += deltaR; }
    if (!isFree(grid, c, r)) return false;
  }
  return true;
}

/** Drops every point a straight line can skip: from each kept point, the furthest one in clear sight. */
export function straighten(grid: NavGrid, points: readonly FloorPoint[]): FloorPoint[] {
  if (points.length <= 2) return [...points];
  const out: FloorPoint[] = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1 && !clearLine(grid, points[i], points[j])) j--;
    out.push(points[j]);
    i = j;
  }
  return out;
}

/** A tiny binary min-heap of [priority, cell]. */
class Heap {
  private items: [number, number][] = [];
  get size(): number { return this.items.length; }
  peek(): number { return this.items[0]?.[0] ?? Infinity; }
  push(priority: number, cell: number): void {
    const a = this.items;
    a.push([priority, cell]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The way from `from` to `to` (scene points: y tells a perch from the floor).
 * A* over the grid from every start landing (costed by its hop) to every
 * target landing in the regions the start can reach (plus its hop), then
 * straightened. Hops are weighed by NAV_HOP_COST.
 */
export function findRoute(grid: NavGrid, from: Vec3, to: Vec3, options: { maxHop?: number } = {}): RouteResult {
  const maxHop = options.maxHop ?? NAV_MAX_HOP;
  const starts = landings(grid, from, { maxHop });
  if (!starts.length) return { ok: false, reason: "stuck", nearest: nearestFloor(grid, from)?.hop ?? Infinity };
  const regions = [...new Set(starts.map((s) => grid.region[s.cell]))];
  const ends = landings(grid, to, { regions, maxHop });
  if (!ends.length) return { ok: false, reason: "unreachable", nearest: nearestFloor(grid, to, regions)?.hop ?? Infinity };

  const { cols, rows, cell } = grid;
  const endHop = new Map<number, Landing>();
  for (const e of ends) if (!endHop.has(e.cell) || e.hop < endHop.get(e.cell)!.hop) endHop.set(e.cell, e);
  const goals = [...endHop.values()];
  const h = (k: number): number => {
    const r = Math.floor(k / cols), c = k % cols;
    let best = Infinity;
    for (const g of goals) {
      const dc = Math.abs(c - (g.cell % cols)), dr = Math.abs(r - Math.floor(g.cell / cols));
      best = Math.min(best, cell * (Math.max(dc, dr) + (Math.SQRT2 - 1) * Math.min(dc, dr)) + g.hop * NAV_HOP_COST);
    }
    return best;
  };
  const cost = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const startOf = new Map<number, Landing>();
  const open = new Heap();
  for (const s of starts) {
    const g = s.hop * NAV_HOP_COST;
    if (g < cost[s.cell]) { cost[s.cell] = g; startOf.set(s.cell, s); open.push(g + h(s.cell), s.cell); }
  }
  let bestTotal = Infinity, bestEnd = -1;
  while (open.size && open.peek() < bestTotal) {
    const [f, k] = open.pop();
    if (f > cost[k] + h(k) + 1e-9) continue; // stale
    const goal = endHop.get(k);
    if (goal && cost[k] + goal.hop * NAV_HOP_COST < bestTotal) { bestTotal = cost[k] + goal.hop * NAV_HOP_COST; bestEnd = k; }
    const r = Math.floor(k / cols), c = k % cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if ((!dr && !dc) || !isFree(grid, c + dc, r + dr)) continue;
        if (dr && dc && (!isFree(grid, c + dc, r) || !isFree(grid, c, r + dr))) continue;
        const j = (r + dr) * cols + c + dc;
        const next = cost[k] + (dr && dc ? Math.SQRT2 : 1) * cell;
        if (next < cost[j] - 1e-12) { cost[j] = next; came[j] = k; startOf.delete(j); open.push(next + h(j), j); }
      }
    }
  }
  // Every goal is in a region a start is in, so one is always found.
  const cells: number[] = [];
  for (let k = bestEnd; k >= 0; k = came[k]) cells.push(k);
  cells.reverse();
  const start = startOf.get(cells[0])!;
  const end = endHop.get(bestEnd)!;
  const raw: FloorPoint[] = [start.point, ...cells.map((k) => cellCentre(grid, k)), end.point];
  const points = straighten(grid, raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1]));
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return { ok: true, route: { points, length, hopOff: start.hop, hopOn: end.hop } };
}
