import { NAV_CELL, NAV_RADIUS } from "./nav.js";
import type { HomeSpot } from "./scene.js";

/**
 * Where waiting visitors stand, shared by the page (which draws them there)
 * and home_check (which checks they can walk to a seat from there). Pure.
 */

/** Waiting visitors drawn at most (the caption still counts them all). */
export const MAX_WAITING_DRAWN = 8;
export const WAITING_GAP = 0.7;
/**
 * A waiting place is kept this far from the walls: a Tomo-sized walker's
 * radius and a grid cell, so it stands on free floor (nav.ts frees a cell
 * only if all of it keeps the radius) and the visitor can walk to a seat
 * from there instead of fading.
 */
export const WAITING_WALL_GAP = NAV_RADIUS + NAV_CELL;
/**
 * Where the `index`-th waiting visitor stands: in a row through the
 * overflow spot, across the way it faces (0, right, left, further right…),
 * kept WAITING_WALL_GAP inside the walls.
 */
export function waitingPosition(spot: HomeSpot, index: number, room: readonly [number, number, number]): [number, number, number] {
  const step = Math.ceil(index / 2) * (index % 2 ? 1 : -1) * WAITING_GAP;
  const facing = (spot.facing ?? 0) * Math.PI / 180;
  const clamp = (value: number, half: number) => Math.max(-half + WAITING_WALL_GAP, Math.min(half - WAITING_WALL_GAP, value));
  return [clamp(spot.at[0] + Math.cos(facing) * step, room[0] / 2), spot.at[1], clamp(spot.at[2] - Math.sin(facing) * step, room[2] / 2)];
}
