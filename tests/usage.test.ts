import { describe, expect, it } from "vitest";
import type { ExecFileException } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUsageReport,
  CLAUDE_REFRESH_ARGS,
  formatCountdown,
  formatReset,
  formatUsageReport,
  keychainErrorMessage,
  runClaudeRefresh,
  type RefreshOutcome,
} from "../src/agent/usage.js";

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

describe("formatUsageReport with the limits array", () => {
  // The real live shape verified against the endpoint.
  const LIMITS = [
    { kind: "session", group: "session", percent: 5, severity: "normal", resets_at: "2026-07-28T03:00:00Z", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 36, severity: "normal", resets_at: "2026-08-02T15:00:00Z", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 43, severity: "normal", resets_at: "2026-08-02T15:00:00Z", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
  ];

  it("renders one line per limit with kind/scope labels, percent, and countdown", () => {
    const report = formatUsageReport({ limits: LIMITS }, NOW, "max_20x");
    const lines = report.split("\n");
    expect(lines[0]).toBe("📊 Claude usage (Max 20x)");
    expect(report).toContain("Session (5h):");
    expect(report).toContain("Weekly (all):");
    // Scoped limit reads its model name from scope, not hardcoded.
    expect(report).toContain("Weekly · Fable:");
    expect(report).toContain("5%");
    expect(report).toContain("36%");
    expect(report).toContain("43%");
    expect(report).toContain("resets in 4h 24m");
    expect(report).toContain("resets in 5d 16h");
  });

  it("marks the active limit and leaves inactive ones unmarked", () => {
    const report = formatUsageReport({ limits: LIMITS }, NOW);
    const fableLine = report.split("\n").find((l) => l.includes("Fable"));
    const sessionLine = report.split("\n").find((l) => l.startsWith("Session"));
    expect(fableLine).toContain("← active");
    expect(sessionLine).not.toContain("← active");
  });

  it("prefixes an elevated-severity limit with a warning and renders unknown kinds generically", () => {
    const report = formatUsageReport({
      limits: [
        { kind: "session", group: "session", percent: 92, severity: "warning", resets_at: "2026-07-28T03:00:00Z", scope: null, is_active: true },
        { kind: "five_hour_scoped", group: "session", percent: 10, resets_at: "2026-07-28T03:00:00Z", scope: { model: { display_name: "Opus" }, surface: "code" }, is_active: false },
      ],
    }, NOW);
    // Elevated severity → ⚠️ prefix on that line.
    const warnLine = report.split("\n").find((l) => l.includes("92%"));
    expect(warnLine?.startsWith("⚠️")).toBe(true);
    // Unknown kind is not dropped — rendered from kind + scope generically.
    expect(report).toContain("Five Hour Scoped · Opus · code:");
    expect(report).toContain("10%");
  });

  it("orders session limits before weekly ones regardless of input order", () => {
    const report = formatUsageReport({
      limits: [
        { kind: "weekly_all", group: "weekly", percent: 36, resets_at: "2026-08-02T15:00:00Z", scope: null, is_active: false },
        { kind: "session", group: "session", percent: 5, resets_at: "2026-07-28T03:00:00Z", scope: null, is_active: false },
      ],
    }, NOW);
    const body = report.split("\n").filter((l) => l.includes("%"));
    expect(body[0]).toContain("Session");
    expect(body[1]).toContain("Weekly");
  });

  it("still appends the extra-usage and gateway-caveat lines under the limits path", () => {
    const report = formatUsageReport({
      limits: LIMITS,
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1.5, currency: "USD" },
    }, NOW, "max", true);
    expect(report).toContain("Extra usage: $1.50 / $5000 this month");
    expect(report).toContain("gateway mode active");
  });

  it("falls back to the legacy five_hour/seven_day windows when limits is empty or absent", () => {
    const legacy = { five_hour: { utilization: 5, resets_at: "2026-07-28T03:00:00Z" }, seven_day: { utilization: 36, resets_at: "2026-08-02T15:00:00Z" } };
    const fromEmpty = formatUsageReport({ ...legacy, limits: [] }, NOW, "max");
    const fromAbsent = formatUsageReport(legacy, NOW, "max");
    for (const report of [fromEmpty, fromAbsent]) {
      expect(report).toContain("Session (5h):  5%");
      expect(report).toContain("Weekly (7d):   36%");
      expect(report).not.toContain("← active");
      expect(report).not.toContain("· resets"); // legacy uses the two-line layout, not the "· resets" limits layout
    }
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

  describe("stale access token with a refresh token", () => {
    const USAGE_BODY = {
      five_hour: { utilization: 2, resets_at: "2026-07-28T02:59:59+00:00" },
      seven_day: { utilization: 36, resets_at: "2026-08-02T14:59:59+00:00" },
    };
    const STALE = { claudeAiOauth: { accessToken: "stale", refreshToken: "rt", expiresAt: NOW - 1000, subscriptionType: "max" } };
    const FRESH = { claudeAiOauth: { accessToken: "fresh", refreshToken: "rt2", expiresAt: NOW + 3_600_000, subscriptionType: "max" } };

    /** Credential store that returns `first`, then `afterRefresh` once refreshCredentials ran. */
    function store(first: unknown, afterRefresh: unknown, outcome: RefreshOutcome = "completed") {
      const state = { refreshes: 0, loads: 0 };
      return {
        state,
        loadCredentials: async () => { state.loads++; return (state.refreshes > 0 ? afterRefresh : first) as typeof CREDS; },
        refreshCredentials: async (): Promise<RefreshOutcome> => { state.refreshes++; return outcome; },
      };
    }
    const PENDING = "refreshes automatically on the next agent turn";

    it("delegates the refresh to Claude Code, re-reads, and reports usage with the fresh token", async () => {
      const s = store(STALE, FRESH);
      const seenAuth: string[] = [];
      const report = await buildUsageReport({
        now: () => NOW,
        loadCredentials: s.loadCredentials,
        refreshCredentials: s.refreshCredentials,
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          seenAuth.push(new Headers(init?.headers).get("Authorization") ?? "");
          return okResponse(USAGE_BODY);
        }) as unknown as typeof fetch,
      });
      expect(s.state.refreshes).toBe(1);
      expect(seenAuth).toEqual(["Bearer fresh"]);
      expect(report).toContain("Session (5h):  2%");
      expect(report).not.toContain("expired");
    });

    it("says the refresh failed (re-login if it persists) when Claude Code ran but the token is still expired", async () => {
      const s = store(STALE, STALE, "completed");
      let fetched = false;
      const report = await buildUsageReport({
        now: () => NOW,
        loadCredentials: s.loadCredentials,
        refreshCredentials: s.refreshCredentials,
        fetchImpl: (async () => { fetched = true; return okResponse(USAGE_BODY); }) as unknown as typeof fetch,
      });
      expect(s.state.refreshes).toBe(1);
      expect(fetched).toBe(false);
      expect(report).toContain("token refresh failed");
      expect(report).toContain("if this persists, re-login");
      expect(report).not.toContain(PENDING);
    });

    it("does not tell the owner to re-login when the refresh timed out", async () => {
      const s = store(STALE, STALE, "timed_out");
      let fetched = false;
      const report = await buildUsageReport({
        now: () => NOW,
        loadCredentials: s.loadCredentials,
        refreshCredentials: s.refreshCredentials,
        fetchImpl: (async () => { fetched = true; return okResponse(USAGE_BODY); }) as unknown as typeof fetch,
      });
      expect(s.state.refreshes).toBe(1);
      expect(fetched).toBe(false);
      expect(report).toContain(PENDING);
      expect(report).not.toMatch(/re-login/i);
    });

    it("degrades to the stale-token message when the refresh or re-read throws", async () => {
      let loads = 0;
      const report = await buildUsageReport({
        now: () => NOW,
        loadCredentials: async () => { if (loads++ > 0) throw new Error("secret detail"); return STALE; },
        refreshCredentials: async () => { throw new Error("spawn failed"); },
      });
      expect(report).toContain(PENDING);
      expect(report).not.toContain("secret detail");
    });

    it("still asks to re-login when the token is expired and there is no refresh token", async () => {
      let refreshes = 0;
      const report = await buildUsageReport({
        now: () => NOW,
        loadCredentials: async () => ({ claudeAiOauth: { accessToken: "t", expiresAt: NOW - 1000 } }),
        refreshCredentials: async (): Promise<RefreshOutcome> => { refreshes++; return "completed"; },
      });
      expect(refreshes).toBe(0);
      expect(report).toContain("access token expired");
      expect(report).toContain("Re-login to Claude Code");
    });

    it("on a 401 with a valid-looking expiry, refreshes and retries once with the new token", async () => {
      const valid = { claudeAiOauth: { ...STALE.claudeAiOauth, expiresAt: NOW + 3_600_000 } };
      const s = store(valid, FRESH);
      const seenAuth: string[] = [];
      const report = await buildUsageReport({
        now: () => NOW,
        loadCredentials: s.loadCredentials,
        refreshCredentials: s.refreshCredentials,
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          const auth = new Headers(init?.headers).get("Authorization") ?? "";
          seenAuth.push(auth);
          return auth === "Bearer fresh" ? okResponse(USAGE_BODY) : new Response("", { status: 401 });
        }) as unknown as typeof fetch,
      });
      expect(s.state.refreshes).toBe(1);
      expect(seenAuth).toEqual(["Bearer stale", "Bearer fresh"]);
      expect(report).toContain("Weekly (7d):   36%");
    });

    it("on a 401 whose token didn't change after a timed-out refresh, doesn't retry and says next turn", async () => {
      const valid = { claudeAiOauth: { ...STALE.claudeAiOauth, expiresAt: NOW + 3_600_000 } };
      const s = store(valid, valid, "timed_out");
      let calls = 0;
      const report = await buildUsageReport({
        now: () => NOW,
        loadCredentials: s.loadCredentials,
        refreshCredentials: s.refreshCredentials,
        fetchImpl: (async () => { calls++; return new Response("", { status: 401 }); }) as unknown as typeof fetch,
      });
      expect(s.state.refreshes).toBe(1);
      expect(calls).toBe(1);
      expect(report).toContain(PENDING);
      expect(report).not.toMatch(/re-login/i);
    });

    it("on a 401 that survives a completed refresh, says so and suggests re-login if it persists", async () => {
      const valid = { claudeAiOauth: { ...STALE.claudeAiOauth, expiresAt: NOW + 3_600_000 } };
      const s = store(valid, valid, "completed");
      const report = await buildUsageReport({
        now: () => NOW,
        loadCredentials: s.loadCredentials,
        refreshCredentials: s.refreshCredentials,
        fetchImpl: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
      });
      expect(report).toContain("rejected the stored access token (401)");
      expect(report).toContain("If this persists, re-login");
      expect(report).not.toContain(PENDING);
    });

    it("refreshes at most once per /usage (expired, then 401 on the fresh token)", async () => {
      const s = store(STALE, FRESH);
      let calls = 0;
      const report = await buildUsageReport({
        now: () => NOW,
        loadCredentials: s.loadCredentials,
        refreshCredentials: s.refreshCredentials,
        fetchImpl: (async () => { calls++; return new Response("", { status: 401 }); }) as unknown as typeof fetch,
      });
      expect(s.state.refreshes).toBe(1);
      expect(calls).toBe(1);
      expect(report).toContain("rejected the stored access token (401)");
    });
  });

  describe("runClaudeRefresh (real launcher, stub executable)", () => {
    /** Write an executable node script into a fresh temp dir. */
    function stub(body: string): { dir: string; bin: string } {
      const dir = mkdtempSync(join(tmpdir(), "tomo-usage-stub-"));
      const bin = join(dir, "claude");
      writeFileSync(bin, `#!${process.execPath}\n${body}\n`);
      chmodSync(bin, 0o755);
      return { dir, bin };
    }
    function alive(pid: number): boolean {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }

    it("runs the binary with the refresh argv and no stdin, and reports completed on exit", async () => {
      const { dir, bin } = stub(`
        const fs = require("node:fs");
        fs.writeFileSync(process.argv[1] + ".args",
          JSON.stringify({ args: process.argv.slice(2), stdinIsPipe: fs.fstatSync(0).isFIFO() }));
      `);
      try {
        const outcome = await runClaudeRefresh(bin, { cwd: dir, timeoutMs: 10_000 });
        expect(outcome).toBe("completed");
        const seen = JSON.parse(readFileSync(`${bin}.args`, "utf-8"));
        expect(seen.args).toEqual([...CLAUDE_REFRESH_ARGS]);
        expect(seen.args).toEqual(["-p", "/usage", "--safe-mode", "--no-session-persistence"]);
        // stdin must not be an open pipe, or `claude -p` would wait on it.
        expect(seen.stdinIsPipe).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports failed_to_start for a missing binary", async () => {
      expect(await runClaudeRefresh(join(tmpdir(), "definitely-not-a-claude-binary-xyz"))).toBe("failed_to_start");
    });

    it("resolves at the deadline even if the child ignores SIGTERM, then SIGKILLs it", async () => {
      const { dir, bin } = stub(`
        require("node:fs").writeFileSync(process.argv[1] + ".pid", String(process.pid));
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      `);
      try {
        const started = Date.now();
        const outcome = await runClaudeRefresh(bin, { cwd: dir, timeoutMs: 500, killGraceMs: 300 });
        const elapsed = Date.now() - started;
        expect(outcome).toBe("timed_out");
        expect(elapsed).toBeLessThan(2_000);
        const pid = Number(readFileSync(`${bin}.pid`, "utf-8"));
        // Still alive right after the deadline (SIGTERM ignored)...
        expect(alive(pid)).toBe(true);
        // ...but SIGKILLed after the grace period.
        const until = Date.now() + 3_000;
        while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
        expect(alive(pid)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 10_000);
  });

  it("returns a FIXED network-error message that never echoes the raw error", async () => {
    // The thrown message must not leak into the surfaced text (a future fetch
    // wrapper could put the bearer token in an error). Assert exact string.
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => CREDS,
      fetchImpl: (async () => { throw new Error("Authorization: Bearer sk-secret-leak"); }) as unknown as typeof fetch,
    });
    expect(report).toBe("Claude usage unavailable: network error.");
    expect(report).not.toContain("sk-secret-leak");
  });

  it("maps a request timeout (AbortSignal.timeout) to a fixed timeout message", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => CREDS,
      fetchImpl: (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as unknown as typeof fetch,
    });
    expect(report).toBe("Claude usage unavailable: usage request timed out.");
  });

  it("maps a timeout during the body read to the timeout message", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => CREDS,
      fetchImpl: (async () => ({
        status: 200,
        ok: true,
        json: async () => { throw new DOMException("aborted", "AbortError"); },
      })) as unknown as typeof fetch,
    });
    expect(report).toBe("Claude usage unavailable: usage request timed out.");
  });

  it("maps a non-200 to an HTTP status message", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => CREDS,
      fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    });
    expect(report).toContain("HTTP 500");
  });

  it("never throws on malformed endpoint data — degrades per field", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => CREDS,
      fetchImpl: (async () => okResponse({
        limits: [
          // Every field the wrong type — must not throw, renders "Usage: n/a".
          { kind: 7, group: 7, percent: "x", severity: 7, resets_at: 7, scope: { model: { display_name: 7 }, surface: 7 }, is_active: "yes" },
          // A valid entry still renders.
          { kind: "session", group: "session", percent: 5, resets_at: "2026-07-28T03:00:00Z", scope: null, is_active: false },
          "not-an-object",
          null,
        ],
      })) as unknown as typeof fetch,
    });
    expect(report).toContain("📊 Claude usage");
    expect(report).toContain("Session (5h):  5%");
    expect(report).toContain("Usage:"); // the all-malformed entry degrades, not dropped
    expect(report).toContain("n/a");
  });

  it("never throws when the JSON body is literally null", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => CREDS,
      fetchImpl: (async () => new Response("null", { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch,
    });
    expect(report).toContain("📊 Claude usage");
  });

  it("degrades to an actionable message when credentials are literally null", async () => {
    let fetched = false;
    const report = await buildUsageReport({
      now: () => NOW,
      // JSON.parse("null") is typeof "object"; accessing .claudeAiOauth would throw.
      loadCredentials: (async () => null) as unknown as () => Promise<Record<string, never>>,
      fetchImpl: (async () => { fetched = true; return okResponse({}); }) as unknown as typeof fetch,
    });
    expect(fetched).toBe(false);
    expect(report).toContain("malformed");
    expect(report).toContain("Re-login to Claude Code");
  });

  it("degrades when credentials parse to a primitive", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: (async () => 42) as unknown as () => Promise<Record<string, never>>,
    });
    expect(report).toContain("malformed");
  });

  it("collapses an arbitrary credential-loader error to a fixed message (no leak)", async () => {
    const report = await buildUsageReport({
      now: () => NOW,
      loadCredentials: async () => { throw new Error("Authorization: Bearer sk-secret-leak"); },
    });
    expect(report).toBe("Claude usage unavailable: could not read Claude Code credentials.");
    expect(report).not.toContain("sk-secret-leak");
  });

  it("aborts a genuinely stalled body read via the shared timeout signal", async () => {
    // Shorten the real deadline so the stalled body aborts fast instead of 10s.
    const original = AbortSignal.timeout;
    (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout =
      (ms: number) => original(Math.min(ms, 30));
    try {
      const report = await buildUsageReport({
        now: () => NOW,
        loadCredentials: async () => CREDS,
        fetchImpl: (async (_url: string, init: RequestInit) => ({
          status: 200,
          ok: true,
          json: () => new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
          }),
        })) as unknown as typeof fetch,
      });
      expect(report).toBe("Claude usage unavailable: usage request timed out.");
    } finally {
      (AbortSignal as unknown as { timeout: typeof original }).timeout = original;
    }
  });
});

describe("keychainErrorMessage", () => {
  const mk = (over: Partial<ExecFileException>): ExecFileException => over as ExecFileException;

  it("maps an execFile timeout (killed=true + signal) to a timeout message", () => {
    expect(keychainErrorMessage(mk({ killed: true, signal: "SIGTERM" }), "")).toContain("timed out");
  });

  it("does NOT treat an external SIGTERM (killed=false) as a timeout", () => {
    // Node only sets killed=true when IT killed the child via the timeout; an
    // externally-terminated child has killed:false and must fall through.
    const msg = keychainErrorMessage(mk({ killed: false, signal: "SIGTERM" }), "");
    expect(msg).not.toContain("timed out");
    expect(msg).toContain("could not read");
  });

  it("maps exit code 44 (item not found) to a login prompt", () => {
    expect(keychainErrorMessage(mk({ code: 44 as unknown as string }), "")).toContain("Log in with Claude Code");
  });

  it("maps a locked/denied Keychain to an unlock message", () => {
    expect(keychainErrorMessage(mk({ code: "1" }), "SecKeychain: interaction is not allowed")).toContain("locked");
  });

  it("falls back to a generic read failure otherwise", () => {
    expect(keychainErrorMessage(mk({ code: "1" }), "unexpected")).toContain("could not read");
  });
});
