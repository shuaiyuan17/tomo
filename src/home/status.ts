import type { HomeWeather } from "./scene.js";

/**
 * What Tomo is doing right now, as its home shows it: one flat record the
 * daemon derives from the watch bus and the page turns into conditions
 * (scene.ts CONDITIONS), sign values and the caption under the room.
 *
 * It says THAT Tomo is busy and with what kind of thing. Text about the work
 * itself (`task`) is only filled in for conversations the browser may
 * already read, the Tasks panel's rule.
 */
export type HomeToolKind = "shell" | "files" | "web" | "search" | "subagent" | "other";
export type HomeTurnSource = "owner" | "cron" | "heartbeat" | "group" | "other";



/**
 * What is outside the window, for the configured city (`config.city`).
 * Absent when no city is set or the weather could not be read: the page then
 * shows a clear sky by the viewer's own clock.
 */
export interface HomeSky {
  weather: HomeWeather;
  /** By the city's own sunrise and sunset. */
  phase: "night" | "dawn" | "day" | "dusk";
  /** How far through the daylight (sunrise → sunset) or the night (sunset → sunrise) it is, 0–1: where the sun or moon stands. */
  progress: number;
  /** Outside temperature in °C, when known. */
  tempC?: number;
}

/** The `type` of a visitor that is one of the owner's running sub-sessions (a task), not an SDK subagent. */
export const HOME_SUBSESSION_TYPE = "subsession";

/** A visitor: a running subagent, or one of the owner's running sub-sessions. */
export interface HomeSubagent {
  /** Stable for the life of the subagent, so its visitor keeps its seat. */
  id: string;
  /** The SDK's subagent_type, lowercased; absent when unknown. HOME_SUBSESSION_TYPE for a sub-session. */
  type?: string;
  /** What it was sent to do, for its sign (a sub-session's title). Only for conversations the browser may read. */
  task?: string;
}

export interface HomeStatus {
  /** A turn is running somewhere. */
  working: boolean;
  /** Who started the running turn (the owner's own, when several run). */
  by?: HomeTurnSource;
  /** The kind of tool in use right now, if any. */
  tool?: HomeToolKind;
  subagents: HomeSubagent[];
  /** Running background tasks that are not subagents (shells, monitors), ambient ones excluded. */
  tasks: number;
  /** When a scheduled job last fired (ms epoch, daemon clock); the page shows `cron` for a few seconds after it. */
  cronAt?: number;
  /** When the next enabled scheduled job runs (ms epoch), if any. */
  nextJobAt?: number;
  compacting: boolean;
  trouble?: "retry" | "rate_limit" | "error";
  /** Since when nothing has been running (ms epoch); absent while working. */
  idleSince?: number;
  /** The pet's mood word, when Tomo has a pet. */
  pet?: string;
  sky?: HomeSky;
  /** The daemon's clock when this was computed (ms epoch): the page converts the times above to its own clock with it. */
  at: number;
}

/** How long after a scheduled job fires the `cron` condition holds. */
export const CRON_FLASH_MS = 6_000;
