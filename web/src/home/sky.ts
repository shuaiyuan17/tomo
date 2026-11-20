import type { HomeSky, HomeStatus } from "../../../src/home/status.js";
import { i18n } from "../i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: home:weather.*

/**
 * What is outside the window, without three.js: the sky the daemon reported
 * (`status.sky`, for the configured city), or, without one, a clear sky by
 * the viewer's own clock. Also how much it dims and cools the room's light.
 */

export type SkyPhase = HomeSky["phase"];
export interface Sky { weather: HomeSky["weather"]; phase: SkyPhase; progress: number; tempC?: number; /** Reported by the daemon (weather conditions hold only then). */ known: boolean }

/** The viewer's clock when no city is configured: dawn 6–7, day 7–18, dusk 18–19, night otherwise. */
export function localSky(date: Date): Sky {
  const hours = date.getHours() + date.getMinutes() / 60;
  const phase: SkyPhase = hours >= 6 && hours < 7 ? "dawn" : hours >= 7 && hours < 18 ? "day" : hours >= 18 && hours < 19 ? "dusk" : "night";
  // Daylight runs 6 → 19, the night 19 → 6 (11 h).
  const progress = phase === "night" ? ((hours - 19 + 24) % 24) / 11 : (hours - 6) / 13;
  return { weather: "clear", phase, progress: Math.min(1, Math.max(0, progress)), known: false };
}

export function skyOf(status: HomeStatus, now: number): Sky {
  const sky = status.sky;
  if (!sky) return localSky(new Date(now));
  return { weather: sky.weather, phase: sky.phase, progress: Math.min(1, Math.max(0, Number.isFinite(sky.progress) ? sky.progress : 0.5)),
    ...(typeof sky.tempC === "number" && Number.isFinite(sky.tempC) ? { tempC: sky.tempC } : {}), known: true };
}

/** `day` / `night` are about outside the window; dawn and dusk count as day. */
export function isDayOutside(sky: Sky): boolean { return sky.phase !== "night"; }

/**
 * How the sky reaches the room: a factor on the scene's own light level and
 * a colour the light leans toward. Subtle on purpose, so a lamp reads at
 * night without the room going dark, and the scene's `light` still matters.
 */
export function skyLight(sky: Sky): { factor: number; tint: string; tintAmount: number } {
  const phase = sky.phase === "night" ? { factor: 0.62, tint: "#9fb0d8", tintAmount: 0.35 }
    : sky.phase === "dawn" ? { factor: 0.85, tint: "#ffc9a0", tintAmount: 0.25 }
    : sky.phase === "dusk" ? { factor: 0.82, tint: "#ffb98a", tintAmount: 0.28 }
    : { factor: 1, tint: "#ffffff", tintAmount: 0 };
  const weather = sky.weather === "storm" ? 0.72 : sky.weather === "overcast" || sky.weather === "rain" || sky.weather === "snow" ? 0.84
    : sky.weather === "fog" ? 0.88 : sky.weather === "clouds" ? 0.94 : 1;
  const cool = sky.weather === "storm" || sky.weather === "overcast" || sky.weather === "rain" ? 0.15 : 0;
  return { factor: phase.factor * weather, tint: phase.tintAmount ? phase.tint : "#b9c6d8", tintAmount: phase.tintAmount || cool };
}

const WORDS = { clear: "home:weather.clear", clouds: "home:weather.clouds", overcast: "home:weather.overcast", fog: "home:weather.fog",
  rain: "home:weather.rain", snow: "home:weather.snow", storm: "home:weather.storm" } as const satisfies Record<HomeSky["weather"], string>;
/** "12°C, raining" — only when the daemon reported the weather. */
export function weatherWords(sky: Sky): string {
  if (!sky.known) return "";
  const words = i18n.t(WORDS[sky.weather]);
  return sky.tempC === undefined ? words : i18n.t("home:weather.withTemp", { temp: Math.round(sky.tempC), words });
}

/** The weather moves (rain, snow, drifting cloud, a storm's flashes); a clear sky stands still. */
export function skyMoves(sky: Sky): boolean { return sky.weather !== "clear"; }
