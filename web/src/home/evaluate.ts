import type { HomeCharacters, HomeReaction } from "../../../src/home/scene.js";
import { MAX_SIGN_CHARS, REACTION_DEFAULTS, SIGN_VALUES } from "./contract.js";
import type { HomeStatus, HomeSubagent } from "../../../src/home/status.js";
import { cronFlashing, homeCaption, idleValue, nextJobValue } from "./caption.js";
import { isDayOutside, skyOf } from "./sky.js";

/**
 * The scene's live logic, without three.js: which conditions hold, what a
 * part's reactions come to, what a sign says, who sits where. The renderer
 * only draws what these return.
 */

export type Vec3 = [number, number, number];
export type Conditions = ReadonlySet<string>;

/**
 * What holds right now (scene.ts CONDITIONS, plus `pet:<mood>`). `status` is
 * on the local clock; `now` also stands in for the sky when the daemon
 * reported none (sky.ts).
 */
export function homeConditions(status: HomeStatus, now: number): Set<string> {
  const set = new Set<string>();
  set.add(status.working ? "working" : "idle");
  if (status.working && status.by && status.by !== "other") set.add(`by:${status.by}`);
  if (status.tool) set.add(`tool:${status.tool}`);
  if (status.subagents.length) set.add("subagents");
  if (status.tasks > 0) set.add("tasks");
  if (cronFlashing(status, now)) set.add("cron");
  if (status.compacting) set.add("compacting");
  if (status.trouble) set.add("trouble");
  const sky = skyOf(status, now);
  set.add(isDayOutside(sky) ? "day" : "night");
  if (sky.known) set.add(`weather:${sky.weather}`);
  if (status.pet && /^[a-z]{1,20}$/.test(status.pet.toLowerCase())) set.add(`pet:${status.pet.toLowerCase()}`);
  return set;
}

/** What holds on a character's own body: everything that holds, and `walking` while it walks (scene.ts CONDITIONS). */
export function bodyConditions(conditions: Conditions, walking: boolean): Conditions {
  if (!walking) return conditions;
  const set = new Set(conditions);
  set.add("walking");
  return set;
}

/** One condition (with an optional `not:`), or a list that must all hold. */
export function holds(when: string | readonly string[], conditions: Conditions): boolean {
  if (typeof when !== "string") return when.every((one) => holds(one, conditions));
  return when.startsWith("not:") ? !conditions.has(when.slice(4)) : conditions.has(when);
}


export interface Motion { amount: number; speed: number }
/** What a part's reactions come to under the current conditions. */
export interface PartEffects {
  visible: boolean;
  /** A colour to glow, "self" for the part's own, or null. */
  glow: string | null;
  tint: string | null;
  bob: Motion | null;
  spin: Motion | null;
  swing: Motion | null;
  pulse: Motion | null;
}
export const NO_EFFECTS: PartEffects = { visible: true, glow: null, tint: null, bob: null, spin: null, swing: null, pulse: null };

/**
 * A part with any `show` is visible only while one of them holds; any `hide`
 * that holds hides it. For the others the first reaction that holds wins.
 */
export function partEffects(reactions: readonly HomeReaction[] | undefined, conditions: Conditions): PartEffects {
  if (!reactions?.length) return NO_EFFECTS;
  const active = reactions.filter((r) => holds(r.when, conditions));
  const first = (kind: HomeReaction["do"]) => active.find((r) => r.do === kind);
  const shows = reactions.filter((r) => r.do === "show");
  const visible = (!shows.length || shows.some((r) => active.includes(r))) && !first("hide");
  const glow = first("glow"), tint = first("tint");
  const motion = (kind: "bob" | "swing" | "pulse"): Motion | null => {
    const r = first(kind);
    if (!r) return null;
    const d = REACTION_DEFAULTS[kind];
    return { amount: Math.min(r.amount ?? d.amount, d.max), speed: r.speed ?? d.speed };
  };
  const spin = first("spin");
  return {
    visible, glow: glow ? glow.color ?? "self" : null, tint: tint?.color ?? null,
    bob: motion("bob"), swing: motion("swing"), pulse: motion("pulse"),
    spin: spin ? { amount: 0, speed: spin.speed ?? REACTION_DEFAULTS.spin.speed } : null,
  };
}

export type SignValues = Partial<Record<typeof SIGN_VALUES[number], string>>;
/** The values every sign can show (all but a visitor's own `{task}`). */
export function signValues(status: HomeStatus, now: number): SignValues {
  return { subagents: String(status.subagents.length), tasks: String(status.tasks), tool: status.tool ?? "",
    idle: idleValue(status, now), next_job: nextJobValue(status, now), status: homeCaption(status, now), task: "" };
}
const VALUE = new RegExp(`\\{(${SIGN_VALUES.join("|")})\\}`, "g");
/** Fills `{values}` in; anything else in braces stays as written. At most MAX_SIGN_CHARS. */
export function fillSign(template: string, values: SignValues): string {
  const text = template.replace(VALUE, (_, name: typeof SIGN_VALUES[number]) => (values[name] ?? "").replace(/\s+/g, " ").trim());
  return text.length > MAX_SIGN_CHARS ? `${text.slice(0, MAX_SIGN_CHARS - 1).trimEnd()}…` : text;
}

/** Where Tomo (or the pet) is: the first rule whose condition holds, else its own spot. */
export function characterSpot(character: { spot: string; rules?: Array<{ when: string | string[]; spot: string }> }, conditions: Conditions): string {
  return character.rules?.find((rule) => holds(rule.when, conditions))?.spot ?? character.spot;
}

export interface Seating {
  /** Subagent id → index into `visitors.spots`. */
  seated: Map<string, number>;
  /** Subagents with no free seat, in order: they wait at `overflow`. */
  waiting: string[];
}
/**
 * One visitor per running subagent. A visitor keeps the seat it was given
 * for as long as its subagent runs; newcomers (and those waiting) take the
 * lowest free seat in the order the status lists them.
 */
export function seatVisitors(subagents: readonly HomeSubagent[], seats: number, previous: ReadonlyMap<string, number>): Seating {
  const seated = new Map<string, number>();
  const taken = new Set<number>();
  for (const { id } of subagents) {
    const seat = previous.get(id);
    if (seat !== undefined && seat < seats && !taken.has(seat) && !seated.has(id)) { seated.set(id, seat); taken.add(seat); }
  }
  const waiting: string[] = [];
  let next = 0;
  for (const { id } of subagents) {
    if (seated.has(id) || waiting.includes(id)) continue;
    while (taken.has(next)) next++;
    if (next < seats) { seated.set(id, next); taken.add(next); }
    else waiting.push(id);
  }
  return { seated, waiting };
}

/** The body a visitor gets: its subagent type's own kind, else the default. */
export function visitorKind(visitors: NonNullable<HomeCharacters["visitors"]>, type: string | undefined): string {
  return (type && visitors.kinds?.[type.toLowerCase()]) || visitors.kind;
}

