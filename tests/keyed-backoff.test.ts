import { describe, expect, it } from "vitest";
import { KeyedBackoff, backoffDelay, type BackoffTimers } from "../src/agent/keyed-backoff.js";

function fakeTimers(): BackoffTimers & { live: Array<{ fn: () => void; ms: number; cleared: boolean }> } {
  const live: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    live,
    set: (fn, ms) => { const t = { fn, ms, cleared: false }; live.push(t); return t; },
    clear: (h) => { (h as { cleared: boolean }).cleared = true; },
  };
}

describe("backoffDelay", () => {
  it("doubles from the base and stops at the cap, even for huge attempts", () => {
    expect([1, 2, 3, 4].map((n) => backoffDelay(n, 10, 50))).toEqual([10, 20, 40, 50]);
    expect(backoffDelay(5000, 10, 50)).toBe(50);
  });
});

describe("KeyedBackoff", () => {
  it("arms one timer per key, counts attempts across fires, and flags the first capped attempt", () => {
    const timers = fakeTimers();
    const fired: string[] = [];
    const b = new KeyedBackoff(10, 40, (k) => fired.push(k), timers);
    expect(b.schedule("a")).toEqual({ attempt: 1, delayMs: 10, capped: false });
    expect(b.schedule("a")).toBeUndefined();
    expect(b.isPending("a")).toBe(true);
    timers.live[0].fn();
    expect(fired).toEqual(["a"]);
    expect(b.isPending("a")).toBe(false);
    expect(b.schedule("a")).toEqual({ attempt: 2, delayMs: 20, capped: false });
    timers.live[1].fn();
    expect(b.schedule("a")).toEqual({ attempt: 3, delayMs: 40, capped: true });
    timers.live[2].fn();
    expect(b.schedule("a")).toEqual({ attempt: 4, delayMs: 40, capped: false });
    // Another key is independent.
    expect(b.schedule("b")).toEqual({ attempt: 1, delayMs: 10, capped: false });
  });

  it("reset clears the pending timer and the attempt count", () => {
    const timers = fakeTimers();
    const b = new KeyedBackoff(10, 40, () => {}, timers);
    b.schedule("a");
    timers.live[0].fn();
    b.schedule("a");
    b.reset("a");
    expect(timers.live[1].cleared).toBe(true);
    expect(b.isPending("a")).toBe(false);
    expect(b.schedule("a")).toMatchObject({ attempt: 1, delayMs: 10 });
  });

  it("stop clears every pending timer", () => {
    const timers = fakeTimers();
    const b = new KeyedBackoff(10, 40, () => {}, timers);
    b.schedule("a");
    b.schedule("b");
    b.stop();
    expect(timers.live.every((t) => t.cleared)).toBe(true);
    expect(b.isPending("a") || b.isPending("b")).toBe(false);
  });
});
