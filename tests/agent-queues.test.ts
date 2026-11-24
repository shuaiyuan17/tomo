import { describe, expect, it } from "vitest";
import { INTERRUPTED_NOTE_MARKER, PendingNotesQueue, type DurablePendingNotesStore } from "../src/agent/pending-notes-queue.js";
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
    // Still on disk while the turn that took them runs…
    expect(store.getPendingNotes("telegram:-987")).toHaveLength(15);
    queue.settle("telegram:-987", drained);
    // …and gone once it has ended.
    expect(store.getPendingNotes("telegram:-987")).toEqual([]);
  });

  it("keeps drained notes durable until their turn settles, alongside notes queued meanwhile", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);
    queue.queueNote("k", "before");
    const drained = queue.drain("k");
    queue.queueNote("k", "during");
    // In flight it is stored already marked as possibly partly answered.
    expect(store.getPendingNotes("k")).toEqual([`${INTERRUPTED_NOTE_MARKER}\nbefore`, "during"]);

    // A crash here: the next process sees both and delivers both.
    const next = new PendingNotesQueue(store);
    expect(next.drain("k")).toContain("before");

    queue.settle("k", drained);
    expect(store.getPendingNotes("k")).toEqual(["during"]);
  });

  it("restoreInterrupted puts a taken-but-unfinished batch back, marked", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);
    queue.queueNote("k", "n1");
    const drained = queue.drain("k");
    queue.restoreInterrupted("k", drained);
    expect(store.getPendingNotes("k")).toEqual([`${INTERRUPTED_NOTE_MARKER}\nn1`]);
    const again = queue.drain("k");
    expect(again.startsWith(INTERRUPTED_NOTE_MARKER)).toBe(true);
    expect(again.split(INTERRUPTED_NOTE_MARKER)).toHaveLength(2);
  });

  it("restore puts a drained batch back without duplicating it on disk", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);
    queue.queueNote("k", "n1");
    const drained = queue.drain("k");
    queue.restore("k", drained);
    expect(store.getPendingNotes("k")).toEqual(["n1"]);
    expect(queue.drain("k")).toContain("n1");
  });

  it("never caps away a durable-inbox note (the message's only copy)", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);
    queue.queueNote("k", '<tomo-event type="inbox" name="interrupted" ts="x">\nthe message\n</tomo-event>');
    for (let i = 0; i < 30; i++) queue.queueNote("k", `note-${i}`);
    expect(queue.peekNotes("k")[0]).toContain("the message");
    expect(queue.peekNotes("k")).toHaveLength(15);
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
  it("puts error notes back under their caps when a failing turn is restored, instead of a durable blob", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);
    queue.queueNote("k", "n1");

    // Ten turns in a row fail: each drains, queues a new error, then is put back.
    for (let i = 0; i < 10; i++) {
      const drained = queue.drain("k");
      queue.queueError("k", `[error] err-${i} ${"x".repeat(300)}`);
      queue.restoreInterrupted("k", drained);
    }

    // The durable store only ever holds the one real note, marked once.
    expect(store.getPendingNotes("k")).toEqual([`${INTERRUPTED_NOTE_MARKER}\nn1`]);

    const next = queue.drain("k");
    expect(next.match(/<tomo-event type="errors"/g)).toHaveLength(1);
    expect(next.match(/\n- \[error\]/g)?.length ?? 0).toBeLessThanOrEqual(3);
    expect(next.length).toBeLessThan(2000);
    expect(next).toContain("err-9");
    expect(next).not.toContain("err-0");
    expect(next.split(INTERRUPTED_NOTE_MARKER)).toHaveLength(2);
  });

  it("restores an error-only prefix to the error queue, never to the durable store", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);
    queue.queueError("k", "[error] boom");
    const drained = queue.drain("k");
    expect(drained).toContain("boom");

    queue.restoreInterrupted("k", drained);
    expect(store.getPendingNotes("k")).toEqual([]);
    expect(queue.peekNotes("k")).toEqual([]);
    expect(queue.drain("k")).toContain("boom");
  });

  it("does not let a pinned inbox note carry a restored error block with it", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);
    const inbox = '<tomo-event type="inbox" name="interrupted" ts="x">\nthe message\n</tomo-event>';
    queue.queueNote("k", inbox);
    queue.queueError("k", "[error] boom");
    const drained = queue.drain("k");
    queue.restoreInterrupted("k", drained);
    const stored = store.getPendingNotes("k");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain("the message");
    expect(stored[0]).not.toContain('type="errors"');
  });

  it("restores a multi-note batch as separate notes, in order, ahead of newer ones", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);
    queue.queueNote("k", "a");
    queue.queueNote("k", "b");
    const drained = queue.drain("k");
    queue.queueNote("k", "c");
    queue.restore("k", drained);
    expect(store.getPendingNotes("k")).toEqual(["a", "b", "c"]);
    // A second put-back of the same prefix is a no-op, not a duplicate.
    queue.restore("k", drained);
    expect(store.getPendingNotes("k")).toEqual(["a", "b", "c"]);
  });
  it("keeps every restored note when the queue filled up while the batch was in flight", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);
    for (let i = 0; i < 15; i++) queue.queueNote("k", `old-${i}`);
    const drained = queue.drain("k");
    for (let i = 0; i < 15; i++) queue.queueNote("k", `new-${i}`);
    queue.restore("k", drained);
    const stored = store.getPendingNotes("k");
    for (let i = 0; i < 15; i++) expect(stored).toContain(`old-${i}`);
    expect(stored[0]).toBe("old-0");
    expect(stored.at(-1)).toBe("new-14");
  });

  it("keeps the newest errors when overlapping batches are restored in drain order", () => {
    const store = new MemoryPendingNotesStore();
    const queue = new PendingNotesQueue(store);
    for (let i = 0; i < 3; i++) queue.queueError("k", `[error] older-${i}`);
    const first = queue.drain("k");
    for (let i = 0; i < 3; i++) queue.queueError("k", `[error] newer-${i}`);
    const second = queue.drain("k");
    queue.restore("k", first);
    queue.restore("k", second);
    const next = queue.drain("k");
    for (let i = 0; i < 3; i++) expect(next).toContain(`newer-${i}`);
    expect(next).not.toContain("older-");
    expect(next.indexOf("newer-0")).toBeLessThan(next.indexOf("newer-2"));
  });
  it("strips errors blocks an older version left inside stored notes", () => {
    const store = new MemoryPendingNotesStore();
    const errors = '<tomo-event type="errors" ts="x">\nRecent Tomo errors\n- [error] old-boom\n</tomo-event>';
    const inbox = '<tomo-event type="inbox" name="interrupted" ts="x">\nthe message\n</tomo-event>';
    store.setPendingNotes("k", [
      `${INTERRUPTED_NOTE_MARKER}\n${inbox}\n\n${errors}\n\n${errors}`,
      `${INTERRUPTED_NOTE_MARKER}\n${errors}`,
    ]);
    const queue = new PendingNotesQueue(store);
    const drained = queue.drain("k");
    expect(drained).toContain("the message");
    expect(drained).not.toContain("old-boom");
    expect(drained.split(INTERRUPTED_NOTE_MARKER)).toHaveLength(2);
    queue.restoreInterrupted("k", drained);
    expect(store.getPendingNotes("k")).toEqual([`${INTERRUPTED_NOTE_MARKER}\n${inbox}`]);
  });
});
