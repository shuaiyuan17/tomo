import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SUBSESSION_EVENT_MS, WebChannel, type WebSubsessionAccess } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import type { SubsessionRecord } from "../src/agent/subsessions/types.js";
import type { OwnerConfig } from "../src/owner.js";
import { rpcSchema, type WebEvent, type WebSubsession } from "../src/web/protocol.js";
import { BRIEF_LIMIT, ENTRY_LIMIT, MAX_RAIL_SUBSESSIONS, SUBSESSION_ENDED_VISIBLE_MS, UPDATES_LIMIT, subsessionDetail, subsessionUpdates, subsessionList, subsessionView } from "../src/web/subsessions-view.js";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
function record(id: string, extra: Partial<SubsessionRecord> = {}): SubsessionRecord {
  return {
    id, sessionKey: `task:${id}`, parentKey: "dm:owner", title: `Task ${id}`, brief: "Do the thing.", status: "active",
    createdAt: NOW - 2 * H, lastActivityAt: NOW - 60_000, activeMs: 1000, resumeNeeded: false, startDelivered: true,
    interruptStreak: 0, failStreak: 0, turnsWithoutProgress: 0, restartRequested: false, reportDelivered: false,
    compactPending: false, postCompactReminder: false, pendingInput: [], nextInputSeq: 1, replyMap: [], ownerMessageIds: [],
    conversation: [], conversationSeq: 0, mirrorSeenSeq: 0, seenThrough: 0, sent: [], transitions: [], ...extra,
  };
}

describe("the rail's view of sub-sessions", () => {
  it("shows only the owner's scope, never another session's tasks or archived ones", () => {
    const tasks = [record("s1"), record("s2", { parentKey: "telegram:-100" }), record("s3", { status: "archived", endedAt: NOW - H })];
    expect(subsessionList(tasks, "dm:owner", NOW, () => false).map((t) => t.id)).toEqual(["s1"]);
    expect(subsessionView(tasks[1], "dm:owner", NOW, false)).toBeUndefined();
    expect(subsessionDetail(tasks[1], "dm:owner", NOW, false)).toBeUndefined();
    expect(subsessionDetail(tasks[2], "dm:owner", NOW, false)).toBeUndefined();
  });

  it("lists open tasks oldest first, then recently ended ones newest first, and drops old ended ones", () => {
    const tasks = [
      record("s1", { status: "finished", endedAt: NOW - 2 * H }),
      record("s2", { status: "waiting", waitingOn: "owner", createdAt: NOW - H }),
      record("s3", { status: "queued", createdAt: NOW - 3 * H }),
      record("s4", { status: "cancelled", endedAt: NOW - H }),
      record("s5", { status: "failed", endedAt: NOW - SUBSESSION_ENDED_VISIBLE_MS - 1 }),
    ];
    expect(subsessionList(tasks, "dm:owner", NOW, () => false).map((t) => t.id)).toEqual(["s3", "s2", "s4", "s1"]);
    const many = Array.from({ length: MAX_RAIL_SUBSESSIONS + 5 }, (_, i) => record(`s${i + 1}`, { createdAt: NOW - i }));
    // Every open task is listed however many there are; ended ones only fill what is left.
    expect(subsessionList(many, "dm:owner", NOW, () => false)).toHaveLength(MAX_RAIL_SUBSESSIONS + 5);
    const ended = Array.from({ length: MAX_RAIL_SUBSESSIONS }, (_, i) => record(`e${i}`, { status: "finished", endedAt: NOW - i - 1 }));
    expect(subsessionList([record("s1"), record("s2"), ...ended], "dm:owner", NOW, () => false).map((t) => t.id).slice(0, 3)).toEqual(["s1", "s2", "e0"]);
    expect(subsessionList([record("s1"), record("s2"), ...ended], "dm:owner", NOW, () => false)).toHaveLength(MAX_RAIL_SUBSESSIONS);
  });

  it("marks writable exactly the statuses the owner may still write to, and working only while open", () => {
    const view = (status: SubsessionRecord["status"], working = true) => subsessionView(record("s1", { status, ...(status === "waiting" ? { waitingOn: "external" as const } : {}) }), "dm:owner", NOW, working)!;
    expect(["queued", "active", "waiting", "finished"].map((s) => view(s as SubsessionRecord["status"]).writable)).toEqual([true, true, true, true]);
    expect(view("cancelled").writable).toBe(false);
    expect(view("failed").writable).toBe(false);
    expect(view("active").working).toBe(true);
    expect(view("finished").working).toBe(false);
    expect(view("waiting")).toMatchObject({ status: "waiting", waitingOn: "external" });
  });

  it("marks a task waiting on something external as working in the background only while its background work runs", () => {
    const waiting = record("s1", { status: "waiting", waitingOn: "external" });
    expect(subsessionView(waiting, "dm:owner", NOW, false, { background: true })).toMatchObject({ status: "waiting", waitingOn: "external", background: true });
    expect(subsessionView(waiting, "dm:owner", NOW, false, {})).not.toHaveProperty("background");
    // Never for a task waiting on the owner, nor one that is not waiting.
    expect(subsessionView(record("s2", { status: "waiting", waitingOn: "owner" }), "dm:owner", NOW, false, { background: true })).not.toHaveProperty("background");
    expect(subsessionView(record("s3", { status: "active" }), "dm:owner", NOW, false, { background: true })).not.toHaveProperty("background");
    const list = subsessionList([waiting, record("s4", { status: "waiting", waitingOn: "external", createdAt: NOW + 1 })], "dm:owner", NOW, () => false, (r) => ({ background: r.id === "s1" }));
    expect(list.map((v) => [v.id, v.background ?? false])).toEqual([["s1", true], ["s4", false]]);
    expect(subsessionDetail(waiting, "dm:owner", NOW, false, { background: true })?.background).toBe(true);
    expect(subsessionView(waiting, "dm:owner", NOW, false, { model: "claude-sonnet-5-5[1m]" })?.model).toBe("claude-sonnet-5-5[1m]");
    expect(subsessionView(waiting, "dm:owner", NOW, false)).not.toHaveProperty("model");
  });

  it("carries the conversation, brief and report, clipped to fit the IPC frame", () => {
    const detail = subsessionDetail(record("s1", {
      brief: "b".repeat(BRIEF_LIMIT + 10), quote: ["what the owner said"], report: "Done.", conversationSeq: 2,
      conversation: [{ seq: 1, at: NOW, from: "owner", kind: "message", text: "hi", files: 2 }, { seq: 2, at: NOW, from: "task", kind: "ask", text: "x".repeat(ENTRY_LIMIT + 5) }],
    }), "dm:owner", NOW, false)!;
    expect(detail.briefTruncated).toBe(true);
    expect(Array.from(detail.brief)).toHaveLength(BRIEF_LIMIT + 1);
    expect(detail.quote).toEqual(["what the owner said"]);
    expect(detail.report).toBe("Done.");
    expect(detail.revision).toBe(2);
    expect(detail.conversation[0]).toEqual({ seq: 1, at: NOW, from: "owner", kind: "message", text: "hi", files: 2 });
    expect(Array.from(detail.conversation[1].text)).toHaveLength(ENTRY_LIMIT + 1);
  });
});

describe("a sub-session's plan, done steps and updates", () => {
  const transitions: SubsessionRecord["transitions"] = [
    { at: NOW - 50, from: null, to: "queued", event: "spawn" },
    { at: NOW - 40, from: "queued", to: "active", event: "start" },
    { at: NOW - 30, from: "active", to: "waiting", event: "wait_external" },
    { at: NOW - 25, from: "waiting", to: "queued", event: "cron_wake" },
    { at: NOW - 24, from: "queued", to: "active", event: "start" },
    { at: NOW - 10, from: "active", to: "waiting", event: "ask" },
    { at: NOW - 5, from: "waiting", to: "active", event: "owner_message" },
    { at: NOW, from: "active", to: "finished", event: "finish" },
  ];

  it("lists the task's updates and its milestones, newest first, without the queued/active churn", () => {
    const r = record("s1", { transitions, updates: [{ at: NOW - 35, text: "Chose approach B" }, { at: NOW - 15, kind: "plan", text: "Dropped step C" }, { at: NOW, text: "Shipped" }] });
    expect(subsessionUpdates(r)).toEqual([
      // At the same instant the milestone reads as the later of the two.
      { at: NOW, kind: "milestone", milestone: "finished" },
      { at: NOW, kind: "update", text: "Shipped" },
      { at: NOW - 10, kind: "milestone", milestone: "waitingOwner" },
      { at: NOW - 15, kind: "update", text: "Dropped step C", plan: true },
      { at: NOW - 35, kind: "update", text: "Chose approach B" },
      { at: NOW - 40, kind: "milestone", milestone: "started" },
    ]);
    // Once the spawn has left the capped log, no start reads as the first one.
    expect(subsessionUpdates(record("s1", { transitions: transitions.slice(1) })).some((e) => e.kind === "milestone" && e.milestone === "started")).toBe(false);
    expect(subsessionUpdates(record("s1", { transitions: [{ at: NOW, from: "active", to: "failed", event: "fail" }] }))).toEqual([{ at: NOW, kind: "milestone", milestone: "failed" }]);
  });

  it("caps the updates it sends, keeps done steps in order, and shows the plan only while the task is open", () => {
    const updates = Array.from({ length: 30 }, (_, i) => ({ at: NOW - 1000 + i, text: `u${i}` }));
    const many = Array.from({ length: 30 }, (_, i) => ({ at: NOW - 2000 + i, from: "active" as const, to: "finished" as const, event: "finish" }));
    expect(subsessionUpdates(record("s1", { updates, transitions: many }))).toHaveLength(UPDATES_LIMIT);
    const plan = [{ text: "Write tests", status: "in_progress" as const }, { text: "Open the PR", status: "pending" as const }];
    const doneSteps = [{ at: NOW - 20, text: "Read the code", result: "found it" }, { at: NOW - 10, text: "Fix it" }];
    const open = subsessionDetail(record("s1", { plan, doneSteps }), "dm:owner", NOW, false)!;
    expect(open.plan).toEqual(plan);
    expect(open.doneSteps).toEqual(doneSteps);
    const ended = subsessionDetail(record("s1", { plan, doneSteps, status: "finished", endedAt: NOW }), "dm:owner", NOW, false)!;
    expect(ended).not.toHaveProperty("plan");
    expect(ended.doneSteps).toEqual(doneSteps);
    // Nothing to show, nothing sent; and the list rows never carry any of it.
    const bare = subsessionDetail(record("s1"), "dm:owner", NOW, false)!;
    for (const key of ["plan", "doneSteps", "updates"]) expect(bare).not.toHaveProperty(key);
    const row = subsessionView(record("s1", { plan, doneSteps, updates }), "dm:owner", NOW, false)!;
    for (const key of ["plan", "doneSteps", "updates"]) expect(row).not.toHaveProperty(key);
  });
});

describe("the task table tells its listener about every write", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it("calls onChange after a write, and a throwing listener does not fail the write", () => {
    dir = mkdtempSync(join(tmpdir(), "tomo-web-sub-"));
    const onChange = vi.fn(() => { throw new Error("listener broke"); });
    const store = new SubsessionStore(join(dir, "t.json"), { onChange });
    const created = store.create({ parentKey: "dm:owner", title: "T", brief: "b" });
    expect(onChange).toHaveBeenCalledTimes(1);
    store.update(created.id, (r) => { r.progress = "halfway"; });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(store.get(created.id)?.progress).toBe("halfway");
    store.list();
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

const owner: OwnerConfig = { name: "owner", telegram: ["test-owner"], imessage: [] };
const channels: WebChannel[] = [];
afterEach(async () => { vi.useRealTimers(); for (const channel of channels.splice(0)) await channel.stop(); });
const summary = (id: string): WebSubsession => ({ id, title: "T", status: "waiting", waitingOn: "owner", working: false, createdAt: 1, lastActivityAt: 1, activeMs: 0, revision: 3, writable: true });
function setup(access?: Partial<WebSubsessionAccess>, configured: OwnerConfig | null = owner) {
  const bus = new WatchBus();
  const full: WebSubsessionAccess | undefined = access ? {
    list: () => ({ available: true, tasks: [summary("s1")] }), get: () => undefined,
    message: () => ({ ok: true, duplicate: false, task: summary("s1") }), ...access } : undefined;
  const channel = new WebChannel(configured ?? undefined, bus, { ...(full ? { subsessions: full } : {}) });
  channels.push(channel);
  const handler = vi.fn(async () => true);
  channel.onMessage(handler);
  const events: WebEvent[] = [];
  channel.events.subscribe(({ event }) => events.push(event));
  return { channel, bus, events, handler };
}

describe("WebChannel: the owner's sub-sessions", () => {
  it("writes to a task through the access only, never through the DM's message handler", () => {
    const message = vi.fn(() => ({ ok: true as const, duplicate: false, task: summary("s1") }));
    const { channel, handler } = setup({ message });
    const requestId = randomUUID();
    expect(channel.messageSubsession("s1", { requestId, text: "use plan B" })).toEqual({ status: "delivered", task: summary("s1") });
    expect(message).toHaveBeenCalledWith("s1", "use plan B", requestId);
    expect(handler).not.toHaveBeenCalled();
  });

  it("names each refusal, and refuses with no owner or with sub-sessions off", () => {
    const codes: Array<[string, number, string]> = [["unknown", 404, "subsession_not_found"], ["ended", 409, "subsession_ended"], ["full", 429, "subsession_inbox_full"], ["unreadable", 503, "subsessions_unavailable"]];
    for (const [reason, status, code] of codes) {
      const { channel } = setup({ message: () => ({ ok: false, reason: reason as "unknown" }) });
      expect(() => channel.messageSubsession("s1", { requestId: randomUUID(), text: "x" })).toThrow(expect.objectContaining({ status, code }));
    }
    expect(() => setup().channel.messageSubsession("s1", { requestId: randomUUID(), text: "x" })).toThrow(expect.objectContaining({ status: 503, code: "subsessions_unavailable" }));
    expect(() => setup({}, null).channel.messageSubsession("s1", { requestId: randomUUID(), text: "x" })).toThrow(expect.objectContaining({ status: 409, code: "owner_setup_required" }));
    expect(setup().channel.subsessionList()).toEqual({ available: false, tasks: [] });
    expect(() => setup({ get: () => undefined }).channel.subsession("s9")).toThrow(expect.objectContaining({ status: 404, code: "subsession_not_found" }));
    // A table that cannot be read right now is not "gone": the chat reads again.
    expect(() => setup({ get: () => null }).channel.subsession("s1")).toThrow(expect.objectContaining({ status: 503, code: "subsessions_unavailable" }));
  });

  it("tells the browser of a burst of table changes once", async () => {
    vi.useFakeTimers();
    const { channel, events } = setup({});
    channel.publishSubsessionsChanged(); channel.publishSubsessionsChanged(); channel.publishSubsessionsChanged();
    expect(events.filter((e) => e.type === "subsessions")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SUBSESSION_EVENT_MS);
    expect(events.filter((e) => e.type === "subsessions")).toHaveLength(1);
  });

  it("a task's turn starting or ending updates the rail, and nothing else about it reaches the browser", async () => {
    vi.useFakeTimers();
    const { bus, events } = setup({});
    bus.publish({ type: "turn.start", sessionKey: "task:s1", source: "background" } as never);
    bus.publish({ type: "transcript", sessionKey: "task:s1" } as never);
    bus.publish({ type: "tool.start", sessionKey: "task:s1", tool: "Bash" } as never);
    await vi.advanceTimersByTimeAsync(SUBSESSION_EVENT_MS);
    expect(events.map((e) => e.type)).toEqual(["subsessions"]);
  });
});

describe("the RPC surface for sub-sessions", () => {
  it("accepts only sub-session ids and a non-empty message", () => {
    const epoch = randomUUID();
    const ok = (input: unknown) => rpcSchema.safeParse(input).success;
    expect(ok({ method: "subsession", id: "s12" })).toBe(true);
    for (const id of ["s0", "dm:owner", "task:s1", "S1", "s1/../x", "telegram:-100"]) expect(ok({ method: "subsession", id })).toBe(false);
    expect(ok({ method: "subsession-message", epoch, id: "s1", input: { requestId: randomUUID(), text: "hi" } })).toBe(true);
    expect(ok({ method: "subsession-message", epoch, id: "s1", input: { requestId: randomUUID(), text: "   " } })).toBe(false);
    expect(ok({ method: "subsession-message", epoch, id: "s1", input: { requestId: randomUUID(), text: "hi", targetId: "x" } })).toBe(false);
  });
});
