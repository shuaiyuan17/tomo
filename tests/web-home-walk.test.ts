import { describe, expect, it } from "vitest";
import type { Vec3 } from "../src/home/geometry.js";
import { buildNavGrid, findRoute, NAV_HOP_ARC, NAV_PET, NAV_RADIUS, type FloorPoint, type NavRoute } from "../src/home/nav.js";
import type { HomePart, HomeScene } from "../src/home/scene.js";
import { STARTER_SCENE } from "../src/home/starter.js";
import {
  ARRIVE_TURN, BLINK_TIME, HOP_MAX_DURATION, planMove, planRoute, poseAt, STEP_HEIGHT, WALK_MAX_DURATION, WALK_MIN_DURATION, WALK_SPEED,
  type WalkPlan,
} from "../web/src/home/walk.js";

function room(objects: HomePart[] = []): HomeScene {
  return { version: 1, room: { size: [6, 3, 6] }, objects } as HomeScene;
}
function block(x0: number, x1: number, z0: number, z1: number, height = 1): HomePart {
  return { shape: "box", size: [x1 - x0, height, z1 - z0], at: [(x0 + x1) / 2, 0, (z0 + z1) / 2] };
}
function route(points: FloorPoint[], hopOff = 0, hopOn = 0): NavRoute {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return { points, length, hopOff, hopOn };
}
/** Poses every millisecond of the plan, end included. */
function samples(plan: WalkPlan, step = 0.001) {
  const out = [];
  for (let t = 0; t < plan.duration; t += step) out.push({ t, ...poseAt(plan, t) });
  out.push({ t: plan.duration, ...poseAt(plan, plan.duration) });
  return out;
}
const maxHeight = (plan: WalkPlan) => Math.max(...samples(plan).map((s) => s.position[1]));
/** Smallest difference between two angles. */
const turn = (a: number, b: number) => Math.abs(((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);

describe("walk: a straight stretch", () => {
  const from: Vec3 = [-1, 0, 0], to: Vec3 = [2, 0, 0];
  const plan = planRoute(route([[-1, 0], [2, 0]]), from, to, 0, Math.PI);

  it("takes as long as walking it at the walking speed", () => {
    expect(plan.kind).toBe("walk");
    expect(plan.duration).toBeCloseTo(3 / WALK_SPEED, 6);
  });
  it("starts where it is and ends on the spot, facing the spot's way", () => {
    expect(poseAt(plan, 0).position).toEqual(from);
    const end = poseAt(plan, plan.duration);
    expect(end.position).toEqual(to);
    expect(end.yaw).toBe(Math.PI);
    expect(end.bob).toBe(0);
  });
  it("stays on the line, on the floor, bouncing a little per step", () => {
    for (const s of samples(plan)) {
      expect(s.position[2]).toBeCloseTo(0, 9);
      expect(s.position[1]).toBeCloseTo(0, 9);
      expect(s.bob).toBeGreaterThanOrEqual(0);
      expect(s.bob).toBeLessThanOrEqual(STEP_HEIGHT + 1e-9);
      expect(s.fade).toBe(1);
    }
    expect(Math.max(...samples(plan).map((s) => s.bob))).toBeGreaterThan(STEP_HEIGHT * 0.9);
  });
  it("walks at an even pace in the middle, easing in and out at the ends", () => {
    const mid = plan.duration / 2;
    const speed = (t: number) => (poseAt(plan, t + 0.01).position[0] - poseAt(plan, t).position[0]) / 0.01;
    expect(speed(mid - 0.3)).toBeCloseTo(speed(mid + 0.3), 6);
    expect(speed(0)).toBeLessThan(speed(mid) / 4);
    expect(speed(plan.duration - 0.011)).toBeLessThan(speed(mid) / 4);
  });
  it("faces the way it walks, and turns to the spot's facing only at the end", () => {
    const east = Math.PI / 2; // atan2(dx, dz) for +x
    expect(turn(poseAt(plan, plan.duration / 2).yaw, east)).toBeLessThan(1e-9);
    expect(turn(poseAt(plan, plan.duration - ARRIVE_TURN - 0.01).yaw, east)).toBeLessThan(1e-9);
  });
});

describe("walk: round a corner", () => {
  const plan = planRoute(route([[0, 0], [1, 0], [1, 1]]), [0, 0, 0], [1, 0, 1], Math.PI / 2, 0);
  const all = samples(plan);

  it("goes through the corner, not across it", () => {
    // Every point is on one of the two stretches.
    for (const { position: [x, , z] } of all) expect(Math.min(Math.abs(z), Math.abs(x - 1))).toBeLessThan(1e-9);
    expect(all.some(({ position: [x, , z] }) => Math.abs(x - 1) < 0.01 && Math.abs(z) < 0.01)).toBe(true);
  });
  it("turns from the first heading to the second, smoothly", () => {
    const t = (d: number) => all.find((s) => s.position[0] + s.position[2] >= d)!.t;
    expect(turn(poseAt(plan, t(0.5)).yaw, Math.PI / 2)).toBeLessThan(1e-6);
    expect(turn(poseAt(plan, t(1.5)).yaw, 0)).toBeLessThan(1e-6);
    for (let i = 1; i < all.length; i++) expect(turn(all[i - 1].yaw, all[i].yaw)).toBeLessThan(0.05);
  });
  it("never jumps", () => {
    for (let i = 1; i < all.length; i++) {
      const [a, b] = [all[i - 1].position, all[i].position];
      expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeLessThan(0.01);
    }
  });
});

describe("walk: hops", () => {
  const seat: Vec3 = [1, 0.45, 0];

  it("walks to the landing and hops up, its arc topping out NAV_HOP_ARC above the perch, as nav.ts checks", () => {
    const plan = planRoute(route([[-1, 0], [0.5, 0]], 0, 0.5), [-1, 0, 0], seat, 0, 0);
    expect(plan.hopsOn).toBe(true);
    expect(maxHeight(plan)).toBeCloseTo(seat[1] + NAV_HOP_ARC, 4);
    expect(maxHeight(plan)).toBeLessThanOrEqual(seat[1] + NAV_HOP_ARC + 1e-9);
    // It reaches the landing on the floor before it leaves it.
    const atLanding = samples(plan).find((s) => s.position[0] >= 0.5 - 1e-9)!;
    expect(atLanding.position[1]).toBeCloseTo(0, 6);
    expect(poseAt(plan, plan.duration).position).toEqual(seat);
    // The hop's height rises and falls once: up from the floor, down onto the seat.
    const hop = samples(plan).filter((s) => s.position[0] > 0.5);
    const top = hop.reduce((i, s, k) => (s.position[1] > hop[i].position[1] ? k : i), 0);
    for (let k = 1; k <= top; k++) expect(hop[k].position[1]).toBeGreaterThanOrEqual(hop[k - 1].position[1] - 1e-9);
    for (let k = top + 1; k < hop.length; k++) expect(hop[k].position[1]).toBeLessThanOrEqual(hop[k - 1].position[1] + 1e-9);
  });
  it("turns to the spot's facing during the hop on", () => {
    const plan = planRoute(route([[-1, 0], [0.5, 0]], 0, 0.5), [-1, 0, 0], seat, 0, Math.PI);
    const hopStart = plan.duration - (plan.phases.at(-1)!.duration);
    expect(turn(poseAt(plan, hopStart - 0.05).yaw, Math.PI / 2)).toBeLessThan(1e-6);
    expect(poseAt(plan, plan.duration).yaw).toBe(Math.PI);
  });
  it("hops down from a perch first, then walks, with the same arc", () => {
    const plan = planRoute(route([[0.5, 0], [-1, 0]], 0.5, 0), seat, [-1, 0, 0], 0, 0);
    expect(poseAt(plan, 0).position).toEqual(seat);
    expect(maxHeight(plan)).toBeCloseTo(seat[1] + NAV_HOP_ARC, 4);
    const hop = plan.phases[0];
    expect(hop.kind).toBe("hop");
    expect(poseAt(plan, hop.duration).position[1]).toBeCloseTo(0, 9);
    expect(poseAt(plan, hop.duration).position[0]).toBeCloseTo(0.5, 9);
    expect(poseAt(plan, plan.duration).position).toEqual([-1, 0, 0]);
  });
  it("from one perch to another: down, walk, up, never higher than the higher perch's arc", () => {
    const high: Vec3 = [-1, 0.8, 0];
    const plan = planRoute(route([[0.5, 0], [-0.5, 0]], 0.5, 0.5), seat, high, 0, 0);
    expect(plan.phases.map((p) => p.kind)).toEqual(["hop", "walk", "hop"]);
    expect(maxHeight(plan)).toBeCloseTo(high[1] + NAV_HOP_ARC, 4);
  });
});

describe("walk: how long", () => {
  it("is capped: a long way is walked faster", () => {
    const plan = planRoute(route([[-2.5, -2.5], [2.5, -2.5], [2.5, 2.5], [-2.5, 2.5]]), [-2.5, 0, -2.5], [-2.5, 0, 2.5], 0, 0);
    expect(15 / WALK_SPEED).toBeGreaterThan(WALK_MAX_DURATION);
    expect(plan.duration).toBeCloseTo(WALK_MAX_DURATION, 9);
    expect(poseAt(plan, plan.duration).position).toEqual([-2.5, 0, 2.5]);
  });
  it("is capped with the hops included", () => {
    const plan = planRoute(route([[-2.5, 0], [2.5, 0], [2.5, 2]], 0.6, 0.6), [-2.5, 0.45, 0.5], [2.5, 0.45, 2.5], 0, 0);
    expect(plan.duration).toBeCloseTo(WALK_MAX_DURATION, 9);
    expect(plan.phases[0].duration).toBeLessThanOrEqual(HOP_MAX_DURATION);
  });
  it("is not a twitch when the way is short", () => {
    const plan = planRoute(route([[0, 0], [0.1, 0]]), [0, 0, 0], [0.1, 0, 0], 0, 0);
    expect(plan.duration).toBeCloseTo(WALK_MIN_DURATION, 9);
  });
});

describe("walk: no way, or no distance", () => {
  it("does not move when it is already there (a perch to the same perch)", () => {
    const grid = buildNavGrid(STARTER_SCENE);
    const cushion = STARTER_SCENE.spots!.cushion.at;
    const plan = planMove(grid, cushion, cushion, 1, 1);
    expect(plan.kind).toBe("still");
    expect(plan.duration).toBe(0);
    expect(poseAt(plan, 0).position).toEqual(cushion);
  });
  it("turns on the spot when only its facing changed", () => {
    const plan = planMove(null, [1, 0, 1], [1, 0, 1], 0, Math.PI / 2);
    expect(plan.kind).toBe("turn");
    expect(plan.duration).toBe(ARRIVE_TURN);
    for (const s of samples(plan)) expect(s.position).toEqual([1, 0, 1]);
    expect(poseAt(plan, plan.duration).yaw).toBe(Math.PI / 2);
  });
  it("fades out where it is and in at the target when the target is sealed off", () => {
    // A pocket closed in on all four sides.
    const scene = room([block(1, 2.6, 1, 1.2), block(1, 2.6, 2.4, 2.6), block(1, 1.2, 1, 2.6), block(2.4, 2.6, 1, 2.6)]);
    const grid = buildNavGrid(scene);
    const from: Vec3 = [-2, 0, -2], to: Vec3 = [1.8, 0, 1.8];
    expect(findRoute(grid, from, to)).toMatchObject({ ok: false, reason: "unreachable" });
    const plan = planMove(grid, from, to, 0, 1);
    expect(plan.kind).toBe("blink");
    expect(plan.duration).toBeCloseTo(BLINK_TIME * 2, 9);
    expect(poseAt(plan, BLINK_TIME * 0.5)).toMatchObject({ position: from });
    expect(poseAt(plan, BLINK_TIME * 0.5).fade).toBeGreaterThan(0);
    expect(poseAt(plan, BLINK_TIME * 0.5).fade).toBeLessThan(1);
    expect(poseAt(plan, BLINK_TIME - 1e-6).fade).toBeLessThan(1e-3);
    expect(poseAt(plan, BLINK_TIME * 1.5)).toMatchObject({ position: to, yaw: 1 });
    expect(poseAt(plan, plan.duration)).toEqual({ position: to, bob: 0, yaw: 1, fade: 1 });
  });
  it("fades too when it is stuck where it stands, or there is no grid", () => {
    const grid = buildNavGrid(room([block(-1, 1, -1, 1)]));
    expect(planMove(grid, [0, 0, 0], [2, 0, 2], 0, 0).kind).toBe("blink");
    expect(planMove(null, [0, 0, 0], [2, 0, 2], 0, 0).kind).toBe("blink");
  });
});

describe("walk: round the furniture", () => {
  it("goes round a box in the way instead of through it", () => {
    const box = { x0: -0.5, x1: 0.5, z0: -1, z1: 1 };
    const grid = buildNavGrid(room([block(box.x0, box.x1, box.z0, box.z1)]));
    const plan = planMove(grid, [-2, 0, 0], [2, 0, 0], 0, 0);
    expect(plan.kind).toBe("walk");
    for (const { position: [x, , z] } of samples(plan)) {
      const dx = Math.max(box.x0 - x, 0, x - box.x1), dz = Math.max(box.z0 - z, 0, z - box.z1);
      expect(Math.hypot(dx, dz)).toBeGreaterThan(NAV_RADIUS - 1e-6);
    }
  });
  it("in the starter room, hops onto the desk chair with the arc nav.ts checked", () => {
    const grid = buildNavGrid(STARTER_SCENE);
    const spots = STARTER_SCENE.spots!;
    const chair = spots["desk-chair"].at;
    const plan = planMove(grid, spots.window.at, chair, 0, 0);
    expect(plan.kind).toBe("walk");
    expect(plan.hopsOn).toBe(true);
    expect(plan.duration).toBeLessThanOrEqual(WALK_MAX_DURATION + 1e-9);
    expect(maxHeight(plan)).toBeCloseTo(chair[1] + NAV_HOP_ARC, 4);
    expect(poseAt(plan, plan.duration).position).toEqual(chair);
  });
  it("walks a pet into its hut at the pet's size", () => {
    const grid = buildNavGrid(STARTER_SCENE, { walker: NAV_PET });
    const spots = STARTER_SCENE.spots!;
    const plan = planMove(grid, spots["pet-bed"].at, spots["pet-nest"].at, 0, 0);
    expect(plan.kind).toBe("walk");
    expect(plan.hopsOn).toBe(false);
  });
});
