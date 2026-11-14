import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { WatchBus } from "../src/watch/bus.js";
import { WebChannel } from "../src/channels/web.js";
import type { WebCronJob, WebEvent } from "../src/web/protocol.js";
import { formatUntil, SCHEDULED_LIMIT, upcomingJobs } from "../web/src/scheduled.js";
import { cronJobHash, focusFromHash, viewFromHash } from "../web/src/study-data.js";

const job = (id: string, nextRunAt: number | null, extra: Partial<WebCronJob> = {}): WebCronJob => ({
  revision: "0".repeat(64), id, name: id, enabled: true, schedule: { kind: "every", everyMs: 60_000 }, scheduleLabel: "every 1m",
  message: "m", sessionKey: "dm:owner", deleteAfterRun: false, createdAt: 0, nextRunAt, lastRunAt: null, lastStatus: null, interruptedAt: null, ...extra });

describe("upcoming jobs", () => {
  it("keeps enabled jobs with a next run, soonest first, at most the limit", () => {
    const jobs = [job("late", 9_000), job("paused", 1_000, { enabled: false }), job("never", null), job("soon", 2_000),
      job("b-tie", 5_000), job("a-tie", 5_000), job("x1", 6_000), job("x2", 7_000), job("x3", 8_000)];
    expect(upcomingJobs(jobs).map((j) => j.id)).toEqual(["soon", "a-tie", "b-tie", "x1", "x2"]);
    expect(upcomingJobs(jobs)).toHaveLength(SCHEDULED_LIMIT);
    expect(upcomingJobs(jobs, 3).map((j) => j.id)).toEqual(["soon", "a-tie", "b-tie"]);
    expect(upcomingJobs([job("paused", 1, { enabled: false })])).toEqual([]);
  });
});

describe("relative time", () => {
  // A fixed local afternoon so day boundaries are unambiguous in any time zone.
  const now = new Date(2026, 10, 14, 14, 0, 0).getTime();
  const at = (days: number, hour: number, minute = 0) => new Date(2026, 10, 14 + days, hour, minute).getTime();
  it.each([
    [now + 20_000, "due now"],
    [now - 5 * 60_000, "overdue"],
    [now + 12 * 60_000, "in 12 min"],
    [now + 59 * 60_000, "in 59 min"],
    [now + 3 * 3_600_000 + 60_000, "in 3 h"],
    [at(0, 21, 30), "Today 9:30 PM"],
    [at(1, 8), "Tomorrow 8:00 AM"],
    [at(3, 8), "Tue 8:00 AM"],
    [at(10, 8), "Nov 24, 8:00 AM"],
  ])("formats %s", (when, expected) => {
    expect(formatUntil(when as number, now, "en-US")).toBe(expected);
  });
});

describe("jumping to a job", () => {
  it("links a row to its job in the Study's Cron tab", () => {
    expect(cronJobHash("abc-123")).toBe("#study/cron/abc-123");
    expect(viewFromHash("#study/cron/abc-123")).toBe("cron");
    expect(focusFromHash("#study/cron/abc-123")).toBe("abc-123");
    expect(focusFromHash("#study/cron")).toBeNull();
    expect(cronJobHash("../evil")).toBe("#study/cron");
    expect(viewFromHash("#study/cron/../evil")).toBeNull();
    expect(focusFromHash("#study/nope/abc")).toBeNull();
  });

  it("renders each job's row with the id the link scrolls to, and says when the linked job is gone", async () => {
    const { CronList, cronRowId } = await import("../web/src/study.js");
    const html = renderToStaticMarkup(createElement(CronList, { jobs: [job("abc-123", 1)], focus: "abc-123" }));
    expect(html).toContain(`id="${cronRowId("abc-123")}"`);
    expect(html).not.toContain("no longer scheduled");
    expect(renderToStaticMarkup(createElement(CronList, { jobs: [job("abc-123", 1)], focus: "gone" }))).toContain("That job is no longer scheduled.");
  });
});

describe("cron change events", () => {
  it("tells the page to re-read /cron when a job fires or finishes, with no payload", () => {
    const bus = new WatchBus();
    const channel = new WebChannel({ name: "owner", telegram: ["1"], imessage: [] }, bus);
    const events: WebEvent[] = [];
    channel.events.subscribe(({ event }) => events.push(event));
    bus.publish({ type: "cron.fired", jobId: "j", name: "Secret job name" });
    bus.publish({ type: "cron.done", jobId: "j", name: "Secret job name", ok: true });
    expect(events).toEqual([{ type: "cron" }, { type: "cron" }]);
    void channel.stop();
  });
});

