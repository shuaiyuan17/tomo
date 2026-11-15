import type { HomePart, HomeReaction, HomeScene, HomeShape } from "../../../src/home/scene.js";
import type { Vec3 } from "./evaluate.js";

/**
 * The scene as a tree the renderer can build from, without three.js: kinds
 * expanded into instances, `on` resolved, and each node's bounding box so an
 * object knows where the top of the one it rests on is.
 *
 * The placement rules are the format's (scene.ts PLACEMENT; the checker and
 * Tomo's floor plan follow them too):
 * - `at` is a part's base centre in its parent's frame; `turn` then rotates
 *   it around x, then y, then z (three.js's XYZ order, R = Rx · Ry · Rz);
 * - a shape, picture, sign or window occupies `size`, standing on its base;
 *   `size` means nothing on a group or kind instance;
 * - `scale` multiplies a part and everything in it uniformly (sizes and
 *   positions of its parts), not what rests on it;
 * - an object `on` another is placed in that object's turned frame, at its
 *   top centre plus its own `at`: (0, height, 0) for a shape or panel, the
 *   centre of the top of its bounding box for a group or kind instance.
 *
 * In the renderer a node is an anchor (`at`, `turn`) holding a motion group
 * that reactions move; inside that, the content is scaled by `scale`.
 * Objects resting on it ride in the motion group, unscaled.
 */

export interface Box { min: Vec3; max: Vec3 }
export type NodeType = "shape" | "group" | "picture" | "sign" | "window";
export interface LayoutNode {
  /** Stable path through the scene ("o3/p1"), for phases and diffing. */
  key: string;
  type: NodeType;
  shape?: HomeShape;
  /** The mesh's size (shape, panel, window); unused for a group. */
  size: Vec3;
  /** Uniform scale of the node's content (its mesh and its parts). */
  scale: number;
  at: Vec3;
  turn: Vec3;
  color: string;
  background?: string;
  sign?: string;
  picture?: string;
  reactions: HomeReaction[];
  /** Inside the node, in its own units. */
  children: LayoutNode[];
  /** Top-level objects resting on this one (their `at` already measured from its top centre). */
  carried: LayoutNode[];
  /** Bounding box in the node's own (motion) frame, `scale` applied, carried objects excluded. */
  box: Box;
}

export const DEFAULT_COLOR = "#bfb3a0";
export const DEFAULT_SIGN_COLOR = "#2a2622";
export const DEFAULT_SIGN_BACKGROUND = "#f4efe6";
export const DEFAULT_WINDOW_FRAME = "#f1ead9";
/** Nodes built at most, whatever the scene says (the server's own limit is MAX_OBJECTS). */
export const NODE_BUDGET = 2_000;
/** Nesting followed at most, kinds included (the server checks MAX_DEPTH). */
export const MAX_NESTING = 8;

const ONE: Vec3 = [1, 1, 1], ZERO: Vec3 = [0, 0, 0];
const EMPTY_BOX: Box = { min: [0, 0, 0], max: [0, 0, 0] };

/** Rotation matrix rows for three.js's default Euler order (XYZ), degrees. */
export function rotationRows(turn: Vec3): [Vec3, Vec3, Vec3] {
  const [x, y, z] = turn.map((deg) => deg * Math.PI / 180);
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return [[c * e, -c * f, d], [af + be * d, ae - bf * d, -b * c], [bf - ae * d, be + af * d, a * c]];
}
/** `box` scaled, turned and moved into the parent's frame (an axis-aligned box around the result). */
export function transformBox(box: Box, at: Vec3, turn: Vec3, scale: Vec3 = ONE): Box {
  const rows = rotationRows(turn);
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [(i & 1 ? box.max[0] : box.min[0]) * scale[0], (i & 2 ? box.max[1] : box.min[1]) * scale[1], (i & 4 ? box.max[2] : box.min[2]) * scale[2]];
    for (let axis = 0; axis < 3; axis++) {
      const value = rows[axis][0] * p[0] + rows[axis][1] * p[1] + rows[axis][2] * p[2] + at[axis];
      min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}
function union(boxes: Box[]): Box {
  if (!boxes.length) return EMPTY_BOX;
  return { min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]))) as Vec3,
    max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]))) as Vec3 };
}
/**
 * Where something resting on a node goes, in its (turned) motion frame: the
 * top centre of a shape, picture, sign or window (its own height), or the
 * centre of the top of a group's or kind instance's bounding box.
 */
export function topCentre(node: LayoutNode): Vec3 {
  if (node.type !== "group") return [0, node.size[1] * node.scale, 0];
  if (!node.children.length) return [0, 0, 0];
  return [(node.box.min[0] + node.box.max[0]) / 2, node.box.max[1], (node.box.min[2] + node.box.max[2]) / 2];
}
function childBox(child: LayoutNode): Box { return transformBox(child.box, child.at, child.turn); }

interface Context { kinds: NonNullable<HomeScene["kinds"]>; budget: { left: number }; kindStack: string[] }

function layoutPart(part: HomePart, key: string, depth: number, ctx: Context): LayoutNode | null {
  if (ctx.budget.left <= 0 || depth > MAX_NESTING) return null;
  ctx.budget.left--;
  const type: NodeType = part.shape ? "shape" : part.picture ? "picture" : part.sign !== undefined ? "sign" : part.window ? "window" : "group";
  const node: LayoutNode = {
    key, type, size: part.size ?? ONE, scale: part.scale ?? 1, at: part.at ?? ZERO, turn: part.turn ?? ZERO,
    color: part.color ?? (type === "sign" ? DEFAULT_SIGN_COLOR : type === "window" ? DEFAULT_WINDOW_FRAME : DEFAULT_COLOR), reactions: part.reactions ?? [],
    children: [], carried: [], box: EMPTY_BOX,
    ...(part.shape ? { shape: part.shape } : {}), ...(part.picture ? { picture: part.picture } : {}),
    ...(type === "sign" ? { sign: part.sign, background: part.background ?? DEFAULT_SIGN_BACKGROUND } : {}),
  };
  // Only a part that is nothing else is a kind instance (one of shape / kind / picture / sign says what it is).
  const kindParts = type === "group" && part.kind && !ctx.kindStack.includes(part.kind) ? ctx.kinds[part.kind]?.parts ?? [] : [];
  if (kindParts.length) ctx.kindStack.push(part.kind!);
  kindParts.forEach((child, i) => { const built = layoutPart(child, `${key}/k${i}`, depth + 1, ctx); if (built) node.children.push(built); });
  if (kindParts.length) ctx.kindStack.pop();
  (part.parts ?? []).forEach((child, i) => { const built = layoutPart(child, `${key}/p${i}`, depth + 1, ctx); if (built) node.children.push(built); });
  node.box = boxOf(node);
  return node;
}

function boxOf(node: LayoutNode): Box {
  const inside = union(node.children.map(childBox));
  const [w, h, d] = node.size;
  const unscaled = node.type === "group" ? (node.children.length ? inside : EMPTY_BOX)
    : node.children.length ? union([{ min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] }, inside]) : { min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] } as Box;
  const s = node.scale;
  return s === 1 ? unscaled : { min: unscaled.min.map((v) => v * s) as Vec3, max: unscaled.max.map((v) => v * s) as Vec3 };
}

export interface SceneLayout {
  /** Objects standing in the room (carried ones hang off their bearer). */
  roots: LayoutNode[];
  /** Nodes built, carried ones included. */
  count: number;
  /** Top-level objects whose `on` could not be followed (missing, itself, or a loop): they stand in the room. */
  unresolved: string[];
}

/** The scene's objects, kinds expanded and `on` resolved. */
export function layoutScene(scene: HomeScene, budget = NODE_BUDGET): SceneLayout {
  const ctx: Context = { kinds: scene.kinds ?? {}, budget: { left: budget }, kindStack: [] };
  const built = scene.objects.map((part, i) => ({ part, node: layoutPart(part, `o${i}`, 0, ctx) }));
  const byId = new Map<string, { part: HomePart; node: LayoutNode | null }>();
  for (const entry of built) if (entry.part.id && entry.node && !byId.has(entry.part.id)) byId.set(entry.part.id, entry);
  // An `on` is followed when its target exists and the chain from there never
  // comes back to this object. (A loop further up breaks where it closes.)
  const resolvable = (start: HomePart): boolean => {
    if (!start.on || start.on === start.id || !byId.has(start.on)) return false;
    const seen = new Set<string>();
    let current: HomePart | undefined = byId.get(start.on)!.part;
    while (current?.id && !seen.has(current.id)) {
      seen.add(current.id);
      if (!current.on) return true;
      if (current.on === start.id) return false;
      current = byId.get(current.on)?.part;
    }
    return true;
  };
  const roots: LayoutNode[] = [], unresolved: string[] = [];
  for (const { part, node } of built) {
    if (!node) continue;
    if (!part.on) { roots.push(node); continue; }
    if (!resolvable(part)) { unresolved.push(part.id ?? node.key); roots.push(node); continue; }
    const bearer = byId.get(part.on)!.node!;
    const top = topCentre(bearer);
    node.at = [top[0] + node.at[0], top[1] + node.at[1], top[2] + node.at[2]];
    bearer.carried.push(node);
  }
  return { roots, count: budget - ctx.budget.left, unresolved };
}

/** A character's body: an instance of `kind`, standing at its own origin. */
export function layoutKind(scene: HomeScene, kind: string, key: string, budget = 400): LayoutNode | null {
  if (!scene.kinds?.[kind]) return null;
  return layoutPart({ kind }, key, 0, { kinds: scene.kinds, budget: { left: budget }, kindStack: [] });
}
