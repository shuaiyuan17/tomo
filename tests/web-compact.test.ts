import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

const { ContextNudger } = await import("../src/agent/context-nudger.js");
const { WebChannel } = await import("../src/channels/web.js");
const { WatchBus } = await import("../src/watch/bus.js");
const { compactButton, compactSettled, COMPACT_PENDING_MS, compactError } = await import("../web/src/compact.js");

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
    expect(nudger.requestCompact("dm:owner")).toBe("queued");
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
    expect(text).toContain("NO_REPLY");
    finish(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(nudger.requestCompact("dm:owner")).toBe("queued");
  });

  it("the web channel refuses while the owner's session has running tasks (ambient and other sessions do not count)", () => {
    const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
    const bus = new WatchBus();
    const compact = vi.fn(() => "queued" as const);
    const channel = new WebChannel(owner, bus, { compact });
    channels.push(channel);
    const task = (taskId: string, extra = {}) => ({ taskId, taskType: "local_agent", description: "x", ambient: false, background: true, startedAt: 1, ...extra });
    bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [task("w", { ambient: true })] });
    bus.publish({ type: "tasks", sessionKey: "telegram:-1", tasks: [task("g")] });
    expect(channel.requestCompact()).toEqual({ status: "queued" });
    bus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [task("w", { ambient: true }), task("a")] });
    expect(() => channel.requestCompact()).toThrow(expect.objectContaining({ status: 409, code: "tasks_running" }));
    expect(compact).toHaveBeenCalledTimes(1);
  });
});

describe("compact button state", () => {
  it("hidden outside the owner session; disabled while tasks run; requested until context drops or time passes", () => {
    expect(compactButton({ ownerSession: false, running: 0, contextUsed: 0, now: 0 }).state).toBe("hidden");
    expect(compactButton({ ownerSession: true, running: 0, contextUsed: 100, now: 0 })).toEqual({ state: "ready", label: "Compact context" });
    expect(compactButton({ ownerSession: true, running: 2, contextUsed: 100, now: 0 })).toEqual({ state: "busy", label: "2 tasks running — wait for them to finish" });
    const request = { at: 0, usedAtRequest: 100_000 };
    expect(compactButton({ ownerSession: true, running: 0, request, contextUsed: 95_000, now: 1_000 }).state).toBe("requested");
    expect(compactSettled(request, 50_000, 1_000)).toBe(true);
    expect(compactSettled(request, 95_000, COMPACT_PENDING_MS)).toBe(true);
    expect(compactError("tasks_running")).toContain("Tasks are still running");
  });
});
