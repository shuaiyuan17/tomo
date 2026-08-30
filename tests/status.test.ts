import { describe, it, expect } from "vitest";
import { renderStatusReport, type StatusReport } from "../src/cli/status.js";

const NOW = 1_000_000_000_000;

function baseReport(): StatusReport {
  return {
    version: "1.2.3",
    daemon: { pid: 4321, uptimeMs: 2.5 * 3_600_000, autostart: false },
    configIssues: [],
    channels: [
      { name: "telegram", configured: true },
      { name: "imessage", configured: false },
    ],
    sessions: [
      { key: "dm:alice", contextPct: 34, queries: 120, costUsd: 1.2345 },
      { key: "telegram:-100123", contextPct: 12, queries: 8, costUsd: 0.021 },
    ],
    cron: {
      total: 3,
      enabled: 2,
      failing: 1,
      upcoming: [
        { name: "water reminder", nextRunAt: NOW + 45 * 60_000 },
        { name: "morning briefing", nextRunAt: NOW + 16 * 3_600_000 },
      ],
    },
  };
}

describe("renderStatusReport", () => {
  it("renders an unreadable cron store as unreadable, never as none", () => {
    const r = baseReport();
    r.cron = { unreadable: "/home/x/.tomo/data/cron/jobs.json", total: 0, enabled: 0, failing: 0, upcoming: [] };
    const out = renderStatusReport(r, NOW);
    expect(out).toContain("Scheduled tasks: store unreadable (/home/x/.tomo/data/cron/jobs.json)");
    expect(out).not.toContain("Scheduled tasks: none");
    // The rest of the report still renders — that is the point of degrading.
    expect(out).toContain("Tomo v1.2.3 — running");
    expect(out).toContain("Sessions (2 active):");
  });


  it("renders a running daemon with uptime", () => {
    const out = renderStatusReport(baseReport(), NOW);
    expect(out).toContain("Tomo v1.2.3 — running (PID 4321, up 2h 30m)");
    expect(out).not.toContain("[autostart]");
    expect(out).not.toContain("Config:");
  });

  it("renders not-running with autostart note", () => {
    const r = baseReport();
    r.daemon = { pid: null, uptimeMs: null, autostart: true };
    const out = renderStatusReport(r, NOW);
    expect(out).toContain("Tomo v1.2.3 — not running — autostart is enabled");
  });

  it("lists config issues when present", () => {
    const r = baseReport();
    r.configIssues = ["lcm.nudgeAtPct: expected a number (got \"abc\"; using 70)"];
    const out = renderStatusReport(r, NOW);
    expect(out).toContain("Config: 1 issue (daemon will refuse to start)");
    expect(out).toContain("✗ lcm.nudgeAtPct");
  });

  it("renders channels, sessions, and upcoming cron runs", () => {
    const out = renderStatusReport(baseReport(), NOW);
    expect(out).toMatch(/telegram\s+configured/);
    expect(out).toMatch(/imessage\s+not configured/);
    expect(out).toContain("Sessions (2 active):");
    expect(out).toMatch(/dm:alice\s+ctx\s+34% · 120 queries · \$1\.2345/);
    expect(out).toContain("Scheduled tasks (3 — 2 enabled, 1 failing):");
    expect(out).toMatch(/water reminder\s+in 45m/);
    expect(out).toMatch(/morning briefing\s+in 16h/);
  });

  it("truncates long session lists", () => {
    const r = baseReport();
    r.sessions = Array.from({ length: 7 }, (_, i) => ({
      key: `dm:user${i}`,
      contextPct: 10,
      queries: 1,
      costUsd: 0,
    }));
    const out = renderStatusReport(r, NOW);
    expect(out).toContain("Sessions (7 active):");
    expect(out).toContain("…and 2 more");
    expect(out).not.toContain("dm:user6");
  });

  it("handles the empty state", () => {
    const r = baseReport();
    r.sessions = [];
    r.cron = { total: 0, enabled: 0, failing: 0, upcoming: [] };
    const out = renderStatusReport(r, NOW);
    expect(out).toContain("Sessions: none");
    expect(out).toContain("Scheduled tasks: none");
  });

  it("notes when enabled jobs have no upcoming runs", () => {
    const r = baseReport();
    r.cron = { total: 1, enabled: 0, failing: 1, upcoming: [] };
    const out = renderStatusReport(r, NOW);
    expect(out).toContain("no upcoming runs");
  });
});
