/**
 * The few values the page needs from the home contract (src/home/scene.ts,
 * src/web/protocol.ts). Those modules build zod schemas when imported, which
 * the browser does not need (the server validates): these copies are pinned
 * to the originals by tests/web-home.test.ts.
 */
export const SIGN_VALUES = ["subagents", "tasks", "tool", "idle", "next_job", "status", "task"] as const;
export const MAX_SIGN_CHARS = 80;
export const HOME_SNAPSHOT_MAX_BYTES = 1024 * 1024;
/** Reaction amounts and speeds when a scene gives none, and their ceilings (scene.ts REACTIONS). */
export const REACTION_DEFAULTS = { bob: { amount: 0.06, max: 1, speed: 1.2 }, spin: { speed: 0.25 }, swing: { amount: 12, max: 45, speed: 1 }, pulse: { amount: 0.08, max: 0.5, speed: 1 } } as const;
