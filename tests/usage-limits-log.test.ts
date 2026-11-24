import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../src/logger.js", () => ({ log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { fetchUsage } from "../src/agent/usage.js";
import { sdkSignalOf } from "../src/agent/sdk-signals.js";
import { LIMITS_REPEAT_MS, LimitsLog, readSessionWindowPercent, type LimitSample } from "../src/usage/limits-log.js";
import { usageDataDir } from "../src/usage/dir.js";

const NOW = Date.parse("2026-11-15T20:00:00.000Z");
const OAUTH = {
  limits: [
    { kind: "session", group: "session", percent: 36, severity: "normal", resets_at: "2026-11-15T22:00:00Z", is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 81, severity: "warning", resets_at: "2026-11-18T07:00:00Z",
      scope: { model: { id: "claude-opus", display_name: "Opus" } } },
  ],
};
const RATE = { kind: "rate_limit" as const, status: "allowed_warning" as const, limit: "five_hour", resetsAt: Date.parse("2026-11-15T22:00:00Z"), utilization: 90 };

let home: string;
let clock: number;
const lines = (log: LimitsLog): LimitSample[] => existsSync(log.path)
  ? readFileSync(log.path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as LimitSample) : [];

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "tomo-limits-")); clock = NOW; warn.mockClear(); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("LimitsLog", () => {
  it("writes an oauth-usage line under data/usage/limits.ndjson", async () => {
    const log = new LimitsLog(home, () => clock);
    expect(log.path).toBe(join(usageDataDir(home), "limits.ndjson"));
    expect(usageDataDir(home)).toBe(join(home, "data", "usage"));
    await log.recordOAuthUsage(OAUTH);
    const [line, ...rest] = lines(log);
    expect(rest).toEqual([]);
    expect(line).toEqual({ v: 1, ts: "2026-11-15T20:00:00.000Z", source: "oauth-usage", windows: [
      { window: "session", label: expect.any(String), group: "session", scoped: false, percent: 36, resetsAt: "2026-11-15T22:00:00.000Z", status: "normal", active: true },
      { window: "weekly_scoped:Opus", label: expect.any(String), group: "weekly", scoped: true, percent: 81, resetsAt: "2026-11-18T07:00:00.000Z", status: "elevated", active: false },
    ] });
  });

  it("writes legacy-window oauth bodies too, and skips an empty one", async () => {
    const log = new LimitsLog(home, () => clock);
    await log.recordOAuthUsage({});
    expect(lines(log)).toEqual([]);
    await log.recordOAuthUsage({ five_hour: { utilization: 12, resets_at: null } });
    expect(lines(log)[0].windows).toEqual([{ window: "five_hour", label: "Session (5h)", group: "session", scoped: false, percent: 12, status: "normal", active: false }]);
  });

  it("writes a rate-limit-event line and ignores other signals", async () => {
    const log = new LimitsLog(home, () => clock);
    await log.recordSignal({ kind: "compacting", active: true });
    await log.recordSignal({ ...RATE, overage: true });
    expect(lines(log)).toEqual([{ v: 1, ts: "2026-11-15T20:00:00.000Z", source: "rate-limit-event",
      windows: [{ window: "five_hour", percent: 90, resetsAt: "2026-11-15T22:00:00.000Z", status: "allowed_warning", overage: true }] }]);
  });

  it("keeps the SDK's own precision: 0.901 and 0.904 are two samples", async () => {
    const log = new LimitsLog(home, () => clock);
    const event = (utilization: number) => sdkSignalOf({ type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1_763_244_000, utilization } })!;
    await log.recordSignal(event(0.901));
    await log.recordSignal(event(0.904));
    await log.recordSignal(event(0.904));
    expect(lines(log).map((l) => [l.windows[0].percent, l.windows[0].utilization])).toEqual([[90.1, 0.901], [90.4, 0.904]]);
  });

  it("dedups an unchanged sample for 10 minutes, per stream", async () => {
    const log = new LimitsLog(home, () => clock);
    await log.recordOAuthUsage(OAUTH);
    await log.recordSignal(RATE);
    clock += 60_000;
    await log.recordOAuthUsage(OAUTH);
    await log.recordSignal(RATE);
    expect(lines(log)).toHaveLength(2);
    // Another rate-limit type is its own stream.
    await log.recordSignal({ ...RATE, limit: "seven_day" });
    expect(lines(log)).toHaveLength(3);
    // A changed value is written at once.
    await log.recordSignal({ ...RATE, utilization: 91 });
    expect(lines(log)).toHaveLength(4);
    // Unchanged again: written once the 10 minutes since the last line are up.
    clock = NOW + LIMITS_REPEAT_MS - 1;
    await log.recordOAuthUsage(OAUTH);
    expect(lines(log)).toHaveLength(4);
    clock = NOW + LIMITS_REPEAT_MS;
    await log.recordOAuthUsage(OAUTH);
    expect(lines(log).map((l) => l.source)).toEqual(["oauth-usage", "rate-limit-event", "rate-limit-event", "rate-limit-event", "oauth-usage"]);
  });

  it("a failed write warns, never throws, and is not deduplicated against", async () => {
    writeFileSync(join(home, "data"), "a file where the directory should be");
    const log = new LimitsLog(home, () => clock);
    await expect(log.recordOAuthUsage(OAUTH)).resolves.toBeUndefined();
    await expect(log.recordSignal(RATE)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][1]).toBe("Could not record a usage-limit sample");
    rmSync(join(home, "data"));
    await log.recordOAuthUsage(OAUTH);
    expect(lines(log)).toHaveLength(1);
  });
});

describe("fetchUsage onData", () => {
  const CREDS = { claudeAiOauth: { accessToken: "t", expiresAt: NOW + 3_600_000 } };
  const ok = async () => new Response(JSON.stringify(OAUTH), { status: 200 });
  it("sees the parsed body of a good read, and only a good read", async () => {
    const seen: unknown[] = [];
    await fetchUsage({ now: () => NOW, loadCredentials: async () => CREDS, fetchImpl: ok as never, onData: (d) => seen.push(d) });
    await fetchUsage({ now: () => NOW, loadCredentials: async () => CREDS, fetchImpl: (async () => new Response("{}", { status: 500 })) as never, onData: (d) => seen.push(d) });
    expect(seen).toEqual([OAUTH]);
  });
  it("a throwing observer does not break the read", async () => {
    const result = await fetchUsage({ now: () => NOW, loadCredentials: async () => CREDS, fetchImpl: ok as never, onData: () => { throw new Error("boom"); } });
    expect(result).toMatchObject({ ok: true, data: OAUTH });
  });
});

describe("readSessionWindowPercent (the sub-session quota gate's reading)", () => {
  it("reads the newest 5-hour reading, from either source", async () => {
    const log = new LimitsLog(home, () => clock);
    expect(readSessionWindowPercent(log.path, NOW)).toBeUndefined();
    await log.recordOAuthUsage(OAUTH);
    expect(readSessionWindowPercent(log.path, NOW)).toBe(36);
    clock += 60_000;
    await log.recordSignal(RATE);
    expect(readSessionWindowPercent(log.path, clock)).toBe(90);
    // A rate-limit line for another window does not speak for the 5-hour one.
    clock += 60_000;
    await log.recordSignal({ ...RATE, limit: "seven_day", utilization: 10 });
    expect(readSessionWindowPercent(log.path, clock)).toBe(90);
  });

  it("reads 0 once the window has reset, or when the newest usage read has no 5-hour window", async () => {
    const log = new LimitsLog(home, () => clock);
    await log.recordSignal(RATE);
    expect(readSessionWindowPercent(log.path, Date.parse("2026-11-15T22:00:01Z"))).toBe(0);
    expect(readSessionWindowPercent(log.path, NOW + 5 * 3_600_000)).toBe(0);
    clock += 60_000;
    await log.recordOAuthUsage({ limits: [OAUTH.limits[1]] });
    expect(readSessionWindowPercent(log.path, clock)).toBe(0);
  });

  it("throws when the file exists but cannot be read", () => {
    const dir = join(home, "data", "usage", "limits.ndjson");
    // A directory where the file should be: open() fails with EISDIR, not ENOENT.
    mkdirSync(dir, { recursive: true });
    expect(() => readSessionWindowPercent(dir, NOW)).toThrow();
  });
});
