import { z } from "zod";

/**
 * Tomo's home: the scene Tomo writes (`<workspace>/home/scene.json`) and the
 * web UI draws as a low-poly 3D room.
 *
 * THE SCENE IS DATA. Nothing in it runs: shapes, colours, positions, and
 * "when <condition>, do <reaction>" pairs picked from the two closed lists
 * below. A new behaviour is a new entry in REACTIONS implemented in the
 * renderer, never something a scene can define. Sign text is drawn as text;
 * a picture is an image file from `home/assets/`, only ever shown as an image.
 *
 * This file is the contract shared by the daemon (the check tool), the web
 * server (which validates before serving) and the browser (types only: it
 * draws what the server already validated). Semantic checks that need the
 * whole scene (references, bounds, counts) live in check.ts.
 *
 * Units are metres. +x is right, +y is up, +z is toward the viewer; the room
 * sits on y = 0 and is centred on the origin, its back wall at -z and its
 * left wall at -x. Angles are degrees.
 *
 * PLACEMENT, which the checker, the floor plan and the renderer all follow:
 * - `at` is where a part's base centre is, in its parent's frame (the room's
 *   for a top-level object). A part stands on its parent's y = 0.
 * - `turn` is applied around x, then y, then z.
 * - `size` gives a shape, picture, sign or window its own dimensions. It
 *   means nothing on a group or a kind instance: to make one of those bigger
 *   or smaller use `scale`, which multiplies the part and everything in it
 *   (its parts' sizes and positions) uniformly.
 * - `on`: the object's `at` is measured from the top centre of the object it
 *   rests on (for a group or kind instance, the centre of the top of its
 *   bounding box), in that object's turned frame, so it moves and turns with
 *   it. A chain of `on` is fine; a loop is a problem.
 */

export const HOME_SCENE_VERSION = 1;

// ---- limits (also enforced by check.ts where they span the scene) ----
export const MAX_SCENE_BYTES = 256 * 1024;
export const MAX_OBJECTS = 400;          // every part of every placed object, kinds expanded
export const MAX_KINDS = 64;
export const MAX_PARTS_PER_NODE = 48;
export const MAX_DEPTH = 4;              // object → part → part → part
export const MAX_SPOTS = 32;
export const MAX_REACTIONS = 6;
export const MAX_SIGN_CHARS = 80;
export const ROOM_MIN = 2;
export const ROOM_MAX = 20;
export const SIZE_MAX = 20;

/** `desk`, `guest-seat-2`: what ids, kinds, spots and asset names look like. */
export const SLUG = /^[a-z][a-z0-9-]{0,39}$/;
/** A file in `home/assets/`. */
export const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}\.(png|jpe?g|webp|svg)$/;

const slug = z.string().regex(SLUG);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const coord = z.number().finite().min(-ROOM_MAX).max(ROOM_MAX);
const vec3 = z.tuple([coord, coord, coord]);
const size3 = z.tuple([z.number().finite().min(0.01).max(SIZE_MAX), z.number().finite().min(0.01).max(SIZE_MAX), z.number().finite().min(0.01).max(SIZE_MAX)]);
const degrees = z.number().finite().min(-360).max(360);

export const SHAPES = ["box", "cylinder", "cone", "sphere"] as const;
export type HomeShape = typeof SHAPES[number];

/**
 * What is true right now, as a scene can ask it. Closed list; `not:` in front
 * negates. `pet:<mood>` matches the pet's mood word (happy, sleeping, …).
 *
 * working / idle        a turn is running / none is
 * by:owner|cron|heartbeat|group   who started the running turn
 * tool:shell|files|web|search|subagent|other   the kind of tool in use
 * subagents / tasks     at least one subagent / background task is running
 * cron                  a scheduled job fired in the last few seconds
 * compacting            context is being compacted
 * trouble               the turn is retrying, rate-limited or errored
 * day / night           outside the window: the configured city's sun when
 *                       known, else the viewer's local time (dawn and dusk
 *                       count as day)
 * weather:clear|clouds|overcast|fog|rain|snow|storm
 *                       the weather outside, when a city is configured and
 *                       the weather is known; none of them holds otherwise
 * walking               on a character's own body only (a part of the kind
 *                       it is drawn with): it is walking or hopping right
 *                       now. Anywhere else it never holds.
 */
export const WEATHERS = ["clear", "clouds", "overcast", "fog", "rain", "snow", "storm"] as const;
export type HomeWeather = typeof WEATHERS[number];
export const CONDITIONS = ["working", "idle", "by:owner", "by:cron", "by:heartbeat", "by:group",
  "tool:shell", "tool:files", "tool:web", "tool:search", "tool:subagent", "tool:other",
  "subagents", "tasks", "cron", "compacting", "trouble", "day", "night",
  "weather:clear", "weather:clouds", "weather:overcast", "weather:fog", "weather:rain", "weather:snow", "weather:storm", "walking"] as const;
export const CONDITION = /^(not:)?(working|idle|by:(owner|cron|heartbeat|group)|tool:(shell|files|web|search|subagent|other)|subagents|tasks|cron|compacting|trouble|day|night|weather:(clear|clouds|overcast|fog|rain|snow|storm)|walking|pet:[a-z]{1,20})$/;
const condition = z.string().regex(CONDITION);
/** One condition, or several that must all hold. */
const when = z.union([condition, z.array(condition).min(1).max(4)]);

/**
 * What a part does while its condition holds. Closed list.
 *
 * show / hide   visible only while / hidden while (a holding `hide` wins)
 * glow          emits light of `color` (default: its own colour)
 * tint          takes `color` instead of its own (`color` is required)
 * bob           moves up and down by `amount` metres (default 0.06, at most 1)
 * spin          turns around its vertical axis (default 0.25 turns a second)
 * swing         rocks side to side by `amount` degrees (default 12, at most 45)
 * pulse         grows and shrinks by `amount` (0.08 = 8%, the default; at most 0.5)
 *
 * `speed` is cycles (or turns) per second for the four that move; default 1,
 * spin 0.25. When several reactions of the same kind hold, the first wins.
 * Movement stops under the viewer's reduced-motion setting; the states stay.
 */
export const REACTION_DEFAULTS = { bob: { amount: 0.06, max: 1, speed: 1.2 }, spin: { speed: 0.25 }, swing: { amount: 12, max: 45, speed: 1 }, pulse: { amount: 0.08, max: 0.5, speed: 1 } } as const;
export const REACTIONS = ["show", "hide", "glow", "tint", "bob", "spin", "swing", "pulse"] as const;
const reaction = z.object({
  when,
  do: z.enum(REACTIONS),
  color: color.optional(),
  amount: z.number().finite().min(0).max(45).optional(),
  speed: z.number().finite().min(0.05).max(4).optional(),
}).strict();
export type HomeReaction = z.infer<typeof reaction>;

/**
 * Values a sign can show: `{subagents}` and `{tasks}` (counts), `{tool}` (the
 * kind in use, or ""), `{idle}` ("20 min"), `{next_job}` ("in 12 min", or
 * ""), `{status}` (the caption under the room), and on a visitor's own sign
 * `{task}` (what that subagent is doing).
 */
export const SIGN_VALUES = ["subagents", "tasks", "tool", "idle", "next_job", "status", "task"] as const;

export interface HomePart {
  /** Names this part, so something else can sit `on` it. Unique among top-level objects. */
  id?: string;
  /** Exactly one of shape / kind / picture / sign / window says what this part is; none of them makes it an empty group of `parts`. */
  shape?: HomeShape;
  /** A reusable group defined under `kinds`. */
  kind?: string;
  /** A flat panel showing `home/assets/<picture>`. `size` is [width, height, thickness]. */
  picture?: string;
  /** A flat panel showing a short line of text; `{values}` are filled in live. `color` is the text, `background` the panel. */
  sign?: string;
  background?: string;
  /**
   * A window: a flat panel showing the sky outside, drawn by the app (Tomo
   * places and sizes it; what it shows is not authored). It follows the real
   * time of day and weather (HomeStatus.sky), or the viewer's clock and a
   * clear sky when no city is configured. `size` is [width, height,
   * thickness]; `color` is the frame.
   */
  window?: true;
  /** Bounding size [width, height, depth] of a shape or panel. A cylinder or cone stands on its base; a sphere is faceted. Default [1, 1, 1]. Not for groups or kind instances: see `scale`. */
  size?: [number, number, number];
  /** Makes this part and everything in it uniformly bigger or smaller (0.1–10, default 1). */
  scale?: number;
  /** Where its base centre is, relative to its parent (the room for a top-level object). Default [0, 0, 0]. */
  at?: [number, number, number];
  /** Rotation in degrees around x, y, z. Default [0, 0, 0]. */
  turn?: [number, number, number];
  color?: string;
  /** Top-level only: the id of another top-level object this one rests on. Its `at` is then measured from that object's top centre, and it moves with it. */
  on?: string;
  reactions?: HomeReaction[];
  parts?: HomePart[];
}

const partFields = {
  id: slug.optional(),
  shape: z.enum(SHAPES).optional(),
  kind: slug.optional(),
  picture: z.string().regex(ASSET_NAME).optional(),
  sign: z.string().min(1).max(MAX_SIGN_CHARS).optional(),
  background: color.optional(),
  window: z.literal(true).optional(),
  size: size3.optional(),
  scale: z.number().finite().min(0.1).max(10).optional(),
  at: vec3.optional(),
  turn: z.tuple([degrees, degrees, degrees]).optional(),
  color: color.optional(),
  on: slug.optional(),
  reactions: z.array(reaction).max(MAX_REACTIONS).optional(),
};
const part: z.ZodType<HomePart> = z.lazy(() => z.object({ ...partFields, parts: z.array(part).max(MAX_PARTS_PER_NODE).optional() }).strict());

const spot = z.object({
  at: vec3,
  /** Which way a character there faces: degrees around the vertical axis, 0 = toward the viewer. */
  facing: degrees.optional(),
}).strict();

/**
 * How a character walks: `speed` in m/s, `radius` its footprint for finding
 * a way round the furniture (not worked out from its body: a crab's claws
 * would make it too wide to pass anything), `height` the clearance it needs
 * (it walks under anything that starts at least this high; lower is in its
 * way). Both default to its sort's size (nav.ts NAV_WALKER, the pet
 * NAV_PET). A wandering stroll goes at
 * `speed`; a move a rule makes goes WALK_RULE_FACTOR times as fast, and
 * takes at most a few seconds however far it is.
 */
export const WALK_SPEED_LIMITS = { min: 0.2, max: 3, default: 1 } as const;
export const WALK_RULE_FACTOR = 1.5;
export const WALK_RADIUS_LIMITS = { min: 0.1, max: 0.6 } as const;
export const WALK_HEIGHT_LIMITS = { min: 0.2, max: 2.5 } as const;
const walk = z.object({
  speed: z.number().finite().min(WALK_SPEED_LIMITS.min).max(WALK_SPEED_LIMITS.max).optional(),
  radius: z.number().finite().min(WALK_RADIUS_LIMITS.min).max(WALK_RADIUS_LIMITS.max).optional(),
  height: z.number().finite().min(WALK_HEIGHT_LIMITS.min).max(WALK_HEIGHT_LIMITS.max).optional(),
}).strict();
export type HomeWalk = z.infer<typeof walk>;

/**
 * Wandering: while no rule holds (and `when` does, if given), the character
 * strolls between `spots` instead of standing at its own spot, staying a
 * random time from `every` = [shortest, longest] seconds at each. Tomo
 * wanders only while idle; under the viewer's reduced-motion setting nobody
 * does (they stand at their spot).
 */
export const WANDER_SPOT_LIMITS = { min: 2, max: 8 } as const;
export const WANDER_EVERY_LIMITS = { min: 5, max: 3600, default: [30, 90] as readonly [number, number] } as const;
const seconds = z.number().finite().min(WANDER_EVERY_LIMITS.min).max(WANDER_EVERY_LIMITS.max);
const wander = z.object({
  spots: z.array(slug).min(WANDER_SPOT_LIMITS.min).max(WANDER_SPOT_LIMITS.max),
  every: z.tuple([seconds, seconds]).refine(([a, b]) => a <= b, { message: "shortest after longest" }).optional(),
  when: when.optional(),
}).strict();
export type HomeWander = z.infer<typeof wander>;

/** At most this many characters under `characters.others` (check.ts says so). */
export const MAX_OTHERS = 4;

const mover = z.object({
  kind: slug,
  spot: slug,
  rules: z.array(z.object({ when, spot: slug }).strict()).max(8).optional(),
  walk: walk.optional(),
  wander: wander.optional(),
}).strict();

const characters = z.object({
  /** Tomo itself. The first rule whose condition holds decides where it is; otherwise it wanders (`wander`) or stands at `spot`. */
  tomo: mover.optional(),
  /**
   * One copy per running subagent, seated at `spots` in order; the rest wait
   * at `overflow` (or are not drawn). `kinds` gives a subagent type its own
   * body (the SDK's subagent_type, lowercased; anything else uses `kind`).
   */
  visitors: z.object({
    kind: slug,
    kinds: z.record(z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,39}$/), slug).optional(),
    spots: z.array(slug).min(1).max(12),
    overflow: slug.optional(),
  }).strict().optional(),
  /**
   * Tomo's pet, when it has one. Like Tomo, the first rule whose condition
   * holds decides where it is, otherwise it wanders or stands at `spot`: a
   * pet with a nest goes to the nest's spot `when: "pet:sleeping"`. Unlike
   * Tomo it may wander while Tomo works.
   */
  pet: mover.optional(),
  /**
   * More characters, by name (a slug): a dog, a second cat. Each is like the
   * pet (rules, then wander, then its own spot; it may wander while Tomo
   * works) but always drawn, and its size defaults to Tomo's. At most
   * MAX_OTHERS.
   */
  others: z.record(slug, mover).optional(),
}).strict();

export const homeSceneSchema = z.object({
  version: z.literal(HOME_SCENE_VERSION),
  /** What Tomo calls this design. */
  name: z.string().min(1).max(60).optional(),
  room: z.object({
    /** [width, height, depth]. */
    size: z.tuple([z.number().min(ROOM_MIN).max(ROOM_MAX), z.number().min(ROOM_MIN).max(8), z.number().min(ROOM_MIN).max(ROOM_MAX)]),
    floor: color,
    walls: color,
    /** What is behind the room. Default: a dark neutral. */
    backdrop: color.optional(),
  }).strict(),
  light: z.object({
    color: color.optional(),
    /** Where the light comes from: degrees around the room, 0 = from the viewer's side. */
    angle: degrees.optional(),
    /** 0 = dim and moody, 1 = bright. */
    level: z.number().min(0).max(1).optional(),
  }).strict().optional(),
  kinds: z.record(slug, z.object({ parts: z.array(part).min(1).max(MAX_PARTS_PER_NODE) }).strict()).optional(),
  objects: z.array(part).max(MAX_OBJECTS),
  spots: z.record(slug, spot).optional(),
  characters: characters.optional(),
}).strict();

export type HomeScene = z.infer<typeof homeSceneSchema>;
export type HomeSpot = z.infer<typeof spot>;
export type HomeCharacters = z.infer<typeof characters>;
export type HomeMover = z.infer<typeof mover>;
