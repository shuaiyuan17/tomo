import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isGroupSessionKey,
  isTaskSessionKey,
  parseRawSessionKey,
  privateReplyTargetFromSessionKey,
  sessionKind,
  taskIdFromSessionKey,
  taskSessionKey,
} from "../src/sessions/keys.js";
import { normalizeSendTarget } from "../src/agent/send-target.js";
import { isStorableSessionKey } from "../src/cron/scope.js";
import { isMemoryWrite, subsessionMemoryGuardHooks } from "../src/agent/subsessions/memory-guard.js";
import { PendingNotesQueue } from "../src/agent/pending-notes-queue.js";
import { buildSubsessionPrompt, formatPostCompactReminder } from "../src/agent/subsessions/prompt.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { SubsessionService } from "../src/agent/subsessions/service.js";
import { buildTaskOwnerTools, buildTaskSelfTools, SUBSESSION_SELF_TOOL_NAMES, SUBSESSION_TASK_TOOL_NAMES } from "../src/mcp/subsession-tools.js";
import { DEFAULT_SUBSESSIONS } from "../src/config.js";
import { formatTomoEvent, isOwnerAudienceNote, markOwnerAudience } from "../src/tomo-event.js";

describe("task: session keys", () => {
  it("are their own kind: not a DM, not a group, not a raw channel key", () => {
    const key = taskSessionKey("s3");
    expect(key).toBe("task:s3");
    expect(isTaskSessionKey(key)).toBe(true);
    expect(sessionKind(key)).toBe("task");
    expect(sessionKind("dm:owner")).toBe("owner-dm");
    expect(sessionKind("telegram:-100123")).toBe("group");
    expect(sessionKind("telegram:42")).toBe("raw");
    expect(parseRawSessionKey(key)).toBeUndefined();
    expect(isGroupSessionKey(key)).toBe(false);
    expect(privateReplyTargetFromSessionKey(key)).toBeUndefined();
  });

  it("carry only well-formed short ids", () => {
    expect(taskIdFromSessionKey("task:s12")).toBe("s12");
    for (const bad of ["task:", "task:s0", "task:s01", "task:x1", "task:s1:dm:owner", "dm:s1"]) {
      expect(taskIdFromSessionKey(bad)).toBeUndefined();
    }
  });

  it("are no send_message target, but are a cron delivery key", () => {
    expect(normalizeSendTarget("task:s1", undefined)).toBeNull();
    expect(isStorableSessionKey("task:s1")).toBe(true);
    expect(isStorableSessionKey("task:nope")).toBe(false);
  });
});

describe("sub-session memory guard", () => {
  const ctx = { cwd: "/ws", workspaceDir: "/ws" };
  it("denies writes to memory and the prompt files, and allows reads", () => {
    expect(isMemoryWrite("Write", { file_path: "/ws/memory/notes.md", content: "x" }, ctx)).toBe(true);
    expect(isMemoryWrite("Edit", { file_path: "/ws/SOUL.md", old_string: "a", new_string: "b" }, ctx)).toBe(true);
    expect(isMemoryWrite("Bash", { command: "echo hi >> /ws/memory/MEMORY.md" }, ctx)).toBe(true);
    expect(isMemoryWrite("Read", { file_path: "/ws/memory/notes.md" }, ctx)).toBe(false);
    expect(isMemoryWrite("Write", { file_path: "/ws/tmp/out.md", content: "x" }, ctx)).toBe(false);
  });

  it("answers the hook with a deny and a reason", async () => {
    const hooks = subsessionMemoryGuardHooks("task:s1", "/ws", "/ws");
    const deny = await hooks.PreToolUse[0].hooks[0]({ tool_name: "Write", tool_input: { file_path: "/ws/memory/a.md", content: "x" } });
    expect(deny).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await hooks.PreToolUse[0].hooks[0]({ tool_name: "Read", tool_input: { file_path: "/ws/memory/a.md" } })).toEqual({});
  });
});

describe("pending notes: sub-session reports", () => {
  const memoryStore = () => {
    const data = new Map<string, { id: string; text: string }[]>();
    return {
      getPendingNotes: (k: string) => [...(data.get(k) ?? [])],
      setPendingNotes: (k: string, n: { id: string; text: string }[]) => { data.set(k, [...n]); },
    };
  };

  it("a report note is pinned: the note cap never drops it", () => {
    const q = new PendingNotesQueue(memoryStore() as never);
    const report = formatTomoEvent("subsession-report", "the report", { name: "s1" });
    q.queueNote("dm:owner", report);
    for (let i = 0; i < 40; i++) q.queueNote("dm:owner", formatTomoEvent("note", `filler ${i}`));
    expect(q.peekNotes("dm:owner")).toContain(report);
  });

  it("a failed task's handback note is pinned too", () => {
    const q = new PendingNotesQueue(memoryStore() as never);
    const handback = formatTomoEvent("subsession-handback", "1. the owner's message", { name: "s1" });
    q.queueNote("dm:owner", handback);
    for (let i = 0; i < 40; i++) q.queueNote("dm:owner", formatTomoEvent("note", `filler ${i}`));
    expect(q.peekNotes("dm:owner")).toContain(handback);
  });

  it("hasNote sees queued and in-flight notes", () => {
    const q = new PendingNotesQueue(memoryStore() as never);
    q.queueNote("dm:owner", "marker-a");
    expect(q.hasNote("dm:owner", (n) => n.includes("marker-a"))).toBe(true);
    q.drain("dm:owner");
    expect(q.hasNote("dm:owner", (n) => n.includes("marker-a"))).toBe(true);
    expect(q.hasNote("dm:owner", (n) => n.includes("marker-b"))).toBe(false);
  });

  it("a note marked for the owner is held back from a turn that is not the owner's own", () => {
    const store = memoryStore();
    const q = new PendingNotesQueue(store as never);
    const report = markOwnerAudience(formatTomoEvent("subsession-report", "private task text", { name: "s1" }));
    const plain = formatTomoEvent("note", "anyone may see this");
    q.queueNote("dm:owner", report);
    q.queueNote("dm:owner", plain);
    const groupPrefix = q.drain("dm:owner", { holdOwnerAudience: true });
    expect(groupPrefix).toContain("anyone may see this");
    expect(groupPrefix).not.toContain("private task text");
    // Still queued (and on disk) for the owner's own next turn.
    expect(store.getPendingNotes("dm:owner").some((n) => n.text.includes("private task text"))).toBe(true);
    q.settle("dm:owner", groupPrefix);
    expect(q.drain("dm:owner")).toContain("private task text");
  });

  it("the owner mark survives the report's pinning and the interrupted prefix", () => {
    const report = markOwnerAudience(formatTomoEvent("subsession-report", "r", { name: "s1" }));
    expect(report.startsWith('<tomo-event type="subsession-report" name="s1"')).toBe(true);
    expect(isOwnerAudienceNote(report)).toBe(true);
    expect(markOwnerAudience(report)).toBe(report);
    expect(isOwnerAudienceNote(formatTomoEvent("note", 'body says audience="owner"'))).toBe(false);
  });
});

describe("sub-session prompt", () => {
  it("offers the owner-facing tools and carries no memory instructions", () => {
    const prompt = buildSubsessionPrompt({ agentName: "Tomo", ownerName: "Shuai" });
    for (const name of ["task_reply", "task_ask", "task_finish"]) expect(prompt).toContain(name);
    // One tool speaks: an answer or unprompted news.
    expect(prompt).not.toContain("task_notify");
    expect(prompt).not.toMatch(/MEMORY\.md index|memory_write/);
    expect(prompt).toContain("task_plan");
    expect(prompt).not.toContain("task_progress");
  });

  it("says task_finish is refused while a message the task has not read is waiting (in the tool, where it applies)", () => {
    const finish = buildTaskSelfTools({ service: () => undefined, key: "task:s1" }).find((t) => t.name === "task_finish")!;
    expect(finish.description).toMatch(/Refused while a message you have not read yet is waiting[^\n]*next turn/);
  });
});

describe("sub-session tools", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; vi.restoreAllMocks(); });

  function service(): SubsessionService {
    dir = mkdtempSync(join(tmpdir(), "tomo-subtools-"));
    const svc = new SubsessionService({
      store: new SubsessionStore(join(dir, "t.json")),
      config: () => ({ ...DEFAULT_SUBSESSIONS, enabled: true, maxRunning: 0 + 1 }),
      runTaskTurn: () => new Promise(() => {}),
      sendToScope: async () => ({ ok: true }),
      noticeToScope: async () => {},
      noticeOwner: async () => {},
      queuePendingNote: () => true,
      hasPendingNote: () => false,
      wakeScope: () => {},
      contextUsage: () => undefined,
      cronJobCount: () => 0,
      removeCronJobs: () => {},
      stopSession: async () => {},
      registryReadable: () => true,
      hasSdkSession: () => false,
      ensureRegistryEntry: () => {},
      unlinkRegistryEntry: () => {},
      registryTaskKeys: () => [],
      isStopping: () => false,
    });
    // Recovery done (the tools work from here); dispatch stays closed.
    svc.recoverAtStartup();
    return svc;
  }
  const call = (tools: ReturnType<typeof buildTaskOwnerTools>, name: string, args: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.handler(args as never, undefined as never) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

  it("lists the tool names once for allowedTools", () => {
    expect(new Set(SUBSESSION_TASK_TOOL_NAMES).size).toBe(SUBSESSION_TASK_TOOL_NAMES.length);
    expect(SUBSESSION_TASK_TOOL_NAMES).toContain("task_spawn");
    expect(SUBSESSION_TASK_TOOL_NAMES).toContain("task_finish");
  });

  it("a scope sees and steers only its own tasks", async () => {
    const svc = service();
    const owner = buildTaskOwnerTools({ service: () => svc, scope: () => "dm:owner" });
    const group = buildTaskOwnerTools({ service: () => svc, scope: () => "telegram:-100123" });
    const spawned = await call(owner, "task_spawn", { title: "Mine", brief: "b" });
    expect(spawned.isError).toBeUndefined();
    expect(spawned.content[0].text).toContain("s1");
    expect((await call(group, "task_status", {})).content[0].text).toBe("No sub-sessions.");
    expect((await call(group, "task_cancel", { id: "s1" })).isError).toBe(true);
    expect((await call(group, "task_message", { id: "s1", text: "hi" })).isError).toBe(true);
    expect((await call(owner, "task_status", { id: "s1" })).content[0].text).toContain("Mine");
  });

  it("task_message attaches the owner's own messages only when asked and only when the turn has some", async () => {
    const svc = service();
    let mine: Array<{ text: string; at: number; channel: string }> = [];
    const owner = buildTaskOwnerTools({ service: () => svc, scope: () => "dm:owner", ownerMessages: () => mine });
    await call(owner, "task_spawn", { title: "Mine", brief: "b" });
    // Nothing of the owner's in this turn (a background wake): attaching is refused, nothing relayed.
    const refused = await call(owner, "task_message", { id: "s1", text: "go", attach_owner_message: true });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("no message from the owner");
    expect(svc.get("s1")!.pendingInput).toHaveLength(0);
    // Without attaching: the main session's own note.
    expect((await call(owner, "task_message", { id: "s1", text: "a note" })).isError).toBeUndefined();
    expect(svc.get("s1")!.pendingInput.at(-1)).toMatchObject({ from: "main", words: "a note" });
    // With the owner's message in this turn: copied in as theirs, not the model's retelling.
    mine = [{ text: "ship it", at: 1, channel: "imessage" }];
    const passed = await call(owner, "task_message", { id: "s1", text: "They said ship it.", attach_owner_message: true });
    expect(passed.content[0].text).toContain("with the owner's message");
    expect(svc.get("s1")!.pendingInput.at(-1)).toMatchObject({ from: "owner", words: "ship it" });
    expect(svc.get("s1")!.pendingInput.at(-1)!.text).toContain("[1970-01-01T00:00:00.001Z · imessage] ship it");
  });

  it("task_finish takes what the owner has to do; task_done clears it, only in the owning scope", async () => {
    const svc = service();
    const owner = buildTaskOwnerTools({ service: () => svc, scope: () => "dm:owner" });
    const group = buildTaskOwnerTools({ service: () => svc, scope: () => "telegram:-100123" });
    await call(owner, "task_spawn", { title: "Mine", brief: "b" });
    expect((await call(owner, "task_done", { id: "s1", report: 1 })).content[0].text).toContain("asks nothing of the owner");
    // As its first turn leaves it (dispatch is not open here, so nothing else starts it).
    (svc as unknown as { store: { transition: (id: string, e: string) => unknown } }).store.transition("s1", "start");
    const self = buildTaskSelfTools({ service: () => svc, key: "task:s1" });
    const out = await call(self as never, "task_finish", { report: "PR #4 is open.", owner_action: "Merge PR #4" });
    expect(out.content[0].text).toContain("needing the owner");
    expect(svc.get("s1")).toMatchObject({ status: "finished", ownerAction: "Merge PR #4" });
    expect((await call(group, "task_done", { id: "s1", report: 1 })).isError).toBe(true);
    expect(svc.get("s1")?.ownerAction).toBe("Merge PR #4");
    // task_cancel agrees with /s stop: a finished task waiting on the owner is not cancelled; task_done clears it.
    const cancel = await call(owner, "task_cancel", { id: "s1" });
    expect(cancel.isError).toBe(true);
    expect(cancel.content[0].text).toContain(`task_done("s1", ${svc.get("s1")!.reportSeq})`);
    expect(svc.get("s1")).toMatchObject({ status: "finished", ownerAction: "Merge PR #4" });
    const report = svc.get("s1")!.reportSeq!;
    const done = await call(owner, "task_done", { id: "s1", report });
    expect(done.isError).toBeUndefined();
    expect(svc.get("s1")?.ownerAction).toBeUndefined();
  });

  it("task_spawn tells the model to tell the owner before starting a task on its own", () => {
    const tools = buildTaskOwnerTools({ service: () => undefined, scope: () => "dm:owner" });
    const description = (tools.find((t) => t.name === "task_spawn") as unknown as { description: string }).description;
    expect(description).toMatch(/on your own[^.]*must tell the owner first/);
  });

  it("refuses a turn that may not manage sub-sessions", async () => {
    const svc = service();
    const tools = buildTaskOwnerTools({ service: () => svc, scope: () => undefined });
    expect((await call(tools, "task_spawn", { title: "x", brief: "y" })).isError).toBe(true);
  });

  it("task_finish refused for unread input says how many and that they come next turn", async () => {
    const fake = { finish: () => ({ ok: false, from: "active", refused: "x", unread: 2 }) } as unknown as SubsessionService;
    const self = buildTaskSelfTools({ service: () => fake, key: "task:s1" });
    const out = await call(self as never, "task_finish", { report: "done" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/still have 2 unread messages[^]*next turn[^]*task_finish again/);
    const illegal = { finish: () => ({ ok: false, from: "cancelled" }) } as unknown as SubsessionService;
    const other = await call(buildTaskSelfTools({ service: () => illegal, key: "task:s1" }) as never, "task_finish", { report: "done" });
    expect(other.content[0].text).toContain("this task is cancelled");
  });

  it("a task's own tools are bound to its key", async () => {
    const svc = service();
    const created = svc.spawn("dm:owner", { title: "Mine", brief: "b" });
    if (!created.ok) throw new Error(created.error);
    const self = buildTaskSelfTools({ service: () => svc, key: created.record.sessionKey });
    const other = buildTaskSelfTools({ service: () => svc, key: "task:s9" });
    expect((await call(self as never, "task_update", { line: "halfway" })).isError).toBeUndefined();
    expect(svc.get("s1")?.updates?.map((u) => u.text)).toEqual(["halfway"]);
    expect((await call(other as never, "task_update", { line: "x" })).isError).toBe(true);
  });

  it("has no task_progress: what the task is doing now is its plan step in progress", () => {
    const svc = service();
    const names = buildTaskSelfTools({ service: () => svc, key: "task:s1" }).map((t) => t.name);
    expect(names).not.toContain("task_progress");
    expect(SUBSESSION_SELF_TOOL_NAMES as readonly string[]).not.toContain("task_progress");
  });

  it("reminds the task after a compact of its plan, the steps it already filed done, and its updates", () => {
    const svc = service();
    const created = svc.spawn("dm:owner", { title: "Mine", brief: "b" });
    if (!created.ok) throw new Error(created.error);
    const record = { ...created.record, plan: [{ text: "Write tests", status: "in_progress" as const }], doneSteps: [{ at: 1, text: "Read the code", result: "found it" }], updates: [{ at: 2, text: "Chose B" }] };
    const reminder = formatPostCompactReminder(record);
    expect(reminder).toContain("[in progress] Write tests");
    expect(reminder).toContain("Read the code: found it");
    expect(reminder).toContain("Chose B");
  });

  it("task_plan sets the steps ahead, files finished ones with their results, and allows one step in progress", async () => {
    const svc = service();
    const created = svc.spawn("dm:owner", { title: "Mine", brief: "b" });
    if (!created.ok) throw new Error(created.error);
    const self = buildTaskSelfTools({ service: () => svc, key: created.record.sessionKey });
    const steps = [{ step: "Read the code", status: "in_progress" }, { step: "Write tests" }];
    expect((await call(self as never, "task_plan", { steps })).isError).toBeUndefined();
    expect(svc.get("s1")?.plan).toEqual([{ text: "Read the code", status: "in_progress" }, { text: "Write tests", status: "pending" }]);
    expect((await call(self as never, "task_plan", { steps: [{ step: "Write tests", status: "in_progress" }], done: [{ step: "Read the code", result: "found it" }] })).isError).toBeUndefined();
    expect(svc.get("s1")?.plan).toEqual([{ text: "Write tests", status: "in_progress" }]);
    expect(svc.get("s1")?.doneSteps).toEqual([{ at: expect.any(Number), text: "Read the code", result: "found it" }]);
    const refused = await call(self as never, "task_plan", { steps: [{ step: "a", status: "in_progress" }, { step: "b", status: "in_progress" }] });
    expect(refused.isError).toBe(true);
    expect(svc.get("s1")?.plan).toHaveLength(1);
    // A blank step is refused, not read as clearing the plan.
    expect((await call(self as never, "task_plan", { steps: [{ step: "  " }], reason: "x" })).isError).toBe(true);
    expect(svc.get("s1")?.plan).toHaveLength(1);
    // Two steps alike are refused, saying how to tell them apart.
    const twice = await call(self as never, "task_plan", { steps: [{ step: "Write tests" }, { step: "Write tests" }], reason: "x" });
    expect(twice.isError).toBe(true);
    expect(JSON.stringify(twice.content)).toContain("its own words");
    expect(svc.get("s1")?.plan).toHaveLength(1);
    // A step longer than the limit is cut, not refused.
    expect((await call(self as never, "task_plan", { steps: [{ step: "Write tests", status: "in_progress" }, { step: "😀".repeat(200) }] })).isError).toBeUndefined();
    expect(Array.from(svc.get("s1")!.plan![1].text)).toHaveLength(120);
    await call(self as never, "task_plan", { steps: [{ step: "Write tests", status: "in_progress" }], reason: "dropped the emoji step" });
    const detail = (await call(self as never, "task_status", {})).content[0].text;
    expect(detail).toContain("[in progress] Write tests");
    expect(detail).toContain("Read the code — found it");
    // Dropping a step still ahead without a reason is refused, with a way out.
    const dropped = await call(self as never, "task_plan", { steps: [] });
    expect(dropped.isError).toBe(true);
    expect(dropped.content[0].text).toMatch(/reason/);
    // A step filed done in other words is named, so the task can tell it slipped.
    const paraphrased = await call(self as never, "task_plan", { steps: [], done: [{ step: "Wrote tests" }] });
    expect(paraphrased.isError).toBe(true);
    expect(paraphrased.content[0].text).toContain('"Write tests" is no longer in the plan and not in `done`');
    expect(paraphrased.content[0].text).toContain("in exactly these words");
    expect((await call(self as never, "task_plan", { steps: [{ step: "Write docs" }], reason: "Tests already exist" })).isError).toBeUndefined();
    expect((await call(self as never, "task_status", {})).content[0].text).toContain("Plan changed: Tests already exist");
    // An empty list clears the plan.
    await call(self as never, "task_plan", { steps: [], done: [{ step: "Write docs" }] });
    expect(svc.get("s1")?.plan).toBeUndefined();
    expect(svc.get("s1")?.doneSteps).toHaveLength(2);
  });

  it("task_update records a decision, and refuses a blank one", async () => {
    const svc = service();
    const created = svc.spawn("dm:owner", { title: "Mine", brief: "b" });
    if (!created.ok) throw new Error(created.error);
    const self = buildTaskSelfTools({ service: () => svc, key: created.record.sessionKey });
    expect((await call(self as never, "task_update", { line: "Scope: also add a plan checklist" })).isError).toBeUndefined();
    expect(svc.get("s1")?.updates).toEqual([{ at: expect.any(Number), text: "Scope: also add a plan checklist" }]);
    const blank = await call(self as never, "task_update", { line: "   " });
    expect(blank.isError).toBe(true);
    expect(svc.get("s1")?.updates).toHaveLength(1);
    expect((await call(self as never, "task_status", {})).content[0].text).toContain("Decisions and updates (newest last):");
    const other = buildTaskSelfTools({ service: () => svc, key: "task:s9" });
    expect((await call(other as never, "task_update", { line: "x" })).isError).toBe(true);
  });
});
