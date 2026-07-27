import { describe, expect, it } from "vitest";
import { buildUsageReport, formatCountdown, formatReset, formatUsageReport } from "../src/agent/usage.js";

// A fixed "now" so countdowns and clock times are deterministic.
// 2026-07-27T15:36:00-07:00 == 2026-07-27T22:36:00Z
const NOW = Date.parse("2026-07-27T22:36:00.000Z");

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const CREDS = { claudeAiOauth: { accessToken: "test-token", expiresAt: NOW + 3_600_000, subscriptionType: "max_20x" } };

describe("formatCountdown", () => {
  it("shows days+hours, hours+minutes, minutes, and 'now'", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(-5000)).toBe("now");
    expect(formatCountdown(47 * 60_000)).toBe("47m");
    expect(formatCountdown((5 * 60 + 12) * 60_000)).toBe("5h 12m");
    expect(formatCountdown((5 * 24 * 60 + 23 * 60) * 60_000)).toBe("5d 23h");
  });
});

describe("formatReset", () => {
  it("returns a countdown and a local clock string", () => {
    const { countdown, clock } = formatReset("2026-07-28T02:59:59+00:00", NOW);
    expect(countdown).toBe("4h 23m");
    expect(clock).toMatch(/\d/); // local-zone dependent, just assert it rendered
  });

  it("handles unparseable timestamps", () => {
    expect(formatReset("not-a-date", NOW)).toEqual({ countdown: "unknown", clock: "unknown" });
  });
});

describe("formatUsageReport", () => {
  it("renders session + weekly windows, rounds utilization, omits null per-model rows", () => {
    const report = formatUsageReport({
      five_hour: { utilization: 2.6, resets_at: "2026-07-28T02:59:59+00:00" },
      seven_day: { utilization: 36.0, resets_at: "2026-08-02T14:59:59+00:00" },
      seven_day_opus: null,
      seven_day_sonnet: null,
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 0, currency: "USD" },
    }, NOW, "max_20x");

    expect(report).toContain("📊 Claude usage (Max 20x)");
    expect(report).toContain("Session (5h):  3%"); // 2.6 rounds to 3
    expect(report).toContain("Weekly (7d):   36%");
    expect(report).toContain("resets in 4h 23m");
    expect(report).toContain("resets in 5d 16h");
    expect(report).toContain("Extra usage: $0.00 / $5000 this month");
    expect(report).not.toContain("Opus");
    expect(report).not.toContain("Sonnet");
  });

  it("appends a gateway caveat when gatewayActive is set", () => {
    const report = formatUsageReport({
      five_hour: { utilization: 2, resets_at: "2026-07-28T02:59:59+00:00" },
      seven_day: { utilization: 36, resets_at: "2026-08-02T14:59:59+00:00" },
    }, NOW, "max_20x", true);
    expect(report).toContain("gateway mode active");
    expect(report).toContain("not necessarily what this session bills to");
  });

  it("adds per-model rows when present and omits disabled extra usage", () => {
    const report = formatUsageReport({
      five_hour: { utilization: 0, resets_at: "2026-07-28T02:59:59+00:00" },
      seven_day: { utilization: 10, resets_at: "2026-08-02T14:59:59+00:00" },
      seven_day_opus: { utilization: 42, resets_at: "2026-08-02T14:59:59+00:00" },
      extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 0 },
    }, NOW);

    expect(report).toContain("Opus (7d)");
    expect(report).toContain("42%");
    expect(report).not.toContain("Extra usage");
  });
});

describe("buildUsageReport", () => {
  it("fetches with the OAuth bearer + beta header and formats the result", async () => {
    let seenAuth = "";
    let seenBeta = "";
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => CREDS,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seenAuth = headers.get("Authorization") ?? "";
        seenBeta = headers.get("anthropic-beta") ?? "";
        return okResponse({
          five_hour: { utilization: 2, resets_at: "2026-07-28T02:59:59+00:00" },
          seven_day: { utilization: 36, resets_at: "2026-08-02T14:59:59+00:00" },
          extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 0, currency: "USD" },
        });
      }) as unknown as typeof fetch,
    });

    expect(seenAuth).toBe("Bearer test-token");
    expect(seenBeta).toBe("oauth-2025-04-20");
    expect(report).toContain("Session (5h):  2%");
    expect(report).toContain("Weekly (7d):   36%");
  });

  it("short-circuits to the API-key message and never reads credentials", async () => {
    let loaded = false;
    let fetched = false;
    const report = await buildUsageReport({
      now: () => NOW,
      authMethod: "api-key",
      loadCredentials: async () => { loaded = true; return CREDS; },
      fetchImpl: (async () => { fetched = true; return okResponse({}); }) as unknown as typeof fetch,
    });
    expect(loaded).toBe(false);
    expect(fetched).toBe(false);
    expect(report).toBe(
      "📊 API-key auth — no subscription limits. Usage is billed per-token; see console.anthropic.com/settings/usage",
    );
  });

  it("shows subscription numbers with a gateway caveat under gateway mode", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      authMethod: "subscription",
      gatewayActive: true,
      loadCredentials: async () => CREDS,
      fetchImpl: (async () => okResponse({
        five_hour: { utilization: 2, resets_at: "2026-07-28T02:59:59+00:00" },
        seven_day: { utilization: 36, resets_at: "2026-08-02T14:59:59+00:00" },
      })) as unknown as typeof fetch,
    });
    expect(report).toContain("Session (5h):  2%");
    expect(report).toContain("gateway mode active");
  });

  it("reports a friendly message when no credentials exist", async () => {
    const report = await buildUsageReport({ now: () => NOW, loadCredentials: async () => ({}) });
    expect(report).toContain("no Claude Code credentials");
  });

  it("reports token expiry from the recorded expiresAt without hitting the network", async () => {
    let called = false;
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => ({ claudeAiOauth: { accessToken: "t", expiresAt: NOW - 1000 } }),
      fetchImpl: (async () => { called = true; return okResponse({}); }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(report).toContain("expired");
  });

  it("maps a 401 to a re-login message", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => CREDS,
      fetchImpl: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
    });
    expect(report).toContain("Re-login to Claude Code");
  });

  it("handles a network error without throwing", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => CREDS,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(report).toContain("network error");
  });

  it("maps a non-200 to an HTTP status message", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => CREDS,
      fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    });
    expect(report).toContain("HTTP 500");
  });
});
