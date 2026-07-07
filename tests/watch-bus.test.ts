import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchBus } from "../src/watch/bus.js";
import { watchBus } from "../src/watch/bus.js";

afterEach(() => {
  watchBus.reset();
  vi.restoreAllMocks();
});

describe("WatchBus", () => {
  it("delivers published events to subscribers with a timestamp", () => {
    const bus = new WatchBus();
    const seen: unknown[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.publish({ type: "heartbeat" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "heartbeat" });
    expect((seen[0] as { ts: number }).ts).toBeGreaterThan(0);
  });

  it("preserves an explicit ts", () => {
    const bus = new WatchBus();
    bus.publish({ type: "heartbeat", ts: 123 });
    expect(bus.recent()[0].ts).toBe(123);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new WatchBus();
    const seen: unknown[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));
    unsub();
    bus.publish({ type: "heartbeat" });
    expect(seen).toHaveLength(0);
  });

  it("a throwing subscriber does not break publish or other subscribers", () => {
    const bus = new WatchBus();
    const seen: unknown[] = [];
    bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((e) => seen.push(e));
    expect(() => bus.publish({ type: "heartbeat" })).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("bounds the ring buffer and returns most-recent events oldest-first", () => {
    const bus = new WatchBus();
    for (let i = 0; i < 1200; i++) {
      bus.publish({ type: "issue", level: "warn", msg: `m${i}`, ts: i });
    }
    const recent = bus.recent(10);
    expect(recent).toHaveLength(10);
    expect(recent[0].ts).toBe(1190);
    expect(recent[9].ts).toBe(1199);
    expect(bus.recent().length).toBeLessThanOrEqual(1000);
  });

  it("tracks the last issue", () => {
    const bus = new WatchBus();
    expect(bus.lastIssue()).toBeNull();
    bus.publish({ type: "issue", level: "warn", msg: "first" });
    bus.publish({ type: "heartbeat" });
    bus.publish({ type: "issue", level: "error", msg: "second" });
    expect(bus.lastIssue()).toMatchObject({ level: "error", msg: "second" });
  });
});

describe("logger issue tap", () => {
  it("publishes warn/error log calls as issue events", async () => {
    const { log } = await import("../src/logger.js");
    watchBus.reset();

    log.warn({ err: new Error("disk full") }, "Could not save");
    log.error("outright failure");
    log.info("routine line");

    const issues = watchBus.recent().filter((e) => e.type === "issue");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ level: "warn" });
    expect((issues[0] as { msg: string }).msg).toContain("Could not save");
    expect((issues[0] as { msg: string }).msg).toContain("disk full");
    expect(issues[1]).toMatchObject({ level: "error", msg: "outright failure" });
  });
});
