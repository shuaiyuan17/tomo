import {
  ASSET_NAME, CONDITIONS, HOME_SCENE_VERSION, MAX_DEPTH, MAX_KINDS, MAX_OBJECTS, MAX_PARTS_PER_NODE, MAX_REACTIONS, MAX_SCENE_BYTES,
  MAX_SIGN_CHARS, MAX_SPOTS, REACTION_DEFAULTS, REACTIONS, ROOM_MAX, ROOM_MIN, SHAPES, SIGN_VALUES, SIZE_MAX,
} from "./scene.js";
import { PET_MOODS } from "./check.js";
import { MAX_ASSET_BYTES } from "./files.js";
import { STARTER_SCENE } from "./starter.js";

/**
 * The parts of the `tomo-home` skill (defaults/skills/home/SKILL.md) that
 * come from the format itself, so the skill cannot drift from scene.ts: the
 * bundled file has `{{home:<name>}}` placeholders, filled in when the daemon
 * copies the skill into the workspace (workspace/bundled-skills.ts).
 *
 * The descriptions are keyed by the constants' own types, so a condition,
 * reaction or sign value added to scene.ts without words here fails to
 * compile; tests/home-skill.test.ts checks the rendered skill too.
 */

const CONDITION_WORDS: Record<typeof CONDITIONS[number], string> = {
  working: "a turn is running (you are answering, or doing a job)",
  idle: "no turn is running",
  "by:owner": "the running turn is the owner's conversation",
  "by:cron": "the running turn is a scheduled job",
  "by:heartbeat": "the running turn is a heartbeat (your free time)",
  "by:group": "the running turn is in a group chat",
  "tool:shell": "the tool in use is the shell (Bash, Monitor)",
  "tool:files": "the tool in use reads or writes files",
  "tool:web": "the tool in use is on the web (fetch, search, a browser)",
  "tool:search": "the tool in use searches (Grep, Glob, recall)",
  "tool:subagent": "the tool in use starts or talks to a subagent",
  "tool:other": "some other tool is in use",
  subagents: "at least one subagent is running",
  tasks: "at least one background task (shell, monitor) is running",
  cron: "a scheduled job fired in the last few seconds",
  compacting: "your context is being compacted",
  trouble: "the turn is retrying, rate-limited or hit an error",
  day: "it is day outside the window (the configured city's sun; the viewer's clock without a city; dawn and dusk count as day)",
  night: "it is night outside the window",
  "weather:clear": "the sky outside is clear (only with a city configured and the weather known, like every weather condition)",
  "weather:clouds": "partly cloudy outside",
  "weather:overcast": "overcast outside",
  "weather:fog": "fog or mist outside",
  "weather:rain": "rain or drizzle outside",
  "weather:snow": "snow or sleet outside",
  "weather:storm": "a thunderstorm outside",
};
const REACTION_WORDS: Record<typeof REACTIONS[number], string> = {
  show: "visible only while the condition holds",
  hide: "hidden while it holds",
  glow: "gives off light of `color` (default: its own colour)",
  tint: "takes `color` instead of its own (needs `color`)",
  bob: "moves up and down by `amount` metres",
  spin: "turns around its vertical axis, `speed` turns a second",
  swing: "rocks side to side by `amount` degrees",
  pulse: "grows and shrinks by `amount` (0.1 = 10%)",
};
const SIGN_WORDS: Record<typeof SIGN_VALUES[number], string> = {
  subagents: "how many subagents are running",
  tasks: "how many background tasks are running",
  tool: "the kind of tool in use (shell, files, …), or nothing",
  idle: "how long you have been idle (\"20 min\")",
  next_job: "when the next scheduled job runs (\"in 12 min\"), or nothing",
  status: "the caption under the room",
  task: "on a visitor's own sign only: what that subagent is doing",
};

/** "; default amount 0.06 (at most 1), speed 1.2", from REACTION_DEFAULTS. */
function defaultsOf(reaction: typeof REACTIONS[number]): string {
  const d = (REACTION_DEFAULTS as Record<string, { amount?: number; max?: number; speed?: number }>)[reaction];
  if (!d) return "";
  const bits = [
    ...(d.amount !== undefined ? [`default amount ${d.amount}${d.max !== undefined ? ` (at most ${d.max}; more is drawn as ${d.max})` : ""}`] : []),
    ...(d.speed !== undefined ? [`speed ${d.speed}`] : []),
  ];
  return bits.length ? `; ${bits.join(", ")}` : "";
}

const list = (entries: Array<[string, string]>) => entries.map(([name, words]) => `- \`${name}\`: ${words}`).join("\n");

export const HOME_SKILL_VALUES: Record<string, () => string> = {
  version: () => String(HOME_SCENE_VERSION),
  shapes: () => SHAPES.map((s) => `\`${s}\``).join(", "),
  conditions: () => list(CONDITIONS.map((c) => [c, CONDITION_WORDS[c]])),
  reactions: () => list(REACTIONS.map((r) => [r, `${REACTION_WORDS[r]}${defaultsOf(r)}`])),
  "scale-range": () => "0.1–10",
  "sign-values": () => list(SIGN_VALUES.map((v) => [`{${v}}`, SIGN_WORDS[v]])),
  "pet-moods": () => PET_MOODS.map((m) => `\`${m}\``).join(", "),
  "asset-name": () => `\`${ASSET_NAME.source}\``,
  "asset-kib": () => String(MAX_ASSET_BYTES / 1024),
  "limits-depth": () => `${MAX_DEPTH} levels: object → part → part → part`,
  limits: () => list([
    ["scene file", `at most ${MAX_SCENE_BYTES / 1024} KiB`],
    ["room size", `width and depth ${ROOM_MIN}–${ROOM_MAX} m, height ${ROOM_MIN}–8 m`],
    ["a part's size", `0.01–${SIZE_MAX} m on each side`],
    ["parts in the whole scene", `at most ${MAX_OBJECTS}, counting every part of every object with kinds expanded`],
    ["nesting", `at most ${MAX_DEPTH} levels (object → part → part → part), kinds expanded`],
    ["parts directly in one object or kind", `at most ${MAX_PARTS_PER_NODE}`],
    ["kinds", `at most ${MAX_KINDS}`],
    ["spots", `at most ${MAX_SPOTS}`],
    ["reactions on one part", `at most ${MAX_REACTIONS}`],
    ["sign text", `at most ${MAX_SIGN_CHARS} characters`],
    ["a picture file", `at most ${MAX_ASSET_BYTES / 1024} KiB`],
  ]),
  starter: () => JSON.stringify(STARTER_SCENE, null, 2),
};

/** Fills `{{home:<name>}}` in a bundled skill file. An unknown name throws: a typo must not ship as literal braces. */
export function renderSkillTemplate(text: string): string {
  return text.replace(/\{\{home:([a-z-]+)\}\}/g, (_match, name: string) => {
    const value = HOME_SKILL_VALUES[name];
    if (!value) throw new Error(`Unknown skill placeholder {{home:${name}}}`);
    return value();
  });
}
