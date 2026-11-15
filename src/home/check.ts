import type { core } from "zod";
import {
  ASSET_NAME, CONDITIONS, homeSceneSchema, MAX_DEPTH, MAX_KINDS, MAX_OBJECTS, MAX_REACTIONS, MAX_SCENE_BYTES, MAX_SIGN_CHARS,
  MAX_SPOTS, REACTION_DEFAULTS, REACTIONS, SHAPES, SIGN_VALUES, SLUG, type HomePart, type HomeScene,
} from "./scene.js";
import { centre, num, placeScene, roomBox, vec, whatOf, type Box } from "./geometry.js";

/**
 * The whole-scene check: everything the zod schema cannot see because it
 * needs the whole scene (references, cycles, counts, bounds, assets), plus
 * non-fatal warnings. Pure: the caller passes the asset names it found.
 *
 * Every problem is one plain sentence that names the place
 * (`objects[3] "screen": …`) and says how to fix it. These are read by Tomo,
 * which then edits the file, so they say what to change rather than what the
 * validator thought.
 */

export interface HomeCheckResult {
  /** No problems: `scene` is safe to draw. Warnings never make it false. */
  ok: boolean;
  scene?: HomeScene;
  problems: string[];
  warnings: string[];
}
export interface HomeCheckOptions {
  /** Files present in `home/assets/`. Undefined: pictures are not checked against the folder. */
  assets?: ReadonlySet<string>;
  /** Files in `home/assets/` that cannot be used, with the reason (files.ts listHomeAssets). */
  refusedAssets?: ReadonlyMap<string, string>;
}

/** At most this many problems (and warnings) are listed; the rest are counted. */
export const MAX_LISTED = 40;
/** A part whose centre is further than this outside a wall, the floor or the ceiling is a problem. */
export const FAR_OUTSIDE_M = 1;
/** The pet's mood words (src/mcp/pet-store.ts PetMood); a `pet:` condition naming another can never hold. */
export const PET_MOODS = ["sleeping", "recovering", "blissful", "happy", "content", "bored", "sad", "miserable", "sick", "hungry"] as const;

const PART_KEYS = ["id", "shape", "kind", "picture", "sign", "window", "background", "size", "scale", "at", "turn", "color", "on", "reactions", "parts"];
const KNOWN_KEYS = [...PART_KEYS, "version", "name", "room", "light", "kinds", "objects", "spots", "characters", "floor", "walls", "backdrop",
  "angle", "level", "when", "do", "amount", "speed", "facing", "tomo", "visitors", "pet", "spot", "rules", "overflow"];
/** Rough width of the text a `{value}` turns into, in characters. */
/** The smallest a sign's text is drawn, as a share of the panel's height, before it is cut with an ellipsis. */
export const SIGN_MIN_TEXT_HEIGHT = 0.3;
const VALUE_WIDTH: Record<string, number> = { subagents: 2, tasks: 2, tool: 8, idle: 6, next_job: 10, status: 28, task: 36 };

class Report {
  problems: string[] = [];
  warnings: string[] = [];
  problem(text: string): void { this.problems.push(text); }
  warn(text: string): void { this.warnings.push(text); }
  result(scene?: HomeScene): HomeCheckResult {
    const clip = (list: string[]) => list.length <= MAX_LISTED ? list : [...list.slice(0, MAX_LISTED), `…and ${list.length - MAX_LISTED} more like these.`];
    const ok = this.problems.length === 0 && scene !== undefined;
    return { ok, ...(ok ? { scene } : {}), problems: clip(this.problems), warnings: clip(this.warnings) };
  }
}

/** Checks the text of a scene file. */
export function checkHomeSceneText(text: string, options: HomeCheckOptions = {}, fileName = "scene.json"): HomeCheckResult {
  const report = new Report();
  if (Buffer.byteLength(text) > MAX_SCENE_BYTES) {
    report.problem(`${fileName} is ${Math.ceil(Buffer.byteLength(text) / 1024)} KiB; the most is ${MAX_SCENE_BYTES / 1024} KiB. Use kinds for repeated things instead of copying them.`);
    return report.result();
  }
  let value: unknown;
  const body = text.replace(/^\uFEFF/, "");
  try { value = JSON.parse(body); }
  catch (error) {
    // Only where, never the parser's message: it quotes the file's text.
    const message = error instanceof Error ? error.message : "";
    const position = Number(/position (\d+)/.exec(message)?.[1] ?? NaN);
    let where = body.trim() === "" ? " (the file is empty)" : message.includes("end of JSON") ? " (it ends too early)" : "";
    if (Number.isFinite(position)) {
      const before = body.slice(0, position).split("\n");
      where = ` near line ${before.length}, column ${before.at(-1)!.length + 1}`;
    }
    report.problem(`${fileName} is not valid JSON${where}. Fix the syntax there: a missing comma or quote, a trailing comma, or a comment (JSON has none).`);
    return report.result();
  }
  return checkHomeScene(value, options);
}

/** Checks a parsed scene. */
export function checkHomeScene(value: unknown, options: HomeCheckOptions = {}): HomeCheckResult {
  const report = new Report();
  const parsed = homeSceneSchema.safeParse(value);
  if (!parsed.success) {
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const text = describeIssue(issue, value);
      if (!seen.has(text)) { seen.add(text); report.problem(text); }
    }
    return report.result();
  }
  checkWhole(parsed.data, options, report);
  return report.result(parsed.data);
}

// ---------------------------------------------------------------------------
// Schema problems, in words
// ---------------------------------------------------------------------------

/** `objects[3] "screen".parts[1].color`, naming objects by id where they have one. */
export function placeName(path: readonly PropertyKey[], root: unknown): string {
  let out = "";
  let node: unknown = root;
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out ? `.${String(key)}` : String(key);
    node = node && typeof node === "object" ? (node as Record<PropertyKey, unknown>)[key] : undefined;
    if (typeof key === "number" && node && typeof node === "object" && !Array.isArray(node)) {
      const id = (node as { id?: unknown }).id;
      if (typeof id === "string" && id.length <= 40) out += ` ${JSON.stringify(id)}`;
    }
  }
  return out || "the scene";
}
function valueAt(path: readonly PropertyKey[], root: unknown): unknown {
  let node = root;
  for (const key of path) node = node && typeof node === "object" ? (node as Record<PropertyKey, unknown>)[key] : undefined;
  return node;
}
function shown(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
/** What a field's string should look like, by the field's name. */
function formatHint(field: string | undefined, parent: string | undefined): string {
  if (field && ["color", "background", "floor", "walls", "backdrop"].includes(field)) return "a colour written as # and six hex digits, like #a9825b";
  if (field === "picture") return `a file name in home/assets/ (lowercase, ending .png, .jpg, .webp or .svg, like ${shown("poster.png")})`;
  if (field === "when" || parent === "when") return `a condition from the list (${CONDITIONS.join(", ")}), optionally with not: in front, or pet:<mood>`;
  return "lowercase letters, digits and dashes, starting with a letter, at most 40 characters (like desk-lamp)";
}
function didYouMean(word: string, options: readonly string[]): string {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const option of options) {
    const score = distance(word.toLowerCase(), option.toLowerCase());
    if (score < bestScore) { best = option; bestScore = score; }
  }
  return best && bestScore <= Math.max(1, Math.floor(word.length / 3)) ? ` (did you mean ${JSON.stringify(best)}?)` : "";
}
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = old;
    }
  }
  return row[b.length];
}

function describeIssue(issue: core.$ZodIssue, root: unknown): string {
  const path = issue.path;
  const place = placeName(path, root);
  const field = typeof path.at(-1) === "string" ? String(path.at(-1)) : undefined;
  const parent = path.length > 1 && typeof path.at(-2) === "string" ? String(path.at(-2)) : undefined;
  const value = valueAt(path, root);
  switch (issue.code) {
    case "invalid_type":
      if (value === undefined) return `${place} is missing; add it.`;
      return `${place}: ${shown(value)} should be ${issue.expected === "tuple" ? "a list of three numbers like [1, 0.5, 2]" : `a ${issue.expected}`}.`;
    case "unrecognized_keys":
      return issue.keys.map((key) => `${place}: ${JSON.stringify(key)} is not part of the scene format${didYouMean(key, KNOWN_KEYS)}; remove it or rename it.`).join(" ");
    case "invalid_value": {
      if (field === "do") return `${place}: ${shown(value)} is not a reaction${didYouMean(String(value), REACTIONS)}; use one of ${REACTIONS.join(", ")}.`;
      if (field === "shape") return `${place}: ${shown(value)} is not a shape${didYouMean(String(value), SHAPES)}; use one of ${SHAPES.join(", ")}.`;
      if (field === "version") return `${place} must be 1.`;
      if (field === "window") return `${place}: window can only be true (the app draws the sky in it); remove it to make this something else.`;
      return `${place}: ${shown(value)} is not allowed here; use one of ${issue.values.map((v) => JSON.stringify(v)).join(", ")}.`;
    }
    case "invalid_format":
      if (field === "picture" && typeof value === "string" && !ASSET_NAME.test(value)) {
        return `${place}: ${shown(value)} is not a picture name; it must be ${formatHint(field, parent)}, with no folder in front.`;
      }
      return `${place}: ${shown(value)} should be ${formatHint(field, parent)}.`;
    case "invalid_key":
      return `${place}: the name ${shown(path.at(-1))} should be ${formatHint(undefined, undefined)}; rename it.`;
    case "too_big":
    case "too_small": {
      const big = issue.code === "too_big";
      const limit = big ? (issue as core.$ZodIssueTooBig).maximum : (issue as core.$ZodIssueTooSmall).minimum;
      if (issue.origin === "number") return `${place}: ${shown(value)} is too ${big ? "large" : "small"}; the ${big ? "most" : "least"} is ${String(limit)}.`;
      if (issue.origin === "array") {
        const n = Array.isArray(value) ? value.length : 0;
        if (field === "size" || field === "at" || field === "turn") return `${place} must be exactly three numbers [x, y, z]; it has ${n}.`;
        if (field === "reactions") return `${place} has ${n} reactions; the most is ${MAX_REACTIONS}. Split them over parts.`;
        return `${place} has ${n} entries; the ${big ? "most" : "least"} is ${String(limit)}.`;
      }
      if (issue.origin === "string") {
        if (field === "sign") return `${place}: the sign text is ${String(value).length} characters; the most is ${MAX_SIGN_CHARS}. Shorten it.`;
        return `${place} is too ${big ? "long" : "short"}; the ${big ? "most" : "least"} is ${String(limit)} characters.`;
      }
      return `${place} is too ${big ? "large" : "small"} (limit ${String(limit)}).`;
    }
    case "invalid_union":
      if (field === "when") return `${place}: ${shown(value)} should be a condition, or a list of one to four conditions; a condition is ${formatHint("when", undefined)}.`;
      return `${place}: ${shown(value)} is not in a shape the format accepts.`;
    default:
      return `${place}: ${issue.message}.`;
  }
}

// ---------------------------------------------------------------------------
// Whole-scene problems
// ---------------------------------------------------------------------------

interface Visit { part: HomePart; place: string; top: boolean; kind?: string }

function checkWhole(scene: HomeScene, options: HomeCheckOptions, report: Report): void {
  const kinds = scene.kinds ?? {};
  const kindNames = Object.keys(kinds);
  const spots = scene.spots ?? {};
  const visitorKinds = visitorKindSet(scene);

  if (kindNames.length > MAX_KINDS) report.problem(`kinds has ${kindNames.length} entries; the most is ${MAX_KINDS}. Merge kinds that look alike.`);
  if (Object.keys(spots).length > MAX_SPOTS) report.problem(`spots has ${Object.keys(spots).length} entries; the most is ${MAX_SPOTS}. Remove spots nothing uses.`);

  // Duplicate top-level ids.
  const firstId = new Map<string, number>();
  scene.objects.forEach((object, index) => {
    if (!object.id) return;
    const first = firstId.get(object.id);
    if (first === undefined) firstId.set(object.id, index);
    else report.problem(`objects[${index}] ${JSON.stringify(object.id)}: objects[${first}] already has this id; give each top-level object its own id.`);
  });

  // Every node, in the objects and in the kinds.
  const visits: Visit[] = [];
  const collect = (part: HomePart, place: string, top: boolean, kind?: string) => {
    if (visits.length > 20_000) return;
    visits.push({ part, place, top, ...(kind ? { kind } : {}) });
    (part.parts ?? []).forEach((sub, i) => collect(sub, `${place}.parts[${i}]${sub.id ? ` ${JSON.stringify(sub.id)}` : ""}`, false, kind));
  };
  scene.objects.forEach((object, i) => collect(object, `objects[${i}]${object.id ? ` ${JSON.stringify(object.id)}` : ""}`, true));
  for (const name of kindNames) kinds[name].parts.forEach((part, i) => collect(part, `kinds.${name}.parts[${i}]${part.id ? ` ${JSON.stringify(part.id)}` : ""}`, false, name));

  const usedKinds = new Set<string>();
  const usedPictures = new Set<string>();
  for (const { part, place, top, kind } of visits) {
    const what = whatOf(part);
    if (what.length > 1) report.problem(`${place}: it is a ${what.join(" and a ")} at once; a part is exactly one of shape, kind, picture, sign or window. Split it into separate parts.`);
    if (what.length === 0 && !(part.parts?.length)) report.problem(`${place}: it is nothing: give it a shape, kind, picture, sign or window, or parts to group.`);
    if (part.kind !== undefined) {
      usedKinds.add(part.kind);
      if (!kinds[part.kind]) report.problem(`${place}: kind ${JSON.stringify(part.kind)} is not defined${didYouMean(part.kind, kindNames)}; add it under kinds or use one of ${kindNames.length ? kindNames.join(", ") : "(none defined)"}.`);
    }
    if (part.on !== undefined) {
      if (!top) report.problem(`${place}: on is only for top-level objects; place a part with at, relative to its parent, instead.`);
      else if (part.on === part.id) report.problem(`${place}: it sits on itself; on must name another top-level object.`);
      else if (!firstId.has(part.on)) report.problem(`${place}: on ${JSON.stringify(part.on)} names no top-level object${didYouMean(part.on, [...firstId.keys()])}; use the id of the object it rests on.`);
    }
    if (part.picture !== undefined) {
      usedPictures.add(part.picture);
      const refused = options.refusedAssets?.get(part.picture);
      if (refused) report.problem(`${place}: picture ${JSON.stringify(part.picture)} is in home/assets/ but cannot be used: ${refused}. Replace the file, or remove the picture.`);
      else if (options.assets && !options.assets.has(part.picture)) report.problem(`${place}: picture ${JSON.stringify(part.picture)} is not in home/assets/; put the image file there under exactly that name, or remove the picture.`);
    }
    if (part.size !== undefined && !what.some((w) => w === "shape" || w === "picture" || w === "sign" || w === "window")) {
      report.warn(`${place}: size means nothing on a ${what.includes("kind") ? "kind instance" : "group"}; to make it bigger or smaller use "scale" (like "scale": 1.5), which grows it and everything in it.`);
    }
    if (part.background !== undefined && part.sign === undefined) report.warn(`${place}: background only colours a sign's panel, and this part is not a sign; remove it or use color.`);
    if (part.sign !== undefined) checkSign(part, place, kind !== undefined && visitorKinds.has(kind), report);
    (part.reactions ?? []).forEach((reaction, i) => {
      const cap = (REACTION_DEFAULTS as Record<string, { max?: number }>)[reaction.do]?.max;
      if (cap !== undefined && reaction.amount !== undefined && reaction.amount > cap) {
        report.warn(`${place}.reactions[${i}]: ${reaction.do} amount ${num(reaction.amount)} is above its cap of ${num(cap)} and will be drawn as ${num(cap)}; use ${num(cap)} or less.`);
      }
      if (reaction.do === "tint" && !reaction.color) report.problem(`${place}.reactions[${i}]: tint needs a color to change to; add "color": "#rrggbb".`);
      for (const condition of Array.isArray(reaction.when) ? reaction.when : [reaction.when]) {
        const mood = /^(?:not:)?pet:(.+)$/.exec(condition)?.[1];
        if (mood && !(PET_MOODS as readonly string[]).includes(mood)) report.warn(`${place}.reactions[${i}]: pet:${mood} can never hold; the pet's moods are ${PET_MOODS.join(", ")}.`);
      }
    });
  }

  // `on` cycles (a → b → a): each object is on the floor otherwise.
  scene.objects.forEach((object, index) => {
    const chain: number[] = [index];
    let at = object.on !== undefined ? firstId.get(object.on) : undefined;
    while (at !== undefined && at !== index && !chain.includes(at)) { chain.push(at); const on = scene.objects[at].on; at = on !== undefined ? firstId.get(on) : undefined; }
    if (at === index && chain.length > 1 && Math.min(...chain) === index) {
      report.problem(`objects[${index}]: ${chain.map((i) => JSON.stringify(scene.objects[i].id ?? `objects[${i}]`)).join(" sits on ")} sits on ${JSON.stringify(object.id)} again; something must stand on the floor. Remove one of these on.`);
    }
  });

  checkKindCycles(kinds, report);
  checkCounts(scene, report);
  checkCharacters(scene, usedKinds, report);
  for (const name of kindNames) if (!usedKinds.has(name)) report.warn(`kinds.${name} is defined but nothing uses it; remove it, or use it with "kind": ${JSON.stringify(name)}.`);
  checkPlacement(scene, report);
}

/** The visitors' kinds and every kind they are built from: a `{task}` sign in any of them is on a visitor. */
function visitorKindSet(scene: HomeScene): Set<string> {
  const visitors = scene.characters?.visitors;
  const found = new Set<string>();
  const queue = visitors ? [visitors.kind, ...Object.values(visitors.kinds ?? {})] : [];
  const visit = (parts: readonly HomePart[] | undefined): void => {
    for (const part of parts ?? []) { if (part.kind) queue.push(part.kind); visit(part.parts); }
  };
  while (queue.length) {
    const name = queue.pop()!;
    if (found.has(name)) continue;
    found.add(name);
    visit(scene.kinds?.[name]?.parts);
  }
  return found;
}

function checkSign(part: HomePart, place: string, onVisitor: boolean, report: Report): void {
  const text = part.sign!;
  let width = 0;
  let rest = text;
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    const name = match[1];
    if (!(SIGN_VALUES as readonly string[]).includes(name)) report.problem(`${place}: the sign shows {${name}}, which is not a value; use ${SIGN_VALUES.map((v) => `{${v}}`).join(", ")}, or remove the braces.`);
    else {
      if (name === "task" && !onVisitor) report.warn(`${place}: {task} is only filled in on a visitor's own sign (a part of the visitors kind); here it stays empty.`);
      width += VALUE_WIDTH[name] ?? 8;
    }
    rest = rest.replace(match[0], "");
  }
  width += [...rest].length;
  // The page draws one line as large as fits, from 60% of the panel's height
  // down to 30%, and cuts it with an ellipsis below that (web/src/home/three/
  // resources.ts drawSign). Glyphs are about 0.55 of their height wide. So
  // the warning is for text that would be cut even at the smallest size.
  const [w, h] = part.size ?? [1, 1, 1];
  const needed = width * h * SIGN_MIN_TEXT_HEIGHT * 0.55;
  if (needed > w * 1.05) report.warn(`${place}: the sign ${JSON.stringify(text)} needs about ${num(needed)} m even at its smallest text, but the panel is ${num(w)} m wide, so it will be cut short; make it wider, lower, or shorten the text.`);
}

function checkKindCycles(kinds: NonNullable<HomeScene["kinds"]>, report: Report): void {
  const uses = new Map<string, Set<string>>();
  const gather = (part: HomePart, into: Set<string>) => { if (part.kind !== undefined) into.add(part.kind); for (const sub of part.parts ?? []) gather(sub, into); };
  for (const [name, kind] of Object.entries(kinds)) { const set = new Set<string>(); for (const part of kind.parts) gather(part, set); uses.set(name, set); }
  const reported = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const visit = (name: string, stack: string[]) => {
    state.set(name, "open");
    for (const next of uses.get(name) ?? []) {
      if (!uses.has(next)) continue;
      if (state.get(next) === "open") {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = [...new Set(cycle)].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          report.problem(cycle.length === 2
            ? `kinds.${next}: it uses itself; a kind cannot contain itself. Remove "kind": ${JSON.stringify(next)} from its parts.`
            : `kinds.${next}: ${cycle.map((k) => JSON.stringify(k)).join(" uses ")}, a circle; a kind cannot contain itself. Remove one of these kind references.`);
        }
      } else if (!state.has(next)) visit(next, [...stack, next]);
    }
    state.set(name, "done");
  };
  for (const name of uses.keys()) if (!state.has(name)) visit(name, [name]);
}

/** Expanded part count and depth, kinds included; cycles count as nothing more. */
function checkCounts(scene: HomeScene, report: Report): void {
  const kinds = scene.kinds ?? {};
  const memo = new Map<string, { count: number; depth: number }>();
  const ofKind = (name: string, stack: string[]): { count: number; depth: number } => {
    const known = memo.get(name);
    if (known) return known;
    if (!kinds[name] || stack.includes(name)) return { count: 0, depth: 0 };
    let count = 0; let depth = 0;
    for (const part of kinds[name].parts) { const r = ofPart(part, [...stack, name]); count += r.count; depth = Math.max(depth, r.depth); }
    const result = { count: Math.min(count, 1e9), depth };
    memo.set(name, result);
    return result;
  };
  const ofPart = (part: HomePart, stack: string[]): { count: number; depth: number } => {
    let count = 1; let below = 0;
    if (part.kind !== undefined) { const k = ofKind(part.kind, stack); count += k.count; below = Math.max(below, k.depth); }
    for (const sub of part.parts ?? []) { const r = ofPart(sub, stack); count += r.count; below = Math.max(below, r.depth); }
    return { count: Math.min(count, 1e9), depth: below + 1 };
  };
  let total = 0;
  scene.objects.forEach((object, index) => {
    const r = ofPart(object, []);
    total += r.count;
    if (r.depth > MAX_DEPTH) report.problem(`objects[${index}]${object.id ? ` ${JSON.stringify(object.id)}` : ""}: it nests ${r.depth} levels deep once kinds are expanded; the most is ${MAX_DEPTH} (object → part → part → part). Flatten it, or make the inner parts direct parts.`);
  });
  if (total > MAX_OBJECTS) {
    const heavy = Object.keys(kinds).map((name) => ({ name, count: ofKind(name, []).count })).filter((k) => k.count > 1).sort((a, b) => b.count - a.count).slice(0, 3);
    report.problem(`The scene has ${total} parts once kinds are expanded; the most is ${MAX_OBJECTS}. Use fewer copies or simpler kinds${heavy.length ? ` (${heavy.map((k) => `${k.name}: ${k.count} parts each`).join(", ")})` : ""}.`);
  }
}

function checkCharacters(scene: HomeScene, usedKinds: Set<string>, report: Report): void {
  const kinds = scene.kinds ?? {};
  const spots = scene.spots ?? {};
  const kindNames = Object.keys(kinds);
  const spotNames = Object.keys(spots);
  const characters = scene.characters;
  if (!characters) return;
  const needKind = (place: string, name: string) => {
    usedKinds.add(name);
    if (!kinds[name]) report.problem(`${place}: kind ${JSON.stringify(name)} is not defined${didYouMean(name, kindNames)}; add it under kinds, or use one of ${kindNames.length ? kindNames.join(", ") : "(none defined)"}.`);
  };
  const needSpot = (place: string, name: string) => {
    if (!spots[name]) report.problem(`${place}: spot ${JSON.stringify(name)} is not defined${didYouMean(name, spotNames)}; add it under spots, or use one of ${spotNames.length ? spotNames.join(", ") : "(none defined)"}.`);
  };
  /** A rule's spot must exist, and a `pet:` mood it names must be one the pet can have. */
  const checkRule = (place: string, rule: { when: string | string[]; spot: string }) => {
    needSpot(`${place}.spot`, rule.spot);
    for (const condition of Array.isArray(rule.when) ? rule.when : [rule.when]) {
      const mood = /^(?:not:)?pet:(.+)$/.exec(condition)?.[1];
      if (mood && !(PET_MOODS as readonly string[]).includes(mood)) report.warn(`${place}: pet:${mood} can never hold; the pet's moods are ${PET_MOODS.join(", ")}.`);
    }
  };
  if (characters.tomo) {
    needKind("characters.tomo.kind", characters.tomo.kind);
    needSpot("characters.tomo.spot", characters.tomo.spot);
    (characters.tomo.rules ?? []).forEach((rule, i) => checkRule(`characters.tomo.rules[${i}]`, rule));
  }
  if (characters.visitors) {
    const visitors = characters.visitors;
    needKind("characters.visitors.kind", visitors.kind);
    for (const [type, kind] of Object.entries(visitors.kinds ?? {})) needKind(`characters.visitors.kinds.${type}`, kind);
    visitors.spots.forEach((spot, i) => {
      needSpot(`characters.visitors.spots[${i}]`, spot);
      if (visitors.spots.indexOf(spot) !== i) report.warn(`characters.visitors.spots[${i}]: ${JSON.stringify(spot)} is listed twice, so two visitors would sit in one place; list each spot once.`);
    });
    if (visitors.overflow !== undefined) needSpot("characters.visitors.overflow", visitors.overflow);
  }
  if (characters.pet) {
    needKind("characters.pet.kind", characters.pet.kind);
    needSpot("characters.pet.spot", characters.pet.spot);
    (characters.pet.rules ?? []).forEach((rule, i) => checkRule(`characters.pet.rules[${i}]`, rule));
  }
}

function outsideBy(point: readonly number[], room: Box): { axis: number; side: "min" | "max"; by: number } | undefined {
  let worst: { axis: number; side: "min" | "max"; by: number } | undefined;
  for (let axis = 0; axis < 3; axis++) {
    const below = room.min[axis] - point[axis];
    const above = point[axis] - room.max[axis];
    if (below > (worst?.by ?? 0)) worst = { axis, side: "min", by: below };
    if (above > (worst?.by ?? 0)) worst = { axis, side: "max", by: above };
  }
  return worst;
}
const WALL = [["left wall", "right wall"], ["floor", "ceiling"], ["back wall", "front (the viewer's side)"]] as const;

function checkPlacement(scene: HomeScene, report: Report): void {
  const room = roomBox(scene);
  const [w, h, d] = scene.room.size;
  const extent = `the room is ${num(w)} m wide (x from ${num(-w / 2)} to ${num(w / 2)}), ${num(h)} m high and ${num(d)} m deep (z from ${num(-d / 2)} to ${num(d / 2)})`;
  const placement = placeScene(scene);
  const name = (index: number) => `objects[${index}]${scene.objects[index].id ? ` ${JSON.stringify(scene.objects[index].id)}` : ""}`;
  for (const object of placement.objects) {
    for (const leaf of object.leaves) {
      const at = centre(leaf.box);
      const out = outsideBy(at, room);
      if (out && out.by > FAR_OUTSIDE_M) {
        report.problem(`${name(object.index)}: a part of it is centred at ${vec(at)}, ${num(out.by)} m beyond the ${WALL[out.axis][out.side === "min" ? 0 : 1]}; ${extent}. Move it inside.`);
        break;
      }
    }
  }
  for (const [spot, value] of Object.entries(scene.spots ?? {})) {
    const out = outsideBy(value.at, room);
    if (out && out.by > FAR_OUTSIDE_M) report.problem(`spots.${spot}: it is at ${vec(value.at)}, ${num(out.by)} m beyond the ${WALL[out.axis][out.side === "min" ? 0 : 1]}; ${extent}. Move it inside.`);
  }
  // Two solid objects in the same space (a desk through a bed). Parts of one
  // object, and an object with what it sits on, are meant to touch.
  const onChain = (index: number): Set<number> => {
    const chain = new Set<number>();
    let at = placement.objects[index].on;
    while (at !== undefined && !chain.has(at)) { chain.add(at); at = placement.objects[at].on; }
    return chain;
  };
  const chains = placement.objects.map((o) => onChain(o.index));
  let warned = 0;
  for (let a = 0; a < placement.objects.length && warned < MAX_LISTED; a++) {
    for (let b = a + 1; b < placement.objects.length && warned < MAX_LISTED; b++) {
      if (chains[a].has(b) || chains[b].has(a)) continue;
      const hit = overlap(placement.objects[a].leaves, placement.objects[b].leaves);
      if (hit) {
        warned++;
        report.warn(`${name(a)} and ${name(b)} occupy the same space around ${vec(hit)}; move one of them, or put one on the other with on.`);
      }
    }
  }
}

function overlap(left: { box: Box; solid: boolean }[], right: { box: Box; solid: boolean }[]): number[] | undefined {
  for (const a of left) {
    if (!a.solid) continue;
    for (const b of right) {
      if (!b.solid) continue;
      const lo = [0, 1, 2].map((k) => Math.max(a.box.min[k], b.box.min[k]));
      const hi = [0, 1, 2].map((k) => Math.min(a.box.max[k], b.box.max[k]));
      const sides = [0, 1, 2].map((k) => hi[k] - lo[k]);
      if (sides.some((s) => s < 0.05)) continue;
      const volume = (box: Box) => [0, 1, 2].reduce((v, k) => v * (box.max[k] - box.min[k]), 1);
      if (sides[0] * sides[1] * sides[2] >= 0.25 * Math.min(volume(a.box), volume(b.box))) return lo.map((v, k) => (v + hi[k]) / 2);
    }
  }
  return undefined;
}

/** Exported for the skill text: the slug rule in words. */
export const SLUG_RULE = `lowercase letters, digits and dashes, starting with a letter, at most 40 characters (${SLUG.source})`;
