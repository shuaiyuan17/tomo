import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

const { ContextNudger } = await import("../src/agent/context-nudger.js");
const { WebChannel } = await import("../src/channels/web.js");
const { WatchBus } = await import("../src/watch/bus.js");
const { compactButton, COMPACT_DONE_MS, compactError } = await import("../web/src/compact.js");

const channels: InstanceType<typeof WebChannel>[] = [];
afterEach(async () => { for (const c of channels.splice(0)) await c.stop(); });

describe("owner-requested compact", () => {
  it("queues the compact housekeeping event into the given session, silently, at most one at a time", async () => {
    let finish!: (ok: boolean) => void;
    const calls: Array<[string, string, unknown]> = [];
    const sessions = { getEntry: () => ({ stats: { contextUsed: 150_000, contextMax: 200_000 } }) };
    const nudger = new ContextNudger(sessions as never, (message, key, options) => {
      calls.push([message, key, options]);
      return new Promise<boolean>((r) => { finish = r; });
    });
    const settled = vi.fn();
    expect(nudger.requestCompact("dm:owner", settled)).toBe("queued");
    expect(nudger.requestCompact("dm:owner")).toBe("already_requested");
    expect(calls).toHaveLength(1);
    const [text, key, options] = calls[0];
    expect(key).toBe("dm:owner");
    expect(options).toEqual({ showTyping: false, suppressDelivery: true });
    expect(text).toContain('type="context-nudge"');
    expect(text).toContain('name="compact"');
    expect(text).toContain("The owner requested a compact from the web UI.");
    expect(text).toContain("75% (150000/200000 tokens)");
    expect(text).toContain("lcm compact skill");
    expect(text).toContain("Before compacting, check that no subagent or background task is running; if any is, do not compact");
    expect(text).toContain("NO_REPLY");
    finish(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toHaveBeenCalledWith(true);
    expect(nudger.requestCompact("dm:owner")).toBe("queued");
  });

  it("the web channel targets the owner conversation the browser shows, refuses while tasks run, and publishes each request's state", async () => {
    const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
    const bus = new WatchBus();
    const settle: Array<(ok: boolean) => void> = [];
    const compact = vi.fn((_key: string, onSettled: (ok: boolean) => void) => { settle.push(onSettled); return "queued" as const; });
    // A legacy owner key, as the catalog rule picks it before the canonical one exists.
    const channel = new WebChannel(owner, bus, { compact, ownerKey: () => "telegram:test-owner" });
    channels.push(channel);
    const states: string[] = [];
    channel.events.subscribe(({ event }) => { if (event.type === "compact") states.push(event.request.state); });
    const task = (taskId: string, extra = {}) => ({ taskId, taskType: "local_agent", description: "x", ambient: false, background: true, startedAt: 1, ...extra });
    bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [task("w", { ambient: true })] });
    bus.publish({ type: "tasks", sessionKey: "telegram:-1", tasks: [task("g")] });
    const first = channel.requestCompact();
    expect(first.status).toBe("queued");
    expect(compact.mock.calls[0][0]).toBe("telegram:test-owner");
    expect(channel.snapshot().compact).toMatchObject({ requestId: first.requestId, state: "accepted" });
    settle[0](true);
    expect(channel.snapshot().compact).toMatchObject({ requestId: first.requestId, state: "done" });
    bus.publish({ type: "tasks", sessionKey: "telegram:test-owner", tasks: [task("w", { ambient: true }), task("a")] });
    expect(() => channel.requestCompact()).toThrow(expect.objectContaining({ status: 409, code: "tasks_running" }));
    expect(channel.snapshot().compact!.state).toBe("declined");
    expect(states).toEqual(["accepted", "done", "declined"]);
    expect(compact).toHaveBeenCalledTimes(1);
  });
});

describe("compact button state", () => {
  const req = (state: "accepted" | "declined" | "done" | "failed") => ({ requestId: "r", state, at: 0 });
  it("follows the server's request state", () => {
    expect(compactButton({ ownerSession: false, running: 0, seenAt: 0, now: 0 }).state).toBe("hidden");
    expect(compactButton({ ownerSession: true, running: 0, seenAt: 0, now: 0 })).toEqual({ state: "ready", label: "Compact context" });
    expect(compactButton({ ownerSession: true, running: 2, seenAt: 0, now: 0 })).toEqual({ state: "busy", label: "2 tasks running — wait for them to finish" });
    expect(compactButton({ ownerSession: true, running: 0, request: req("accepted"), seenAt: 0, now: 999_999 }).state).toBe("requested");
    expect(compactButton({ ownerSession: true, running: 0, request: req("done"), seenAt: 0, now: COMPACT_DONE_MS - 1 })).toEqual({ state: "done", label: "Compacted" });
    expect(compactButton({ ownerSession: true, running: 0, request: req("done"), seenAt: 0, now: COMPACT_DONE_MS }).state).toBe("ready");
    expect(compactButton({ ownerSession: true, running: 0, request: req("failed"), seenAt: 0, now: 1 })).toMatchObject({ state: "ready", note: expect.stringContaining("didn't finish") });
    expect(compactButton({ ownerSession: true, running: 0, request: req("declined"), seenAt: 0, now: 1 })).toMatchObject({ note: expect.stringContaining("Tasks were running") });
    expect(compactError("tasks_running")).toContain("Tasks are still running");
  });
});
