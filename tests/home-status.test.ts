import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACT_STALE_MS, HomeStatusReducer, RATE_LIMIT_MS, subagentId, toolKind, TROUBLE_ERROR_MS, TURN_STALE_MS, turnSource } from "../src/home/status-reducer.js";
import { HomeService, STATUS_MIN_INTERVAL_MS } from "../src/home/service.js";
import { WatchBus } from "../src/watch/bus.js";
import { TaskTracker, type TaskSystemMessage } from "../src/agent/task-tracker.js";
import type { WatchEvent, WatchTask } from "../src/watch/protocol.js";
import type { WebEvent } from "../src/web/protocol.js";

const OWNER = "dm:owner";
const GROUP = "telegram:-100123";
const all = { mayShowTask: () => true };
const none = { mayShowTask: () => false };
let ts = 1_000;
const at = <T extends object>(event: T) => ({ ts: ++ts, ...event }) as unknown as WatchEvent;
const task = (taskId: string, extra: Partial<WatchTask> = {}): WatchTask => ({ taskId, taskType: "local_agent", description: `look into ${taskId}`, ambient: false, background: true, startedAt: ts, ...extra });

describe("home status reducer", () => {
  it("is idle at first, since its creation", () => {
    expect(new HomeStatusReducer(500).status(600, all)).toEqual({ working: false, subagents: [], tasks: 0, compacting: false, idleSince: 500, at: 600 });
  });

  it("maps turn sources: the owner, groups, cron, heartbeats", () => {
    expect(turnSource("user", OWNER)).toBe("owner");
    expect(turnSource("user", GROUP)).toBe("group");
    expect(turnSource("user", "imessage:any;+;chat1")).toBe("group");
    expect(turnSource("cron", GROUP)).toBe("cron");
    expect(turnSource("continuity", OWNER)).toBe("heartbeat");
    expect(turnSource("user", "telegram:42")).toBe("other");
  });

  it("several turns: the owner's wins for by, else the latest; idle once all end", () => {
    const r = new HomeStatusReducer(0);
    r.apply(at({ type: "turn.start", sessionKey: GROUP, source: "user" }));
    expect(r.status(ts, all)).toMatchObject({ working: true, by: "group" });
    expect(r.status(ts, all).idleSince).toBeUndefined();
    r.apply(at({ type: "turn.start", sessionKey: OWNER, source: "user", requestId: "a" }));
    r.apply(at({ type: "turn.start", sessionKey: "telegram:-1009", source: "cron" }));
    expect(r.status(ts, all).by).toBe("owner");
    r.apply(at({ type: "turn.end", sessionKey: OWNER, source: "user", ok: true, durationMs: 1, requestId: "a" }));
    expect(r.status(ts, all).by).toBe("cron");
    r.apply(at({ type: "turn.end", sessionKey: "telegram:-1009", source: "cron", ok: true, durationMs: 1 }));
    r.apply(at({ type: "turn.end", sessionKey: GROUP, source: "user", ok: false, durationMs: 1 }));
    expect(r.status(ts + 5, all)).toMatchObject({ working: false, idleSince: ts });
  });

  it("a declined steer (turn.requeue) closes only its own turn", () => {
    const r = new HomeStatusReducer(0);
    r.apply(at({ type: "turn.start", sessionKey: OWNER, source: "user", requestId: "running" }));
    r.apply(at({ type: "turn.start", sessionKey: OWNER, source: "user", requestId: "steer" }));
    r.apply(at({ type: "turn.requeue", sessionKey: OWNER, requestId: "steer" }));
    r.apply(at({ type: "turn.requeue", sessionKey: OWNER, requestId: "unknown" }));
    expect(r.status(ts, all).working).toBe(true);
    r.apply(at({ type: "turn.end", sessionKey: OWNER, source: "user", ok: true, durationMs: 1, requestId: "running" }));
    expect(r.status(ts, all).working).toBe(false);
  });

  it("a turn whose end was lost stops counting after TURN_STALE_MS", () => {
    const r = new HomeStatusReducer(0);
    r.apply(at({ type: "turn.start", sessionKey: OWNER, source: "user" }));
    expect(r.status(ts + TURN_STALE_MS - 1, all).working).toBe(true);
    expect(r.status(ts + TURN_STALE_MS, all).working).toBe(false);
  });

  it("maps tool names to the six kinds, MCP tools included", () => {
    expect(["Bash", "Monitor", "KillShell"].map(toolKind)).toEqual(["shell", "shell", "shell"]);
    expect(["Read", "Write", "Edit", "NotebookEdit"].map(toolKind)).toEqual(["files", "files", "files", "files"]);
    expect(["Grep", "Glob", "ToolSearch", "mcp__tomo-internal__recall_conversation"].map(toolKind)).toEqual(["search", "search", "search", "search"]);
    expect(["WebFetch", "WebSearch", "mcp__playwright__browser_click", "mcp__fetch__fetch"].map(toolKind)).toEqual(["web", "web", "web", "web"]);
    expect(["Agent", "Task", "SendMessage"].map(toolKind)).toEqual(["subagent", "subagent", "subagent"]);
    expect(["mcp__filesystem__read_text_file", "mcp__desktop__run_command", "mcp__notion__notion-search"].map(toolKind)).toEqual(["files", "shell", "search"]);
    expect(["TodoWrite", "Skill", "mcp__tomo-internal__send_message", "mcp__calendar__create_event", "?"].map(toolKind)).toEqual(["other", "other", "other", "other", "other"]);
  });

  it("tool: the newest open call of the leading turn; calls close by name and with their turn", () => {
    const r = new HomeStatusReducer(0);
    r.apply(at({ type: "turn.start", sessionKey: GROUP, source: "user" }));
    r.apply(at({ type: "tool.start", sessionKey: GROUP, tool: "WebFetch" }));
    expect(r.status(ts, all).tool).toBe("web");
    r.apply(at({ type: "turn.start", sessionKey: OWNER, source: "user" }));
    // The owner leads, but has no open call: the newest elsewhere shows.
    expect(r.status(ts, all).tool).toBe("web");
    r.apply(at({ type: "tool.start", sessionKey: OWNER, tool: "Read" }));
    r.apply(at({ type: "tool.start", sessionKey: OWNER, tool: "Bash" }));
    expect(r.status(ts, all).tool).toBe("shell");
    r.apply(at({ type: "tool.end", sessionKey: OWNER, tool: "Bash", ok: true }));
    expect(r.status(ts, all).tool).toBe("files");
    r.apply(at({ type: "tool.end", sessionKey: OWNER, tool: "?", ok: true }));
    expect(r.status(ts, all).tool).toBe("web");
    r.apply(at({ type: "turn.end", sessionKey: GROUP, source: "user", ok: true, durationMs: 1 }));
    expect(r.status(ts, all).tool).toBeUndefined();
  });

  it("subagents and background tasks; ambient and ended ones left out", () => {
    const r = new HomeStatusReducer(0);
    r.apply(at({ type: "tasks", sessionKey: OWNER, tasks: [
      task("t1", { subagentType: "General-Purpose" }), task("t2", { background: false }),
      task("sh", { taskType: "local_bash" }), task("fg", { taskType: "local_bash", background: false }),
      task("watch", { taskType: "monitor", ambient: true }), task("done", { status: "completed" }),
    ] }));
    const status = r.status(ts, all);
    expect(status.subagents.map((s) => s.id)).toEqual([subagentId(OWNER, "t1"), subagentId(OWNER, "t2")]);
    expect(status.subagents[0]).toEqual({ id: subagentId(OWNER, "t1"), type: "general-purpose", task: "look into t1" });
    expect(status.tasks).toBe(1);
    expect(status.subagents[0].id).not.toContain("t1");
    r.apply(at({ type: "tasks", sessionKey: OWNER, tasks: [] }));
    expect(r.status(ts, all)).toMatchObject({ subagents: [], tasks: 0 });
  });

  it("a background subagent keeps a visitor after its turn ends, whichever SDK frame comes first", () => {
    const started = { subtype: "task_started", task_id: "bg", task_type: "local_agent", subagent_type: "general-purpose", description: "rebase the PRs", is_backgrounded: true } as const;
    const level = { subtype: "background_tasks_changed", tasks: [{ task_id: "bg", task_type: "local_agent", subagent_type: "general-purpose", description: "rebase the PRs" }] } as const;
    for (const order of [[started, level], [level, started]] as TaskSystemMessage[][]) {
      const r = new HomeStatusReducer(ts);
      const tracker = new TaskTracker();
      const feed = (change: ReturnType<TaskTracker["apply"]>) => { if (change) r.apply(at({ type: "tasks", sessionKey: OWNER, tasks: change.tasks })); };
      r.apply(at({ type: "turn.start", sessionKey: OWNER, source: "user" }));
      for (const message of order) feed(tracker.apply(message));
      feed(tracker.endTurn());
      r.apply(at({ type: "turn.end", sessionKey: OWNER }));
      const s = r.status(++ts, all);
      expect(s.working).toBe(false);
      expect(s.subagents.length).toBeGreaterThanOrEqual(1);
      expect(s.subagents[0]).toMatchObject({ id: subagentId(OWNER, "bg"), type: "general-purpose" });
      expect(s.tasks).toBe(0);
    }
  });

  it("a subagent's task text only for sessions the browser may read", () => {
    const r = new HomeStatusReducer(0);
    r.apply(at({ type: "tasks", sessionKey: "dm:legacy", tasks: [task("hidden")] }));
    r.apply(at({ type: "tasks", sessionKey: GROUP, tasks: [task("shown")] }));
    const asked: string[] = [];
    const status = r.status(ts, { mayShowTask: (key) => { asked.push(key); return key === GROUP; } });
    expect(status.subagents.find((s) => s.id === subagentId("dm:legacy", "hidden"))).toEqual({ id: subagentId("dm:legacy", "hidden") });
    expect(status.subagents.find((s) => s.id === subagentId(GROUP, "shown"))?.task).toBe("look into shown");
    expect(JSON.stringify(r.status(ts, none))).not.toContain("look into");
    expect(JSON.stringify(r.status(ts, { mayShowTask: () => { throw new Error("registry"); } }))).not.toContain("look into");
    expect(asked.sort()).toEqual(["dm:legacy", GROUP]);
  });

  it("cron.fired sets cronAt; next job and pet come from outside", () => {
    const r = new HomeStatusReducer(0);
    r.apply(at({ type: "cron.fired", jobId: "j", name: "Daily" }));
    r.setNextJobAt(99_999);
    r.setPet("happy");
    expect(r.status(ts, all)).toMatchObject({ cronAt: ts, nextJobAt: 99_999, pet: "happy" });
  });

  it("compacting: the SDK's own, or a shell running tomo lcm compact, until it is over", () => {
    const r = new HomeStatusReducer(0);
    r.apply(at({ type: "turn.start", sessionKey: OWNER, source: "user" }));
    r.apply(at({ type: "sdk", sessionKey: OWNER, signal: { kind: "compacting", active: true } }));
    expect(r.status(ts, all).compacting).toBe(true);
    r.apply(at({ type: "sdk", sessionKey: OWNER, signal: { kind: "compacting", active: false } }));
    expect(r.status(ts, all).compacting).toBe(false);
    r.apply(at({ type: "tool.start", sessionKey: OWNER, tool: "Bash", detail: "tomo lcm compact --session x --to 120" }));
    expect(r.status(ts, all).compacting).toBe(true);
    r.apply(at({ type: "tool.end", sessionKey: OWNER, tool: "Bash", ok: true }));
    expect(r.status(ts, all).compacting).toBe(false);
    r.apply(at({ type: "sdk", sessionKey: OWNER, signal: { kind: "compacting", active: true } }));
    r.apply(at({ type: "compact", sessionKey: OWNER }));
    expect(r.status(ts, all).compacting).toBe(false);
    r.apply(at({ type: "sdk", sessionKey: OWNER, signal: { kind: "compacting", active: true } }));
    expect(r.status(ts + COMPACT_STALE_MS, all).compacting).toBe(false);
  });

  it("trouble: retry until progress or the turn ends, error until the next turn, rate limit until allowed or reset", () => {
    const r = new HomeStatusReducer(0);
    r.apply(at({ type: "turn.start", sessionKey: OWNER, source: "user" }));
    r.apply(at({ type: "sdk", sessionKey: OWNER, signal: { kind: "retry", attempt: 1, maxRetries: 10, delayMs: 500, error: "overloaded" } }));
    expect(r.status(ts, all).trouble).toBe("retry");
    r.apply(at({ type: "tool.start", sessionKey: OWNER, tool: "Read" }));
    expect(r.status(ts, all).trouble).toBeUndefined();
    r.apply(at({ type: "sdk", sessionKey: OWNER, signal: { kind: "retry", attempt: 2, maxRetries: 10, delayMs: 500, error: "overloaded" } }));
    r.apply(at({ type: "turn.end", sessionKey: OWNER, source: "user", ok: false, durationMs: 1 }));
    expect(r.status(ts, all).trouble).toBeUndefined();

    r.apply(at({ type: "sdk", sessionKey: OWNER, signal: { kind: "error", error: "billing_error" } }));
    expect(r.status(ts, all).trouble).toBe("error");
    expect(r.status(ts + TROUBLE_ERROR_MS, all).trouble).toBeUndefined();
    r.apply(at({ type: "sdk", sessionKey: OWNER, signal: { kind: "error", error: "billing_error" } }));
    r.apply(at({ type: "turn.start", sessionKey: OWNER, source: "user" }));
    expect(r.status(ts, all).trouble).toBeUndefined();

    r.apply(at({ type: "sdk", signal: { kind: "rate_limit", status: "rejected", resetsAt: ts + 1000 } }));
    r.apply(at({ type: "sdk", sessionKey: OWNER, signal: { kind: "error", error: "rate_limit" } }));
    expect(r.status(ts, all).trouble).toBe("rate_limit");
    expect(r.status(ts + 1000, all).trouble).toBe("error");
    r.apply(at({ type: "sdk", signal: { kind: "rate_limit", status: "rejected" } }));
    r.apply(at({ type: "sdk", signal: { kind: "rate_limit", status: "allowed" } }));
    r.apply(at({ type: "turn.start", sessionKey: OWNER, source: "user" }));
    expect(r.status(ts, all).trouble).toBeUndefined();
    r.apply(at({ type: "sdk", signal: { kind: "rate_limit", status: "rejected" } }));
    expect(r.status(ts + RATE_LIMIT_MS, all).trouble).toBeUndefined();
  });
});

describe("home service publishing", () => {
  let root: string;
  let service: HomeService | undefined;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tomo-home-service-")); });
  afterEach(() => { service?.stop(); service = undefined; vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

  it("publishes home-status only on a real change, at most every STATUS_MIN_INTERVAL_MS, the last change always", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const bus = new WatchBus();
    const events: WebEvent[] = [];
    service = new HomeService({ workspaceDir: join(root, "ws"), lastGoodPath: join(root, "last.json"), bus, pollMs: 60_000 });
    service.attachWeb({ publish: (e) => events.push(e), available: () => true, mayShowTask: () => true });
    service.start();
    const statuses = () => events.filter((e) => e.type === "home-status");
    bus.publish({ type: "turn.start", sessionKey: OWNER, source: "user" });
    expect(statuses()).toHaveLength(1);
    // Nothing that changes the record: no event.
    bus.publish({ type: "transcript", sessionKey: OWNER, role: "user", channel: "web", text: "hi" });
    bus.publish({ type: "turn.stats", sessionKey: OWNER, costUsd: 0, contextUsed: 1, contextMax: 2 });
    await vi.advanceTimersByTimeAsync(STATUS_MIN_INTERVAL_MS * 2);
    expect(statuses()).toHaveLength(1);
    // A burst: one more right after the interval, carrying the latest state.
    for (const tool of ["Read", "Bash", "WebFetch", "Write"]) bus.publish({ type: "tool.start", sessionKey: OWNER, tool });
    expect(statuses()).toHaveLength(2);
    bus.publish({ type: "tool.start", sessionKey: OWNER, tool: "Grep" });
    expect(statuses()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(STATUS_MIN_INTERVAL_MS);
    expect(statuses()).toHaveLength(3);
    expect((statuses().at(-1) as Extract<WebEvent, { type: "home-status" }>).status.tool).toBe("search");
  });

  it("serves WebHome with the scene, revision and status; publishes home when the scene changes", async () => {
    const { writeFileSync } = await import("node:fs");
    const bus = new WatchBus();
    const events: WebEvent[] = [];
    const ws = join(root, "ws");
    (await import("node:fs")).mkdirSync(ws);
    service = new HomeService({ workspaceDir: ws, lastGoodPath: join(root, "last.json"), bus, debounceMs: 10, pollMs: 50, nextJobAt: () => 123, petMood: () => { throw new Error("pet"); } });
    service.attachWeb({ publish: (e) => events.push(e), available: () => true, mayShowTask: () => true });
    service.start();
    const first = service.web();
    expect(first).toMatchObject({ starter: true, status: { working: false, nextJobAt: 123 } });
    expect(first.status.pet).toBeUndefined();
    writeFileSync(join(ws, "home", "scene.json"), JSON.stringify({ version: 1, room: { size: [4, 3, 4], floor: "#111111", walls: "#222222" }, objects: [] }));
    await vi.waitFor(() => expect(events.some((e) => e.type === "home" && e.revision !== first.revision)).toBe(true), { timeout: 3000 });
    expect(service.web().starter).toBe(false);
  });

  it("presence: a read of /home within PRESENCE_MS means a page is showing; otherwise look answers at once", async () => {
    vi.useFakeTimers({ now: 50_000 });
    const { PRESENCE_MS } = await import("../src/home/service.js");
    const events: WebEvent[] = [];
    service = new HomeService({ workspaceDir: join(root, "ws"), lastGoodPath: join(root, "last.json"), bus: new WatchBus(), pollMs: 60_000 });
    service.attachWeb({ publish: (e) => events.push(e), available: () => true, mayShowTask: () => true });
    expect(await service.look("r", 1000)).toEqual({ status: "no_browser" });
    expect(events.some((e) => e.type === "home-look")).toBe(false);
    service.web();
    await vi.advanceTimersByTimeAsync(PRESENCE_MS - 1);
    const asked = service.look("r", 1000);
    expect(events.some((e) => e.type === "home-look")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await asked).toEqual({ status: "no_browser" });
    await vi.advanceTimersByTimeAsync(PRESENCE_MS);
    events.length = 0;
    expect(await service.look("r", 1000)).toEqual({ status: "no_browser" });
    expect(events).toEqual([]);
  });
});
