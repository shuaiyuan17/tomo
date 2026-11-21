import type { HomePart, HomeReaction, HomeScene } from "./scene.js";

/**
 * Where every part of a scene ends up, as the whole-scene check and the floor
 * plan both need it. Pure, bounded, and never trusts the scene to be sane:
 * kind cycles are cut, and the walk stops at a node budget.
 *
 * The placement rules are scene.ts's PLACEMENT:
 * - a part's `at` is its base centre in its parent's frame, then `turn`
 *   rotates it (degrees, three.js order X then Y then Z), then `scale`
 *   multiplies it and everything in it uniformly (sizes and positions);
 * - a shape, picture, sign or window occupies `size` (default [1, 1, 1]) standing on
 *   its base: y from 0 to size[1], x and z centred;
 * - a `kind` reference places that kind's parts as its children; a group
 *   (no shape, kind, picture, sign or window) is only a frame: its `size`
 *   means nothing (`scale` does);
 * - a top-level object with `on` is placed in the turned frame of the object
 *   it sits on, moved up to that object's top (the top of its own size for a
 *   shape, the top of its parts for a group or kind). It does not inherit
 *   that object's `scale`: it rests on it, it is not part of it.
 */

export type Vec3 = [number, number, number];
/** Row-major 3×3 rotation, a translation and a uniform scale (applied before the rotation). */
export interface Frame { r: number[]; t: Vec3; s: number }
export interface Box { min: Vec3; max: Vec3 }

export const IDENTITY: Frame = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1 };

/** Safety stop for the walk; well above MAX_OBJECTS so the count check still sees an overflow. */
export const WALK_BUDGET = 4000;

function rotation(turn: readonly number[] | undefined): number[] {
  if (!turn || (turn[0] === 0 && turn[1] === 0 && turn[2] === 0)) return IDENTITY.r;
  const [x, y, z] = turn.map((d) => (d * Math.PI) / 180);
  const [a, b] = [Math.cos(x), Math.sin(x)];
  const [c, d] = [Math.cos(y), Math.sin(y)];
  const [e, f] = [Math.cos(z), Math.sin(z)];
  // three.js Euler 'XYZ': R = Rx · Ry · Rz.
  return [
    c * e, -c * f, d,
    a * f + b * e * d, a * e - b * f * d, -b * c,
    b * f - a * e * d, b * e + a * f * d, a * c,
  ];
}
function mul(m: number[], n: number[]): number[] {
  const out = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = m[i * 3] * n[j] + m[i * 3 + 1] * n[3 + j] + m[i * 3 + 2] * n[6 + j];
  return out;
}
export function apply(frame: Frame, point: readonly number[]): Vec3 {
  const r = frame.r;
  const p = point.map((v) => v * frame.s);
  return [r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + frame.t[0], r[3] * p[0] + r[4] * p[1] + r[5] * p[2] + frame.t[1], r[6] * p[0] + r[7] * p[1] + r[8] * p[2] + frame.t[2]];
}
/** `parent` then a child at `at`, turned by `turn`, scaled by `scale`. */
export function child(parent: Frame, at: readonly number[] | undefined, turn: readonly number[] | undefined, scale = 1): Frame {
  return { t: apply(parent, at ?? [0, 0, 0]), r: mul(parent.r, rotation(turn)), s: parent.s * scale };
}
/** The world box of a local box (corners transformed, then bounded). */
export function boxIn(frame: Frame, local: Box): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = apply(frame, [i & 1 ? local.max[0] : local.min[0], i & 2 ? local.max[1] : local.min[1], i & 4 ? local.max[2] : local.min[2]]);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  }
  return { min, max };
}
export function union(a: Box | undefined, b: Box): Box {
  if (!a) return { min: [...b.min], max: [...b.max] };
  return { min: [0, 1, 2].map((k) => Math.min(a.min[k], b.min[k])) as Vec3, max: [0, 1, 2].map((k) => Math.max(a.max[k], b.max[k])) as Vec3 };
}
export function centre(box: Box): Vec3 { return [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2) as Vec3; }

/** What a part is: exactly one of these, or a group. */
export type PartWhat = "shape" | "kind" | "picture" | "sign" | "window" | "group";
export function whatOf(part: HomePart): PartWhat[] {
  const out: PartWhat[] = [];
  if (part.shape !== undefined) out.push("shape");
  if (part.kind !== undefined) out.push("kind");
  if (part.picture !== undefined) out.push("picture");
  if (part.sign !== undefined) out.push("sign");
  if (part.window !== undefined) out.push("window");
  return out;
}

/** A drawn part (shape, picture, sign or window) in world space. */
export interface PlacedLeaf {
  /** Index of the top-level object it belongs to. */
  object: number;
  part: HomePart;
  box: Box;
  /** A shape (pictures and signs are flat panels, not solid). */
  solid: boolean;
  /** The show and hide reactions on it and on what it is part of: when present, it is drawn only some of the time. */
  toggles?: HomeReaction[];
}
export interface PlacedObject {
  index: number;
  part: HomePart;
  /** Its own frame (base centre, turned). */
  frame: Frame;
  /** Everything it draws, in world space; undefined when it draws nothing. */
  box?: Box;
  leaves: PlacedLeaf[];
  /** Index of the object it sits on, when `on` names one that could be placed. */
  on?: number;
}
export interface Placement { objects: PlacedObject[]; truncated: boolean }

/** The local box of a leaf part (before its frame). */
export function leafBox(part: HomePart): Box {
  const [w, h, d] = part.size ?? [1, 1, 1];
  return { min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] };
}

/**
 * Places every top-level object of a schema-valid scene. A kind reference
 * that is missing or that would recurse into itself places nothing more; an
 * `on` that names nothing (or a cycle) places the object on the floor.
 */
export function placeScene(scene: HomeScene): Placement {
  let budget = WALK_BUDGET;
  let truncated = false;
  const kinds = scene.kinds ?? {};
  const ids = new Map<string, number>();
  scene.objects.forEach((object, index) => { if (object.id && !ids.has(object.id)) ids.set(object.id, index); });

  const walk = (part: HomePart, frame: Frame, object: number, leaves: PlacedLeaf[], stack: string[], above: HomeReaction[]): void => {
    if (--budget < 0) { truncated = true; return; }
    const what = whatOf(part);
    const own = (part.reactions ?? []).filter((r) => r.do === "show" || r.do === "hide");
    const toggles = own.length ? [...above, ...own] : above;
    if (what.includes("shape") || what.includes("picture") || what.includes("sign") || what.includes("window")) {
      leaves.push({ object, part, box: boxIn(frame, leafBox(part)), solid: what.includes("shape"), ...(toggles.length ? { toggles } : {}) });
    }
    if (part.kind !== undefined && kinds[part.kind] && !stack.includes(part.kind)) {
      for (const sub of kinds[part.kind].parts) walk(sub, child(frame, sub.at, sub.turn, sub.scale), object, leaves, [...stack, part.kind], toggles);
    }
    for (const sub of part.parts ?? []) walk(sub, child(frame, sub.at, sub.turn, sub.scale), object, leaves, stack, toggles);
  };

  const placed = new Map<number, PlacedObject>();
  const placing = new Set<number>();
  const place = (index: number): PlacedObject => {
    const done = placed.get(index);
    if (done) return done;
    const part = scene.objects[index];
    let base: Frame = IDENTITY;
    let on: number | undefined;
    const target = part.on !== undefined ? ids.get(part.on) : undefined;
    placing.add(index);
    if (target !== undefined && target !== index && !placing.has(target)) {
      const below = place(target);
      on = target;
      // Its top, in its turned frame, but not its scale: what rests on it is not part of it.
      base = { ...child(below.frame, [0, topOf(below), 0], undefined), s: 1 };
    }
    placing.delete(index);
    const frame = child(base, part.at, part.turn, part.scale);
    const leaves: PlacedLeaf[] = [];
    walk(part, frame, index, leaves, [], []);
    let box: Box | undefined;
    for (const leaf of leaves) box = union(box, leaf.box);
    const result: PlacedObject = { index, part, frame, leaves, ...(box ? { box } : {}), ...(on !== undefined ? { on } : {}) };
    placed.set(index, result);
    return result;
  };
  const objects = scene.objects.map((_, index) => place(index));
  return { objects, truncated };
}

/**
 * The height of an object's top above its own base, in its own frame: its
 * size for a shape, picture or sign, else the top of what it draws.
 */
function topOf(object: PlacedObject): number {
  const what = whatOf(object.part);
  if (what.includes("shape") || what.includes("picture") || what.includes("sign") || what.includes("window")) return (object.part.size ?? [1, 1, 1])[1];
  if (!object.box) return 0;
  // Its drawn box is in world units; the frame scales again, so undo its scale.
  return Math.max(0, object.box.max[1] - object.frame.t[1]) / object.frame.s;
}

/** The room as a box: x and z centred on the origin, y from the floor up. */
export function roomBox(scene: HomeScene): Box {
  const [w, h, d] = scene.room.size;
  return { min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] };
}

/** A number as the checker and floor plan write it: at most two decimals, no trailing zeros. */
export function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}
export function vec(value: readonly number[]): string { return `(${value.map(num).join(", ")})`; }
