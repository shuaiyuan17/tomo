import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatInterruptedAgentsNotice, RunningAgentsLedger } from "../src/agent/running-agents-ledger.js";
import { WatchBus } from "../src/watch/bus.js";
import type { WatchTask } from "../src/watch/protocol.js";

let dir: string;
let path: string;
let clock = 1_000_000;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ledger-")); path = join(dir, "data", "running-agents.json"); clock = 1_000_000; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (warn = vi.fn()) => new RunningAgentsLedger({ path, now: () => clock, warn });
const agent = (id: string, extra: Partial<WatchTask> = {}): WatchTask => ({
  taskId: id, taskType: "local_agent", subagentType: "general-purpose", description: `do ${id}`,
  ambient: false, background: true, startedAt: 1_000_000, ...extra,
});
const onDisk = () => JSON.parse(readFileSync(path, "utf8")) as { running: { taskId: string }[]; interrupted: { taskId: string }[] };

describe("running-agents ledger", () => {
  it("writes on every start and end, so a crash (no shutdown code) is covered", () => {
    const ledger = open();
    ledger.observe("dm:owner", [agent("a1")]);
    expect(onDisk().running.map((r) => r.taskId)).toEqual(["a1"]);
    ledger.observe("dm:owner", [agent("a1"), agent("a2")]);
    expect(onDisk().running.map((r) => r.taskId)).toEqual(["a1", "a2"]);
    // a1 finished normally: gone from disk at once.
    ledger.observe("dm:owner", [agent("a2")]);
    expect(onDisk().running.map((r) => r.taskId)).toEqual(["a2"]);
    // No shutdown, no freeze: the next process finds a2.
    const next = open();
    expect([...next.pendingBySession().get("dm:owner")!].map((r) => r.taskId)).toEqual(["a2"]);
    expect(onDisk()).toMatchObject({ running: [], interrupted: [{ taskId: "a2" }] });
  });

  it("drops stopped, completed-in-level, ambient and nested tasks", () => {
    const ledger = open();
    ledger.observe("dm:owner", [agent("s", { status: "stopped" }), agent("c", { status: "completed" }),
      agent("w", { ambient: true }), agent("n", { parentTaskId: "x" }), agent("m", { taskType: "monitor" })]);
    expect(existsSync(path) ? onDisk().running : []).toEqual([]);
  });

  it("freeze keeps what was running when shutdown closes the sessions", () => {
    const ledger = open();
    ledger.observe("dm:owner", [agent("a1")]);
    ledger.freeze();
    ledger.observe("dm:owner", []);
    expect(open().pendingBySession().get("dm:owner")?.map((r) => r.taskId)).toEqual(["a1"]);
  });

  it("acknowledging forgets the notice, so it is given once", () => {
    open().observe("dm:owner", [agent("a1")]);
    const second = open();
    second.acknowledge("dm:owner");
    expect(open().pendingBySession().size).toBe(0);
  });

  it("re-registers an agent resumed by SendMessage (a new task_started after it ended)", () => {
    const ledger = open();
    ledger.observe("dm:owner", [agent("a1", { runId: "r1" })]);
    ledger.observe("dm:owner", []);
    clock += 60_000;
    ledger.observe("dm:owner", [agent("a1", { runId: "r2", startedAt: clock })]);
    expect(onDisk().running).toMatchObject([{ taskId: "a1", startedAt: clock }]);
  });

  it("keeps sessions apart and records background commands as such", () => {
    const ledger = open();
    ledger.observe("telegram:-100", [agent("g1")]);
    ledger.observe("dm:owner", [agent("b1", { taskType: "local_bash", subagentType: undefined, description: "npm test" })]);
    const pending = open().pendingBySession();
    expect(pending.get("telegram:-100")?.map((r) => r.taskId)).toEqual(["g1"]);
    expect(pending.get("dm:owner")).toMatchObject([{ taskId: "b1", kind: "command" }]);
  });

  it("subscribes to the watch bus tasks events", () => {
    const bus = new WatchBus();
    const ledger = open();
    const off = ledger.attach(bus);
    bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [agent("a1")] });
    off();
    expect(onDisk().running.map((r) => r.taskId)).toEqual(["a1"]);
  });

  it("throttles progress-only writes", () => {
    const ledger = open();
    ledger.observe("dm:owner", [agent("a1")]);
    const before = readFileSync(path, "utf8");
    clock += 1_000;
    ledger.observe("dm:owner", [agent("a1", { lastTool: "Read" })]);
    expect(readFileSync(path, "utf8")).toBe(before);
    clock += 30_000;
    ledger.observe("dm:owner", [agent("a1", { lastTool: "Grep" })]);
    expect(JSON.parse(readFileSync(path, "utf8")).running[0].lastActivityAt).toBe(clock);
  });

  it("a corrupt or unreadable file does not throw; it warns and starts empty", () => {
    open().observe("dm:owner", [agent("a1")]);
    writeFileSync(path, "{not json");
    const warn = vi.fn();
    const ledger = open(warn);
    expect(ledger.pendingBySession().size).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    ledger.observe("dm:owner", [agent("a2")]);
    expect(onDisk().running.map((r) => r.taskId)).toEqual(["a2"]);
    // Well-formed JSON of the wrong shape: skipped, not fatal.
    rmSync(path); const w2 = vi.fn();
    writeFileSync(path, JSON.stringify({ version: 1, running: [{ bogus: true }], interrupted: "x" }));
    expect(open(w2).pendingBySession().size).toBe(0);
  });

  it("formats the notice with id, type, runtime, and what cannot be resumed", () => {
    const body = formatInterruptedAgentsNotice([
      { sessionKey: "k", taskId: "a1", kind: "agent", taskType: "local_agent", subagentType: "general-purpose", description: "fix bug", startedAt: 0, lastActivityAt: 12 * 60_000 },
      { sessionKey: "k", taskId: "e1", kind: "agent", taskType: "local_agent", subagentType: "Explore", description: "look", startedAt: 0, lastActivityAt: 0 },
      { sessionKey: "k", taskId: "b1", kind: "command", taskType: "local_bash", description: "npm test", startedAt: 0, lastActivityAt: 0 },
    ], "UTC");
    expect(body).toContain('- a1 "fix bug" (general-purpose, ran 12m, last activity 01/01 00:12 UTC)');
    expect(body).toMatch(/e1 "look" \(Explore.*cannot be resumed/);
    expect(body).toMatch(/b1 "npm test" \(background command.*rerun/);
    expect(body).toContain("SendMessage to its id");
  });
});
