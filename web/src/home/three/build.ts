import { Color, Group, Mesh, type MeshStandardMaterial, type Object3D } from "three";
import { NO_EFFECTS, type PartEffects } from "../evaluate.js";
import type { LayoutNode } from "../layout.js";
import { drawSign, Resources, SIGN_PIXEL_BUDGET, signCanvasSize } from "./resources.js";
import { windowCanvasSize } from "./sky-canvas.js";

/**
 * A layout tree made into three.js objects, and the per-frame animation of
 * the parts that react. Each node is an anchor (its `at` and `turn`) holding
 * a motion group (what reactions move) holding the mesh or the group's
 * scaled contents, then whatever rests on it.
 */

export interface MeshEntry { material: MeshStandardMaterial; base: Color }
type Weight = "show" | "glow" | "tint" | "bob" | "spin" | "swing" | "pulse";
export interface PartRuntime {
  node: LayoutNode;
  motion: Object3D;
  /** Meshes under this part with materials of their own (it glows or tints them). */
  meshes: MeshEntry[];
  phase: number;
  target: PartEffects;
  weights: Record<Weight, number>;
  /** The last settings each reaction had, so it eases out as it was. */
  last: { glow: Color | null; tint: Color; bob: { amount: number; speed: number }; swing: { amount: number; speed: number }; pulse: { amount: number; speed: number }; spin: number };
  spinAngle: number;
}
/** A sign with nothing to say (its values are all empty) is not drawn. */
export interface SignRuntime { node: LayoutNode; canvas: HTMLCanvasElement; texture: { needsUpdate: boolean }; panel: Object3D | null; text: string | null; color: string; background: string }
/** A window's sky: redrawn by the stage when the sky changes, and while its weather moves. */
export interface WindowRuntime { canvas: HTMLCanvasElement; texture: { needsUpdate: boolean } }
export interface Built { root: Object3D; parts: PartRuntime[]; signs: SignRuntime[]; windows: WindowRuntime[] }

const RAD = Math.PI / 180;
const recolours = (node: LayoutNode) => node.reactions.some((r) => r.do === "glow" || r.do === "tint");

function phaseOf(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 6283) / 1000;
}

/** Sign pixels before any budget scaling, so a scene full of signs is drawn smaller rather than all at full size. */
export function signPixels(nodes: LayoutNode[]): number {
  let total = 0;
  const walk = (node: LayoutNode) => {
    if (node.type === "sign") { const [w, h] = signCanvasSize(node.size[0], node.size[1]); total += w * h; }
    node.children.forEach(walk); node.carried.forEach(walk);
  };
  nodes.forEach(walk);
  return total;
}

export function buildNodes(nodes: LayoutNode[], resources: Resources, signScale = 1): Built {
  const root = new Group();
  const built: Built = { root, parts: [], signs: [], windows: [] };
  for (const node of nodes) root.add(buildNode(node, resources, built, [], signScale));
  return built;
}
/** Sign canvases scaled down to fit SIGN_PIXEL_BUDGET across everything drawn. */
export function signScaleFor(pixels: number): number { return pixels > SIGN_PIXEL_BUDGET ? Math.sqrt(SIGN_PIXEL_BUDGET / pixels) : 1; }

function buildNode(node: LayoutNode, resources: Resources, built: Built, collectors: MeshEntry[][], signScale: number): Object3D {
  const anchor = new Group();
  anchor.position.set(...node.at);
  anchor.rotation.set(node.turn[0] * RAD, node.turn[1] * RAD, node.turn[2] * RAD);
  const motion = new Group();
  anchor.add(motion);
  let part: PartRuntime | undefined;
  if (node.reactions.length) {
    part = { node, motion, meshes: [], phase: phaseOf(node.key), target: NO_EFFECTS,
      weights: { show: 1, glow: 0, tint: 0, bob: 0, spin: 0, swing: 0, pulse: 0 },
      last: { glow: null, tint: new Color(), bob: { amount: 0, speed: 1 }, swing: { amount: 0, speed: 1 }, pulse: { amount: 0, speed: 1 }, spin: 0 }, spinAngle: 0 };
    built.parts.push(part);
  }
  const stack = part && recolours(node) ? [...collectors, part.meshes] : collectors;
  const own = stack.length > 0;
  const material = (color: string, map?: MeshStandardMaterial["map"]) => {
    if (!own && !map) return resources.shared(color);
    const made = resources.own(color, map ?? undefined);
    if (map) made.emissiveMap = map;
    if (own) { const entry = { material: made, base: made.color.clone() }; for (const list of stack) list.push(entry); }
    return made;
  };
  // `scale` multiplies the content (mesh and parts); what rests on the node rides in `motion`, unscaled.
  const content = node.scale === 1 ? motion : new Group();
  if (content !== motion) { content.scale.setScalar(node.scale); motion.add(content); }
  const addMesh = (mesh: Mesh) => { mesh.castShadow = true; mesh.receiveShadow = true; mesh.scale.set(...node.size); content.add(mesh); };

  if (node.type === "shape") addMesh(new Mesh(resources.geometry(node.shape!), material(node.color)));
  else if (node.type === "window") buildWindow(node, content, resources, built, material);
  else if (node.type === "sign" || node.type === "picture") {
    const side = material(node.type === "sign" ? node.background! : node.color);
    let front: MeshStandardMaterial;
    let sign: SignRuntime | undefined;
    if (node.type === "sign") {
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = signCanvasSize(node.size[0], node.size[1], signScale);
      drawSign(canvas, "", node.color, node.background!);
      const texture = resources.canvasTexture(canvas);
      front = material("#ffffff", texture);
      sign = { node, canvas, texture, panel: null, text: null, color: node.color, background: node.background! };
      built.signs.push(sign);
    } else {
      front = material("#ffffff", resources.blank);
      resources.picture(node.picture!, (texture) => { front.map = texture; front.emissiveMap = texture; });
    }
    // BoxGeometry faces: +x, -x, +y, -y, +z (the front), -z.
    const panel = new Mesh(resources.geometry("panel"), [side, side, side, side, front, side]);
    addMesh(panel);
    if (sign) { sign.panel = panel; panel.visible = false; }
  }
  // A group's `size` scales nothing: its parts are placed in its own units.
  for (const child of node.children) content.add(buildNode(child, resources, built, stack, signScale));
  for (const carried of node.carried) motion.add(buildNode(carried, resources, built, [], signScale));
  return anchor;
}

/**
 * A window: a pane showing the sky (a canvas the stage draws; it gives its
 * own light, so it reads as outside), set in a frame of the part's colour
 * with a cross of glazing bars in front.
 */
function buildWindow(node: LayoutNode, motion: Object3D, resources: Resources, built: Built,
  material: (color: string, map?: MeshStandardMaterial["map"]) => MeshStandardMaterial): void {
  const [w, h, d] = node.size;
  const canvas = document.createElement("canvas");
  [canvas.width, canvas.height] = windowCanvasSize(w, h);
  const texture = resources.canvasTexture(canvas);
  const pane = resources.own("#ffffff", texture);
  pane.emissiveMap = texture; pane.emissive.set("#ffffff"); pane.emissiveIntensity = 0.75;
  const frame = material(node.color);
  const mesh = (size: [number, number, number], at: [number, number, number], fill: MeshStandardMaterial | MeshStandardMaterial[]) => {
    const made = new Mesh(resources.geometry("box"), fill);
    made.scale.set(...size); made.position.set(...at); made.castShadow = true; made.receiveShadow = true; motion.add(made); return made;
  };
  const bar = Math.max(0.03, Math.min(w, h) * 0.06);
  const glass = mesh([w - bar, h - bar, d * 0.5], [0, bar / 2, 0], [frame, frame, frame, frame, pane, frame]);
  glass.castShadow = false;
  const front = d / 2 + 0.005;
  mesh([w, bar, d + 0.01], [0, 0, 0.005], frame);
  mesh([w, bar, d + 0.01], [0, h - bar, 0.005], frame);
  mesh([bar, h, d + 0.01], [-w / 2 + bar / 2, 0, 0.005], frame);
  mesh([bar, h, d + 0.01], [w / 2 - bar / 2, 0, 0.005], frame);
  mesh([bar * 0.6, h - bar, 0.012], [0, bar / 2, front], frame);
  mesh([w - bar, bar * 0.6, 0.012], [0, h * 0.55, front], frame);
  built.windows.push({ canvas, texture });
}

/** Brings each sign's text up to date; true when any changed. */
export function updateSigns(signs: SignRuntime[], text: (sign: SignRuntime) => string): boolean {
  let changed = false;
  for (const sign of signs) {
    const next = text(sign);
    if (next === sign.text) continue;
    sign.text = next; drawSign(sign.canvas, next, sign.color, sign.background); sign.texture.needsUpdate = true; changed = true;
    if (sign.panel) sign.panel.visible = next.trim() !== "";
  }
  return changed;
}
/** Redraws every sign (the sign font arrived). */
export function redrawSigns(signs: SignRuntime[]): void {
  for (const sign of signs) { drawSign(sign.canvas, sign.text ?? "", sign.color, sign.background); sign.texture.needsUpdate = true; }
}

const RATE: Record<Weight, number> = { show: 12, glow: 6, tint: 6, bob: 4, spin: 3, swing: 3, pulse: 4 };
const GLOW_INTENSITY = 0.9;
const MOTIONS = ["bob", "spin", "swing", "pulse"] as const;

/** New conditions: each part's reactions are worked out again (their weights then ease there). */
export function retarget(part: PartRuntime, effects: PartEffects): void {
  part.target = effects;
  if (effects.glow) part.last.glow = effects.glow === "self" ? null : new Color(effects.glow);
  if (effects.tint) part.last.tint.set(effects.tint);
  if (effects.bob) part.last.bob = effects.bob;
  if (effects.swing) part.last.swing = effects.swing;
  if (effects.pulse) part.last.pulse = effects.pulse;
  if (effects.spin) part.last.spin = effects.spin.speed;
}

/**
 * Moves a part one frame on (`dt` seconds; `t` the clock). With reduced
 * motion states are applied at once and nothing moves. Returns whether it
 * still needs frames.
 */
export function stepPart(part: PartRuntime, dt: number, t: number, reduced: boolean): boolean {
  const { target, weights, last, motion } = part;
  const goal: Record<Weight, number> = { show: target.visible ? 1 : 0, glow: target.glow ? 1 : 0, tint: target.tint ? 1 : 0,
    bob: target.bob ? 1 : 0, spin: target.spin ? 1 : 0, swing: target.swing ? 1 : 0, pulse: target.pulse ? 1 : 0 };
  if (reduced) for (const motionKind of MOTIONS) goal[motionKind] = 0;
  let busy = false;
  for (const key of Object.keys(goal) as Weight[]) {
    const from = weights[key];
    weights[key] = reduced ? goal[key] : ease(from, goal[key], dt, RATE[key]);
    if (weights[key] !== goal[key]) busy = true;
  }
  const wave = (speed: number) => Math.sin(2 * Math.PI * speed * t + part.phase);
  motion.position.y = weights.bob ? last.bob.amount * (1 - Math.cos(2 * Math.PI * last.bob.speed * t + part.phase)) / 2 * weights.bob : 0;
  motion.rotation.z = weights.swing ? last.swing.amount * RAD * wave(last.swing.speed) * weights.swing : 0;
  if (weights.spin) part.spinAngle = (part.spinAngle + 2 * Math.PI * last.spin * dt * weights.spin) % (2 * Math.PI);
  motion.rotation.y = part.spinAngle;
  const pulse = weights.pulse ? 1 + last.pulse.amount * wave(last.pulse.speed) * weights.pulse : 1;
  motion.scale.setScalar(Math.max(0.0001, weights.show) * pulse);
  motion.visible = weights.show > 0.002;
  for (const entry of part.meshes) {
    entry.material.color.copy(entry.base);
    if (weights.tint) entry.material.color.lerp(last.tint, weights.tint);
    entry.material.emissive.copy(last.glow ?? entry.material.color);
    entry.material.emissiveIntensity = weights.glow * GLOW_INTENSITY;
  }
  return busy || (!reduced && MOTIONS.some((kind) => weights[kind] > 0));
}

/** Exponential approach that lands exactly once close. */
export function ease(from: number, to: number, dt: number, rate: number): number {
  const next = to + (from - to) * Math.exp(-rate * dt);
  return Math.abs(next - to) < 0.002 ? to : next;
}
