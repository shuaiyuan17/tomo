import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTasksCommand } from "../src/channels/chat-commands.js";
import { formatTaskList, RECENT_ENDED_LIMIT, startOfLocalDay } from "../src/agent/tasks-command.js";
import { HISTORY_RETENTION_MS, TASK_RETENTION_MS, TaskBoard, type SessionTaskList } from "../src/web/tasks.js";
import type { WatchTask } from "../src/watch/protocol.js";
import type { WebTask } from "../src/web/protocol.js";

afterEach(() => vi.useRealTimers());

describe("parseTasksCommand", () => {
  it("accepts /task and /tasks, any case, with surrounding whitespace", () => {
    expect(parseTasksCommand("/task")).toEqual({ args: "" });
    expect(parseTasksCommand("/tasks")).toEqual({ args: "" });
    expect(parseTasksCommand("/Tasks")).toEqual({ args: "" });
    expect(parseTasksCommand("/TASK")).toEqual({ args: "" });
    expect(parseTasksCommand("  /tasks  \n")).toEqual({ args: "" });
    expect(parseTasksCommand("/tasks all")).toEqual({ args: "all" });
    expect(parseTasksCommand(" /Tasks   ALL ")).toEqual({ args: "ALL" });
  });

  it("accepts /tasks@botname only for this bot", () => {
    expect(parseTasksCommand("/tasks@TomoBot all", "tomobot")).toEqual({ args: "all" });
    expect(parseTasksCommand("/task@tomobot", "tomobot")).toEqual({ args: "" });
    expect(parseTasksCommand("/tasks@otherbot", "tomobot")).toBeUndefined();
    expect(parseTasksCommand("/tasks@tomobot")).toBeUndefined();
  });

  it("rejects anything else", () => {
    for (const text of ["tasks", "/taskss", "/tasking", "/status", "please /tasks", "/", "/tasks-all", ""]) {
      expect(parseTasksCommand(text), text).toBeUndefined();
    }
  });
});

const NOW = Date.UTC(2026, 10, 15, 17, 0, 0);
const MIN = 60_000;
const web = (taskId: string, extra: Partial<WebTask> = {}): WebTask => ({
  sessionId: "dm:shuai", taskId, taskType: "local_agent", description: `task ${taskId}`, ambient: false,
  startedAt: NOW - 10 * MIN, state: "running", ...extra });

describe("formatTaskList", () => {
  const fmt = (list: SessionTaskList, all = false) => formatTaskList(list, { now: NOW, all, timeZone: "UTC" });

  it("says so when there is nothing", () => {
    expect(fmt({ running: [], ended: [] })).toBe("No tasks running.");
  });

  it("lists running tasks, then ended ones, as plain text", () => {
    const text = fmt({
      running: [
        { ...web("a", { description: "bloom Android PR-10 settings and import screens, plus tests" }), lastActiveAt: NOW - 2 * MIN },
        web("b", { taskType: "local_bash", description: "codex review #549", startedAt: NOW - 3 * MIN }),
      ],
      ended: [
        web("c", { description: "Cost page", state: "completed", startedAt: NOW - 50 * MIN, endedAt: NOW - 19 * MIN }),
        web("d", { taskType: "monitor", description: "watch CI", state: "failed", startedAt: NOW - 90 * MIN, endedAt: NOW - 30 * MIN }),
      ],
    });
    expect(text).toBe([
      "Tasks · 2 running, 1 done, 1 failed today",
      "▶ bloom Android PR-10 settings and import… · agent · 10m · last 16:58",
      "▶ codex review #549 · bash · 3m",
      "✓ Cost page · agent · 31m · 16:41",
      "✗ watch CI · monitor · 1h 00m · 16:30",
    ].join("\n"));
    expect(text).not.toMatch(/[*_`#]{2}|^\s*[-*] /m);
  });

  it("lists the last few ended tasks by default and all of them with `all`", () => {
    const ended = Array.from({ length: RECENT_ENDED_LIMIT + 3 }, (_, i) =>
      web(`e${i}`, { state: "completed", endedAt: NOW - (i + 1) * MIN }));
    const short = fmt({ running: [], ended }).split("\n");
    expect(short[0]).toBe(`Tasks · 0 running, ${ended.length} done today`);
    expect(short.filter((line) => line.startsWith("✓"))).toHaveLength(RECENT_ENDED_LIMIT);
    expect(short.at(-1)).toBe("… 3 more today (/tasks all)");
    const full = fmt({ running: [], ended }, true).split("\n");
    expect(full.filter((line) => line.startsWith("✓"))).toHaveLength(ended.length);
    expect(full.at(-1)).not.toContain("more today");
  });

  it("collapses whitespace in descriptions", () => {
    expect(fmt({ running: [web("a", { description: "line one\n  line two" })], ended: [] })).toContain("▶ line one line two · agent");
  });
});

const watch = (taskId: string, extra: Partial<WatchTask> = {}): WatchTask => ({
  taskId, taskType: "local_agent", description: `task ${taskId}`, ambient: false, background: true, startedAt: 0, ...extra });

describe("TaskBoard.listFor", () => {
  it("returns only the slot asked for", () => {
    vi.useFakeTimers({ now: NOW });
    const b = new TaskBoard(() => {});
    b.apply("dm:shuai", [watch("private", { description: "owner secret" })]);
    b.apply("telegram:-100777", [watch("g1")]);
    b.apply("telegram:-100888", [watch("g2")]);
    const group = b.listFor("telegram:-100777", 0);
    expect(group.running.map((t) => t.taskId)).toEqual(["g1"]);
    expect(JSON.stringify(group)).not.toContain("owner secret");
    expect(b.listFor("dm:shuai", 0).running.map((t) => t.taskId)).toEqual(["private"]);
    expect(b.listFor("telegram:-1", 0)).toEqual({ running: [], ended: [] });
    b.dispose();
  });

  it("keeps ended tasks past the panel's retention window, with their end status", () => {
    vi.useFakeTimers({ now: NOW });
    const b = new TaskBoard(() => {});
    b.apply("s", [watch("a", { startedAt: NOW }), watch("b", { startedAt: NOW })]);
    vi.advanceTimersByTime(MIN);
    b.apply("s", [watch("b", { startedAt: NOW })], [{ taskId: "a", status: "failed" }]);
    vi.advanceTimersByTime(TASK_RETENTION_MS * 5);
    expect(b.snapshot().map((t) => t.taskId)).toEqual(["b"]);
    const list = b.listFor("s", 0);
    expect(list.running.map((t) => t.taskId)).toEqual(["b"]);
    expect(list.ended).toMatchObject([{ taskId: "a", state: "failed", endedAt: NOW + MIN }]);
    // `since` filters; history past its retention goes.
    expect(b.listFor("s", NOW + 2 * MIN).ended).toEqual([]);
    vi.advanceTimersByTime(HISTORY_RETENTION_MS);
    b.apply("s", []);
    expect(b.listFor("s", 0).ended.map((t) => t.taskId)).toEqual(["b"]);
    b.dispose();
  });

  it("leaves out ambient tasks and lists a resumed task once, as running", () => {
    vi.useFakeTimers({ now: NOW });
    const b = new TaskBoard(() => {});
    b.apply("s", [watch("a"), watch("w", { ambient: true })]);
    b.apply("s", []);
    b.apply("s", [watch("a")]);
    const list = b.listFor("s", 0);
    expect(list.running.map((t) => t.taskId)).toEqual(["a"]);
    expect(list.ended.map((t) => t.taskId)).toEqual([]);
    b.dispose();
  });

  it("records when a running task last made progress", () => {
    vi.useFakeTimers({ now: NOW });
    const b = new TaskBoard(() => {});
    b.apply("s", [watch("a")]);
    expect(b.listFor("s", 0).running[0].lastActiveAt).toBeUndefined();
    vi.advanceTimersByTime(MIN);
    b.apply("s", [watch("a", { lastTool: "Bash", toolUses: 1 })]);
    expect(b.listFor("s", 0).running[0].lastActiveAt).toBe(NOW + MIN);
    b.dispose();
  });
});

describe("startOfLocalDay", () => {
  it("is local midnight of the same day", () => {
    const start = new Date(startOfLocalDay(NOW));
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
    expect(NOW - start.getTime()).toBeLessThan(24 * 60 * MIN);
    expect(NOW - start.getTime()).toBeGreaterThanOrEqual(0);
  });
});
