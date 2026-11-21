import type { Vec3 } from "../../../src/home/geometry.js";
import { findRoute, isFloor, NAV_HOP_ARC, NAV_MAX_HOP, type NavGrid, type NavRoute } from "../../../src/home/nav.js";

/**
 * How a character gets from where it is to its spot, as a pure function of
 * time: no three.js, no clock. The stage plans a move once, when the target
 * changes, and asks `poseAt` every frame.
 *
 * A move is one of:
 * - a walk along a route nav.ts found: hop down from a perch (a seat, a
 *   cushion) to the floor if it starts on one, walk the straightened path at
 *   an even pace (easing in and out), hop up onto the target if it is a
 *   perch. A hop is a ballistic arc whose top is NAV_HOP_ARC above the perch,
 *   exactly the height nav.ts checked the hop's way against, so the
 *   animation never rises into something the check let it pass under;
 * - a blink, where there is no route (the target is sealed off, or the
 *   character is stuck): shrink away where it is, grow back at the target;
 * - a turn on the spot, when only the facing changed;
 * - nothing, when it is already there.
 */

/** Walking speed, m/s. */
export const WALK_SPEED = 1.5;
/** No move takes longer: a long way is walked faster. */
export const WALK_MAX_DURATION = 3.5;
/** A short walk takes at least this long (it would look like a twitch). */
export const WALK_MIN_DURATION = 0.45;
/** A hop takes this long, longer the further it goes (up to NAV_MAX_HOP). */
export const HOP_MIN_DURATION = 0.35, HOP_MAX_DURATION = 0.5;
/** Metres walked while turning to face a new stretch of the path. */
export const TURN_DISTANCE = 0.2;
/** Seconds before arriving (on foot) spent turning to the spot's facing; also how long a turn on the spot takes. */
export const ARRIVE_TURN = 0.3;
/** Seconds to shrink away, and again to grow back, in a blink. */
export const BLINK_TIME = 0.3;
/** A little bounce per step while walking: one every STEP_LENGTH metres, STEP_HEIGHT high. */
export const STEP_LENGTH = 0.32, STEP_HEIGHT = 0.07;
/** Seconds of easing in, and out, at the ends of a walk. */
const RAMP = 0.2;
/** Closer than this is the same place. */
const SAME = 0.01;

interface HopPhase {
  kind: "hop"; start: number; duration: number;
  /** Down from the start, or up onto the target. */
  role: "off" | "on";
  from: Vec3; to: Vec3;
  /** Height of the top of the arc. */
  peak: number;
  /** Fraction of the hop at which the top is reached. */
  apexAt: number;
  yaw0: number; yaw1: number;
}
interface WalkPhase {
  kind: "walk"; start: number; duration: number;
  points: Vec3[];
  /** Distance along the walk at each point. */
  along: number[];
  length: number;
  /** Fraction of the walk's time spent easing in (and again out). */
  ramp: number;
  /** Facing at the start of each stretch (what it turns from). */
  yaws: number[];
  headings: number[];
}
type Phase = HopPhase | WalkPhase;

export interface WalkPlan {
  kind: "still" | "turn" | "walk" | "blink";
  duration: number;
  from: Vec3; to: Vec3;
  fromYaw: number; toYaw: number;
  phases: Phase[];
  /** Whether it ends with a hop (then it turns to the spot's facing during the hop, not before). */
  hopsOn: boolean;
}

export interface WalkPose {
  /** Where it is, without the step bounce. */
  position: Vec3;
  /** The step bounce to add to position's height. */
  bob: number;
  yaw: number;
  /** 1 seen in full, 0 shrunk away (a blink). */
  fade: number;
}

export const angleLerp = (a: number, b: number, t: number): number => { const d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; return a + d * t; };
export const smooth = (t: number): number => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const flat = (a: Vec3, b: Vec3): number => Math.hypot(b[0] - a[0], b[2] - a[2]);
const heading = (a: Vec3, b: Vec3, otherwise: number): number => flat(a, b) > 0.05 ? Math.atan2(b[0] - a[0], b[2] - a[2]) : otherwise;
const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** The height of a hop from `a` to `b` at fraction `u`: a ballistic arc peaking at `peak`, reached at `apexAt`. */
function hopHeight(phase: HopPhase, u: number): number {
  const { from, to, peak, apexAt } = phase;
  if (u <= apexAt) { const k = apexAt > 0 ? (apexAt - u) / apexAt : 0; return peak - (peak - from[1]) * k * k; }
  const k = apexAt < 1 ? (u - apexAt) / (1 - apexAt) : 0;
  return peak - (peak - to[1]) * k * k;
}
function hopPhase(role: "off" | "on", from: Vec3, to: Vec3, start: number, yaw0: number, yaw1: number): HopPhase {
  // The top is NAV_HOP_ARC above the higher end (the perch), as nav.ts's clearHop assumes.
  const peak = Math.max(from[1], to[1], 0) + NAV_HOP_ARC;
  const rise = Math.sqrt(Math.max(0, peak - from[1])), fall = Math.sqrt(Math.max(0, peak - to[1]));
  const apexAt = rise + fall > 0 ? rise / (rise + fall) : 0.5;
  const duration = HOP_MIN_DURATION + (HOP_MAX_DURATION - HOP_MIN_DURATION) * Math.min(1, dist3(from, to) / NAV_MAX_HOP);
  return { kind: "hop", role, start, duration, from, to, peak, apexAt, yaw0, yaw1 };
}

/** Fraction of a walk's length covered at fraction `u` of its time: even pace, eased in and out over `ramp`. */
function walked(u: number, ramp: number): number {
  if (ramp <= 0) return u;
  const v = 1 / (1 - ramp);
  if (u < ramp) return (v * u * u) / (2 * ramp);
  if (u > 1 - ramp) return 1 - (v * (1 - u) * (1 - u)) / (2 * ramp);
  return v * (u - ramp / 2);
}

/** Nothing to do: already there, facing the right way. */
export function planStill(at: Vec3, yaw: number): WalkPlan {
  return { kind: "still", duration: 0, from: at, to: at, fromYaw: yaw, toYaw: yaw, phases: [], hopsOn: false };
}
/** Turn on the spot. */
export function planTurn(at: Vec3, fromYaw: number, toYaw: number): WalkPlan {
  return { kind: "turn", duration: ARRIVE_TURN, from: at, to: at, fromYaw, toYaw, phases: [], hopsOn: false };
}
/** Shrink away at `from`, grow back at `to`. */
export function planBlink(from: Vec3, to: Vec3, fromYaw: number, toYaw: number): WalkPlan {
  return { kind: "blink", duration: BLINK_TIME * 2, from, to, fromYaw, toYaw, phases: [], hopsOn: false };
}

/** Walk `route` (found by nav.ts from `from` to `to`): hop off, walk, hop on. */
export function planRoute(route: NavRoute, from: Vec3, to: Vec3, fromYaw: number, toYaw: number, speed = WALK_SPEED): WalkPlan {
  const hopOff = !isFloor(from), hopOn = !isFloor(to);
  const ground = route.points.map(([x, z]): Vec3 => [x, 0, z]);
  if (!ground.length) ground.push([from[0], 0, from[2]]);
  // On the floor the walk runs from the floor place's own height to the other's (a rug, a pet bed); after a hop, from the floor.
  ground[0][1] = hopOff ? 0 : from[1];
  ground[ground.length - 1][1] = hopOn ? 0 : to[1];

  const phases: Phase[] = [];
  let t = 0, yaw = fromYaw;
  if (hopOff) {
    const toward = heading(from, ground[0], fromYaw);
    const hop = hopPhase("off", from, ground[0], t, yaw, toward);
    phases.push(hop); t += hop.duration; yaw = toward;
  }
  const along = [0];
  for (let i = 1; i < ground.length; i++) along.push(along[i - 1] + flat(ground[i - 1], ground[i]));
  const length = along[along.length - 1];
  let hopOnPhase: HopPhase | undefined;
  if (hopOn) hopOnPhase = hopPhase("on", ground[ground.length - 1], to, 0, 0, toYaw);
  const hopTime = (phases[0]?.duration ?? 0) + (hopOnPhase?.duration ?? 0);
  if (length > 0) {
    let duration = length / speed;
    duration = Math.max(duration, WALK_MIN_DURATION - hopTime);
    duration = Math.min(duration, Math.max(0.1, WALK_MAX_DURATION - hopTime));
    const headings: number[] = [], yaws: number[] = [];
    for (let i = 0; i + 1 < ground.length; i++) {
      headings.push(heading(ground[i], ground[i + 1], i ? headings[i - 1] : yaw));
      if (i === 0) yaws.push(yaw);
      else {
        // Where the previous stretch's turn had got to by its end.
        const stretch = along[i] - along[i - 1];
        yaws.push(angleLerp(yaws[i - 1], headings[i - 1], smooth(stretch / TURN_DISTANCE)));
      }
    }
    const walk: WalkPhase = { kind: "walk", start: t, duration, points: ground, along, length, ramp: Math.min(0.5, RAMP / duration), yaws, headings };
    phases.push(walk); t += duration;
    yaw = walkYaw(walk, length);
  }
  if (hopOnPhase) {
    hopOnPhase.start = t; hopOnPhase.yaw0 = yaw;
    phases.push(hopOnPhase); t += hopOnPhase.duration;
  }
  if (!phases.length) return dist3(from, to) < SAME ? planStill(to, toYaw) : planBlink(from, to, fromYaw, toYaw);
  return { kind: "walk", duration: t, from, to, fromYaw, toYaw, phases, hopsOn: hopOn };
}

function walkYaw(walk: WalkPhase, d: number): number {
  let i = 0;
  while (i < walk.headings.length - 1 && d > walk.along[i + 1]) i++;
  return angleLerp(walk.yaws[i], walk.headings[i], smooth((d - walk.along[i]) / TURN_DISTANCE));
}

/**
 * The move from `from` to `to` on `grid` (null: no grid, so no route): the
 * same place is no move (or a turn), no route is a blink, else the walk.
 */
export function planMove(grid: NavGrid | null, from: Vec3, to: Vec3, fromYaw: number, toYaw: number, speed = WALK_SPEED): WalkPlan {
  if (dist3(from, to) < SAME) return Math.abs(angleLerp(fromYaw, toYaw, 1) - fromYaw) > 0.001 ? planTurn(to, fromYaw, toYaw) : planStill(to, toYaw);
  const found = grid ? findRoute(grid, from, to) : null;
  if (!found?.ok) return planBlink(from, to, fromYaw, toYaw);
  return planRoute(found.route, from, to, fromYaw, toYaw, speed);
}

/** Where the move has got to `t` seconds after it started. */
export function poseAt(plan: WalkPlan, t: number): WalkPose {
  if (t >= plan.duration) return { position: [...plan.to], bob: 0, yaw: plan.toYaw, fade: 1 };
  if (t <= 0) return { position: [...plan.from], bob: 0, yaw: plan.fromYaw, fade: 1 };
  if (plan.kind === "blink") {
    return t < BLINK_TIME
      ? { position: [...plan.from], bob: 0, yaw: plan.fromYaw, fade: 1 - smooth(t / BLINK_TIME) }
      : { position: [...plan.to], bob: 0, yaw: plan.toYaw, fade: smooth((t - BLINK_TIME) / BLINK_TIME) };
  }
  if (plan.kind !== "walk") return { position: [...plan.to], bob: 0, yaw: angleLerp(plan.fromYaw, plan.toYaw, smooth(t / plan.duration)), fade: 1 };

  const phase = plan.phases.find((p) => t < p.start + p.duration) ?? plan.phases[plan.phases.length - 1];
  const u = Math.min(1, Math.max(0, (t - phase.start) / phase.duration));
  let position: Vec3, yaw: number, bob = 0;
  if (phase.kind === "hop") {
    position = lerp3(phase.from, phase.to, u);
    position[1] = hopHeight(phase, u);
    // Hopping off it turns toward the floor in the first half; hopping on, to the spot's facing over the whole hop.
    yaw = angleLerp(phase.yaw0, phase.yaw1, smooth(phase.role === "off" ? u * 2 : u));
  } else {
    const d = walked(u, phase.ramp) * phase.length;
    let i = 0;
    while (i < phase.points.length - 2 && d > phase.along[i + 1]) i++;
    const stretch = phase.along[i + 1] - phase.along[i];
    position = lerp3(phase.points[i], phase.points[i + 1], stretch > 0 ? (d - phase.along[i]) / stretch : 1);
    // Height runs evenly from one end's floor height to the other's.
    const f = phase.length > 0 ? d / phase.length : 1;
    position[1] = phase.points[0][1] + (phase.points[phase.points.length - 1][1] - phase.points[0][1]) * f;
    yaw = walkYaw(phase, d);
    if (phase.length > 0.05) bob = Math.abs(Math.sin(Math.PI * Math.max(1, Math.round(phase.length / STEP_LENGTH)) * f)) * STEP_HEIGHT;
  }
  // Not ending with a hop: turn to the spot's facing over the last moments.
  if (!plan.hopsOn) {
    const left = plan.duration - t;
    if (left < ARRIVE_TURN) yaw = angleLerp(yaw, plan.toYaw, smooth(1 - left / ARRIVE_TURN));
  }
  return { position, bob, yaw, fade: 1 };
}
