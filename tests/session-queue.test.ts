import { describe, expect, it } from "vitest";
import { SessionQueue } from "../src/agent/session-queue.js";

describe("SessionQueue", () => {
  it("serializes work for the same session key and cleans up after draining", async () => {
    const queue = new SessionQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = queue.enqueue("telegram:123", async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push("first:end");
      return "first";
    });
    const second = queue.enqueue("telegram:123", async () => {
      events.push("second");
      return "second";
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second"]);

    await queue.drain();
    expect((queue as unknown as { queues: Map<string, Promise<void>> }).queues.size).toBe(0);
  });

  it("keeps later work running after an earlier task rejects", async () => {
    const queue = new SessionQueue();
    const events: string[] = [];

    const first = queue.enqueue("telegram:123", async () => {
      events.push("first");
      throw new Error("boom");
    });
    const second = queue.enqueue("telegram:123", async () => {
      events.push("second");
      return "second";
    });

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first", "second"]);
  });
});
