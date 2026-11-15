import type { HomePart, HomeReaction, HomeScene } from "./scene.js";
import { centre, num, placeScene, vec, whatOf, type Box } from "./geometry.js";

/**
 * The floor plan: the text Tomo "sees" of its home when there is no picture.
 * A top-down map of the room on a character grid with a legend, then every
 * placed object in words (what it is, size, position, colour, what it sits
 * on, what it does), the spots, and who goes where when.
 *
 * Pure and deterministic (snapshot-tested); bounded: the map is at most
 * MAP_COLUMNS × MAP_ROWS, the text at most MAX_PLAN_CHARS.
 */

export const MAP_COLUMNS = 48;
export const MAP_ROWS = 24;
export const MAX_PLAN_CHARS = 24_000;
/** Nested parts listed per object; the rest are counted. */
const PARTS_LISTED = 12;
const MARKS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A condition as words: "while working", "while not idle", "at night". */
export function describeCondition(condition: string): string {
  const negated = condition.startsWith("not:");
  const bare = negated ? condition.slice(4) : condition;
  const words: Record<string, [string, string]> = {
    working: ["while working", "while not working"],
    idle: ["while idle", "while not idle"],
    subagents: ["while a subagent is running", "while no subagent is running"],
    tasks: ["while a background task is running", "while no background task is running"],
    cron: ["just after a scheduled job fires", "except just after a scheduled job fires"],
    compacting: ["while compacting context", "while not compacting context"],
    trouble: ["while in trouble (retrying, rate-limited or errored)", "while not in trouble"],
    day: ["by day (outside the window)", "except by day"],
    night: ["at night (outside the window)", "except at night"],
  };
  if (words[bare]) return words[bare][negated ? 1 : 0];
  const by = /^by:(.+)$/.exec(bare);
  if (by) {
    const who = { owner: "for the owner", cron: "on a scheduled job", heartbeat: "on a heartbeat", group: "in a group chat" }[by[1]] ?? by[1];
    return negated ? `except while working ${who}` : `while working ${who}`;
  }
  const tool = /^tool:(.+)$/.exec(bare);
  if (tool) {
    const what = { shell: "the shell", files: "files", web: "the web", search: "search", subagent: "a subagent", other: "another tool" }[tool[1]] ?? tool[1];
    return negated ? `while not using ${what}` : `while using ${what}`;
  }
  const weather = /^weather:(.+)$/.exec(bare);
  if (weather) {
    const words = { clear: "clear", clouds: "cloudy", overcast: "overcast", fog: "foggy", rain: "raining", snow: "snowing", storm: "stormy" }[weather[1]] ?? weather[1];
    return negated ? `unless it is ${words} outside` : `while it is ${words} outside`;
  }
  const pet = /^pet:(.+)$/.exec(bare);
  if (pet) return negated ? `while the pet is not ${pet[1]}` : `while the pet is ${pet[1]}`;
  return condition;
}
export function describeWhen(when: HomeReaction["when"]): string {
  const list = Array.isArray(when) ? when : [when];
  return list.map(describeCondition).join(" and ");
}
export function describeReaction(reaction: HomeReaction): string {
  const when = describeWhen(reaction.when);
  switch (reaction.do) {
    case "show": return `shown only ${when}`;
    case "hide": return `hidden ${when}`;
    case "glow": return `glows${reaction.color ? ` ${reaction.color}` : ""} ${when}`;
    case "tint": return `turns ${reaction.color ?? "another colour"} ${when}`;
    case "bob": return `bobs up and down${reaction.amount !== undefined ? ` by ${num(reaction.amount)} m` : ""} ${when}`;
    case "spin": return `spins${reaction.speed !== undefined ? ` at ${num(reaction.speed)} turns a second` : ""} ${when}`;
    case "swing": return `swings${reaction.amount !== undefined ? ` by ${num(reaction.amount)}°` : ""} ${when}`;
    case "pulse": return `pulses${reaction.amount !== undefined ? ` by ${num(reaction.amount * 100)}%` : ""} ${when}`;
  }
}

function describePart(part: HomePart): string {
  const what = whatOf(part);
  const size = part.size ?? [1, 1, 1];
  const dims = `${num(size[0])}×${num(size[1])}×${num(size[2])} m`;
  const bits: string[] = [];
  if (what.includes("shape")) bits.push(`${part.shape} ${dims}`);
  if (what.includes("kind")) bits.push(`a ${part.kind}`);
  if (what.includes("picture")) bits.push(`picture ${part.picture} ${num(size[0])}×${num(size[1])} m`);
  if (what.includes("sign")) bits.push(`sign ${JSON.stringify(part.sign)} ${num(size[0])}×${num(size[1])} m`);
  if (what.includes("window")) bits.push(`window ${num(size[0])}×${num(size[1])} m (the app draws the sky in it)${part.color ? `, frame ${part.color}` : ""}`);
  if (what.length === 0) bits.push(`group of ${part.parts?.length ?? 0} part${part.parts?.length === 1 ? "" : "s"}`);
  if (part.color && !what.includes("window")) bits.push(part.color);
  if (part.background) bits.push(`on ${part.background}`);
  if (part.turn && part.turn.some((t) => t !== 0)) bits.push(`turned ${vec(part.turn)}°`);
  if (part.scale !== undefined && part.scale !== 1) bits.push(`scaled ×${num(part.scale)}`);
  return bits.join(", ");
}

/** "towards the back wall", "left of centre", …: where a point is in the room. */
function region(point: readonly number[], scene: HomeScene): string {
  const [w, , d] = scene.room.size;
  const x = point[0] / (w / 2);
  const z = point[2] / (d / 2);
  const across = x < -0.33 ? "left" : x > 0.33 ? "right" : "centre";
  const deep = z < -0.33 ? "back" : z > 0.33 ? "front" : "middle";
  if (across === "centre" && deep === "middle") return "middle of the room";
  if (across === "centre") return `${deep} centre`;
  if (deep === "middle") return `${across} side`;
  return `${deep} ${across}`;
}

export function renderFloorPlan(scene: HomeScene): string {
  const lines: string[] = [];
  const [w, h, d] = scene.room.size;
  const placement = placeScene(scene);
  const label = (index: number) => scene.objects[index].id ?? (scene.objects[index].kind ? `(${scene.objects[index].kind})` : `objects[${index}]`);

  lines.push(`${scene.name ? `"${scene.name}": ` : ""}room ${num(w)} m wide × ${num(d)} m deep × ${num(h)} m high; floor ${scene.room.floor}, walls ${scene.room.walls}${scene.room.backdrop ? `, backdrop ${scene.room.backdrop}` : ""}.`);
  if (scene.light) {
    const l = scene.light;
    lines.push(`Light: ${l.color ?? "default colour"}${l.angle !== undefined ? `, from ${num(l.angle)}° around the room` : ""}${l.level !== undefined ? `, level ${num(l.level)}` : ""}.`);
  }
  lines.push("");

  // ---- the map: top-down, back wall at the top, the viewer below ----
  const cols = Math.max(8, Math.min(MAP_COLUMNS, Math.round((MAP_COLUMNS * w) / Math.max(w, d))));
  const rows = Math.max(4, Math.min(MAP_ROWS, Math.round((MAP_ROWS * d) / Math.max(w, d))));
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => "."));
  const col = (x: number) => Math.floor(((x + w / 2) / w) * cols);
  const row = (z: number) => Math.floor(((z + d / 2) / d) * rows);
  const clampC = (c: number) => Math.min(cols - 1, Math.max(0, c));
  const clampR = (r: number) => Math.min(rows - 1, Math.max(0, r));
  const marks = new Map<number, string>();
  // Lower things first, so what stands on something is drawn over it.
  const order = placement.objects.filter((o) => o.box).sort((a, b) => a.box!.max[1] - b.box!.max[1] || a.index - b.index);
  placement.objects.forEach((o, i) => { if (o.box) marks.set(o.index, MARKS[i] ?? "#"); });
  const inside = (box: Box) => box.max[0] > -w / 2 && box.min[0] < w / 2 && box.max[2] > -d / 2 && box.min[2] < d / 2;
  for (const object of order) {
    const box = object.box!;
    if (!inside(box)) continue;
    const mark = marks.get(object.index)!;
    // Every cell the footprint covers; at least one.
    const c0 = clampC(col(box.min[0])); const c1 = clampC(Math.max(c0, Math.ceil(((box.max[0] + w / 2) / w) * cols) - 1));
    const r0 = clampR(row(box.min[2])); const r1 = clampR(Math.max(r0, Math.ceil(((box.max[2] + d / 2) / d) * rows) - 1));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r][c] = mark;
  }
  const spotNames = Object.keys(scene.spots ?? {});
  spotNames.forEach((name, i) => {
    const at = scene.spots![name].at;
    if (Math.abs(at[0]) > w / 2 || Math.abs(at[2]) > d / 2) return;
    grid[clampR(row(at[2]))][clampC(col(at[0]))] = i < 9 ? String(i + 1) : "*";
  });
  lines.push("Floor plan from above (back wall at the top, the viewer at the bottom; letters are objects, digits are spots):");
  lines.push(`+${"-".repeat(cols)}+  back wall`);
  for (const r of grid) lines.push(`|${r.join("")}|`);
  lines.push(`+${"-".repeat(cols)}+  viewer's side`);
  lines.push(`One column is ${num(w / cols)} m across, one row ${num(d / rows)} m deep.`);
  const legend: string[] = [];
  for (const object of placement.objects) {
    const mark = marks.get(object.index);
    if (mark) legend.push(`${mark} ${label(object.index)}`);
  }
  spotNames.forEach((name, i) => legend.push(`${i < 9 ? i + 1 : "*"} spot ${name}`));
  if (legend.length) lines.push(`Legend: ${legend.join(", ")}.`);
  lines.push("");

  // ---- the objects ----
  lines.push(`Objects (${scene.objects.length}):`);
  if (scene.objects.length === 0) lines.push("  (none)");
  for (const object of placement.objects) {
    const part = object.part;
    const mark = marks.get(object.index);
    // What it really takes up, where its own size does not say: a kind or group (sized by its parts), or anything scaled.
    const shaped = whatOf(part).some((w) => w !== "kind");
    const extent = object.box && (!shaped || (part.scale ?? 1) !== 1)
      ? `, takes up ${num(object.box.max[0] - object.box.min[0])} m wide × ${num(object.box.max[2] - object.box.min[2])} m deep × ${num(object.box.max[1] - object.box.min[1])} m high` : "";
    const where = object.box ? `${region(centre(object.box), scene)}, base at ${vec(object.frame.t)}, top at ${num(object.box.max[1])} m${extent}` : `base at ${vec(object.frame.t)}, draws nothing`;
    lines.push(`- ${mark ? `[${mark}] ` : ""}${label(object.index)}: ${describePart(part)}; ${where}${object.on !== undefined ? `; on ${label(object.on)}` : part.on ? `; on ${part.on} (not found: on the floor)` : ""}.`);
    for (const reaction of part.reactions ?? []) lines.push(`    ${describeReaction(reaction)}`);
    let listed = 0;
    let more = 0;
    const walk = (parts: HomePart[] | undefined, depth: number) => {
      for (const sub of parts ?? []) {
        if (listed >= PARTS_LISTED) { more++; walk(sub.parts, depth + 1); continue; }
        listed++;
        lines.push(`${"    ".repeat(depth)}  part${sub.id ? ` ${sub.id}` : ""}: ${describePart(sub)} at ${vec(sub.at ?? [0, 0, 0])}${(sub.reactions ?? []).length ? `; ${(sub.reactions ?? []).map(describeReaction).join("; ")}` : ""}`);
        walk(sub.parts, depth + 1);
      }
    };
    walk(part.parts, 1);
    if (more) lines.push(`      …and ${more} more part${more === 1 ? "" : "s"}.`);
  }
  if (placement.truncated) lines.push("  (the scene is too large to place in full; some parts are left out above)");
  lines.push("");

  // ---- kinds ----
  const kinds = Object.entries(scene.kinds ?? {});
  if (kinds.length) {
    lines.push(`Kinds (${kinds.length}): ${kinds.map(([name, kind]) => `${name} (${kind.parts.length} part${kind.parts.length === 1 ? "" : "s"}: ${kind.parts.slice(0, 3).map(describePart).join("; ")}${kind.parts.length > 3 ? "; …" : ""})`).join(", ")}.`);
    lines.push("");
  }

  // ---- spots and characters ----
  lines.push(`Spots (${spotNames.length}):`);
  if (spotNames.length === 0) lines.push("  (none)");
  spotNames.forEach((name, i) => {
    const spot = scene.spots![name];
    const facing = spot.facing ?? 0;
    const towards = facingWords(facing);
    lines.push(`- ${i < 9 ? i + 1 : "*"} ${name}: at ${vec(spot.at)}, ${region(spot.at, scene)}, facing ${num(facing)}° (${towards}).`);
  });
  lines.push("");
  lines.push("Who goes where:");
  const c = scene.characters;
  if (!c || (!c.tomo && !c.visitors && !c.pet)) lines.push("  Nobody: there are no characters, so Tomo is not drawn.");
  if (c?.tomo) {
    const rules = (c.tomo.rules ?? []).map((rule) => `at ${rule.spot} ${describeWhen(rule.when)}`);
    lines.push(`- Tomo (a ${c.tomo.kind}): ${rules.length ? `${rules.join("; otherwise ")}; otherwise ` : ""}at ${c.tomo.spot}.`);
  }
  if (c?.visitors) {
    const v = c.visitors;
    const kinds = Object.entries(v.kinds ?? {});
    lines.push(`- Subagents (a ${v.kind}${kinds.length ? `; ${kinds.map(([type, kind]) => `${type} as a ${kind}`).join(", ")}` : ""}): one each at ${v.spots.join(", ")}, in order; ${v.overflow ? `the rest wait at ${v.overflow}` : `more than ${v.spots.length} are not drawn`}.`);
  }
  if (c?.pet) {
    const rules = (c.pet.rules ?? []).map((rule) => `at ${rule.spot} ${describeWhen(rule.when)}`);
    lines.push(`- The pet (a ${c.pet.kind}), when Tomo has one: ${rules.length ? `${rules.join("; otherwise ")}; otherwise ` : ""}at ${c.pet.spot}.`);
  }

  let text = lines.join("\n");
  if (text.length > MAX_PLAN_CHARS) text = `${text.slice(0, MAX_PLAN_CHARS - 40)}\n…(floor plan cut short here)`;
  return text;
}

function facingWords(degrees: number): string {
  const d = ((Math.round(degrees) % 360) + 360) % 360;
  if (d < 23 || d >= 338) return "toward the viewer";
  if (d < 68) return "toward the viewer and right";
  if (d < 113) return "toward the right wall";
  if (d < 158) return "toward the back and right";
  if (d < 203) return "toward the back wall";
  if (d < 248) return "toward the back and left";
  if (d < 293) return "toward the left wall";
  return "toward the viewer and left";
}
