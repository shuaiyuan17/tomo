import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_WEATHER, HomeWeatherSource, parseWeatherAnswer, skyAt, sunTimes, WANTED_FOR_MS, WEATHER_CODES, WEATHER_FAILURE_TTL_MS, WEATHER_TTL_MS,
  weatherOfCode, type FetchLike,
} from "../src/home/weather.js";
import { WEATHERS } from "../src/home/scene.js";

// A hand-assembled answer in the shape of a live `wttr.in/seattle?format=j1`
// (owner-supplied samples, hourly forecast trimmed). Never tested against
// the live service: the sandbox cannot reach it.
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "wttr-j1-seattle.json"), "utf8"));
const SEATTLE = { latitude: 47.606, longitude: -122.331 };
const minutes = (a: number, b: number) => Math.abs(a - b) / 60_000;

describe("wttr.in answer", () => {
  it("parses the structured answer, tolerant of everything else in it", () => {
    expect(parseWeatherAnswer(FIXTURE)).toEqual({ weather: "rain", tempC: 8, ...SEATTLE });
  });
  it("without usable coordinates there is a weather but no sky", () => {
    const bare = { ...FIXTURE };
    delete bare.nearest_area;
    const parsed = parseWeatherAnswer(bare)!;
    expect(parsed.weather).toBe("rain");
    expect(skyAt(parsed, Date.now())).toBeUndefined();
    const bad = parseWeatherAnswer({ ...FIXTURE, nearest_area: [{ latitude: "north", longitude: "-122" }] })!;
    expect(skyAt(bad, Date.now())).toBeUndefined();
    expect(parseWeatherAnswer({ ...FIXTURE, nearest_area: [{ latitude: "95", longitude: "0" }] })!.latitude).toBeUndefined();
  });
  it("refuses what is not an answer", () => {
    expect(parseWeatherAnswer("Unknown location")).toBeUndefined();
    expect(parseWeatherAnswer({ current_condition: [] })).toBeUndefined();
    expect(parseWeatherAnswer({ current_condition: [{ weatherCode: 176 }] })).toBeUndefined();
  });
});

describe("weather codes", () => {
  it("maps every World Weather Online code to one of the seven", () => {
    const published = [113, 116, 119, 122, 143, 176, 179, 182, 185, 200, 227, 230, 248, 260, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314,
      317, 320, 323, 326, 329, 332, 335, 338, 350, 353, 356, 359, 362, 365, 368, 371, 374, 377, 386, 389, 392, 395];
    expect([...WEATHER_CODES.keys()].sort((a, b) => a - b)).toEqual(published);
    expect(new Set(WEATHER_CODES.values())).toEqual(new Set(WEATHERS));
  });
  it.each([
    ["clear", [113]], ["clouds", [116]], ["overcast", [119, 122]], ["fog", [143, 248, 260]],
    ["rain", [176, 263, 266, 281, 293, 302, 308, 311, 353, 359]], ["snow", [179, 182, 227, 230, 317, 335, 350, 368, 377]], ["storm", [200, 386, 389, 392, 395]],
  ] as const)("%s", (weather, codes) => {
    for (const code of codes) expect(weatherOfCode(code)).toBe(weather);
  });
  it("an unknown code is clouds", () => {
    expect(weatherOfCode(999)).toBe(DEFAULT_WEATHER);
    expect(DEFAULT_WEATHER).toBe("clouds");
  });
});

describe("the sun", () => {
  it("Seattle, 2026-11-15: sunrise about 15:14 UTC, sunset about 00:34 UTC, within five minutes of the service", () => {
    const times = sunTimes(SEATTLE.latitude, SEATTLE.longitude, Date.parse("2026-11-15T20:00:00Z"));
    if ("polar" in times) throw new Error("not polar");
    expect(minutes(times.sunrise, Date.parse("2026-11-15T15:14:00Z"))).toBeLessThan(5);
    expect(minutes(times.sunset, Date.parse("2026-11-16T00:34:00Z"))).toBeLessThan(5);
  });
  it("at 06:35 UTC it is night in Seattle and day in Tokyo, whatever the daemon's own zone", () => {
    const now = Date.parse("2026-11-15T06:35:00Z");
    expect(skyAt({ weather: "rain", ...SEATTLE }, now)).toMatchObject({ weather: "rain", phase: "night" });
    const tokyo = skyAt({ weather: "clear", latitude: 35.68, longitude: 139.69 }, now)!;
    expect(tokyo.phase).toBe("day");
    expect(tokyo.progress).toBeGreaterThan(0.8);
  });
  it("dawn around sunrise, day, dusk around sunset, night after; progress through each", () => {
    const city = { weather: "clear" as const, ...SEATTLE };
    const sky = (iso: string) => skyAt(city, Date.parse(iso))!;
    expect(sky("2026-11-15T15:05:00Z").phase).toBe("dawn");
    expect(sky("2026-11-15T15:30:00Z").phase).toBe("dawn");
    expect(sky("2026-11-15T20:00:00Z")).toMatchObject({ phase: "day" });
    expect(sky("2026-11-15T19:54:00Z").progress).toBeCloseTo(0.5, 1);
    expect(sky("2026-11-16T00:20:00Z").phase).toBe("dusk");
    expect(sky("2026-11-16T00:50:00Z").phase).toBe("dusk");
    expect(sky("2026-11-16T03:00:00Z").phase).toBe("night");
    // Local midnight (08:00 UTC) is about the middle of the night.
    expect(sky("2026-11-15T07:54:00Z").progress).toBeCloseTo(0.5, 1);
    expect(sky("2026-11-16T00:40:00Z").progress).toBeLessThan(0.05);
    expect(sky("2026-11-15T15:10:00Z").progress).toBeGreaterThan(0.95);
  });
  it("polar day and night: no sunrise or sunset, no division by zero", () => {
    expect(sunTimes(78, 15, Date.parse("2026-12-15T12:00:00Z"))).toMatchObject({ polar: "night" });
    expect(sunTimes(78, 15, Date.parse("2026-06-15T12:00:00Z"))).toMatchObject({ polar: "day" });
    const night = skyAt({ weather: "snow", latitude: 78, longitude: 15 }, Date.parse("2026-12-15T23:00:00Z"))!;
    expect(night.phase).toBe("night");
    expect(Number.isFinite(night.progress)).toBe(true);
    expect(skyAt({ weather: "clear", latitude: 78, longitude: 15 }, Date.parse("2026-06-15T11:00:00Z"))!.phase).toBe("day");
    expect(skyAt({ weather: "clear", latitude: 90, longitude: 0 }, Date.parse("2026-06-15T11:00:00Z"))).toBeDefined();
  });
});

describe("weather source", () => {
  const answer = (body: unknown, ok = true) => ({ ok, headers: { get: () => null }, text: async () => typeof body === "string" ? body : JSON.stringify(body) });

  it("no city: no request, no sky", () => {
    const fetch = vi.fn<FetchLike>();
    for (const city of [null, undefined, "  "]) {
      const source = new HomeWeatherSource(city, { fetch });
      source.want();
      expect(source.sky()).toBeUndefined();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks only once wanted, only the city, one request at a time; caches for WEATHER_TTL_MS", async () => {
    let now = Date.parse("2026-11-15T20:00:00Z");
    const fetch = vi.fn<FetchLike>(async () => answer(FIXTURE));
    const update = vi.fn();
    const source = new HomeWeatherSource("Seattle, WA", { fetch, now: () => now, onUpdate: update });
    expect(source.sky()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    source.want();
    source.want();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://wttr.in/Seattle%2C%20WA?format=j1");
    await source.settled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(source.sky()).toMatchObject({ weather: "rain", phase: "day", tempC: 8 });
    now += WEATHER_TTL_MS - 1;
    source.sky();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 2;
    source.sky();
    expect(fetch).toHaveBeenCalledTimes(2);
    await source.settled();
    // Nobody has wanted it for a while: stale answers are not refreshed.
    now += WANTED_FOR_MS + WEATHER_TTL_MS;
    source.sky();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a failure reads as no sky, is cached for WEATHER_FAILURE_TTL_MS, and never throws", async () => {
    let now = 1_000_000;
    let mode: "throw" | "bad" | "html" | "good" = "throw";
    const fetch = vi.fn<FetchLike>(async () => {
      if (mode === "throw") throw new Error("offline");
      if (mode === "bad") return answer("", false);
      if (mode === "html") return answer("<html>Unknown location</html>");
      return answer(FIXTURE);
    });
    const source = new HomeWeatherSource("Seattle", { fetch, now: () => now });
    source.want();
    await source.settled();
    expect(source.sky()).toBeUndefined();
    now += WEATHER_FAILURE_TTL_MS - 1;
    source.want();
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const next of ["bad", "html"] as const) {
      mode = next;
      now += WEATHER_FAILURE_TTL_MS + 1;
      source.want();
      await source.settled();
      expect(source.sky()).toBeUndefined();
    }
    mode = "good";
    now += WEATHER_FAILURE_TTL_MS + 1;
    source.want();
    await source.settled();
    expect(source.sky()?.weather).toBe("rain");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
