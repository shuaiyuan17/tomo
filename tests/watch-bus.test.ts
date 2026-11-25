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
    // `recent()` with no limit is already capped at the ring's 500, so it says
    // nothing about the ring itself. Ask for more than was ever published: an
    // unbounded ring would hand back all 1200 here. The ring trims to 500 once
    // it passes 1000, so it may hold anything up to 1000 between trims.
    const all = bus.recent(Infinity);
    expect(all.length).toBeLessThanOrEqual(1000);
    expect(all.length).toBeGreaterThanOrEqual(500);
    expect(all.at(-1)?.ts).toBe(1199);
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
