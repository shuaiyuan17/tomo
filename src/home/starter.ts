import type { HomeScene } from "./scene.js";

/**
 * The room Tomo's home starts as, before Tomo has written a scene of its
 * own, and what is shown when there is no valid scene at all. It is also the
 * worked example the home skill points Tomo at, so it uses every part of the
 * format at least once: the four shapes, kinds (nested), parts, `at` /
 * `turn` / `size` / `color`, `on`, signs with live values (a visitor's own
 * `{task}` too), a window onto the real sky, spots, every character, `room`,
 * `light`, every reaction, and conditions alone, negated (`not:`), in lists,
 * and about the weather (`weather:rain`: the umbrella). It has no picture
 * panel only because there are no asset files to point at; one would be
 * `{ picture: "art.png", size: [0.8, 0.6, 0.04], at: [...] }`.
 *
 * Layout: the back wall is at z = -3, the left wall at x = -3. Tomo's desk
 * stands in the back left corner, turned so Tomo works facing the right of
 * the room (seen three-quarter from the default view, not from behind); the
 * window in the middle of the back wall, the bell and a shelf on the right;
 * two guest desks for subagents on the right, the cushion and the cat's bed
 * at the front.
 */
const INK = "#1d1b19";
const SCREEN_ON = "#bfe6c4";
const LAMP = "#f3cf6b";

export const STARTER_SCENE: HomeScene = {
  version: 1,
  name: "Starter room",
  room: { size: [6, 3.2, 6], floor: "#a9825b", walls: "#d9cdb6", backdrop: "#1b1a19" },
  light: { color: "#fff1dc", angle: 35, level: 0.6 },
  kinds: {
    // ---- furniture ----
    desk: { parts: [
      { shape: "box", size: [1.5, 0.08, 0.8], at: [0, 0.72, 0], color: "#8a6244" },
      { shape: "box", size: [0.08, 0.72, 0.08], at: [-0.67, 0, -0.32], color: "#6b4a33" },
      { shape: "box", size: [0.08, 0.72, 0.08], at: [0.67, 0, -0.32], color: "#6b4a33" },
      { shape: "box", size: [0.08, 0.72, 0.08], at: [-0.67, 0, 0.32], color: "#6b4a33" },
      { shape: "box", size: [0.08, 0.72, 0.08], at: [0.67, 0, 0.32], color: "#6b4a33" },
    ] },
    "guest-desk": { parts: [
      { shape: "box", size: [1.1, 0.07, 0.6], at: [0, 0.68, 0], color: "#9a7450" },
      { shape: "box", size: [0.07, 0.68, 0.5], at: [-0.48, 0, 0], color: "#7a5a3e" },
      { shape: "box", size: [0.07, 0.68, 0.5], at: [0.48, 0, 0], color: "#7a5a3e" },
    ] },
    stool: { parts: [
      { shape: "cylinder", size: [0.09, 0.37, 0.09], color: "#6b4a33" },
      { shape: "cylinder", size: [0.44, 0.08, 0.44], at: [0, 0.37, 0], color: "#b5623f" },
    ] },
    monitor: { parts: [
      { shape: "box", size: [0.26, 0.02, 0.16], color: "#232226" },
      { shape: "box", size: [0.06, 0.18, 0.06], at: [0, 0.02, -0.03], color: "#232226" },
      { shape: "box", size: [0.74, 0.46, 0.05], at: [0, 0.16, 0], color: "#2b2a2f",
        reactions: [{ when: "trouble", do: "glow", color: "#e8a07a" }, { when: "working", do: "glow", color: SCREEN_ON }] },
      // What kind of tool is in use, on the screen, while there is one.
      { sign: "{tool}", size: [0.6, 0.12, 0.01], at: [0, 0.33, 0.03], color: "#2f4a35", background: SCREEN_ON,
        reactions: [{ when: ["working", "not:compacting"], do: "show" }] },
      // The same on its back, which is the side the room sees.
      { sign: "{tool}", size: [0.6, 0.12, 0.01], at: [0, 0.33, -0.03], turn: [0, 180, 0], color: "#2f4a35", background: SCREEN_ON,
        reactions: [{ when: ["working", "not:compacting"], do: "show" }] },
    ] },
    lamp: { parts: [
      { shape: "cylinder", size: [0.2, 0.03, 0.2], color: "#3b3833" },
      { shape: "cylinder", size: [0.03, 0.4, 0.03], at: [0, 0.03, 0], color: "#3b3833" },
      { shape: "sphere", size: [0.1, 0.1, 0.1], at: [0, 0.34, 0], color: "#f6e7b5",
        reactions: [{ when: "working", do: "glow", color: LAMP }, { when: ["idle", "night"], do: "glow", color: "#d9a84a" }] },
      { shape: "cone", size: [0.3, 0.22, 0.3], at: [0, 0.38, 0], color: "#8f8a80",
        reactions: [{ when: "working", do: "glow", color: LAMP }, { when: ["idle", "night"], do: "glow", color: "#d9a84a" }] },
    ] },
    mug: { parts: [
      { shape: "cylinder", size: [0.12, 0.13, 0.12], color: "#c7694f" },
      { shape: "box", size: [0.03, 0.07, 0.03], at: [0.075, 0.03, 0], color: "#c7694f" },
      { shape: "sphere", size: [0.05, 0.05, 0.05], at: [0, 0.17, 0], color: "#f1ead9",
        reactions: [{ when: "working", do: "show" }, { when: "working", do: "bob", amount: 0.06, speed: 0.7 }] },
    ] },
    plant: { parts: [
      { shape: "cylinder", size: [0.44, 0.4, 0.44], color: "#b5623f" },
      { shape: "cylinder", size: [0.38, 0.02, 0.38], at: [0, 0.4, 0], color: "#5b4a3a" },
      { shape: "cone", size: [0.8, 1.1, 0.8], at: [0, 0.42, 0], color: "#2f5a43" },
      { shape: "cone", size: [0.5, 0.75, 0.5], at: [0.14, 0.95, 0.04], turn: [0, 30, -10], color: "#3a6b4f" },
    ] },
    books: { parts: [
      { shape: "box", size: [0.07, 0.26, 0.2], at: [-0.08, 0, 0], color: "#b5623f" },
      { shape: "box", size: [0.06, 0.22, 0.2], at: [0, 0, 0], color: "#5f7a4f" },
      { shape: "box", size: [0.08, 0.28, 0.2], at: [0.08, 0, 0], color: "#6f8fb5" },
      { shape: "box", size: [0.06, 0.24, 0.2], at: [0.17, 0, 0], turn: [0, 0, -14], color: "#d6a83a" },
    ] },
    // ---- the characters' bodies ----
    eyes: { parts: [
      { shape: "sphere", size: [0.08, 0.1, 0.05], at: [-0.12, 0, 0], color: INK },
      { shape: "sphere", size: [0.08, 0.1, 0.05], at: [0.12, 0, 0], color: INK },
    ] },
    "sleepy-eyes": { parts: [
      { shape: "box", size: [0.11, 0.022, 0.03], at: [-0.12, 0.04, 0], color: INK },
      { shape: "box", size: [0.11, 0.022, 0.03], at: [0.12, 0.04, 0], color: INK },
    ] },
    cheeks: { parts: [
      { shape: "sphere", size: [0.08, 0.05, 0.03], at: [-0.21, 0, 0], color: "#d98a72" },
      { shape: "sphere", size: [0.08, 0.05, 0.03], at: [0.21, 0, 0], color: "#d98a72" },
    ] },
    tomo: { parts: [{
      reactions: [{ when: "working", do: "bob", amount: 0.05, speed: 1.6 }, { when: "idle", do: "pulse", amount: 0.025, speed: 0.3 }],
      parts: [
        // Feet, a round light-green body and a cream belly: nothing like the plant.
        { shape: "sphere", size: [0.16, 0.08, 0.2], at: [-0.15, 0, 0.12], color: "#5f7f4f" },
        { shape: "sphere", size: [0.16, 0.08, 0.2], at: [0.15, 0, 0.12], color: "#5f7f4f" },
        { shape: "sphere", size: [0.7, 0.64, 0.7], at: [0, 0.04, 0], color: "#93b67f" },
        { shape: "sphere", size: [0.42, 0.34, 0.1], at: [0, 0.12, 0.285], color: "#efe6cc" },
        { kind: "eyes", at: [0, 0.4, 0.31], reactions: [{ when: "idle", do: "hide" }] },
        { kind: "sleepy-eyes", at: [0, 0.4, 0.32], reactions: [{ when: "idle", do: "show" }] },
        { kind: "cheeks", at: [0, 0.33, 0.29] },
        { shape: "cylinder", size: [0.025, 0.12, 0.025], at: [0, 0.64, 0], color: "#4f6b40" },
        { shape: "cone", size: [0.12, 0.18, 0.05], at: [0.06, 0.7, 0], turn: [0, 0, -55], color: "#c7694f",
          reactions: [{ when: "working", do: "swing", amount: 10, speed: 1.6 }] },
        { shape: "cone", size: [0.12, 0.18, 0.05], at: [-0.06, 0.7, 0], turn: [0, 0, 55], color: "#c7694f" },
        // A worried drop while a turn is in trouble.
        { shape: "sphere", size: [0.07, 0.1, 0.07], at: [0.3, 0.5, 0.15], color: "#9cc7e0",
          reactions: [{ when: "trouble", do: "show" }, { when: "trouble", do: "bob", amount: 0.04, speed: 2 }] },
      ] }] },
    laptop: { parts: [
      { shape: "box", size: [0.34, 0.02, 0.24], color: "#3b3833" },
      { shape: "box", size: [0.34, 0.22, 0.015], at: [0, 0.02, 0.11], turn: [12, 0, 0], color: "#2b2a2f",
        reactions: [{ when: "working", do: "glow", color: SCREEN_ON }] },
    ] },
    // A visitor's own sign: what its subagent was sent to do.
    "task-tag": { parts: [{ sign: "{task}", size: [1.05, 0.15, 0.02], color: "#2a2622", background: "#fbf8f1" }] },
    visitor: { parts: [
      { reactions: [{ when: "working", do: "bob", amount: 0.035, speed: 2.2 }], parts: [
        { shape: "sphere", size: [0.54, 0.5, 0.54], color: "#c98a4b" },
        // The same eyes and cheeks as Tomo's, smaller (scale multiplies their sizes and spacing).
        { kind: "eyes", at: [0, 0.28, 0.24], scale: 0.82 },
        { kind: "cheeks", at: [0, 0.21, 0.22], scale: 0.8 },
      ] },
      { kind: "laptop", at: [0, 0.33, 0.4] },
      { kind: "task-tag", at: [0, 0.66, 0] },
    ] },
    scout: { parts: [
      { reactions: [{ when: "working", do: "bob", amount: 0.035, speed: 2.6 }], parts: [
        { shape: "sphere", size: [0.5, 0.52, 0.5], color: "#6f8fb5" },
        { kind: "eyes", at: [0, 0.3, 0.22], scale: 0.8 },
        { shape: "cylinder", size: [0.02, 0.16, 0.02], at: [0, 0.5, 0], color: "#3b3833" },
        { shape: "sphere", size: [0.08, 0.08, 0.08], at: [0, 0.64, 0], color: LAMP, reactions: [{ when: "working", do: "glow" }] },
      ] },
      { kind: "laptop", at: [0, 0.33, 0.4] },
      { kind: "task-tag", at: [0, 0.78, 0] },
    ] },
    // A little hut for the cat: walls, a door opening at its front (+z), a cone roof.
    nest: { parts: [
      { shape: "cylinder", size: [0.72, 0.05, 0.72], color: "#c9a77a" },
      { shape: "cylinder", size: [0.56, 0.04, 0.56], at: [0, 0.05, 0], color: "#d98a72" },
      { shape: "box", size: [0.8, 0.5, 0.06], at: [0, 0, -0.37], color: "#b88a5a" },
      { shape: "box", size: [0.06, 0.5, 0.8], at: [-0.37, 0, 0], color: "#a67a4d" },
      { shape: "box", size: [0.06, 0.5, 0.8], at: [0.37, 0, 0], color: "#a67a4d" },
      { shape: "box", size: [0.2, 0.5, 0.06], at: [-0.3, 0, 0.37], color: "#b88a5a" },
      { shape: "box", size: [0.2, 0.5, 0.06], at: [0.3, 0, 0.37], color: "#b88a5a" },
      { shape: "box", size: [0.8, 0.1, 0.06], at: [0, 0.4, 0.37], color: "#b88a5a" },
      { shape: "cone", size: [1.05, 0.42, 1.05], at: [0, 0.5, 0], color: "#c7694f" },
    ] },
    cat: { parts: [{
      reactions: [{ when: "pet:happy", do: "bob", amount: 0.04, speed: 1.4 }, { when: "pet:blissful", do: "bob", amount: 0.03, speed: 0.8 }],
      parts: [
      { shape: "sphere", size: [0.34, 0.24, 0.46], color: "#857a70" },
      { shape: "sphere", size: [0.26, 0.24, 0.24], at: [0, 0.12, 0.2], color: "#857a70" },
      { shape: "cone", size: [0.08, 0.1, 0.06], at: [-0.07, 0.32, 0.2], color: "#857a70" },
      { shape: "cone", size: [0.08, 0.1, 0.06], at: [0.07, 0.32, 0.2], color: "#857a70" },
      { shape: "sphere", size: [0.045, 0.05, 0.02], at: [-0.055, 0.24, 0.315], color: "#d6c25a", reactions: [{ when: "pet:sleeping", do: "hide" }] },
      { shape: "sphere", size: [0.045, 0.05, 0.02], at: [0.055, 0.24, 0.315], color: "#d6c25a", reactions: [{ when: "pet:sleeping", do: "hide" }] },
      { at: [0, 0.26, 0.315], reactions: [{ when: "pet:sleeping", do: "show" }], parts: [
        { shape: "box", size: [0.05, 0.015, 0.02], at: [-0.055, 0, 0], color: INK },
        { shape: "box", size: [0.05, 0.015, 0.02], at: [0.055, 0, 0], color: INK },
      ] },
      { at: [0, 0.1, -0.2],
        reactions: [{ when: "pet:happy", do: "swing", amount: 30, speed: 1.6 }, { when: "not:pet:sleeping", do: "swing", amount: 14, speed: 0.6 }],
        parts: [{ shape: "cylinder", size: [0.045, 0.2, 0.045], turn: [-60, 0, 0], color: "#857a70" }] },
    ] }] },
  },
  objects: [
    // Tomo's desk, and the bell over the room: it rings (swings, and shines)
    // when a scheduled job fires, from its hook on the back wall.
    { id: "desk", kind: "desk", at: [-0.95, 0, -1.9], turn: [0, 90, 0] },
    { at: [1.25, 2.74, -2.82], reactions: [{ when: "cron", do: "swing", amount: 22, speed: 1.4 }], parts: [
      { shape: "cylinder", size: [0.025, 0.25, 0.025], at: [0, -0.25, 0], color: "#6b4a33" },
      { shape: "sphere", size: [0.08, 0.08, 0.08], at: [0, -0.3, 0], color: "#b88a2a" },
      { shape: "cone", size: [0.36, 0.34, 0.36], at: [0, -0.6, 0], color: "#d6a83a", reactions: [{ when: "cron", do: "glow", color: LAMP }] },
      { shape: "sphere", size: [0.09, 0.09, 0.09], at: [0, -0.66, 0], color: "#8a6a1c" },
    ] },
    { shape: "box", size: [0.3, 0.05, 0.24], at: [1.25, 2.74, -2.88], color: "#6b4a33" },

    // Floor boards and a rug.
    ...[-2, -1, 0, 1, 2].map((x) => ({ shape: "box" as const, size: [0.015, 0.01, 6] as [number, number, number], at: [x, 0, 0] as [number, number, number], color: "#9a7450" })),
    { shape: "box", size: [3, 0.02, 2.2], at: [0.2, 0.001, 0.7], color: "#7d8f6b" },
    { shape: "box", size: [2.7, 0.01, 1.9], at: [0.2, 0.02, 0.7], color: "#8a9c77" },

    // What rests on the desk, in the desk's own turned frame (it moves and turns with the desk):
    // the screen faces Tomo's stool, on the room side of the desk.
    { id: "screen", kind: "monitor", on: "desk", at: [0, 0, 0.15], turn: [0, 180, 0] },
    { id: "lamp", kind: "lamp", on: "desk", at: [-0.58, 0, 0.12], turn: [0, 20, 0] },
    { kind: "mug", on: "desk", at: [0.5, 0, -0.22] },
    { kind: "stool", at: [-1.85, 0, -1.9] },

    // The window shows the real sky (the app draws it): the time of day and the weather outside.
    { window: true, size: [1.7, 1.3, 0.08], at: [0, 1.2, -2.96], color: "#f1ead9" },
    { shape: "box", size: [1.85, 0.06, 0.16], at: [0, 1.14, -2.92], color: "#e4dac6" },
    { kind: "plant", at: [-2.45, 0, -0.5], scale: 1.25 },

    // A shelf: books, a globe that turns while Tomo is on the web, a jar that
    // pulses while context is compacted, a light that is on while background tasks run.
    { id: "shelf", shape: "box", size: [1.3, 0.05, 0.3], at: [2.2, 1.5, -2.85], color: "#6b4a33" },
    { kind: "books", on: "shelf", at: [-0.42, 0, 0] },
    { on: "shelf", at: [-0.02, 0, 0], parts: [
      { shape: "cylinder", size: [0.12, 0.03, 0.12], color: "#3b3833" },
      { shape: "cylinder", size: [0.02, 0.06, 0.02], at: [0, 0.03, 0], color: "#3b3833" },
      { shape: "sphere", size: [0.26, 0.26, 0.26], at: [0, 0.07, 0], color: "#6f8fb5", reactions: [{ when: "tool:web", do: "spin", speed: 0.6 }],
        parts: [{ shape: "box", size: [0.12, 0.08, 0.05], at: [0.04, 0.12, 0.09], turn: [0, 20, 0], color: "#7d9a68" }] },
    ] },
    { on: "shelf", shape: "sphere", size: [0.18, 0.22, 0.18], at: [0.3, 0, 0], color: "#9fc7c0",
      reactions: [{ when: "compacting", do: "glow" }, { when: "compacting", do: "pulse", amount: 0.12, speed: 1.2 }] },
    { on: "shelf", shape: "sphere", size: [0.07, 0.07, 0.07], at: [0.52, 0, 0], color: "#55615a",
      reactions: [{ when: "tasks", do: "tint", color: "#7fd18b" }, { when: "tasks", do: "glow", color: "#7fd18b" }] },

    // The chalkboard on the left wall says what is going on.
    { shape: "box", size: [0.04, 0.56, 2.05], at: [-2.98, 1.28, 0.3], color: "#6b4a33" },
    { sign: "{status}", size: [2.6, 0.42, 0.03], at: [-2.955, 1.33, 0.4], turn: [0, 90, 0], color: "#efe8d6", background: "#33413a" },

    // Guest desks for subagents: visitors sit behind them, facing the room.
    { kind: "guest-desk", at: [1.6, 0, -1.1] },
    { kind: "stool", at: [1.6, 0, -1.68] },
    { kind: "guest-desk", at: [1.6, 0, 0.55] },
    { kind: "stool", at: [1.6, 0, -0.03] },

    // An umbrella stand at the front: the umbrella is there while it rains outside.
    { at: [2.55, 0, 2.5], parts: [
      { shape: "cylinder", size: [0.26, 0.42, 0.26], color: "#6f8fb5" },
      { reactions: [{ when: "weather:rain", do: "show" }, { when: "weather:storm", do: "show" }], turn: [8, 0, -6], parts: [
        { shape: "cylinder", size: [0.03, 0.9, 0.03], at: [0, 0.1, 0], color: "#3b3833" },
        { shape: "cone", size: [0.2, 0.5, 0.2], at: [0, 0.55, 0], color: "#c7694f" },
        { shape: "box", size: [0.1, 0.03, 0.03], at: [0.04, 1.0, 0], color: "#3b3833" },
      ] },
    ] },

    // Where Tomo rests, and the cat's bed.
    { shape: "cylinder", size: [1.1, 0.22, 1.1], at: [-1.7, 0, 1.7], color: "#c7694f",
      parts: [{ shape: "cylinder", size: [0.95, 0.04, 0.95], at: [0, 0.22, 0], color: "#d98a72" }] },
    { shape: "cylinder", size: [0.7, 0.1, 0.7], at: [-0.35, 0, 2.35], color: "#7d8f6b" },
    // The cat's hut against the left wall, its door facing the room: it sleeps inside.
    { kind: "nest", at: [-2.5, 0, 0.6], turn: [0, 90, 0] },
  ],
  spots: {
    "desk-chair": { at: [-1.85, 0.45, -1.9], facing: 90 },
    window: { at: [0, 0, -2.3], facing: 180 },
    cushion: { at: [-1.7, 0.26, 1.7], facing: 35 },
    "guest-seat-1": { at: [1.6, 0.45, -1.68], facing: 0 },
    "guest-seat-2": { at: [1.6, 0.45, -0.03], facing: 0 },
    "guest-queue": { at: [1.2, 0, 2.25], facing: 20 },
    "pet-bed": { at: [-0.35, 0.1, 2.35], facing: 40 },
    "pet-nest": { at: [-2.5, 0.09, 0.6], facing: 90 },
  },
  characters: {
    tomo: { kind: "tomo", spot: "cushion", rules: [{ when: "by:heartbeat", spot: "window" }, { when: "working", spot: "desk-chair" }] },
    visitors: { kind: "visitor", kinds: { explore: "scout" }, spots: ["guest-seat-1", "guest-seat-2"], overflow: "guest-queue" },
    pet: { kind: "cat", spot: "pet-bed", rules: [{ when: "pet:sleeping", spot: "pet-nest" }] },
  },
};
