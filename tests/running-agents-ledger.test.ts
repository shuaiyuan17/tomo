import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatInterruptedAgentsNotice, MAX_AUTO_RESUMES, resumeGateHooks, RunningAgentsLedger, type RunningTaskRecord } from "../src/agent/running-agents-ledger.js";
import { buildHooksOption } from "../src/agent/sdk-options.js";
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

  describe("auto-resume", () => {
    const openOn = (warn = vi.fn()) => new RunningAgentsLedger({ path, now: () => clock, warn, autoResume: true });
    /** The agent was running when the daemon died: the next process gates it. */
    const crashWith = (...ids: string[]) => { openOn().observe("dm:owner", ids.map((id) => agent(id))); return openOn(); };
    const recs: RunningTaskRecord[] = [
      { sessionKey: "k", taskId: "a1", kind: "agent", taskType: "local_agent", subagentType: "general-purpose", description: "fix bug", startedAt: 0, lastActivityAt: 0 },
      { sessionKey: "k", taskId: "a2", kind: "agent", taskType: "local_agent", subagentType: "general-purpose", description: "loops", startedAt: 0, lastActivityAt: 0 },
      { sessionKey: "k", taskId: "e1", kind: "agent", taskType: "local_agent", subagentType: "Explore", description: "look", startedAt: 0, lastActivityAt: 0 },
      { sessionKey: "k", taskId: "u1", kind: "agent", taskType: "local_agent", description: "untyped", startedAt: 0, lastActivityAt: 0 },
      { sessionKey: "k", taskId: "b1", kind: "command", taskType: "local_bash", description: "npm test", startedAt: 0, lastActivityAt: 0 },
    ];

    it("off: the notice reads exactly as on main", () => {
      const body = formatInterruptedAgentsNotice(recs, "UTC");
      expect(body.split("\n").at(-1)).toBe(
        "Nothing has been resumed. To continue a resumable subagent, SendMessage to its id (names do not survive a restart; use the id) and it picks up from its saved transcript. "
        + "Explore/Plan subagents and background commands cannot be resumed; rerun them if still needed. "
        + "Decide for each whether it is still worth continuing.");
      expect(body).toContain('- u1 "untyped" (subagent, ran 0m, last activity 01/01 00:00 UTC)\n');
      expect(body).not.toMatch(/FAILED|right away|type unknown/);
    });

    it("on: the stored note marks failed and untyped ones and instructs nothing (the check turn does)", () => {
      const body = formatInterruptedAgentsNotice(recs, "UTC", { failed: new Set(["a2"]) });
      expect(body).toContain('- a1 "fix bug" (general-purpose, ran 0m, last activity 01/01 00:00 UTC)\n');
      expect(body).toContain(`- a2 "loops" (general-purpose, ran 0m, last activity 01/01 00:00 UTC) — FAILED: cut off again after ${MAX_AUTO_RESUMES} resumes; do not resume it`);
      expect(body).toMatch(/e1 "look" \(Explore[^\n]* — cannot be resumed\n/);
      expect(body).toContain("u1 \"untyped\" (subagent, ran 0m, last activity 01/01 00:00 UTC) — type unknown (could be Explore/Plan); do not resume it automatically");
      expect(body).toContain("The startup check says which to resume");
      expect(body).toContain("Resume none that has already been resumed or has finished since");
      expect(body).not.toMatch(/right away|Nothing has been resumed/);
    });

    it(`the gate allows ${MAX_AUTO_RESUMES} resumes of an interrupted agent, counted on disk, then denies`, () => {
      let ledger = crashWith("a1");
      for (let i = 1; i <= MAX_AUTO_RESUMES; i++) {
        expect(ledger.gateResume("dm:owner", "a1")).toBeNull();
        // Counted before the call runs: a crash right now still has it.
        expect(openOn().resumeCount("dm:owner", "a1")).toBe(i);
        // Resumed (running again), and the daemon dies again.
        ledger.observe("dm:owner", [agent("a1")]);
        ledger = openOn();
      }
      const reason = ledger.gateResume("dm:owner", "a1");
      expect(reason).toMatch(new RegExp(`already been resumed ${MAX_AUTO_RESUMES} times`));
      expect(ledger.resumeCount("dm:owner", "a1")).toBe(MAX_AUTO_RESUMES);
      // Every turn hits the same gate: a second try is denied too.
      expect(ledger.gateResume("dm:owner", "a1")).not.toBeNull();
    });

    it("the gate counts per session and agent, and leaves other SendMessage calls alone", () => {
      const ledger = crashWith("a1");
      expect(ledger.gateResume("dm:owner", "other")).toBeNull();
      expect(ledger.gateResume("telegram:1", "a1")).toBeNull();
      expect(ledger.resumeCount("telegram:1", "a1")).toBe(0);
      // A message to the agent while it runs is not a resume.
      ledger.observe("dm:owner", [agent("a1")]);
      expect(ledger.gateResume("dm:owner", "a1")).toBeNull();
      expect(ledger.resumeCount("dm:owner", "a1")).toBe(0);
    });

    it("Explore/Plan agents and commands are not gated", () => {
      openOn().observe("dm:owner", [agent("e1", { subagentType: "Explore" }), agent("b1", { taskType: "local_bash" })]);
      const ledger = openOn();
      expect(ledger.gateResume("dm:owner", "e1")).toBeNull();
      expect(ledger.gateResume("dm:owner", "b1")).toBeNull();
      expect(onDisk()).not.toHaveProperty("resumes");
    });

    it("a count that cannot be written denies the resume and is not kept", () => {
      const ledger = crashWith("a1");
      rmSync(path); mkdirSync(path);  // the ledger path is now a directory: every write fails
      expect(ledger.gateResume("dm:owner", "a1")).toMatch(/could not record/);
      expect(ledger.resumeCount("dm:owner", "a1")).toBe(0);
    });

    it("an agent that ends on its own clears its count; a shutdown does not", () => {
      let ledger = crashWith("a1");
      ledger.gateResume("dm:owner", "a1");
      ledger.observe("dm:owner", [agent("a1")]);
      ledger.freeze();
      ledger.observe("dm:owner", []);
      ledger = openOn();
      expect(ledger.resumeCount("dm:owner", "a1")).toBe(1);

      ledger.gateResume("dm:owner", "a1");
      ledger.observe("dm:owner", [agent("a1")]);
      ledger.observe("dm:owner", [agent("a1", { status: "completed" })]);
      expect(ledger.resumeCount("dm:owner", "a1")).toBe(0);
      expect(openOn().gateResume("dm:owner", "a1")).toBeNull();
      expect(openOn().resumeCount("dm:owner", "a1")).toBe(0);
    });

    it("an agent that disappears without completing (its CLI died, session closed) is gated too", () => {
      const ledger = openOn();
      ledger.observe("dm:owner", [agent("a1"), agent("a2"), agent("e1", { subagentType: "Explore" })]);
      // The CLI died: an empty snapshot, no end status.
      ledger.observe("dm:owner", []);
      expect(ledger.gateResume("dm:owner", "a1")).toBeNull();
      expect(ledger.resumeCount("dm:owner", "a1")).toBe(1);
      expect(ledger.resumeCount("dm:owner", "e1")).toBe(0);
      // Failed or stopped is not completed: still gated.
      ledger.observe("dm:owner", [agent("a2")]);
      ledger.observe("dm:owner", [agent("a2", { status: "failed" })]);
      ledger.gateResume("dm:owner", "a2");
      expect(ledger.resumeCount("dm:owner", "a2")).toBe(1);
      // A foreground run reported completed in `ended` clears it.
      ledger.observe("dm:owner", [agent("a1")]);
      ledger.observe("dm:owner", [], [{ taskId: "a1", status: "completed" }]);
      expect(ledger.resumeCount("dm:owner", "a1")).toBe(0);
      expect(ledger.gateResume("dm:owner", "a1")).toBeNull();
      expect(ledger.resumeCount("dm:owner", "a1")).toBe(0);
    });

    it("the same agent dying with its CLI again and again hits the cap within one run", () => {
      const ledger = openOn();
      ledger.observe("dm:owner", [agent("a1")]);
      ledger.observe("dm:owner", []);
      for (let i = 0; i < MAX_AUTO_RESUMES; i++) {
        expect(ledger.gateResume("dm:owner", "a1")).toBeNull();
        ledger.observe("dm:owner", [agent("a1")]);
        ledger.observe("dm:owner", []);
      }
      expect(ledger.gateResume("dm:owner", "a1")).toMatch(/already been resumed/);
    });

    it("one cut off again past the limit is owed a failure notice until it is sent", () => {
      let ledger = crashWith("a1");
      for (let i = 0; i < MAX_AUTO_RESUMES; i++) {
        expect(ledger.owedFailureNotices()).toEqual([]);
        ledger.gateResume("dm:owner", "a1");
        ledger.observe("dm:owner", [agent("a1")]);
        ledger = openOn();
      }
      expect(ledger.owedFailureNotices()).toEqual([{ sessionKey: "dm:owner", taskId: "a1" }]);
      expect(openOn().owedFailureNotices()).toEqual([{ sessionKey: "dm:owner", taskId: "a1" }]);
      ledger = openOn();
      ledger.failureNoticeSent("dm:owner", ["a1"]);
      expect(openOn().owedFailureNotices()).toEqual([]);
    });

    it("off: no counts are kept or written, and nothing is gated", () => {
      crashWith("a1").gateResume("dm:owner", "a1");
      const off = open();
      expect(off.gateResume("dm:owner", "a1")).toBeNull();
      off.observe("dm:owner", [agent("a2")]);
      expect(onDisk()).not.toHaveProperty("resumes");
    });

    it("discard removes the file", () => {
      open().observe("dm:owner", [agent("a1")]);
      RunningAgentsLedger.discard(path);
      expect(existsSync(path)).toBe(false);
      expect(open().pendingBySession().size).toBe(0);
    });

    it("the hook denies SendMessage with the gate's reason and passes everything else", async () => {
      const gate = vi.fn((id: string) => (id === "bad" ? "no" : null));
      const hook = resumeGateHooks(gate).PreToolUse[0].hooks[0];
      expect(await hook({ tool_name: "SendMessage", tool_input: { to: "bad", message: "x" } })).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
      });
      expect(await hook({ tool_name: "SendMessage", tool_input: { to: "ok" } })).toEqual({});
      expect(await hook({ tool_name: "Bash", tool_input: { to: "bad" } })).toEqual({});
      expect(gate).toHaveBeenCalledTimes(2);
      // Installed through the SDK options only when a gate is given.
      const hooks = (buildHooksOption({ maxTurns: 0, resumeGate: gate }) as { hooks?: { PreToolUse?: { matcher?: string }[] } }).hooks;
      expect(hooks?.PreToolUse?.map((h) => h.matcher)).toContain("SendMessage");
      expect(buildHooksOption({ maxTurns: 0 })).toEqual({});
    });
  });
});

