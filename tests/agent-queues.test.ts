import { describe, expect, it } from "vitest";
import { PendingNotesQueue, type DurablePendingNotesStore } from "../src/agent/pending-notes-queue.js";
import { SessionQueue } from "../src/agent/session-queue.js";

class MemoryPendingNotesStore implements DurablePendingNotesStore {
  notes = new Map<string, string[]>();

  getPendingNotes(key: string): string[] {
    return [...(this.notes.get(key) ?? [])];
  }

  setPendingNotes(key: string, notes: string[]): void {
    if (notes.length === 0) {
      this.notes.delete(key);
    } else {
      this.notes.set(key, [...notes]);
    }
  }
}

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

describe("PendingNotesQueue", () => {
  it("persists pending notes, caps them, and drains once", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);

    for (let i = 0; i < 20; i++) {
      queue.queueNote("telegram:-987", `note-${i}`);
    }

    expect(queue.peekNotes("telegram:-987")).toHaveLength(15);
    expect(queue.peekNotes("telegram:-987")[0]).toBe("note-5");
    expect(store.getPendingNotes("telegram:-987").at(-1)).toBe("note-19");

    const drained = queue.drain("telegram:-987");
    expect(drained).toContain("note-5");
    expect(drained).toContain("note-19");
    expect(queue.drain("telegram:-987")).toBe("");
    expect(store.getPendingNotes("telegram:-987")).toEqual([]);
  });

  it("caps pending error notes before injecting them into a prompt", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);

    for (let i = 0; i < 10; i++) {
      queue.queueError("telegram:12345", `[error] err-${i} ${"x".repeat(450)}`);
    }

    const drained = queue.drain("telegram:12345");
    const bulletCount = drained.match(/\n- /g)?.length ?? 0;

    expect(bulletCount).toBeLessThanOrEqual(3);
    expect(drained.length).toBeLessThan(1500);
    expect(drained).not.toContain("err-0");
    expect(drained).toContain("err-9");
  });
});
