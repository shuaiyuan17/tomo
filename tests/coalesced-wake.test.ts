import { describe, expect, it } from "vitest";
import { CoalescedWake } from "../src/agent/coalesced-wake.js";

/** A per-key queue whose tasks start only when the test says so. */
function manualQueue() {
  const waiting: Array<{ key: string; start: () => Promise<void> }> = [];
  const enqueue = (key: string, task: () => Promise<void>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      waiting.push({ key, start: () => task().then(resolve, reject) });
    });
  const startNext = async (): Promise<void> => {
    const next = waiting.shift();
    if (!next) throw new Error("nothing queued");
    await next.start().catch(() => {});
  };
  return { enqueue, waiting, startNext };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("CoalescedWake", () => {
  it("merges a wake asked for while one is queued", async () => {
    const q = manualQueue();
    const wake = new CoalescedWake(q.enqueue);
    let runs = 0;
    expect(wake.schedule("a", async () => { runs++; }, () => {})).toBe(true);
    expect(wake.isQueued("a")).toBe(true);
    expect(wake.schedule("a", async () => { runs += 10; }, () => {})).toBe(false);
    expect(q.waiting).toHaveLength(1);
    await q.startNext();
    expect(runs).toBe(1);
  });

  it("frees the key when the turn starts, so a wake asked for during it queues the next one", async () => {
    const q = manualQueue();
    const wake = new CoalescedWake(q.enqueue);
    let queuedDuringRun: boolean | undefined;
    let second = false;
    wake.schedule("a", async () => {
      queuedDuringRun = wake.isQueued("a");
      expect(wake.schedule("a", async () => { second = true; }, () => {})).toBe(true);
    }, () => {});
    await q.startNext();
    expect(queuedDuringRun).toBe(false);
    expect(wake.isQueued("a")).toBe(true);
    await q.startNext();
    expect(second).toBe(true);
    expect(wake.isQueued("a")).toBe(false);
  });

  it("frees the key and reports the error when the queued task rejects", async () => {
    const q = manualQueue();
    const wake = new CoalescedWake(q.enqueue);
    const errors: unknown[] = [];
    const boom = new Error("boom");
    wake.schedule("a", async () => { throw boom; }, (err) => errors.push(err));
    await q.startNext();
    await flush();
    expect(errors).toEqual([boom]);
    expect(wake.isQueued("a")).toBe(false);
    expect(wake.schedule("a", async () => {}, () => {})).toBe(true);
  });

  it("frees the key when the queue itself rejects before the task runs", async () => {
    const errors: unknown[] = [];
    const wake = new CoalescedWake(() => Promise.reject(new Error("queue closed")));
    let ran = false;
    wake.schedule("a", async () => { ran = true; }, (err) => errors.push(err));
    expect(wake.isQueued("a")).toBe(true);
    await flush();
    expect(ran).toBe(false);
    expect(errors).toHaveLength(1);
    expect(wake.isQueued("a")).toBe(false);
  });

  it("keeps keys independent", async () => {
    const q = manualQueue();
    const wake = new CoalescedWake(q.enqueue);
    const ran: string[] = [];
    expect(wake.schedule("a", async () => { ran.push("a"); }, () => {})).toBe(true);
    expect(wake.schedule("b", async () => { ran.push("b"); }, () => {})).toBe(true);
    expect(q.waiting.map((w) => w.key)).toEqual(["a", "b"]);
    await q.startNext();
    expect(wake.isQueued("a")).toBe(false);
    expect(wake.isQueued("b")).toBe(true);
    await q.startNext();
    expect(ran).toEqual(["a", "b"]);
  });
});
