import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBSESSIONS } from "../src/config.js";
import { PendingNotesQueue } from "../src/agent/pending-notes-queue.js";
import { SubsessionService, type SubsessionServiceDeps } from "../src/agent/subsessions/service.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { closeSharedTomoDbs, sharedTomoDb, TomoDb } from "../src/db/index.js";
import { makeSessionStore } from "./helpers/session-store-fixtures.js";

// ---------------------------------------------------------------------------
// A finished task's report reaches the owning session as a pending note, and
// the task is marked "report delivered": both rows in tomo.db, written in ONE
// transaction (the pending-notes store and the task table share the
// process's connection). Real stores here, no fakes for either half.
// ---------------------------------------------------------------------------

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-report-tx-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
}

function world() {
  const sessions = makeSessionStore(join(dir, "sessions"), { dbPath: join(dir, "tomo.db") });
  const queue = new PendingNotesQueue(sessions);
  const store = new SubsessionStore(join(dir, "subsessions.json"), { dbPath: join(dir, "tomo.db"), strictTransitions: true });
  const wakes: string[] = [];
  const deps = {
    store,
    config: () => ({ ...DEFAULT_SUBSESSIONS, enabled: true, ownerMessages: "direct" as const }),
    runTaskTurn: async (key: string) => {
      await new Promise((r) => setImmediate(r));
      service.noteToolUse(key);
      service.finish(key, "the report");
      return { ok: true };
    },
    sendToScope: async () => ({ ok: true }),
    noticeToScope: async () => {},
    noticeOwner: async () => {},
    queuePendingNote: (key: string, note: string) => queue.queueNote(key, note),
    queuePendingNoteWith: (key: string, note: string, also: () => void) => queue.queueNoteWith(key, note, also),
    persistPendingNotes: (key: string) => queue.persistNow(key),
    hasPendingNote: (key: string, pred: (n: string) => boolean) => queue.hasNote(key, pred),
    wakeScope: (key: string) => { wakes.push(key); },
    contextUsage: () => undefined,
    cronJobCount: () => 0,
    removeCronJobs: () => {},
    stopSession: async () => {},
    registryReadable: () => true,
    hasSdkSession: () => false,
    ensureRegistryEntry: () => {},
    unlinkRegistryEntry: () => {},
    registryTaskKeys: () => [],
    isStopping: () => false,
  } as unknown as SubsessionServiceDeps;
  const service = new SubsessionService(deps);
  service.recoverAtStartup();
  service.start();
  return { sessions, queue, store, service, wakes };
}

const reportNotes = (notes: string[]) => notes.filter((n) => n.includes('type="subsession-report"'));

describe("report delivery is one transaction", () => {
  it("commits the note and the delivered mark together, then wakes the owning session", async () => {
    const w = world();
    const { record } = w.service.spawn("dm:owner", { title: "t", brief: "b" }) as { record: { id: string } };
    await flush();
    expect(w.store.get(record.id)).toMatchObject({ status: "finished", reportDelivered: true });
    expect(reportNotes(makeSessionStore(join(dir, "sessions"), { dbPath: join(dir, "tomo.db") }).getPendingNotes("dm:owner"))).toHaveLength(1);
    expect(w.wakes).toEqual(["dm:owner"]);
    w.service.stop();
  });

  it("a table write that fails takes the note back with it: nothing on disk, nothing in memory, and the retry delivers once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const w = world();
      const real = SubsessionStore.prototype.update;
      let failNext = true;
      vi.spyOn(SubsessionStore.prototype, "update").mockImplementation(function (this: SubsessionStore, id, fn) {
        // Only the delivered mark (the first update after the report).
        const probe = this.get(id);
        if (failNext && probe?.status === "finished" && !probe.reportDelivered) {
          const before = { ...probe };
          fn(before);
          if (before.reportDelivered) { failNext = false; throw new Error("disk full"); }
        }
        return real.call(this, id, fn);
      });
      const { record } = w.service.spawn("dm:owner", { title: "t", brief: "b" }) as { record: { id: string } };
      await flush();
      expect(w.store.get(record.id)).toMatchObject({ status: "finished", reportDelivered: false });
      const onDisk = () => reportNotes(makeSessionStore(join(dir, "sessions"), { dbPath: join(dir, "tomo.db") }).getPendingNotes("dm:owner"));
      expect(onDisk()).toHaveLength(0);
      expect(w.queue.hasNote("dm:owner", (n) => n.includes('type="subsession-report"'))).toBe(false);
      expect(w.wakes).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      expect(w.store.get(record.id)?.reportDelivered).toBe(true);
      expect(onDisk()).toHaveLength(1);
      expect(w.wakes).toEqual(["dm:owner"]);
      w.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a note write that fails writes no mark either", async () => {
    const w = world();
    const real = TomoDb.prototype.run;
    let fail = true;
    vi.spyOn(TomoDb.prototype, "run").mockImplementation(function (this: TomoDb, sql: string, ...params) {
      if (fail && sql.startsWith("INSERT INTO pending_notes") && String(params[2]).includes('type="subsession-report"')) { fail = false; throw new Error("SQLITE_FULL"); }
      return real.call(this, sql, ...params);
    });
    const { record } = w.service.spawn("dm:owner", { title: "t", brief: "b" }) as { record: { id: string } };
    await flush();
    expect(w.store.get(record.id)).toMatchObject({ status: "finished", reportDelivered: false });
    expect(w.queue.hasNote("dm:owner", (n) => n.includes('type="subsession-report"'))).toBe(false);
    w.service.stop();
  });
});

describe("no commit is reported before the real one", () => {
  it("queueNoteWith inside another transaction refuses, and keeps nothing in memory", () => {
    const w = world();
    const db = sharedTomoDb(join(dir, "tomo.db"));
    const ok = db.transaction(() => w.queue.queueNoteWith("dm:owner", "n", () => {}));
    expect(ok).toBe(false);
    expect(w.queue.hasNote("dm:owner", (n) => n === "n")).toBe(false);
    w.service.stop();
  });

  it("a task write rolled back with an outer transaction leaves the store's cache as committed", () => {
    const w = world();
    const t = w.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    const db = sharedTomoDb(join(dir, "tomo.db"));
    expect(() => db.transaction(() => {
      w.store.update(t.id, (r) => { r.activeMs = 1; });
      w.store.update(t.id, (r) => { r.activeMs = 2; });
      w.store.list();
      throw new Error("outer");
    })).toThrow("outer");
    expect(w.store.peek()?.tasks[0].activeMs).toBe(0);
    expect(w.store.get(t.id)?.activeMs).toBe(0);
    w.service.stop();
  });

  it("the shared connection is never swapped while a transaction is open on it", () => {
    const path = join(dir, "solo.db");
    const db = sharedTomoDb(path);
    db.transaction(() => {
      renameSync(path, `${path}.moved`);
      expect(sharedTomoDb(path)).toBe(db);
      renameSync(`${path}.moved`, path);
    });
    closeSharedTomoDbs();
  });
});

describe("ordering around the commit", () => {
  it("a listener that queues a note while the report commits keeps both notes, on disk and in memory", () => {
    const sessions = makeSessionStore(join(dir, "sessions"), { dbPath: join(dir, "tomo.db") });
    const queue = new PendingNotesQueue(sessions);
    let armed = false;
    const store = new SubsessionStore(join(dir, "subsessions.json"), {
      dbPath: join(dir, "tomo.db"),
      onChange: () => { if (armed) { armed = false; queue.queueNote("dm:owner", "from the listener"); } },
    });
    const t = store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    armed = true;
    expect(queue.queueNoteWith("dm:owner", "the report", () => { store.update(t.id, (r) => { r.activeMs = 5; }); })).toBe(true);
    expect(queue.peekNotes("dm:owner")).toEqual(["the report", "from the listener"]);
    expect(makeSessionStore(join(dir, "sessions"), { dbPath: join(dir, "tomo.db") }).getPendingNotes("dm:owner")).toEqual(["the report", "from the listener"]);
  });

  it("a store first used inside another transaction refuses rather than import there", () => {
    const store = new SubsessionStore(join(dir, "subsessions.json"), { dbPath: join(dir, "tomo.db") });
    const db = sharedTomoDb(join(dir, "tomo.db"));
    expect(() => db.transaction(() => store.list())).toThrow(/first used inside another/);
    expect(store.list()).toEqual([]);
  });
});

describe("first use and hooks", () => {
  it("a pending-notes store first used inside another transaction refuses rather than import there", () => {
    const sessions = makeSessionStore(join(dir, "sessions"), { dbPath: join(dir, "tomo.db") });
    const db = sharedTomoDb(join(dir, "tomo.db"));
    expect(() => db.transaction(() => sessions.getPendingNotes("dm:owner"))).toThrow(/first used inside another/);
    expect(sessions.getPendingNotes("dm:owner")).toEqual([]);
  });

  it("a listener that writes from a commit hook leaves the newest table in the cache", () => {
    let armed = false;
    const store: SubsessionStore = new SubsessionStore(join(dir, "subsessions.json"), {
      dbPath: join(dir, "tomo.db"),
      onChange: () => { if (armed) { armed = false; store.update("s1", (r) => { r.activeMs = 3; }); } },
    });
    store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    const db = sharedTomoDb(join(dir, "tomo.db"));
    armed = true;
    db.transaction(() => {
      store.update("s1", (r) => { r.activeMs = 1; });
      store.update("s1", (r) => { r.activeMs = 2; });
    });
    expect(store.peek()?.tasks[0].activeMs).toBe(3);
    expect(store.get("s1")?.activeMs).toBe(3);
  });
});
