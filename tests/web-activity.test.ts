import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ACTIVITY_TEXT_LIMIT, failureReason, toolActivity, toolOutcome } from "../src/web/activity.js";
import { pairOutputs, toolItemsFromLine } from "../src/web/session-tools.js";
import { itemsFromLine } from "../src/web/subagent-reader.js";
import { clearSecretValuesForTests, registerSecretValue } from "../src/credentials/redactor.js";
import { toolTitle } from "../src/agent/tool-summary.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { SubsessionService } from "../src/agent/subsessions/service.js";
import { buildTaskOwnerTools } from "../src/mcp/subsession-tools.js";
import { buildTodoTools } from "../src/mcp/todo-tools.js";
import { buildCronTools } from "../src/mcp/cron-tools.js";
import { TodoStore } from "../src/todos/store.js";
import { buildPetTools } from "../src/mcp/pet-tools.js";
import { buildMemoryTools } from "../src/mcp/memory-tools.js";
import { MemoryStore } from "../src/memory/store.js";
import { PetStore } from "../src/mcp/pet-store.js";
import { DEFAULT_SUBSESSIONS } from "../src/config.js";
import type { SubagentItem } from "../src/web/protocol.js";
import { webSessionId } from "../src/web/owner.js";

const ROOT = mkdtempSync(join(tmpdir(), "tomo-test-activity-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const I = (tool: string) => `mcp__tomo-internal__${tool}`;

type Handler = { name: string; handler: (args: never, extra: never) => Promise<unknown> };
type Result = { content: Array<{ text: string }>; isError?: boolean };
const run = async (tools: unknown, name: string, args: Record<string, unknown>): Promise<Result> =>
  (tools as Handler[]).find((t) => t.name === name)!.handler(args as never, undefined as never) as Promise<Result>;
const textOf = (result: Result) => result.content.map((c) => c.text).join("\n");

function subsessions(): SubsessionService {
  const svc = new SubsessionService({
    store: new SubsessionStore(join(mkdtempSync(join(ROOT, "s-")), "t.json")),
    config: () => ({ ...DEFAULT_SUBSESSIONS, enabled: true, maxRunning: 1 }),
    runTaskTurn: () => new Promise(() => {}),
    sendToScope: async () => ({ ok: true }), noticeToScope: async () => {}, noticeOwner: async () => {},
    queuePendingNote: () => true, hasPendingNote: () => false, wakeScope: () => {}, contextUsage: () => undefined,
    cronJobCount: () => 0, removeCronJobs: () => {}, stopSession: async () => {}, registryReadable: () => true,
    hasSdkSession: () => false, ensureRegistryEntry: () => {}, unlinkRegistryEntry: () => {}, registryTaskKeys: () => [], isStopping: () => false,
  });
  svc.recoverAtStartup();
  return svc;
}

describe("toolOutcome reads what the real tools return", () => {
  it("sub-session tools: spawn, status, message, cancel, and their failures", async () => {
    const svc = subsessions();
    const tools = buildTaskOwnerTools({ service: () => svc, scope: () => "dm:owner" });
    const spawned = await run(tools, "task_spawn", { title: "Cards", brief: "Build the cards" });
    expect(toolOutcome(I("task_spawn"), textOf(spawned))).toEqual({ id: "s1", status: expect.any(String) });
    expect(toolOutcome(I("task_status"), textOf(await run(tools, "task_status", {})))).toEqual({ count: 1 });
    expect(toolOutcome(I("task_status"), textOf(await run(tools, "task_status", { id: "s1" })))).toEqual({ status: expect.any(String) });
    const passed = toolOutcome(I("task_message"), textOf(await run(tools, "task_message", { id: "s1", text: "go on" })));
    expect(passed?.delivery).toMatch(/^(passed|queued)$/);
    expect(toolOutcome(I("task_cancel"), textOf(await run(tools, "task_cancel", { id: "s1" })))).toEqual({});
    expect(toolOutcome(I("task_cancel"), textOf(await run(tools, "task_cancel", { id: "s1" })))).toEqual({ noop: "s1 was already cancelled." });
    const missing = await run(tools, "task_message", { id: "s9", text: "x" });
    expect(missing.isError).toBe(true);
    expect(failureReason(I("task_message"), textOf(missing))).toBe("no task s9 in this conversation.");
    const empty = buildTaskOwnerTools({ service: () => svc, scope: () => "telegram:-1" });
    expect(toolOutcome(I("task_status"), textOf(await run(empty, "task_status", {})))).toEqual({ count: 0 });
  });

  it("todo tools: add, resolve, list", async () => {
    const dir = mkdtempSync(join(ROOT, "todo-"));
    const tools = buildTodoTools({ store: () => new TodoStore(dir), caller: () => "dm:owner" });
    expect(toolOutcome(I("todo_list"), textOf(await run(tools, "todo_list", { filter: "all" })))).toEqual({ count: 0 });
    const added = await run(tools, "todo_add", { title: "Order seeds", next: "Call the nursery", waiting_on: "me" });
    expect(toolOutcome(I("todo_add"), textOf(added))).toEqual({ id: "t-1", title: "Order seeds · next: Call the nursery", review: expect.any(String) });
    // A title with the separator in it is still read whole.
    const dotted = await run(tools, "todo_add", { title: "Seeds · and soil", next: "Call", waiting_on: "external", ref: "PR 9" });
    expect(toolOutcome(I("todo_add"), textOf(dotted))).toMatchObject({ id: "t-2", title: "Seeds · and soil · next: Call" });
    await run(tools, "todo_resolve", { id: "t-2", action: "drop", reason: "dup" });
    // The printed words, never a split that could name the wrong to-do.
    const marked = await run(tools, "todo_add", { title: "Plan · next: discuss", next: "Book a room", waiting_on: "me" });
    expect(toolOutcome(I("todo_add"), textOf(marked))).toMatchObject({ title: "Plan · next: discuss · next: Book a room" });
    const same = await run(tools, "todo_add", { title: "Plan · next: discuss", next: "Plan · next: discuss", waiting_on: "me" });
    expect(toolOutcome(I("todo_add"), textOf(same))).toMatchObject({ title: "Plan · next: discuss" });
    await run(tools, "todo_resolve", { id: "t-4", action: "drop", reason: "dup" });
    await run(tools, "todo_resolve", { id: "t-3", action: "drop", reason: "dup" });
    await run(tools, "todo_add", { title: "Fix the tap", next: "Phone the plumber", waiting_on: "owner" }); // t-5
    expect(toolOutcome(I("todo_list"), textOf(await run(tools, "todo_list", { filter: "all" })))).toEqual({ count: 2 });
    expect(toolOutcome(I("todo_resolve"), textOf(await run(tools, "todo_resolve", { id: "t-1", action: "done", evidence: "PR 4" })))).toMatchObject({ id: "t-1", title: "Order seeds · next: Call the nursery" });
    expect(toolOutcome(I("todo_resolve"), textOf(await run(tools, "todo_resolve", { id: "t-5", action: "snooze", until: "3d", reason: "later" }))))
      .toMatchObject({ id: "t-5", title: "Fix the tap · next: Phone the plumber", snoozes: 1, maxSnoozes: expect.any(Number), review: expect.any(String) });
    const bad = await run(tools, "todo_resolve", { id: "t-99", action: "done" });
    expect(bad.isError).toBe(true);
    expect(failureReason(I("todo_resolve"), textOf(bad))).not.toMatch(/^todo_resolve/);
  });

  it("cron tools: create, enable, remove, list", async () => {
    const path = join(mkdtempSync(join(ROOT, "cron-")), "tomo.db");
    const tools = buildCronTools(path, "dm:owner");
    const created = await run(tools, "schedule_create", { name: "Dentist", schedule: "in 2h", message: "Dentist at 4", once: true });
    const outcome = toolOutcome(I("schedule_create"), textOf(created));
    expect(outcome).toMatchObject({ id: expect.any(String), lifecycle: "once", enabled: true, nextRunAt: expect.any(Number) });
    const brief = await run(tools, "schedule_create", { name: "Brief", schedule: "30 8 * * *", message: "Morning brief" });
    expect(toolOutcome(I("schedule_create"), textOf(brief))).toMatchObject({ lifecycle: "recurring", cron: "30 8 * * *" });
    const every = await run(tools, "schedule_create", { name: "Water", schedule: "every 2h", message: "Water the plants" });
    expect(toolOutcome(I("schedule_create"), textOf(every))).toMatchObject({ lifecycle: "recurring", everyMs: 7_200_000 });
    // A date kept after it ran is "recurring" by lifecycle, but fires once.
    const kept = await run(tools, "schedule_create", { name: "Call", schedule: "in 3h", message: "Call back", once: false });
    expect(toolOutcome(I("schedule_create"), textOf(kept))).toMatchObject({ firesOnce: true });
    expect(toolOutcome(I("schedule_list"), textOf(await run(tools, "schedule_list", {})))).toEqual({ count: 4 });
    expect(toolOutcome(I("schedule_enable"), textOf(await run(tools, "schedule_enable", { id: outcome!.id, enabled: false })))).toMatchObject({ enabled: false });
    expect(toolOutcome(I("schedule_remove"), textOf(await run(tools, "schedule_remove", { id: outcome!.id })))).toEqual({});
    expect(toolOutcome(I("schedule_remove"), textOf(await run(tools, "schedule_remove", { id: "nope0000" })))).toEqual({ noop: "Job nope0000 not found." });
  });

  it("request_credential / request_permission: the status, and where the owner was asked", () => {
    expect(toolOutcome(I("request_credential"), JSON.stringify({ status: "pending", secret_ref: "r1", asked_on: "telegram", expires_at: 1 }, null, 2)))
      .toEqual({ status: "pending", channel: "telegram" });
    expect(toolOutcome(I("request_permission"), JSON.stringify({ status: "already_allowed", path: "/x" }))).toEqual({ status: "already_allowed" });
    // A denial comes back as JSON: the card shows its reason, not the object.
    expect(failureReason(I("request_permission"), JSON.stringify({ status: "denied", reason: "That path is outside the group's folder." })))
      .toBe("That path is outside the group's folder.");
  });

  it("memory tools: writes, a move, a delete, reads, a list and a search", async () => {
    const dir = mkdtempSync(join(ROOT, "memory-"));
    const store = new MemoryStore({ memoryDir: join(dir, "memory"), historyDir: join(dir, "history") });
    const tools = buildMemoryTools({ store: () => store, access: () => ({ privateBarred: false, canWrite: true, canWriteCore: true }) });
    const topic = "---\ndescription: Trips\n---\nKyoto in May\n";
    expect(toolOutcome(I("memory_write"), textOf(await run(tools, "memory_write", { path: "travel.md", content: topic, if_version: "new" })))).toEqual({});
    expect(toolOutcome(I("memory_str_replace"), textOf(await run(tools, "memory_str_replace", { path: "travel.md", old: "May", new: "June" })))).toEqual({});
    expect(toolOutcome(I("memory_append"), textOf(await run(tools, "memory_append", { path: "travel.md", content: "Osaka after\n" })))).toEqual({});
    expect(toolOutcome(I("memory_read"), textOf(await run(tools, "memory_read", { path: "travel.md" })))).toEqual({ count: 6 });
    expect(toolOutcome(I("memory_read"), textOf(await run(tools, "memory_read", { path: "travel.md", offset: 2, limit: 1 })))).toEqual({ count: 1 });
    expect(toolOutcome(I("memory_list"), textOf(await run(tools, "memory_list", {})))).toEqual({ count: 1 });
    expect(toolOutcome(I("memory_list"), textOf(await run(tools, "memory_list", { prefix: "work/" })))).toEqual({ count: 0 });
    expect(toolOutcome(I("memory_search"), textOf(await run(tools, "memory_search", { query: "osaka" })))).toEqual({ count: 1 });
    expect(toolOutcome(I("memory_search"), textOf(await run(tools, "memory_search", { query: "lisbon" })))).toEqual({ count: 0 });
    expect(toolOutcome(I("memory_move"), textOf(await run(tools, "memory_move", { from: "travel.md", to: "trips.md" })))).toEqual({});
    const listed = textOf(await run(tools, "memory_list", {}));
    const version = /\(version (\S+)\)/.exec(listed)![1];
    expect(toolOutcome(I("memory_delete"), textOf(await run(tools, "memory_delete", { path: "trips.md", if_version: version })))).toEqual({});
    const refused = await run(tools, "memory_str_replace", { path: "nope.md", old: "a", new: "b" });
    expect(refused.isError).toBe(true);
    expect(failureReason(I("memory_str_replace"), textOf(refused))).not.toMatch(/^memory_str_replace/);
    // Over its budget: saved, with the tool's note.
    const big = await run(tools, "memory_write", { path: "MEMORY.md", content: "- line\n".repeat(210), if_version: "new" });
    expect(toolOutcome(I("memory_write"), textOf(big))).toMatchObject({ note: expect.stringMatching(/budget/) });
  });

  it("pet tools: an egg or a full pet is a no-op, a feed is its mood", async () => {
    const path = join(mkdtempSync(join(ROOT, "pet-")), "pet.json");
    const tools = buildPetTools(path);
    expect(toolOutcome(I("pet_hatch"), textOf(await run(tools, "pet_hatch", { name: "Pinch", species: "crab" })))).toEqual({});
    expect(toolOutcome(I("pet_feed"), textOf(await run(tools, "pet_feed", {})))).toEqual({ noop: "Pinch is still an egg. They do not need food yet." });
    const store = new PetStore(path);
    store.save({ ...store.load()!, stage: "baby", hunger: 95, sleeping: false, last_tick: new Date().toISOString() });
    expect(toolOutcome(I("pet_feed"), textOf(await run(tools, "pet_feed", {})))).toMatchObject({ noop: expect.any(String) });
    store.save({ ...store.load()!, hunger: 20 });
    expect(toolOutcome(I("pet_feed"), textOf(await run(tools, "pet_feed", {})))).toEqual({ status: expect.any(String) });
  });
  it("list_sessions: its catalog is a plain success", () => {
    expect(toolOutcome(I("list_sessions"), JSON.stringify({ owner: { name: "o" }, identities: [], groups: [] }, null, 2))).toEqual({});
  });
  it("recall: no hits is a count of 0; a search that never ran is a no-op", () => {
    expect(toolOutcome(I("recall_conversation"), "No matching messages found (searched the last 30 days). Try other phrasings.")).toEqual({ count: 0 });
    expect(toolOutcome(I("recall_conversation"), "No messages searched: `before` (2025-01-01) is more than 30 days ago, and …")).toMatchObject({ noop: expect.any(String) });
  });
  it("a wording it does not know, or a tool that is not internal, is no outcome", () => {
    expect(toolOutcome(I("task_spawn"), "Spawned s1.")).toBeUndefined();
    expect(toolOutcome(I("not_a_tool"), "OK")).toBeUndefined();
    expect(toolOutcome("Bash", "Started s1 (active).")).toBeUndefined();
    expect(failureReason("Bash", "x failed: y")).toBeUndefined();
  });
});

describe("toolActivity reads the raw input", () => {
  it("a brief longer than the INPUT pane's 4,000 characters still makes an activity, clipped on its own", () => {
    const brief = "Goal: build the cards. ".repeat(600);
    const activity = toolActivity(I("task_spawn"), { title: "Cards", brief, model: "fable", quote: ["do it"] });
    expect(activity).toMatchObject({ kind: "task_spawn", title: "Cards", model: "fable", briefTruncated: true, quoted: true });
    expect(activity?.kind === "task_spawn" && activity.brief.length).toBe(ACTIVITY_TEXT_LIMIT);
  });
  it("keeps a schedule's destination session (the input redaction would blank a key named `session`)", () => {
    expect(toolActivity(I("schedule_create"), { name: "Poll", schedule: "0 18 * * 5", message: "m", session: "telegram:-2" })).toMatchObject({ sessionId: webSessionId("telegram:-2") });
    expect(toolActivity(I("schedule_create"), { name: "Poll", schedule: "0 18 * * 5", message: "Post the poll", session: "telegram:-2" }))
      .toMatchObject({ session: "telegram:-2" });
    expect(toolActivity(I("schedule_create"), { name: "Poll", schedule: "0 18 * * 5", message: "m", session: "hunter2-opaque-value" })).not.toHaveProperty("session");
  });
  it("send_message: MEDIA lines become file names, never paths", () => {
    const activity = toolActivity(I("send_message"), { target: "dm:owner", mode: "direct", message: "Here it is\nMEDIA:/Users/me/out/chart.png" });
    expect(activity).toMatchObject({ kind: "send_message", mode: "direct", text: "Here it is", media: ["chart.png"], toOwner: true });
    expect(toolActivity(I("send_message"), { target: "telegram:-2", message: "hi" })).toMatchObject({ mode: "delegate", targetId: webSessionId("telegram:-2") });
    expect(toolActivity(I("send_message"), { target: "owner", message: "hi" })).toMatchObject({ toOwner: true });
    // The tags delivery strips anywhere in a line, quoted or not, and stickers.
    const inline = toolActivity(I("send_message"), { target: "dm:owner", mode: "direct", message: 'Here is the chart MEDIA:"/Users/me/my chart.png" and media:/tmp/b.pdf STICKER:abc' });
    expect(inline).toMatchObject({ text: "Here is the chart  and", media: ["my chart.png", "b.pdf"], stickers: 1 });
    expect(JSON.stringify(inline)).not.toContain("/Users/me");
    // Delegated: passed on verbatim, so shown verbatim.
    expect(toolActivity(I("send_message"), { target: "dm:owner", mode: "delegate", message: "Send them MEDIA:/tmp/b.pdf" })).toMatchObject({ text: "Send them MEDIA:/tmp/b.pdf" });
    expect(toolActivity(I("send_message"), { target: "dm:owner", mode: "delegate", message: "Send them MEDIA:/tmp/b.pdf" })).not.toHaveProperty("media");
  });
  it("scrubs a secret in a text field", () => {
    const activity = toolActivity(I("task_message"), { id: "s1", text: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" });
    expect(activity?.kind === "task_message" && activity.text).not.toContain("abcdefghijklmnop");
  });
  it("a call it cannot read is no activity (the plain line stays)", () => {
    expect(toolActivity(I("task_spawn"), { title: "" })).toBeUndefined();
    expect(toolActivity(I("whatever_new"), {})).toBeUndefined();
    expect(toolActivity("Read", { file_path: "/x" })).toBeUndefined();
  });
});

describe("secrets in an activity", () => {
  it("are scrubbed whole before the clip, so a long registered one that straddles it does not leak its start", () => {
    const secret = `plainsecret${"q".repeat(400)}`;
    registerSecretValue(secret, "long-one");
    try {
      const activity = toolActivity(I("task_spawn"), { title: `intro ${secret}`, brief: `see ${secret}` });
      registerSecretValue("alpha   beta9", "spaced");
      expect(toolActivity(I("task_message"), { id: "s1", text: "x", attach_owner_message: false })).toBeDefined();
      expect(JSON.stringify(toolActivity(I("task_cancel"), { id: "s1", reason: "token alpha   beta9 expired" }))).not.toContain("beta9");
      expect(activity?.kind === "task_spawn" && activity.title).not.toContain("plainsecret");
      expect(activity?.kind === "task_spawn" && activity.brief).not.toContain("plainsecret");
      expect(toolTitle("mcp__docs__fetch", { url: `${"u".repeat(70)}${secret}` })).not.toContain("plain");
    } finally { clearSecretValuesForTests(); }
  });
});

describe("the main chat's tool items carry activity and outcome", () => {
  const line = (type: string, content: unknown[]) => JSON.stringify({ type, isSidechain: false, timestamp: "2026-11-27T10:00:00.000Z", message: { role: type, content } });
  const items = (scope: { owner?: boolean; workspaceDir?: string }) => [
    ...toolItemsFromLine(line("assistant", [{ type: "tool_use", id: "u1", name: I("task_spawn"), input: { title: "Cards", brief: "b".repeat(5_000) } }]), 0, scope),
    ...toolItemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "u1", content: "Started s12 (active). Its messages show as [s12 · Cards]." }]), 100, scope),
    ...toolItemsFromLine(line("assistant", [{ type: "tool_use", id: "u2", name: I("todo_add"), input: { title: "x", next: "y", waiting_on: "me" } }]), 200, scope),
    ...toolItemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "u2", content: "todo_add failed: the title is blank.", is_error: true }]), 300, scope),
  ];
  it("owner DM: the call has its activity, the result its outcome or reason", () => {
    const paired = pairOutputs(items({ owner: true }), undefined, true);
    const [spawn, spawned, add, failed] = paired as Array<Extract<SubagentItem, { kind: "tool" | "result" }>>;
    expect(spawn.kind === "tool" && spawn.inputTruncated).toBe(true);
    expect(spawn.kind === "tool" && spawn.activity).toMatchObject({ kind: "task_spawn", title: "Cards" });
    expect(spawned.kind === "result" && spawned.outcome).toEqual({ id: "s12", status: "active" });
    expect(add.kind === "tool" && add.activity?.kind).toBe("todo_add");
    expect(failed.kind === "result" && failed.reason).toBe("the title is blank.");
  });
  it("a subagent's transcript (no outcome pairing there) gets no activity: its rows stay plain", () => {
    expect(itemsFromLine(line("assistant", [{ type: "tool_use", id: "x", name: I("schedule_remove"), input: { id: "ab12" } }]), 0)[0])
      .not.toHaveProperty("activity");
  });
  it("memory tools read their input: clipped snippets, line counts, a new file", () => {
    expect(toolActivity(I("memory_write"), { path: "a.md", content: "x\ny", if_version: "new" })).toEqual({ kind: "memory_write", path: "a.md", created: true, chars: 3 });
    expect(toolActivity(I("memory_str_replace"), { path: "a.md", old: "o".repeat(200), new: "n" })).toMatchObject({ old: "o".repeat(80), new: "n" });
    expect(toolActivity(I("memory_append"), { path: "j.md", content: "a\nb\nc\n", create: true })).toEqual({ kind: "memory_append", path: "j.md", lines: 3 });
    // A path the card cannot show exactly is not linked.
    expect(toolActivity(I("memory_delete"), { path: "work/my  notes.md" })).toMatchObject({ pathAltered: true });
    expect(toolActivity(I("memory_delete"), { path: " work/a.md " })).not.toHaveProperty("pathAltered");
    expect(toolActivity(I("memory_delete"), { path: "./work/a.md" })).toMatchObject({ pathAltered: true });
    expect(toolActivity(I("memory_move"), { from: "a.md", to: "work/../b.md" })).toMatchObject({ pathAltered: true });
    expect(toolActivity(I("memory_move"), { from: "a.md", to: "b.md" })).toEqual({ kind: "memory_move", from: "a.md", to: "b.md" });
    expect(toolActivity(I("memory_search"), { query: "kyoto" })).toEqual({ kind: "memory_search", query: "kyoto" });
  });
  it("a group: a memory call has no activity and keeps only its path, wherever it points", () => {
    for (const input of [{ path: "private/notes.md", old: "secret", new: "x" }, { path: "./Private/../private/a.md", old: "s", new: "x" },
      { path: "work/../private/a.md", old: "s", new: "x" }, { path: " private/notes.md ", old: "secret", new: "x" }]) {
      const [call] = toolItemsFromLine(line("assistant", [{ type: "tool_use", id: "m1", name: I("memory_str_replace"), input }]), 0, { workspaceDir: "/w" });
      expect(call.kind === "tool" && call.activity).toBeUndefined();
      expect(call.kind === "tool" && call.input).not.toContain("secret");
    }
    const [moved] = toolItemsFromLine(line("assistant", [{ type: "tool_use", id: "m2", name: I("memory_move"), input: { from: "a.md", to: "private/a.md" } }]), 0, { workspaceDir: "/w" });
    expect(moved.kind === "tool" && moved.activity).toBeUndefined();
    // Every memory call in a group: path only, no card (a link's target can change after the call).
    const [open] = toolItemsFromLine(line("assistant", [{ type: "tool_use", id: "m3", name: I("memory_str_replace"), input: { path: "groups/club/a.md", old: "o-text", new: "n" } }]), 0, { workspaceDir: "/w" });
    expect(open.kind === "tool" && open.activity).toBeUndefined();
    expect(open.kind === "tool" && open.input).not.toContain("o-text");
    // A link inside memory/ into private/: resolved on disk.
    const ws = mkdtempSync(join(ROOT, "ws-"));
    mkdirSync(join(ws, "memory", "private"), { recursive: true });
    symlinkSync(join(ws, "memory", "private"), join(ws, "memory", "alias"));
    const [linked] = toolItemsFromLine(line("assistant", [{ type: "tool_use", id: "m5", name: I("memory_str_replace"), input: { path: "alias/notes.md", old: "secret", new: "x" } }]), 0, { workspaceDir: ws });
    expect(linked.kind === "tool" && linked.activity).toBeUndefined();
    expect(linked.kind === "tool" && linked.input).not.toContain("secret");
    // The owner's own chat: private is theirs.
    const [own] = toolItemsFromLine(line("assistant", [{ type: "tool_use", id: "m4", name: I("memory_str_replace"), input: { path: "private/a.md", old: "o", new: "n" } }]), 0, { owner: true });
    expect(own.kind === "tool" && own.activity).toMatchObject({ kind: "memory_str_replace", path: "private/a.md" });
  });
  it("a group: a call that reaches memory/private has no activity, and its output no outcome", () => {
    const privateCall = toolItemsFromLine(line("assistant", [{ type: "tool_use", id: "p1", name: I("task_message"),
      input: { id: "s1", text: "read memory/private/notes.md" } }]), 0, { workspaceDir: "/w" });
    expect(privateCall[0].kind === "tool" && privateCall[0].activity).toBeUndefined();
    const paired = pairOutputs([...privateCall,
      ...toolItemsFromLine(line("user", [{ type: "tool_result", tool_use_id: "p1", content: "Passed to s1." }]), 100, { workspaceDir: "/w" })]);
    expect(paired[1].kind === "result" && paired[1].outcome).toBeUndefined();
  });
});
