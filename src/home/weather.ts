import { z } from "zod";
import type { HomeWeather } from "./scene.js";
import type { HomeSky } from "./status.js";

/**
 * What is outside the home's window: the configured city's weather from
 * wttr.in's structured answer (`?format=j1`), the service the heartbeat
 * already asks for its one-line weather (continuity.ts, left as it is), and
 * the sun computed from the city's position.
 *
 * Day and night are NOT read from the answer's sunrise/sunset strings: those
 * are in the city's local time with no offset, and the answer carries no
 * local time to anchor them (`observation_time` is UTC). Instead the sun's
 * elevation is computed from `nearest_area[0]`'s latitude and longitude and
 * the current UTC time (NOAA's solar position equations), which needs no
 * time zone and works for a city on the other side of the world. No usable
 * coordinates: no sky.
 *
 * Bounded: no city, no request. One request at a time, a 5 s timeout, an
 * answer of at most 512 KiB; a good answer is kept 30 minutes, a failure 5
 * (and reads as no sky: the page falls back by itself). Nothing here throws
 * into the status path. Only the city goes to wttr.in, as for the heartbeat.
 *
 * Fetching happens only while the sky is wanted: `want()` is called when a
 * page reads /home and when home_check looks (service.ts); `sky()` refreshes
 * a stale answer only within WANTED_FOR_MS of the last want, so a daemon with
 * nobody looking asks nothing. Phase and progress are recomputed on every
 * read from the clock, without a new fetch.
 */

export const WEATHER_TTL_MS = 30 * 60_000;
export const WEATHER_FAILURE_TTL_MS = 5 * 60_000;
export const WEATHER_TIMEOUT_MS = 5_000;
export const WEATHER_MAX_BYTES = 512 * 1024;
/** After a want, stale answers are refreshed for this long. */
export const WANTED_FOR_MS = 2 * 60 * 60_000;
/** Dawn and dusk: the sun between these elevations (degrees), rising or setting. */
export const TWILIGHT_DEGREES = 6;
/** An answer older than this is not shown at all (the weather could be anything by now). */
export const WEATHER_MAX_AGE_MS = 2 * 60 * 60_000;

/**
 * World Weather Online condition codes (what wttr.in reports), the full
 * published list, grouped into the scene's seven.
 */
const CODE_GROUPS: Record<HomeWeather, number[]> = {
  clear: [113],
  clouds: [116],
  overcast: [119, 122],
  fog: [143, 248, 260],
  // Patchy rain, drizzle (also freezing), light to torrential rain and showers, freezing rain.
  rain: [176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359],
  // Snow, sleet, blowing snow, blizzard, ice pellets, and their showers.
  snow: [179, 182, 185, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377],
  // Thundery outbreaks, and rain or snow with thunder.
  storm: [200, 386, 389, 392, 395],
};
export const WEATHER_CODES: ReadonlyMap<number, HomeWeather> = new Map(Object.entries(CODE_GROUPS).flatMap(([weather, codes]) => codes.map((code) => [code, weather as HomeWeather] as const)));
/** An unknown code reads as clouds: a neutral sky, neither a false storm nor a false clear one. */
export const DEFAULT_WEATHER: HomeWeather = "clouds";
export function weatherOfCode(code: number): HomeWeather { return WEATHER_CODES.get(code) ?? DEFAULT_WEATHER; }

// Tolerant of everything wttr.in adds; strict only about what is read. Every value is a string.
const numeric = z.string().regex(/^\s*-?\d{1,4}(?:\.\d+)?\s*$/);
const answerSchema = z.object({
  current_condition: z.array(z.object({ weatherCode: z.string().regex(/^\d{1,4}$/), temp_C: z.string().optional() }).passthrough()).min(1),
  nearest_area: z.array(z.object({ latitude: z.unknown().optional(), longitude: z.unknown().optional() }).passthrough()).optional(),
}).passthrough();

/** What the answer says, reduced to what the sky needs. */
export interface CityWeather {
  weather: HomeWeather;
  tempC?: number;
  /** Degrees; absent when the answer gave no usable position (then there is no sky). */
  latitude?: number;
  longitude?: number;
}

/** Parses a `format=j1` answer; undefined when it is not one. */
export function parseWeatherAnswer(value: unknown): CityWeather | undefined {
  const parsed = answerSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const current = parsed.data.current_condition[0];
  const out: CityWeather = { weather: weatherOfCode(Number(current.weatherCode)) };
  if (current.temp_C !== undefined && numeric.safeParse(current.temp_C).success) out.tempC = Math.round(Number(current.temp_C));
  const area = parsed.data.nearest_area?.[0];
  const lat = numeric.safeParse(area?.latitude);
  const lon = numeric.safeParse(area?.longitude);
  if (lat.success && lon.success) {
    const latitude = Number(lat.data); const longitude = Number(lon.data);
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) { out.latitude = latitude; out.longitude = longitude; }
  }
  return out;
}

// ---- the sun (NOAA solar position equations) ----

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const DAY_MS = 86_400_000;

/** Declination (degrees) and the equation of time (minutes) at a UTC instant. */
function solarTerms(time: number): { declination: number; equationOfTime: number } {
  const jc = (time / DAY_MS + 2440587.5 - 2451545) / 36525;
  const l0 = (((280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360) + 360) % 360;
  const m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const c = Math.sin(rad(m)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(rad(2 * m)) * (0.019993 - 0.000101 * jc) + Math.sin(rad(3 * m)) * 0.000289;
  const omega = 125.04 - 1934.136 * jc;
  const apparent = l0 + c - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const obliquity = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(rad(omega));
  const declination = deg(Math.asin(Math.sin(rad(obliquity)) * Math.sin(rad(apparent))));
  const y = Math.tan(rad(obliquity / 2)) ** 2;
  const equationOfTime = 4 * deg(y * Math.sin(2 * rad(l0)) - 2 * e * Math.sin(rad(m)) + 4 * e * y * Math.sin(rad(m)) * Math.cos(2 * rad(l0))
    - 0.5 * y * y * Math.sin(4 * rad(l0)) - 1.25 * e * e * Math.sin(2 * rad(m)));
  return { declination, equationOfTime };
}

/** The sun's elevation (degrees, refraction ignored) and whether it is before solar noon, at a place and UTC instant. */
export function sunElevation(latitude: number, longitude: number, time: number): { elevation: number; rising: boolean } {
  const { declination, equationOfTime } = solarTerms(time);
  const minutes = ((time % DAY_MS) + DAY_MS) % DAY_MS / 60_000;
  const trueSolar = (((minutes + equationOfTime + 4 * longitude) % 1440) + 1440) % 1440;
  const hourAngle = trueSolar / 4 - 180;
  const cosZenith = Math.sin(rad(latitude)) * Math.sin(rad(declination)) + Math.cos(rad(latitude)) * Math.cos(rad(declination)) * Math.cos(rad(hourAngle));
  return { elevation: 90 - deg(Math.acos(Math.max(-1, Math.min(1, cosZenith)))), rising: hourAngle < 0 };
}

/**
 * Sunrise and sunset (ms epoch) around the solar noon nearest `time`, or the
 * polar case: "day" (the sun never sets) / "night" (it never rises).
 */
export function sunTimes(latitude: number, longitude: number, time: number): { sunrise: number; sunset: number; noon: number } | { polar: "day" | "night"; noon: number } {
  const { declination, equationOfTime } = solarTerms(time);
  const dayStart = Math.floor(time / DAY_MS) * DAY_MS;
  let noon = dayStart + (720 - 4 * longitude - equationOfTime) * 60_000;
  while (noon - time > DAY_MS / 2) noon -= DAY_MS;
  while (time - noon > DAY_MS / 2) noon += DAY_MS;
  // 90.833°: the sun's upper limb on the horizon, with standard refraction.
  const cosHa = Math.cos(rad(90.833)) / (Math.cos(rad(latitude)) * Math.cos(rad(declination))) - Math.tan(rad(latitude)) * Math.tan(rad(declination));
  if (!Number.isFinite(cosHa) || cosHa > 1) return { polar: "night", noon };
  if (cosHa < -1) return { polar: "day", noon };
  const half = 4 * deg(Math.acos(cosHa)) * 60_000;
  return { sunrise: noon - half, sunset: noon + half, noon };
}

/**
 * The sky at `time` for a parsed answer. Phase by the sun's elevation (below
 * −6°: night; −6° to +6°: dawn while rising, dusk while setting; above:
 * day); progress through the daylight (sunrise → sunset) or the night
 * (sunset → sunrise), from the computed times; for polar day or night,
 * through the 24 hours from solar midnight. Rounded to hundredths.
 */
export function skyAt(city: CityWeather, time: number): HomeSky | undefined {
  if (city.latitude === undefined || city.longitude === undefined) return undefined;
  const { elevation, rising } = sunElevation(city.latitude, city.longitude, time);
  const phase: HomeSky["phase"] = elevation < -TWILIGHT_DEGREES ? "night" : elevation <= TWILIGHT_DEGREES ? (rising ? "dawn" : "dusk") : "day";
  const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  const times = sunTimes(city.latitude, city.longitude, time);
  let progress: number;
  if ("polar" in times) progress = (time - (times.noon - DAY_MS / 2)) / DAY_MS;
  else if (time >= times.sunrise && time <= times.sunset) progress = (time - times.sunrise) / (times.sunset - times.sunrise);
  else if (time > times.sunset) progress = (time - times.sunset) / (times.sunrise + DAY_MS - times.sunset);
  else progress = (time - (times.sunset - DAY_MS)) / (times.sunrise - (times.sunset - DAY_MS));
  return { weather: city.weather, phase, progress: round(progress), ...(city.tempC !== undefined ? { tempC: city.tempC } : {}) };
}

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export class HomeWeatherSource {
  private answer: CityWeather | undefined;
  private fetchedAt = -Infinity;
  private failedAt = -Infinity;
  private inFlight: Promise<void> | undefined;
  private wantedAt = -Infinity;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly onUpdate: (() => void) | undefined;

  constructor(private readonly city: string | null | undefined, options: { fetch?: FetchLike; now?: () => number; onUpdate?: () => void } = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.onUpdate = options.onUpdate;
  }

  /** Someone is looking (a page read /home, home_check looked): keep the answer fresh for a while. */
  want(): void {
    if (!this.city?.trim()) return;
    this.wantedAt = this.now();
    this.refreshIfStale();
  }

  /** The sky now, from the cached answer (refreshed in the background while wanted). Never throws. */
  sky(): HomeSky | undefined {
    if (!this.city?.trim()) return undefined;
    try {
      if (this.now() - this.wantedAt < WANTED_FOR_MS) this.refreshIfStale();
      if (!this.answer || this.now() - this.fetchedAt > WEATHER_MAX_AGE_MS) return undefined;
      return skyAt(this.answer, this.now());
    } catch { return undefined; }
  }

  /** Resolves once a refresh in flight (if any) settles; for tests and home_check. */
  async settled(): Promise<void> { await this.inFlight; }

  private refreshIfStale(): void {
    const now = this.now();
    if (this.inFlight || now - this.fetchedAt < WEATHER_TTL_MS || now - this.failedAt < WEATHER_FAILURE_TTL_MS) return;
    this.inFlight = this.load().finally(() => { this.inFlight = undefined; });
  }

  private async load(): Promise<void> {
    try {
      const response = await this.fetchImpl(`https://wttr.in/${encodeURIComponent(this.city!.trim())}?format=j1`,
        { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > WEATHER_MAX_BYTES) throw new Error("bad response");
      const text = await response.text();
      if (text.length > WEATHER_MAX_BYTES) throw new Error("too large");
      const parsed = parseWeatherAnswer(JSON.parse(text));
      if (!parsed) throw new Error("unrecognised answer");
      this.answer = parsed;
      this.fetchedAt = this.now();
    } catch {
      // A failure reads as no sky until the next try.
      this.failedAt = this.now();
      this.answer = undefined;
    }
    try { this.onUpdate?.(); } catch { /* the status path never fails on this */ }
  }
}
