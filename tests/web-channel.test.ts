import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { MODEL_RETRY_MS, OWNER_KEY_CHECK_MS, WebChannel } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import { WebEvents } from "../src/web/events.js";
import { parseWebConfig } from "../src/web/config.js";
import { webSessionId } from "../src/web/owner.js";
import { MAX_BOARD_TASKS, MAX_SNAPSHOT_TASK_BYTES, SNAPSHOT_SUMMARY_LIMIT, TASK_RETENTION_MS } from "../src/web/tasks.js";
import type { OwnerConfig } from "../src/owner.js";
import { MAX_BUFFER_BYTES, type WebEvent } from "../src/web/protocol.js";

const owner: OwnerConfig = { name: "owner", telegram: ["test-owner"], imessage: [] };
const channels: WebChannel[] = [];
function setup(configured: OwnerConfig | null = owner, ownerKey?: () => string | undefined,
  taskOutput?: (key: string, id: string) => Promise<{ output: string; size: number } | undefined>,
  taskModel?: (key: string, id: string) => Promise<string | undefined>, now?: () => number) {
  const bus = new WatchBus();
  const channel = new WebChannel(configured ?? undefined, bus, { ownerKey, taskOutput, taskModel, now });
  channels.push(channel);
  const handler = vi.fn(async () => true);
  channel.onMessage(handler);
  const events: WebEvent[] = [];
  channel.events.subscribe(({ event }) => events.push(event));
  return { channel, handler, bus, events };
}
afterEach(async () => { for (const channel of channels.splice(0)) await channel.stop(); });

describe("web configuration and owner", () => {
  it("defaults to loopback port 9465 and degrades invalid optional config without reflecting values", () => {
    expect(parseWebConfig(undefined)).toEqual({ enabled: true, port: 9465 });
    expect(parseWebConfig({ enabled: false, port: 9876 })).toEqual({ enabled: false, port: 9876 });
    const diagnostic = vi.fn();
    expect(parseWebConfig({ port: "secret-value" }, diagnostic).enabled).toBe(false);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret-value");
    expect(diagnostic).toHaveBeenCalledOnce();
  });
  it("the web conversation id is derived from the owner's dm: key", () => {
    const { channel } = setup();
    expect(channel.ownerId).toBe(webSessionId("dm:owner"));
    expect(setup(null).channel.ownerId).toBeNull();
  });
});

describe("WebChannel", () => {
  it("evicts settled receipts after capacity while keeping ingress and active outlets alive", async () => {
    const { channel, bus, handler } = setup();
    const active = randomUUID(); await channel.receive({ requestId: active, text: "still running" });
    let evicted = "";
    for (let i = 0; i < 4100; i++) {
      const requestId = randomUUID(); if (i === 0) evicted = requestId;
      await expect(channel.receive({ requestId, text: "settled" })).resolves.toMatchObject({ state: "queued" });
      bus.publish({ type: "turn.end", sessionKey: "dm:owner", requestId, source: "user", ok: true, durationMs: 1 });
    }
    expect(channel.request(evicted).state).toBe("unknown");
    expect(channel.request(active).state).toBe("queued");
    await expect(channel.send({ chatId: active, text: "still deliverable" })).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(4101);
  });
  it("counts unsettled failed delivery against the active cap until the turn ends", async () => {
    const { channel, bus } = setup(); let first = "";
    for (let i = 0; i < 32; i++) {
      const requestId = randomUUID(); if (!first) first = requestId;
      await channel.receive({ requestId, text: "running" });
      await expect(channel.send({ chatId: requestId, text: "x".repeat(MAX_BUFFER_BYTES) })).rejects.toThrow();
    }
    await expect(channel.receive({ requestId: randomUUID(), text: "over cap" })).rejects.toMatchObject({ status: 429 });
    bus.publish({ type: "turn.end", sessionKey: "dm:owner", requestId: first, source: "user", ok: false, durationMs: 1 });
    await expect(channel.receive({ requestId: randomUUID(), text: "next" })).resolves.toMatchObject({ state: "queued" });
  });
  it("hands ordinary owner DM input to Agent and deduplicates both pending and completed receipts", async () => {
    const { channel, handler, bus } = setup();
    const input = { requestId: randomUUID(), text: "Hello" };
    await Promise.all([channel.receive(input), channel.receive(input)]);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: input.requestId, chatId: "owner", isGroup: false, text: "Hello" }));
    bus.publish({ type: "turn.end", sessionKey: "dm:owner", source: "user", ok: true, durationMs: 1, requestId: input.requestId });
    expect((await channel.receive(input)).state).toBe("completed");
    await expect(channel.receive({ ...input, text: "different" })).rejects.toMatchObject({ status: 409 });
    expect(handler).toHaveBeenCalledOnce();
  });
  it("rejects group/unknown targets, and input with no owner configured, before handoff", async () => {
    const { channel, handler } = setup();
    for (const targetId of [webSessionId("telegram:-1"), "dm:owner", "../config.json"]) {
      await expect(channel.receive({ requestId: randomUUID(), text: "blocked", targetId })).rejects.toMatchObject({ status: 403 });
    }
    expect(handler).not.toHaveBeenCalled();
    const ambiguous = setup(null);
    await expect(ambiguous.channel.receive({ requestId: randomUUID(), text: "blocked" })).rejects.toMatchObject({ status: 409 });
    expect(ambiguous.handler).not.toHaveBeenCalled();
  });
  it("reports refusal and closes ingress while preserving an accepted handoff", async () => {
    const { channel, handler } = setup();
    handler.mockResolvedValueOnce(false);
    const requestId = randomUUID();
    await expect(channel.receive({ requestId, text: "refused" })).rejects.toMatchObject({ status: 503 });
    expect(channel.request(requestId).state).toBe("refused");
    channel.closeIngestion();
    await expect(channel.receive({ requestId: randomUUID(), text: "closed" })).rejects.toMatchObject({ status: 503 });
    expect(handler).toHaveBeenCalledOnce();
  });
  it("keeps per-request outlets and never attributes a late send to the next request", async () => {
    const { channel, bus, events } = setup();
    const first = randomUUID(); const second = randomUUID();
    await channel.receive({ requestId: first, text: "first" });
    await channel.send({ chatId: first, text: "first block" });
    bus.publish({ type: "turn.end", sessionKey: "dm:owner", source: "user", ok: true, durationMs: 1, requestId: first });
    await channel.receive({ requestId: second, text: "second" });
    await expect(channel.send({ chatId: first, text: "late" })).rejects.toThrow("unavailable");
    await channel.send({ chatId: second, text: "second block" });
    expect(events.filter((e) => e.type === "block").map((e) => [e.requestId, e.text])).toEqual([[first, "first block"], [second, "second block"]]);
  });
  it("bounds mailbox bytes and leaves failed delivery visible through turn completion", async () => {
    const { channel, bus } = setup();
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "large reply" });
    for (let bytes = 0; bytes < MAX_BUFFER_BYTES - 192 * 1024 - MAX_SNAPSHOT_TASK_BYTES; bytes += 128 * 1024) await channel.send({ chatId: requestId, text: "x".repeat(128 * 1024) });
    await expect(channel.send({ chatId: requestId, text: "x".repeat(128 * 1024) })).rejects.toThrow("mailbox");
    bus.publish({ type: "turn.end", sessionKey: "dm:owner", source: "user", ok: true, durationMs: 1, requestId });
    expect(channel.request(requestId).state).toBe("failed");
    expect(channel.snapshot().blocks).toEqual([]);
    await expect(channel.send({ chatId: requestId, text: "late failed send" })).rejects.toThrow("unavailable");
  });
  it("forwards only safe attributed activity and isolates observers/lifecycle failures", async () => {
    const { channel, bus, events } = setup();
    bus.publish({ type: "tool.start", tool: "Read", detail: "secret arguments" });
    bus.publish({ type: "tool.start", sessionKey: "dm:peer", tool: "Read", detail: "private" });
    bus.publish({ type: "tool.start", sessionKey: "dm:owner", tool: "Read", detail: "secret arguments" });
    bus.publish({ type: "tool.end", sessionKey: "telegram:-1", tool: "Search", ok: true });
    expect(events).toEqual([
      { type: "tool", sessionId: webSessionId("dm:owner"), tool: "Read", state: "started" },
      { type: "tool", sessionId: webSessionId("telegram:-1"), tool: "Search", state: "completed" },
    ]);
    channel.attach({ start: async () => { throw new Error("listen failed"); }, stop: async () => { throw new Error("stop failed"); } });
    await expect(channel.start()).resolves.toBeUndefined();
    await expect(channel.stop()).resolves.toBeUndefined();
  });
});

describe("web task panel feed", () => {
  const live = (taskId: string, description = `task ${taskId}`) =>
    ({ taskId, taskType: "local_agent", description, ambient: false, background: true, startedAt: 1 });
  it("forwards tasks only for sessions the browser can already read, as snapshot and per-session updates", () => {
    const { channel, bus, events } = setup();
    bus.publish({ type: "tasks", sessionKey: "dm:peer", tasks: [live("p", "another person's private work")] });
    bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [live("a")] });
    bus.publish({ type: "tasks", sessionKey: "telegram:-1", tasks: [live("g")] });
    const updates = events.filter((e) => e.type === "tasks");
    expect(updates.map((e) => e.type === "tasks" && [e.sessionId, e.tasks.map((t) => t.taskId)])).toEqual([
      [webSessionId("dm:owner"), ["a"]], [webSessionId("telegram:-1"), ["g"]]]);
    expect(JSON.stringify(events)).not.toContain("private work");
    const snapshot = channel.snapshot();
    expect(snapshot.tasks.map((t) => [t.sessionId, t.taskId, t.state])).toEqual([
      [webSessionId("dm:owner"), "a", "running"], [webSessionId("telegram:-1"), "g", "running"]]);
    expect(JSON.stringify(snapshot)).not.toContain("private work");
    bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [], ended: [{ taskId: "a", status: "completed" }] });
    expect(channel.snapshot().tasks.find((t) => t.taskId === "a")!.state).toBe("completed");
  });
  it("uses the catalog's owner-key rule: a hidden legacy DM never reaches the panel", () => {
    // Canonical key exists: a legacy telegram DM bound to the owner is hidden by the catalog, so its tasks are too.
    const canonical = setup(owner, () => "dm:owner");
    canonical.bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [live("legacy", "legacy secret")] });
    canonical.bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [live("a")] });
    expect(canonical.channel.snapshot().tasks.map((t) => t.taskId)).toEqual(["a"]);
    expect(JSON.stringify(canonical.events)).not.toContain("legacy secret");
    // Several legacy keys match: the catalog shows no owner session, so no DM tasks at all.
    const ambiguous = setup(owner, () => undefined);
    ambiguous.bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [live("x", "ambiguous secret")] });
    ambiguous.bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [live("y", "ambiguous secret")] });
    expect(ambiguous.channel.snapshot().tasks).toEqual([]);
    expect(JSON.stringify(ambiguous.events)).not.toContain("ambiguous secret");
    // The single legacy key the catalog does show is used; when the rule moves on, its tasks leave the snapshot.
    let current: string | undefined = "telegram:test-owner";
    const single = setup(owner, () => current);
    single.bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [live("l")] });
    expect(single.channel.snapshot().tasks.map((t) => t.taskId)).toEqual(["l"]);
    current = "dm:owner";
    expect(single.channel.snapshot().tasks).toEqual([]);
    single.bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [live("c")] });
    expect(single.channel.snapshot().tasks.map((t) => t.taskId)).toEqual(["c"]);
  });
  it("clears the owner's tasks as soon as the owner-key rule changes, with no new event, and never re-sends them", () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let current: string | undefined = "dm:owner";
      const { channel, bus, events } = setup(owner, () => current);
      bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [live("a", "owner work")] });
      bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [live("b", "owner work")] }); // a ends, retained
      const ownerUpdates = () => events.filter((e) => e.type === "tasks" && e.sessionId === channel.ownerId);
      current = undefined; // e.g. a second legacy key appeared: the catalog hides the owner session
      vi.advanceTimersByTime(OWNER_KEY_CHECK_MS);
      expect(ownerUpdates().at(-1)).toMatchObject({ tasks: [] });
      expect(channel.snapshot().tasks).toEqual([]);
      const count = ownerUpdates().length;
      vi.advanceTimersByTime(TASK_RETENTION_MS * 2);
      expect(ownerUpdates()).toHaveLength(count);
    } finally { vi.useRealTimers(); }
  });
  it("with the real registry reader, a legacy DM's tasks stop the moment the canonical key appears", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SessionStore } = await import("../src/sessions/store.js");
    const { ownerSessionKeyReader } = await import("../src/web/data.js");
    const root = mkdtempSync(join(tmpdir(), "tomo-web-owner-key-"));
    try {
      const sessionsDir = join(root, "sessions"), sdkSessionsDir = join(root, "sdk");
      const store = new SessionStore(sessionsDir, 20, sdkSessionsDir);
      store.setSdkSessionId("telegram:test-owner", "sdk-legacy");
      const { channel, bus, events } = setup(owner, ownerSessionKeyReader({ owner, sessionsDir, sdkSessionsDir }));
      bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [live("l", "legacy work")] });
      expect(channel.snapshot().tasks.map((t) => t.taskId)).toEqual(["l"]);
      // The registry gains the canonical key; the very next legacy event is refused — no cache window.
      store.setSdkSessionId("dm:owner", "sdk-owner");
      const before = events.length;
      bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [live("l", "legacy work"), live("m", "legacy secret")] });
      expect(JSON.stringify(events.slice(before))).not.toContain("legacy secret");
      expect(channel.snapshot().tasks).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("after the registry switches, sends triggered by other sessions, capacity or the timer never carry the old owner tasks", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SessionStore } = await import("../src/sessions/store.js");
    const { ownerSessionKeyReader } = await import("../src/web/data.js");
    const root = mkdtempSync(join(tmpdir(), "tomo-web-gate-"));
    vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    try {
      const sessionsDir = join(root, "sessions"), sdkSessionsDir = join(root, "sdk");
      const store = new SessionStore(sessionsDir, 20, sdkSessionsDir);
      store.setSdkSessionId("telegram:test-owner", "sdk-legacy");
      const { channel, bus, events } = setup(owner, ownerSessionKeyReader({ owner, sessionsDir, sdkSessionsDir }));
      bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [live("l1", "legacy secret"), live("l2", "legacy secret")] });
      bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [live("l2", "legacy secret")] }); // l1 ended, retained
      store.setSdkSessionId("dm:owner", "sdk-owner"); // the catalog now hides the legacy session
      const from = events.length;
      // 1. another session's event; 2. a capacity reallocation; 3. the retention timer.
      bus.publish({ type: "tasks", sessionKey: "telegram:-1", tasks: [live("g1")] });
      bus.publish({ type: "tasks", sessionKey: "telegram:-2", tasks: Array.from({ length: 64 }, (_, i) => live(`h${i}`)) });
      vi.advanceTimersByTime(TASK_RETENTION_MS + OWNER_KEY_CHECK_MS);
      const sent = JSON.stringify(events.slice(from));
      expect(sent).not.toContain("legacy secret");
      expect(events.slice(from).some((e) => e.type === "tasks" && e.sessionId === channel.ownerId && e.tasks.length === 0)).toBe(true);
      expect(JSON.stringify(channel.snapshot())).not.toContain("legacy secret");
    } finally { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps recording a hidden DM's events, so it is correct when it becomes visible again", () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let current: string | undefined = "telegram:test-owner";
      const { channel, bus } = setup(owner, () => current);
      bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [live("a"), live("b")] });
      current = undefined; // hidden (e.g. ambiguous)
      expect(channel.snapshot().tasks).toEqual([]);
      // While hidden: a ends with a report, b keeps running.
      bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [live("b")], ended: [{ taskId: "a", status: "failed" }] });
      current = "telegram:test-owner";
      expect(channel.snapshot().tasks.map((t) => [t.taskId, t.state])).toEqual([["b", "running"], ["a", "failed"]]);
      // Hidden past the retention window: the ended task is gone when it returns.
      current = undefined;
      vi.advanceTimersByTime(TASK_RETENTION_MS);
      current = "telegram:test-owner";
      expect(channel.snapshot().tasks.map((t) => t.taskId)).toEqual(["b"]);
    } finally { vi.useRealTimers(); }
  });
  it("one send routes every key by a single owner-rule read, so a switch mid-send never merges two DMs", () => {
    let current = "telegram:test-owner";
    let reads = 0;
    const { channel, bus, events } = setup(owner, () => { reads++; return current; });
    bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [live("legacy-task")] });
    current = "dm:owner";
    bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [live("canonical-task")] });
    // From now on the rule flips on every read: a per-key read would route both DMs to the owner in one send.
    const flip = ["telegram:test-owner", "dm:owner"];
    const ownerKey = () => { reads++; return flip[reads % 2]; };
    (channel as unknown as { ownerKey: () => string }).ownerKey = ownerKey;
    for (let i = 0; i < 4; i++) {
      const before = events.length;
      bus.publish({ type: "tasks", sessionKey: "telegram:-1", tasks: [live(`g${i}`)] });
      for (const e of events.slice(before)) {
        if (e.type !== "tasks" || e.sessionId !== channel.ownerId) continue;
        const ids = e.tasks.map((t) => t.taskId);
        expect(ids.includes("legacy-task") && ids.includes("canonical-task")).toBe(false);
      }
      const ids = channel.snapshot().tasks.filter((t) => t.sessionId === channel.ownerId).map((t) => t.taskId);
      expect(ids.includes("legacy-task") && ids.includes("canonical-task")).toBe(false);
    }
  });
  it("opens only tasks the panel's gate shows, and reads output only for shell/monitor tasks", async () => {
    let current: string | undefined = "dm:owner";
    const reads: Array<[string, string]> = [];
    const { channel, bus } = setup(owner, () => current, async (key, id) => { reads.push([key, id]); return { output: "tail", size: 4 }; });
    bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [live("a1"), { ...live("b1"), taskType: "local_bash" }] });
    bus.publish({ type: "tasks", sessionKey: "dm:peer", tasks: [live("p1")] });
    const ownerId = channel.ownerId!;
    expect(await channel.task(ownerId, "a1", false)).toEqual({ sessionKey: "dm:owner", taskType: "local_agent" });
    expect(await channel.task(ownerId, "b1", true)).toMatchObject({ output: { output: "tail", size: 4 } });
    expect(reads).toEqual([["dm:owner", "b1"]]);
    await expect(channel.task(ownerId, "a1", true)).rejects.toMatchObject({ status: 400, code: "no_task_output" });
    await expect(channel.task(ownerId, "p1", false)).rejects.toMatchObject({ status: 404 });
    await expect(channel.task(webSessionId("dm:peer"), "p1", false)).rejects.toMatchObject({ status: 404 });
    // Hidden by the owner rule: the same task can no longer be opened.
    current = undefined;
    await expect(channel.task(ownerId, "a1", false)).rejects.toMatchObject({ status: 404 });
  });
  it("looks up a subagent's model once it is written, retries politely, caches it, and skips shell tasks", async () => {
    let clock = 0;
    let model: string | undefined;
    const lookups: string[] = [];
    const { channel, bus, events } = setup(owner, undefined, undefined, async (_key, id) => { lookups.push(id); return model; }, () => clock);
    const publish = () => bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [live("a1"), { ...live("b1"), taskType: "local_bash" }] });
    publish();
    await Promise.resolve();
    publish();
    expect(lookups).toEqual(["a1"]);
    model = "claude-opus-5-5";
    clock += MODEL_RETRY_MS;
    publish();
    await new Promise((r) => setTimeout(r, 0));
    expect(lookups).toEqual(["a1", "a1"]);
    expect(channel.snapshot().tasks.find((t) => t.taskId === "a1")!.model).toBe("claude-opus-5-5");
    expect(channel.snapshot().tasks.find((t) => t.taskId === "b1")!.model).toBeUndefined();
    const last = events.filter((e) => e.type === "tasks").at(-1);
    expect(last && last.type === "tasks" && last.tasks.find((t) => t.taskId === "a1")!.model).toBe("claude-opus-5-5");
    // Known now: further events do not read the transcript again, and the model survives REPLACE updates.
    clock += MODEL_RETRY_MS * 3;
    publish();
    expect(lookups).toHaveLength(2);
    expect(channel.snapshot().tasks.find((t) => t.taskId === "a1")!.model).toBe("claude-opus-5-5");
  });
  it("a full mailbox plus a full board still yields the complete task list on reconnect", async () => {
    const { channel, bus } = setup();
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "large reply" });
    await expect((async () => { for (;;) await channel.send({ chatId: requestId, text: "x".repeat(64 * 1024) }); })()).rejects.toThrow("mailbox");
    // Worst case text: long, escaped (lone surrogates), across many groups.
    const nasty = "\ud800".repeat(500);
    for (let g = 0; g < 10; g++) {
      bus.publish({ type: "tasks", sessionKey: `telegram:-${g + 1}`, tasks: Array.from({ length: 30 }, (_, i) => ({
        ...live(`t${g}-${i}`, nasty), taskType: nasty, subagentType: nasty, lastTool: nasty, summary: nasty, parentTaskId: `t${g}-0` })) });
    }
    const snapshot = channel.snapshot();
    expect(snapshot.tasks).toHaveLength(MAX_BOARD_TASKS);
    // The reconnect snapshot keeps (a short) summary.
    expect(snapshot.tasks.every((t) => t.summary !== undefined && t.summary.length <= SNAPSHOT_SUMMARY_LIMIT + 1)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot.tasks))).toBeLessThanOrEqual(MAX_SNAPSHOT_TASK_BYTES);
    // The frame the supervisor sends (with replay) still fits the IPC limit.
    expect(Buffer.byteLength(JSON.stringify({ snapshot, replay: null }))).toBeLessThan(MAX_BUFFER_BYTES - 1024);
  });
});

it("replays bounded events and reports gaps or another epoch", () => {
  const events = new WebEvents();
  events.publish({ type: "invalidate" });
  const cursor = events.cursor();
  events.subscribe(() => { throw new Error("broken observer"); });
  events.publish({ type: "typing", sessionId: "test", active: true });
  expect(events.after(cursor)?.map((v) => v.event.type)).toEqual(["typing"]);
  for (let i = 0; i < 1001; i++) events.publish({ type: "invalidate" });
  expect(events.after(cursor)).toBeNull();
  expect(events.after("previous-epoch:1")).toBeNull();
  expect(events.after(events.cursor())).toEqual([]);
});

it("selectOwnerSessionKey: canonical first, then a single legacy key, none when ambiguous", async () => {
  const { selectOwnerSessionKey } = await import("../src/web/data.js");
  const two: OwnerConfig = { name: "owner", telegram: ["test-owner"], imessage: ["owner@example.com"] };
  expect(selectOwnerSessionKey(undefined, ["dm:owner"])).toBeUndefined();
  expect(selectOwnerSessionKey(two, ["dm:owner", "telegram:test-owner"])).toBe("dm:owner");
  expect(selectOwnerSessionKey(two, ["telegram:test-owner", "telegram:-5"])).toBe("telegram:test-owner");
  expect(selectOwnerSessionKey(two, ["telegram:test-owner", "imessage:owner@example.com"])).toBeUndefined();
  expect(selectOwnerSessionKey(two, [])).toBe("dm:owner");
});
