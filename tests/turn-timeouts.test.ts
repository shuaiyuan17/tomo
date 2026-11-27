import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUERY_TIMEOUT_ERROR_PREFIX } from "../src/agent/sdk-result.js";
import {
  DELIVERY_TIMEOUT_MS,
  formatTimeout,
  normalizeTimeoutMs,
  queryTimeoutError,
  withDeliveryTimeout,
} from "../src/agent/turn-timeouts.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;

describe("withDeliveryTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Records how the promise settled without leaving a rejection unhandled. */
  function track(promise: Promise<void>): { outcome: () => unknown } {
    let outcome: unknown = "pending";
    promise.then(
      () => { outcome = "resolved"; },
      (err: unknown) => { outcome = err; },
    );
    return { outcome: () => outcome };
  }

  it("rejects with the label once the limit has passed, and not a millisecond earlier", async () => {
    const tracked = track(withDeliveryTimeout(new Promise<void>(() => {}), 1000, "delivery hung"));

    await vi.advanceTimersByTimeAsync(999);
    expect(tracked.outcome()).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    const outcome = tracked.outcome();
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("delivery hung");
  });

  it("resolves when the work finishes first, and leaves no timer behind to reject later", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const tracked = track(withDeliveryTimeout(work, 1000, "delivery hung"));

    await vi.advanceTimersByTimeAsync(400);
    expect(tracked.outcome()).toBe("pending");
    expect(vi.getTimerCount()).toBe(1);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(tracked.outcome()).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(tracked.outcome()).toBe("resolved");
  });

  it("resolves for work that had already finished, with its timer cleared", async () => {
    await expect(withDeliveryTimeout(Promise.resolve(), 1000, "delivery hung")).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the work's own rejection through unchanged, with its timer cleared", async () => {
    const failure = new Error("channel refused the block");
    let fail!: (err: Error) => void;
    const work = new Promise<void>((_, reject) => { fail = reject; });
    const tracked = track(withDeliveryTimeout(work, 1000, "delivery hung"));

    await vi.advanceTimersByTimeAsync(400);
    fail(failure);
    await vi.advanceTimersByTimeAsync(0);

    expect(tracked.outcome()).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("DELIVERY_TIMEOUT_MS", () => {
  it("is shorter than the default inactivity timeout", () => {
    expect(DELIVERY_TIMEOUT_MS).toBeLessThan(normalizeTimeoutMs(undefined));
  });
});

describe("normalizeTimeoutMs", () => {
  it.each<{ name: string; input: number | undefined }>([
    { name: "undefined", input: undefined },
    { name: "NaN", input: Number.NaN },
    { name: "Infinity", input: Number.POSITIVE_INFINITY },
    { name: "-Infinity", input: Number.NEGATIVE_INFINITY },
    { name: "zero", input: 0 },
    { name: "a negative number", input: -1 },
    { name: "a large negative number", input: -60_000 },
  ])("falls back to the ten-minute default for $name", ({ input }) => {
    expect(normalizeTimeoutMs(input)).toBe(TEN_MINUTES_MS);
  });

  it("falls back to the default for a value that is not a number at all", () => {
    expect(normalizeTimeoutMs("30000" as unknown as number)).toBe(TEN_MINUTES_MS);
    expect(normalizeTimeoutMs(null as unknown as number)).toBe(TEN_MINUTES_MS);
  });

  it.each<{ input: number; expected: number }>([
    { input: 1, expected: 1 },
    { input: 30_000, expected: 30_000 },
    { input: TEN_MINUTES_MS, expected: TEN_MINUTES_MS },
    { input: 2 * 60 * 60 * 1000, expected: 2 * 60 * 60 * 1000 },
  ])("keeps the positive whole number $input", ({ input, expected }) => {
    expect(normalizeTimeoutMs(input)).toBe(expected);
  });

  it.each<{ input: number; expected: number }>([
    { input: 1500.9, expected: 1500 },
    { input: 1.999, expected: 1 },
    { input: 59_999.5, expected: 59_999 },
  ])("rounds the fractional $input down to $expected", ({ input, expected }) => {
    expect(normalizeTimeoutMs(input)).toBe(expected);
  });
});

describe("formatTimeout", () => {
  it.each<{ ms: number; expected: string }>([
    { ms: 60_000, expected: "1 minute" },
    { ms: 120_000, expected: "2 minutes" },
    { ms: TEN_MINUTES_MS, expected: "10 minutes" },
    { ms: 90 * 60_000, expected: "90 minutes" },
  ])("writes the whole-minute $ms as '$expected'", ({ ms, expected }) => {
    expect(formatTimeout(ms)).toBe(expected);
  });

  it.each<{ ms: number; expected: string }>([
    { ms: 1000, expected: "1 second" },
    { ms: 2000, expected: "2 seconds" },
    { ms: 59_000, expected: "59 seconds" },
    { ms: 61_000, expected: "61 seconds" },
    { ms: 90_000, expected: "90 seconds" },
  ])("writes the whole-second $ms as '$expected'", ({ ms, expected }) => {
    expect(formatTimeout(ms)).toBe(expected);
  });

  it.each<{ ms: number; expected: string }>([
    { ms: 1, expected: "1ms" },
    { ms: 999, expected: "999ms" },
    { ms: 1500, expected: "1500ms" },
    { ms: 60_001, expected: "60001ms" },
  ])("writes $ms, which is not a whole second, as '$expected'", ({ ms, expected }) => {
    expect(formatTimeout(ms)).toBe(expected);
  });
});

describe("queryTimeoutError", () => {
  it.each<{ ms: number; expected: string }>([
    { ms: TEN_MINUTES_MS, expected: "Query timed out after 10 minutes" },
    { ms: 60_000, expected: "Query timed out after 1 minute" },
    { ms: 45_000, expected: "Query timed out after 45 seconds" },
    { ms: 250, expected: "Query timed out after 250ms" },
  ])("describes a $ms timeout as '$expected'", ({ ms, expected }) => {
    expect(queryTimeoutError(ms)).toBe(expected);
  });

  it("starts with the prefix the retry path recognises a timeout by", () => {
    expect(queryTimeoutError(TEN_MINUTES_MS).startsWith(`${QUERY_TIMEOUT_ERROR_PREFIX} `)).toBe(true);
  });
});
