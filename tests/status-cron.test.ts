import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// HOME is patched BEFORE the dynamic import below, because the cron store's
// default path is resolved from homedir() at module load. Everything this
// file touches lives under the temp home.
const HOME = join(tmpdir(), "tomo-test-status-cron-home");
const CRON_DIR = join(HOME, ".tomo", "data", "cron");
const JOBS = join(CRON_DIR, "jobs.json");
rmSync(HOME, { recursive: true, force: true });
mkdirSync(CRON_DIR, { recursive: true });
process.env.HOME = HOME;
process.env.TOMO_HOME = join(HOME, ".tomo");

const { gatherStatus, renderStatusReport } = await import("../src/cli/status.js");

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe("tomo status with an unreadable cron store", () => {
  it("reports the store as unreadable instead of dying or claiming zero tasks", async () => {
    writeFileSync(JOBS, "{ this is not json");

    // The whole point: daemon state, config issues and channels are exactly
    // what someone runs `tomo status` for when something is broken, so a
    // corrupt jobs.json must not take the report down with it.
    const report = await gatherStatus();
    expect(report.version).toBeTruthy();
    expect(report.cron.unreadable).toBe(JOBS);
    expect(report.cron.total).toBe(0);

    const out = renderStatusReport(report);
    expect(out).toContain(`Scheduled tasks: store unreadable (${JOBS})`);
    // "none" would be the lie this PR exists to remove.
    expect(out).not.toContain("Scheduled tasks: none");
    expect(out).toContain("Tomo v");
  });

  it("reports jobs normally when the store is readable", async () => {
    writeFileSync(JOBS, JSON.stringify({
      version: 1,
      revision: 1,
      jobs: [{
        id: "abc12345",
        name: "water reminder",
        enabled: true,
        schedule: { kind: "every", everyMs: 3_600_000 },
        message: "drink",
        sessionKey: "dm:alice",
        deleteAfterRun: false,
        createdAt: Date.now() - 1000,
        nextRunAt: Date.now() + 60_000,
        lastRunAt: null,
        lastStatus: null,
      }],
    }));

    const report = await gatherStatus();
    expect(report.cron.unreadable).toBeUndefined();
    expect(report.cron.total).toBe(1);
    expect(report.cron.enabled).toBe(1);
    expect(report.cron.upcoming.map((u) => u.name)).toEqual(["water reminder"]);

    const out = renderStatusReport(report);
    expect(out).toContain("Scheduled tasks (1 — 1 enabled)");
    expect(out).not.toContain("unreadable");
  });

  it("reports no tasks when there is no store at all", async () => {
    rmSync(JOBS, { force: true });
    const report = await gatherStatus();
    expect(report.cron.unreadable).toBeUndefined();
    expect(report.cron.total).toBe(0);
    expect(renderStatusReport(report)).toContain("Scheduled tasks: none");
  });
});
