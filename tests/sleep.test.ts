import { describe, expect, it } from "vitest";
import { sleepSync } from "../src/sleep.js";
import { sleepMs } from "../src/lcm/compact.js";

describe("sleepSync", () => {
  it("blocks the calling thread for the requested time", () => {
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const started = performance.now();
    const result: void = sleepSync(60);
    const elapsed = performance.now() - started;
    clearTimeout(timer);
    // Only a lower bound (with slack for timer granularity): a loaded machine
    // can overshoot by any amount, but nothing can make a real wait shorter.
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(result).toBeUndefined();
    // The event loop never ran: the wait was synchronous, not a timer.
    expect(timerFired).toBe(false);
  });

  it("returns at once for a zero wait", () => {
    const started = performance.now();
    sleepSync(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("is still exported from lcm/compact as sleepMs", () => {
    const started = performance.now();
    sleepMs(30);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });
});
