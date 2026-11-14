import { describe, expect, it } from "vitest";
import { fetchUsage, usageWindows, type UsageResult } from "../src/agent/usage.js";
import { USAGE_REFRESH_MIN_MS, USAGE_TTL_MS, UsageCache } from "../src/web/usage.js";
import { formatSpan, isWarn, resetLabel, splitWindows, updatedLabel, usageNotice, windowTitle } from "../web/src/usage.js";
import type { WebUsage, WebUsageWindow } from "../src/web/protocol.js";

const NOW = Date.parse("2026-07-27T22:36:00.000Z");
const CREDS = { claudeAiOauth: { accessToken: "test-token", expiresAt: NOW + 3_600_000, subscriptionType: "max_20x" } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("fetchUsage (the reader /usage uses) classifies failures", () => {
  const run = (deps: Parameters<typeof fetchUsage>[0]) => fetchUsage({ now: () => NOW, loadCredentials: async () => CREDS, ...deps });
  it("ok, with the plan", async () => {
    const result = await run({ fetchImpl: async () => json({ five_hour: { utilization: 10 } }) });
    expect(result).toMatchObject({ ok: true, subscriptionType: "max_20x" });
  });
  it.each([
    ["api_key", { authMethod: "api-key" as const }],
    ["no_token", { loadCredentials: async () => ({}) }],
    ["network", { fetchImpl: async () => { throw new Error("socket"); } }],
    ["http_error", { fetchImpl: async () => json({}, 500) }],
    ["unauthorized", { fetchImpl: async () => json({}, 403) }],
    ["bad_response", { fetchImpl: async () => new Response("not json", { status: 200 }) }],
  ])("%s", async (reason, deps) => {
    const result = await run(deps as never);
    expect(result).toMatchObject({ ok: false, reason });
  });
  it("timeout", async () => {
    const result = await run({ fetchImpl: async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; } });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });
});

describe("usageWindows", () => {
  it("prefers the limits array, sorted session → weekly, scoped rows flagged", () => {
    const windows = usageWindows({ limits: [
      { kind: "weekly_scoped", group: "weekly", percent: 61, resets_at: "2026-08-01T00:00:00Z", scope: { model: { display_name: "Opus" } }, is_active: true },
      { kind: "session", group: "session", percent: 42, resets_at: "2026-07-28T01:00:00Z", severity: "normal" },
      { kind: "weekly_all", group: "weekly", percent: 85, severity: "warning" },
      "junk" as never,
    ] });
    expect(windows.map((w) => [w.label, w.group, w.scoped, w.percent, w.elevated])).toEqual([
      ["Session (5h)", "session", false, 42, false], ["Weekly · Opus", "weekly", true, 61, false], ["Weekly (all)", "weekly", false, 85, true]]);
    expect(windows[0].resetsAt).toBe(Date.parse("2026-07-28T01:00:00Z"));
  });
  it("falls back to the legacy windows, and tolerates garbage", () => {
    expect(usageWindows({ five_hour: { utilization: 2.6, resets_at: "bad" }, seven_day_opus: { utilization: "x" as never } }).map((w) => [w.id, w.percent, w.resetsAt, w.scoped]))
      .toEqual([["five_hour", 2.6, null, false], ["seven_day_opus", null, null, true]]);
    expect(usageWindows(null)).toEqual([]);
  });
});

describe("UsageCache", () => {
  const ok = (percent: number): UsageResult => ({ ok: true, data: { five_hour: { utilization: percent } } });
  it("serves from cache for 30 minutes; refresh is debounced to once per 30 s; one request at a time", async () => {
    let now = 0, calls = 0;
    const cache = new UsageCache(async () => { calls++; return ok(calls * 10); }, () => now);
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(calls).toBe(1);
    expect(a).toMatchObject({ state: "ok", windows: [{ percent: 10 }] });
    expect(b).toEqual(a);
    now += USAGE_REFRESH_MIN_MS - 1;
    expect((await cache.get(true)).windows[0].percent).toBe(10); // debounced
    expect(calls).toBe(1);
    now += 1;
    expect((await cache.get(true)).windows[0].percent).toBe(20);
    now += USAGE_TTL_MS - 1;
    expect((await cache.get()).windows[0].percent).toBe(20);
    now += 1;
    expect((await cache.get()).windows[0].percent).toBe(30);
  });
  it("names each failure, keeps the last good windows as stale, and says empty when there are none", async () => {
    let now = 0;
    const results: UsageResult[] = [ok(40), { ok: false, reason: "network", message: "m" }, { ok: true, data: {} }];
    const cache = new UsageCache(async () => results.shift()!, () => now);
    await cache.get();
    now += USAGE_REFRESH_MIN_MS;
    const failed = await cache.get(true);
    expect(failed).toMatchObject({ state: "network", stale: true, windows: [{ percent: 40 }], updatedAt: 0, fetchedAt: USAGE_REFRESH_MIN_MS });
    now += USAGE_REFRESH_MIN_MS;
    expect(await cache.get(true)).toMatchObject({ state: "empty", windows: [] });
    const fresh = new UsageCache(async () => ({ ok: false, reason: "no_token", message: "no" }), () => 0);
    expect(await fresh.get()).toMatchObject({ state: "no_token", windows: [], updatedAt: null });
  });
});

describe("Plan usage card helpers", () => {
  const w = (o: Partial<WebUsageWindow>): WebUsageWindow => ({ id: "x", label: "Weekly · Opus", group: "weekly", scoped: true, percent: 10, resetsAt: null, active: false, elevated: false, ...o });
  it("warns at 80% or an elevated severity; splits and titles windows", () => {
    expect([isWarn(w({ percent: 79.9 })), isWarn(w({ percent: 80 })), isWarn(w({ percent: 5, elevated: true })), isWarn(w({ percent: null }))]).toEqual([false, true, true, false]);
    const list = [w({ id: "s", group: "session", scoped: false, label: "Session (5h)" }), w({ id: "d", scoped: false, label: "Weekly (all)" }), w({ id: "o" })];
    expect(splitWindows(list).main.map(windowTitle)).toEqual(["5-hour", "7-day"]);
    expect(splitWindows(list).scoped.map(windowTitle)).toEqual(["Opus"]);
  });
  it("formats resets and freshness", () => {
    expect([formatSpan(0), formatSpan(30_000), formatSpan(47 * 60_000), formatSpan(134 * 60_000), formatSpan((4 * 24 + 6) * 3_600_000)]).toEqual(["now", "1m", "47m", "2h 14m", "4d 6h"]);
    expect(resetLabel(w({ resetsAt: 1_000 + 134 * 60_000 }), 1_000)).toBe("Resets in 2h 14m");
    expect(resetLabel(w({ resetsAt: null }), 0)).toBeUndefined();
    expect([updatedLabel(null, 0), updatedLabel(0, 59_000), updatedLabel(0, 5 * 60_000), updatedLabel(0, 3 * 3_600_000)])
      .toEqual(["Not updated yet", "Updated just now", "Updated 5 min ago", "Updated 3 h ago"]);
  });
  it("has a distinct notice per failure", () => {
    const base = { windows: [], fetchedAt: 0, updatedAt: null, nextRefreshAt: 0 };
    const states: WebUsage["state"][] = ["empty", "api_key", "no_token", "credentials_unreadable", "token_expired", "refresh_pending", "unauthorized", "network", "timeout", "http_error", "bad_response", "unavailable"];
    const notices = states.map((state) => usageNotice({ ...base, state }));
    expect(new Set(notices).size).toBe(states.length);
    expect(usageNotice({ ...base, state: "ok" })).toBeUndefined();
  });
});
