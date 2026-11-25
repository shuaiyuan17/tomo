import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchBus } from "../src/watch/bus.js";
import { ActivityLog } from "../src/metrics/activity-log.js";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("ActivityLog", () => {
  let dir: string;
  let path: string;
  let bus: WatchBus;
  let activityLog: ActivityLog | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tomo-activity-"));
    path = join(dir, "activity.ndjson");
    bus = new WatchBus();
  });

  afterEach(() => {
    activityLog?.stop();
    activityLog = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes each bus event as one NDJSON line", () => {
    activityLog = new ActivityLog({ path, bus });
    activityLog.start();

    bus.publish({ type: "turn.start", sessionKey: "dm:me", source: "user" });
    bus.publish({ type: "turn.end", sessionKey: "dm:me", source: "user", ok: true, durationMs: 900 });

    const lines = readLines(path);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: "turn.start", sessionKey: "dm:me", source: "user" });
    expect(lines[1]).toMatchObject({ type: "turn.end", ok: true, durationMs: 900 });
    expect(typeof lines[0].ts).toBe("number");
  });

  it("keeps transcript text by default", () => {
    activityLog = new ActivityLog({ path, bus });
    activityLog.start();

    bus.publish({ type: "transcript", sessionKey: "dm:me", role: "user", channel: "telegram", text: "secret plans" });

    expect(readLines(path)[0]).toMatchObject({ type: "transcript", text: "secret plans" });
  });

  it("replaces transcript text with its length when includeMessageText is false", () => {
    activityLog = new ActivityLog({ path, bus, includeMessageText: false });
    activityLog.start();

    bus.publish({ type: "transcript", sessionKey: "dm:me", role: "user", channel: "telegram", text: "secret plans" });
    bus.publish({ type: "issue", level: "warn", msg: "not a transcript" });

    const lines = readLines(path);
    expect(lines[0]).toMatchObject({ type: "transcript", textChars: 12 });
    expect(lines[0].text).toBeUndefined();
    // Non-transcript events pass through untouched.
    expect(lines[1]).toMatchObject({ type: "issue", msg: "not a transcript" });
  });

  it("replaces task descriptions and summaries with their length when includeMessageText is false", () => {
    activityLog = new ActivityLog({ path, bus, includeMessageText: false });
    activityLog.start();
    bus.publish({ type: "tasks", sessionKey: "dm:me", tasks: [{ taskId: "a", taskType: "local_agent", description: "secret plans",
      summary: "reading diary", ambient: false, background: true, startedAt: 1 }] });
    const line = readLines(path)[0] as { tasks: Array<Record<string, unknown>> };
    expect(line.tasks[0]).toMatchObject({ taskId: "a", descriptionChars: 12, summaryChars: 13 });
    expect(JSON.stringify(line)).not.toContain("secret");
    expect(JSON.stringify(line)).not.toContain("diary");
  });

  it("adds no summaryChars for a task that has no summary yet", () => {
    activityLog = new ActivityLog({ path, bus, includeMessageText: false });
    activityLog.start();
    bus.publish({ type: "tasks", sessionKey: "dm:me", tasks: [{ taskId: "a", taskType: "local_agent", description: "secret plans",
      ambient: false, background: true, startedAt: 1 }] });
    const task = (readLines(path)[0] as { tasks: Array<Record<string, unknown>> }).tasks[0];
    expect(task).toMatchObject({ taskId: "a", descriptionChars: 12 });
    expect(task).not.toHaveProperty("summaryChars");
    expect(task).not.toHaveProperty("summary");
  });

  it("rotates once the live file passes maxBytes and prunes old rotations", () => {
    activityLog = new ActivityLog({ path, bus, maxBytes: 300, maxRotatedFiles: 2 });
    activityLog.start();

    for (let i = 0; i < 12; i++) {
      bus.publish({ type: "issue", level: "warn", msg: `event number ${i} with some padding text` });
    }

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);

    // Oldest events fall off with the pruned rotation; the surviving files
    // hold a contiguous, ordered suffix ending at the newest event.
    const survived = [...readLines(`${path}.2`), ...readLines(`${path}.1`), ...readLines(path)]
      .map((line) => line.msg);
    const first = 12 - survived.length;
    expect(survived).toEqual(
      Array.from({ length: survived.length }, (_, i) => `event number ${first + i} with some padding text`),
    );
  });

  it("resumes size accounting from an existing file", () => {
    activityLog = new ActivityLog({ path, bus, maxBytes: 200, maxRotatedFiles: 1 });
    activityLog.start();
    bus.publish({ type: "issue", level: "warn", msg: "x".repeat(150) });
    activityLog.stop();

    // Second run starts near the cap; the next big write must rotate.
    activityLog = new ActivityLog({ path, bus, maxBytes: 200, maxRotatedFiles: 1 });
    activityLog.start();
    bus.publish({ type: "issue", level: "warn", msg: "y".repeat(150) });

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readLines(`${path}.1`)).toHaveLength(1);
    expect(readLines(path)).toHaveLength(1);
  });

  it("stops writing after stop()", () => {
    activityLog = new ActivityLog({ path, bus });
    activityLog.start();
    bus.publish({ type: "heartbeat" });
    activityLog.stop();
    bus.publish({ type: "heartbeat" });

    expect(readLines(path)).toHaveLength(1);
  });

  it("does not recurse when a rotation failure's own warning re-enters via the bus", async () => {
    // The real logger publishes warn/error back onto the watch bus (the
    // module mock severs that edge) — restore it: this is the feedback loop
    // that makes an unguarded rotation warning re-enter write() forever.
    const { log } = await import("../src/logger.js");
    const warn = log.warn as ReturnType<typeof vi.fn>;
    warn.mockClear();
    warn.mockImplementation(() => {
      bus.publish({ type: "issue", level: "warn", msg: "Activity log rotation failed" });
    });

    try {
      // A directory squatting on the rotation target makes renameSync fail.
      mkdirSync(`${path}.1`);
      activityLog = new ActivityLog({ path, bus, maxBytes: 200, maxRotatedFiles: 1 });
      activityLog.start();

      expect(() => {
        for (let i = 0; i < 10; i++) {
          bus.publish({ type: "issue", level: "warn", msg: "x".repeat(120) });
        }
      }).not.toThrow(); // unguarded, this is a RangeError: max call stack

      // One warning, not thousands — and the feed kept appending.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(readLines(path).length).toBeGreaterThanOrEqual(10);
    } finally {
      warn.mockReset();
    }
  });

  it("warns once per streak of failed writes, and writes again once the path works", async () => {
    // WatchBus.publish already shields the bus from a throwing subscriber, so
    // "does not throw" would prove nothing here. What the log owns is the
    // writeBroken latch: one warning for a streak of failures, reset by the
    // first write that lands.
    const { log } = await import("../src/logger.js");
    const warn = vi.mocked(log.warn);
    warn.mockClear();
    const missingDir = join(dir, "missing-dir");
    const brokenPath = join(missingDir, "activity.ndjson");
    activityLog = new ActivityLog({ path: brokenPath, bus });
    activityLog.start();

    bus.publish({ type: "heartbeat" });
    bus.publish({ type: "heartbeat" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toContain("Activity log write failed");

    mkdirSync(missingDir);
    bus.publish({ type: "issue", level: "warn", msg: "landed" });
    expect(readLines(brokenPath)).toEqual([expect.objectContaining({ msg: "landed" })]);
    expect(warn).toHaveBeenCalledTimes(1);

    // A new failure after a good write is a new fact: it warns again.
    rmSync(missingDir, { recursive: true, force: true });
    bus.publish({ type: "heartbeat" });
    bus.publish({ type: "heartbeat" });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
