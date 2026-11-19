import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTypingLoop } from "../src/channels/typing-loop.js";

/** A tick whose calls stay pending until the test resolves/rejects them. */
function controlledTick() {
  const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  const tick = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return { tick, pending };
}

describe("startTypingLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks immediately and then on every interval", async () => {
    const tick = vi.fn(async () => {});
    const loop = startTypingLoop({ tick, intervalMs: 1000, ttlMs: 60_000, maxErrors: 3 });
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(4);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it("never overlaps a slow tick with the next interval", async () => {
    const { tick, pending } = controlledTick();
    const loop = startTypingLoop({ tick, intervalMs: 1000, ttlMs: 60_000, maxErrors: 3 });
    expect(tick).toHaveBeenCalledTimes(1);

    // The first tick takes 3.5 intervals; none of those intervals may start another.
    await vi.advanceTimersByTimeAsync(3500);
    expect(tick).toHaveBeenCalledTimes(1);

    pending[0].resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("gives up after maxErrors consecutive failures and runs onStop once", async () => {
    const tick = vi.fn(async () => {
      throw new Error("boom");
    });
    const onGiveUp = vi.fn();
    const onStop = vi.fn(async () => {});
    startTypingLoop({ tick, intervalMs: 1000, ttlMs: 60_000, maxErrors: 3, onGiveUp, onStop });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("a success resets the consecutive-error count", async () => {
    let call = 0;
    const tick = vi.fn(async () => {
      call++;
      if (call % 3 !== 0) throw new Error("flaky");
    });
    const onGiveUp = vi.fn();
    const loop = startTypingLoop({ tick, intervalMs: 1000, ttlMs: 60_000, maxErrors: 3, onGiveUp });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledTimes(11);
    await loop.stop();
  });

  it("stops itself and cleans up when the TTL is reached", async () => {
    const tick = vi.fn(async () => {});
    const onStop = vi.fn(async () => {});
    startTypingLoop({ tick, intervalMs: 1000, ttlMs: 5000, maxErrors: 3, onStop });

    await vi.advanceTimersByTimeAsync(5000);
    expect(onStop).toHaveBeenCalledTimes(1);
    const calls = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() during an in-flight tick waits for it before onStop", async () => {
    const { tick, pending } = controlledTick();
    const order: string[] = [];
    const onStop = vi.fn(async () => {
      order.push("onStop");
    });
    const loop = startTypingLoop({ tick, intervalMs: 1000, ttlMs: 60_000, maxErrors: 3, onStop });

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onStop).not.toHaveBeenCalled();
    expect(stopped).toBe(false);

    order.push("tick settled");
    pending[0].resolve();
    await stopping;
    expect(order).toEqual(["tick settled", "onStop"]);
    expect(stopped).toBe(true);
  });

  it("stop() is idempotent", async () => {
    const onStop = vi.fn(async () => {});
    const loop = startTypingLoop({ tick: async () => {}, intervalMs: 1000, ttlMs: 60_000, maxErrors: 3, onStop });
    await Promise.all([loop.stop(), loop.stop()]);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("swallows an onStop failure", async () => {
    const loop = startTypingLoop({
      tick: async () => {},
      intervalMs: 1000,
      ttlMs: 60_000,
      maxErrors: 3,
      onStop: async () => {
        throw new Error("off failed");
      },
    });
    await expect(loop.stop()).resolves.toBeUndefined();
  });
});
