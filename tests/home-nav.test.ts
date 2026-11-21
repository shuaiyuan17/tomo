import { describe, expect, it } from "vitest";
import { placeScene, type Vec3 } from "../src/home/geometry.js";
import {
  buildNavGrid, clearLine, findRoute, landings, navObstacles, NAV_MAX_HOP, NAV_RADIUS, onFloor,
  type FloorPoint, type NavGrid, type NavRoute,
} from "../src/home/nav.js";
import type { HomePart, HomeScene } from "../src/home/scene.js";
import { STARTER_SCENE } from "../src/home/starter.js";

/** A 6 × 6 m room holding `objects`. */
function room(objects: HomePart[] = []): HomeScene {
  return { version: 1, room: { size: [6, 3, 6] }, objects } as HomeScene;
}
/** A box standing on the floor covering x0..x1, z0..z1. */
function block(x0: number, x1: number, z0: number, z1: number, height = 1): HomePart {
  return { shape: "box", size: [x1 - x0, height, z1 - z0], at: [(x0 + x1) / 2, 0, (z0 + z1) / 2] };
}
function walk(grid: NavGrid, from: Vec3, to: Vec3): NavRoute {
  const result = findRoute(grid, from, to);
  if (!result.ok) throw new Error(`no route: ${result.reason}`);
  return result.route;
}
/**
 * The independent check of a walk: sampled every 1 cm along it, no point is
 * nearer than `radius` to a wall or to any part in the way, measured on the
 * scene's own placement (not on the grid the route was found on).
 */
function expectClear(scene: HomeScene, route: NavRoute, radius = NAV_RADIUS): void {
  const [w, , d] = scene.room.size;
  const boxes = placeScene(scene).objects.flatMap((o) => o.leaves)
    .filter((l) => l.solid && l.box.max[1] > 0.12 && l.box.min[1] < 0.9).map((l) => l.box);
  const samples: FloorPoint[] = [...route.points];
  for (let i = 1; i < route.points.length; i++) {
    const [a, b] = [route.points[i - 1], route.points[i]];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.01);
    for (let s = 1; s < n; s++) samples.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
  }
  let worst = Infinity;
  for (const [x, z] of samples) {
    worst = Math.min(worst, x + w / 2, w / 2 - x, z + d / 2, d / 2 - z);
    for (const box of boxes) worst = Math.min(worst, Math.hypot(Math.max(box.min[0] - x, 0, x - box.max[0]), Math.max(box.min[2] - z, 0, z - box.max[2])));
  }
  expect(worst).toBeGreaterThanOrEqual(radius - 1e-9);
}
/** Closest a polyline comes to a footprint (sampled every 1 cm). */
function closest(points: FloorPoint[], min: FloorPoint, max: FloorPoint): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.01);
    for (let s = 0; s <= n; s++) {
      const x = a[0] + ((b[0] - a[0]) * s) / n, z = a[1] + ((b[1] - a[1]) * s) / n;
      best = Math.min(best, Math.hypot(Math.max(min[0] - x, 0, x - max[0]), Math.max(min[1] - z, 0, z - max[1])));
    }
  }
  return best;
}

describe("home navigation: the grid", () => {
  it("counts only solid parts between step height and head room as obstacles", () => {
    const scene = room([
      { shape: "box", size: [2, 0.02, 2], at: [0, 0, 0] },                   // a rug: stepped over
      { shape: "box", size: [1, 0.05, 0.3], at: [2, 1.5, -2.8] },            // a wall shelf: overhead
      { shape: "box", size: [1.5, 0.08, 0.8], at: [-1, 0.72, -2] },          // a desk top: blocks
      { sign: "hello", size: [1, 0.5, 0.02], at: [0, 0.2, 2] },              // a sign: not solid
      { window: true, size: [1, 1, 0.08], at: [0, 0.5, -2.96] },             // a window: not solid
    ]);
    expect(navObstacles(scene)).toEqual([{ min: [-1.75, -2.4], max: [-0.25, -1.6] }]);
  });

  it("keeps a radius off the walls, the open front included", () => {
    const grid = buildNavGrid(room());
    expect(grid.regionSizes).toHaveLength(1);
    expect(onFloor(grid, [0, 0, 2.9])).toBe(false);
    expect(onFloor(grid, [0, 0, 2.6])).toBe(true);
    expect(onFloor(grid, [-2.9, 0, 0])).toBe(false);
  });
});

describe("home navigation: routes", () => {
  it("walks a straight line across an empty room", () => {
    const grid = buildNavGrid(room());
    const route = walk(grid, [-2, 0, 0.33], [2, 0, -0.41]);
    expect(route.points).toEqual([[-2, 0.33], [2, -0.41]]);
    expect(route.length).toBeCloseTo(Math.hypot(4, 0.74), 9);
    expect(route.hopOff).toBe(0);
    expect(route.hopOn).toBe(0);
  });

  it("goes around a box in the middle, keeping its radius off it", () => {
    const scene = room([block(-0.5, 0.5, -0.5, 0.5)]);
    const grid = buildNavGrid(scene);
    expect(clearLine(grid, [-2, 0], [2, 0])).toBe(false);
    const route = walk(grid, [-2, 0, 0], [2, 0, 0]);
    expectClear(scene, route);
    expect(route.points.length).toBeGreaterThanOrEqual(3);
    expect(route.points.length).toBeLessThanOrEqual(5);
    // Around the inflated box (0.75 m half-width): longer than 4 m, far shorter than a wander.
    expect(route.length).toBeGreaterThan(4.2);
    expect(route.length).toBeLessThan(4.8);
    expect(closest(route.points, [-0.5, -0.5], [0.5, 0.5])).toBeGreaterThan(NAV_RADIUS - 0.1);
  });

  it("says a sealed-off pocket cannot be reached, either way, and how far off it is", () => {
    // A closed ring, 2.4 m across inside, centred on (1, 1).
    const scene = room([block(-0.3, 2.3, -0.3, -0.2), block(-0.3, 2.3, 2.2, 2.3), block(-0.3, -0.2, -0.2, 2.2), block(2.2, 2.3, -0.2, 2.2)]);
    const grid = buildNavGrid(scene);
    expect(grid.regionSizes).toHaveLength(2);
    const inside: Vec3 = [1, 0, 1], outside: Vec3 = [-2, 0, -2];
    expect(onFloor(grid, inside)).toBe(true);
    const there = findRoute(grid, outside, inside);
    expect(there).toMatchObject({ ok: false, reason: "unreachable" });
    if (there.ok) return;
    expect(there.nearest).toBeGreaterThan(NAV_MAX_HOP);
    expect(there.nearest).toBeLessThan(1.8);
    expect(findRoute(grid, inside, outside)).toMatchObject({ ok: false, reason: "unreachable" });
    // Inside the pocket is fine.
    expect(walk(grid, [0.5, 0, 0.5], [1.5, 0, 1.5]).length).toBeCloseTo(Math.SQRT2, 9);
  });

  it("is stuck when the start has no floor within a hop", () => {
    const grid = buildNavGrid(room([block(-2, 2, -2, 2)]));
    expect(findRoute(grid, [0, 1, 0], [2.5, 0, 2.5])).toMatchObject({ ok: false, reason: "stuck" });
  });

  it("walks to a landing next to a perch and hops up, and back down", () => {
    const scene = room([block(-0.2, 0.2, -0.2, 0.2, 0.45)]);
    const grid = buildNavGrid(scene);
    const seat: Vec3 = [0, 0.45, 0];
    expect(onFloor(grid, seat)).toBe(false);
    const up = walk(grid, [-2, 0, 0], seat);
    expectClear(scene, up);
    expect(up.hopOn).toBeGreaterThan(0.2 + NAV_RADIUS - 0.05);
    expect(up.hopOn).toBeLessThan(0.2 + NAV_RADIUS + 0.15);
    const last = up.points[up.points.length - 1];
    expect(Math.hypot(last[0] - seat[0], last[1] - seat[2])).toBeCloseTo(up.hopOn, 9);
    // From the left, it lands on the left: no walking round the seat.
    expect(last[0]).toBeLessThan(0);
    expect(up.length + up.hopOn).toBeLessThan(2.1);
    const down = walk(grid, seat, [2, 0, 0]);
    expect(down.hopOff).toBeGreaterThan(0);
    expect(down.points[0][0]).toBeGreaterThan(0);
    expect(down.hopOn).toBe(0);
  });

  it("lands in its own region, not in a sealed pocket that is nearer the perch", () => {
    // A small closed hut with a thick right wall; the perch is on that wall,
    // nearer the hut's inside (0.45 m to its nearest free cell) than the room
    // (about 0.85 m): further than the slack, so only the inside is "nearest".
    const scene = room([block(-0.6, 1.2, -0.6, -0.5), block(-0.6, 1.2, 0.5, 0.6), block(-0.6, -0.5, -0.5, 0.5), block(0.5, 1.2, -0.5, 0.5)]);
    const grid = buildNavGrid(scene);
    expect(grid.regionSizes).toHaveLength(2);
    const perch: Vec3 = [0.6, 1, 0];
    const nearest = landings(grid, perch, { slack: 0 });
    expect(Math.min(...nearest.map((l) => l.hop))).toBeLessThan(0.5);
    const route = walk(grid, [2, 0, 0], perch);
    expect(route.points[route.points.length - 1][0]).toBeGreaterThan(1.2);
    expect(route.hopOn).toBeGreaterThan(0.8);
    expect(route.hopOn).toBeLessThan(1.05);
  });

  it("never cuts between two obstacles that meet at a corner", () => {
    // With no radius (and cells of 0.25 m, exact in binary), the two boxes
    // leave free cells touching only diagonally at (0, 0).
    const scene = room([block(-1, 0, -1, 0), block(0, 1, 0, 1)]);
    const grid = buildNavGrid(scene, { radius: 0, cell: 0.25 });
    expect(clearLine(grid, [-0.5, 0.5], [0.5, -0.5])).toBe(false);
    const route = walk(grid, [-0.5, 0, 0.5], [0.5, 0, -0.5]);
    expectClear(scene, route, 0);
    expect(route.length).toBeGreaterThan(2);
  });

  it("does not run along a grid line beside a blocked cell", () => {
    // Cells of 0.25 m: z = 0 and x = 0 are grid lines exactly. Block the row
    // just behind z = 0 and the column just left of x = 0, by hand.
    const grid = buildNavGrid(room(), { radius: 0, cell: 0.25 });
    for (let c = 10; c <= 13; c++) grid.blocked[11 * grid.cols + c] = 1;
    for (let r = 4; r <= 7; r++) grid.blocked[r * grid.cols + 11] = 1;
    expect(clearLine(grid, [-0.5, 0], [0.5, 0])).toBe(false);
    expect(clearLine(grid, [0, -2], [0, -1])).toBe(false);
    // A line along the free side of the same rows is fine.
    expect(clearLine(grid, [-0.5, 0.25], [0.5, 0.25])).toBe(true);
    // Straightening keeps to cells: it does not take the grid line either.
    expect(clearLine(grid, [-0.625, 0.125], [0.625, 0.125])).toBe(true);
  });

  it("keeps its radius off the walls everywhere along a walk, not just at cell centres", () => {
    // 0.201 m from the front wall: the cell's centre is 0.25 m off it, the point is not.
    const scene = room();
    const grid = buildNavGrid(scene);
    expect(onFloor(grid, [-2, 0, 2.799])).toBe(false);
    const result = findRoute(grid, [-2, 0, 2.799], [2, 0, 2.799]);
    if (result.ok) expectClear(scene, result.route);
  });

  it("never reaches a floor point on the far side of a wall, walking or hopping", () => {
    // A wall right across the room: two regions.
    const scene = room([block(-3, 3, -0.05, 0.05)]);
    const grid = buildNavGrid(scene);
    expect(grid.regionSizes).toHaveLength(2);
    expect(onFloor(grid, [0, 0, 0.5])).toBe(true);
    expect(findRoute(grid, [0, 0, -1], [0, 0, 0.5])).toMatchObject({ ok: false, reason: "unreachable" });
    // Close behind the wall, inside its margin (not free floor itself): still no hop through it.
    expect(onFloor(grid, [0, 0, 0.2])).toBe(false);
    expect(findRoute(grid, [0, 0, -1], [0, 0, 0.2])).toMatchObject({ ok: false, reason: "unreachable" });
    // Even over a low step a hop could clear: floor is walked to, never hopped to.
    const step = buildNavGrid(room([block(-3, 3, -0.05, 0.05, 0.2)]));
    expect(step.regionSizes).toHaveLength(2);
    expect(findRoute(step, [0, 0, -1], [0, 0, 0.5])).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("does not hop through a wall onto a perch behind it, but does hop over something low", () => {
    // A seat 0.45 m high just behind a 1 m wall: the nearest floor on this side is within a hop, but the wall is in the way.
    const walled = room([block(-3, 3, -0.05, 0.05), block(-0.2, 0.2, 0.2, 0.6, 0.45)]);
    expect(findRoute(buildNavGrid(walled), [0, 0, -1], [0, 0.45, 0.4])).toMatchObject({ ok: false, reason: "unreachable" });
    // A low step (0.2 m) in its place is hopped over, with the seat its own region's only way up.
    const stepped = room([block(-3, 3, -0.05, 0.05, 0.2), block(-0.2, 0.2, 0.2, 0.6, 0.45)]);
    expect(findRoute(buildNavGrid(stepped), [0, 0, -1], [0, 0.45, 0.4]).ok).toBe(true);
    // Into a tall basket: what the perch stands in is what it hops onto, not in the way.
    const basket = room([{ shape: "cylinder", size: [0.8, 0.7, 0.8], at: [0, 0, 0] }]);
    expect(findRoute(buildNavGrid(basket), [-2, 0, 0], [0, 0.15, 0]).ok).toBe(true);
  });

  it("does not squeeze through a gap narrower than its body", () => {
    // A wall across the room with a 0.3 m slit in the middle and a 1.2 m opening on the right.
    const scene = room([block(-3, -0.15, -0.05, 0.05), block(0.15, 1.8, -0.05, 0.05)]);
    const grid = buildNavGrid(scene);
    const route = walk(grid, [0, 0, -2], [0, 0, 2]);
    expectClear(scene, route);
    expect(route.length).toBeGreaterThan(5);
    for (let i = 1; i < route.points.length; i++) {
      const [a, b] = [route.points[i - 1], route.points[i]];
      if ((a[1] < 0) === (b[1] < 0)) continue;
      const x = a[0] + ((b[0] - a[0]) * -a[1]) / (b[1] - a[1]);
      expect(x).toBeGreaterThan(1.8 + NAV_RADIUS - 0.1);
    }
  });
});

describe("home navigation: the starter room", () => {
  const grid = buildNavGrid(STARTER_SCENE);
  const spots = STARTER_SCENE.spots!;
  const chars = STARTER_SCENE.characters!;
  const used = new Set<string>([
    chars.tomo!.spot, ...(chars.tomo!.rules ?? []).map((r) => r.spot),
    ...chars.visitors!.spots, ...(chars.visitors!.overflow ? [chars.visitors!.overflow] : []),
    chars.pet!.spot, ...(chars.pet!.rules ?? []).map((r) => r.spot),
  ]);

  it("names every spot its characters use", () => {
    expect([...used].sort()).toEqual(Object.keys(spots).sort());
  });

  for (const home of [chars.tomo!.spot, chars.pet!.spot]) {
    for (const name of used) {
      it(`gets from ${home} to ${name}, on foot or with a hop`, () => {
        const route = walk(grid, spots[home].at, spots[name].at);
        expectClear(STARTER_SCENE, route);
        expect(route.hopOn).toBeLessThanOrEqual(NAV_MAX_HOP);
        expect(route.hopOff).toBeLessThanOrEqual(NAV_MAX_HOP);
        if (onFloor(grid, spots[name].at)) expect(route.hopOn).toBe(0);
        else expect(landings(grid, spots[name].at).length).toBeGreaterThan(0);
      });
    }
  }

  it("has the floor spots on the floor and the seats as perches", () => {
    const floor = Object.keys(spots).filter((name) => onFloor(grid, spots[name].at)).sort();
    expect(floor).toEqual(["guest-queue", "pet-bed", "window"]);
  });

  it("goes round the desk and the guest desks rather than through them", () => {
    const route = walk(grid, spots["guest-seat-2"].at, spots["desk-chair"].at);
    expectClear(STARTER_SCENE, route);
    const straight = Math.hypot(spots["guest-seat-2"].at[0] - spots["desk-chair"].at[0], spots["guest-seat-2"].at[2] - spots["desk-chair"].at[2]);
    expect(route.length + route.hopOff + route.hopOn).toBeGreaterThan(straight);
  });
});
