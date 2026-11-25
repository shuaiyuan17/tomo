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
import { buildSubsessionPrompt } from "../src/agent/subsessions/prompt.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { SubsessionService } from "../src/agent/subsessions/service.js";
import { buildTaskOwnerTools, buildTaskSelfTools, SUBSESSION_TASK_TOOL_NAMES } from "../src/mcp/subsession-tools.js";
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
    const data = new Map<string, string[]>();
    return { getPendingNotes: (k: string) => [...(data.get(k) ?? [])], setPendingNotes: (k: string, n: string[]) => { data.set(k, [...n]); } };
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
    expect(store.getPendingNotes("dm:owner").some((n) => n.includes("private task text"))).toBe(true);
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
    for (const name of ["task_reply", "task_notify", "task_ask", "task_finish"]) expect(prompt).toContain(name);
    expect(prompt).not.toMatch(/MEMORY\.md index|memory_write/);
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

  it("a task's own tools are bound to its key", async () => {
    const svc = service();
    const created = svc.spawn("dm:owner", { title: "Mine", brief: "b" });
    if (!created.ok) throw new Error(created.error);
    const self = buildTaskSelfTools({ service: () => svc, key: created.record.sessionKey });
    const other = buildTaskSelfTools({ service: () => svc, key: "task:s9" });
    expect((await call(self as never, "task_progress", { line: "halfway" })).isError).toBeUndefined();
    expect(svc.get("s1")?.progress).toBe("halfway");
    expect((await call(other as never, "task_progress", { line: "x" })).isError).toBe(true);
  });
});
