import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBSESSIONS, type SubsessionConfig } from "../src/config.js";
import {
  SubsessionService,
  type ScopeSendResult,
  type TaskTurnOutcome,
} from "../src/agent/subsessions/service.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { ACTIVE_HEARTBEAT_MS, ENDED_KEEP_MS, FINISHED_KEEP_MS, REGISTRY_RECHECK_MS } from "../src/agent/subsessions/service.js";
import { formatMirrorNote, formatOwnerMessageEvent, MIRROR_ENTRY_MAX } from "../src/agent/subsessions/prompt.js";
import { appendInput, needsOwner, type SubsessionRecord } from "../src/agent/subsessions/types.js";
import { dropLegacyTaskTodos } from "../src/agent/subsessions/legacy-todos.js";
import { TodoStore } from "../src/todos/store.js";
import { DEFAULT_TODOS } from "../src/todos/limits.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-subp2-")); });
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
}

interface H {
  service: SubsessionService;
  store: SubsessionStore;
  prompts: string[];
  sent: string[];
  notices: string[];
  wakes: string[];
  clock: number;
  /** Pending notes queued for the owning session. */
  notes: string[];
  cronJobs: number;
  onTurn: (prompt: string, key: string) => TaskTurnOutcome | Promise<TaskTurnOutcome>;
  /** The 5-hour window's share used, as the quota gate reads it. */
  quota?: number;
}

function harness(cfg: Partial<SubsessionConfig> = {}, opts: { registry?: Set<string>; unlinked?: string[]; clock?: number } = {}): H {
  const h = { prompts: [], sent: [], notices: [], wakes: [], notes: [], clock: opts.clock ?? 1_000_000, onTurn: () => ({ ok: true }) } as unknown as H;
  h.store = new SubsessionStore(join(dir, "t.json"), { strictTransitions: true, now: () => h.clock });
  h.service = new SubsessionService({
    store: h.store,
    config: () => ({ ...DEFAULT_SUBSESSIONS, enabled: true, ...cfg }),
    runTaskTurn: async (key, prompt) => {
      h.prompts.push(prompt);
      await new Promise((r) => setImmediate(r));
      return h.onTurn(prompt, key);
    },
    sendToScope: async (_parent, text): Promise<ScopeSendResult> => {
      h.sent.push(text);
      return { ok: true };
    },
    noticeToScope: async (_parent, text) => { h.notices.push(text); },
    noticeOwner: async () => {},
    queuePendingNote: (_parent, note) => { h.notes.push(note); return true; },
    hasPendingNote: () => false,
    wakeScope: () => {},
    contextUsage: () => undefined,
    cronJobCount: () => h.cronJobs ?? 0,
    removeCronJobs: () => {},
    stopSession: async () => {},
    registryReadable: () => true,
    hasSdkSession: () => true,
    ensureRegistryEntry: () => {},
    unlinkRegistryEntry: (key) => { opts.unlinked?.push(key); opts.registry?.delete(key); },
    registryTaskKeys: () => [...(opts.registry ?? [])],
    isStopping: () => false,
    now: () => h.clock,
    mirrorWake: (parent) => { h.wakes.push(parent); },
    sessionQuotaPercent: () => h.quota,
  });
  return h;
}

function spawn(h: H, title = "Fix CI") {
  const r = h.service.spawn("dm:owner", { title, brief: "b" });
  if (!r.ok) throw new Error(r.error);
  return r.record;
}

describe("an owner message to a queued task", () => {
  it("starts it even when every slot is taken, so the message is never held", async () => {
    const h = harness({ maxRunning: 1 });
    h.onTurn = (prompt) => (prompt.includes("Busy") ? new Promise(() => {}) : { ok: true, response: "On it." });
    h.service.start();
    spawn(h, "Busy");
    await flush();
    const waiting = spawn(h, "Next");
    await flush();
    expect(h.service.get(waiting.id)?.status).toBe("queued");
    expect(h.service.ownerMessage("dm:owner", waiting.id, "please do this one now").ok).toBe(true);
    await flush();
    expect(h.prompts.some((p) => p.includes("please do this one now"))).toBe(true);
    expect(h.service.get(waiting.id)?.pendingInput).toEqual([]);
    h.service.stop();
  });
});

describe("an owner message whose start cannot be written", () => {
  it("is still delivered (never handed to the owning session too), and the start is made at the recheck", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({ maxRunning: 0 });
      h.onTurn = () => new Promise(() => {});
      h.service.start();
      const task = spawn(h);
      await flush();
      expect(h.service.get(task.id)?.status).toBe("queued");
      const store = h.store as unknown as { transition: (id: string, event: string, ...rest: unknown[]) => unknown };
      const real = store.transition.bind(h.store);
      // Fails at once, and again at the first recheck.
      let fails = 2;
      store.transition = (id, event, ...rest) => {
        if (event === "start" && fails > 0) { fails -= 1; throw new Error("disk full"); }
        return real(id, event, ...rest);
      };
      expect(h.service.ownerMessage("dm:owner", task.id, "do it now")).toMatchObject({ ok: true });
      expect(h.service.get(task.id)?.pendingInput.some((i) => i.text.includes("do it now"))).toBe(true);
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      expect(h.service.get(task.id)?.status).toBe("queued");
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      expect(h.service.get(task.id)?.status).toBe("active");
      expect(h.prompts.some((p) => p.includes("do it now"))).toBe(true);
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an owner message to a queued task whose record can't be read just then", () => {
  async function setup() {
    const h = harness({ maxRunning: 0 });
    h.onTurn = () => new Promise(() => {});
    h.service.start();
    const task = spawn(h);
    await flush();
    const store = h.store as unknown as Record<string, (...a: unknown[]) => unknown>;
    const fails = { get: 0, list: 0 };
    for (const what of ["get", "list"] as const) {
      const real = store[what]!.bind(h.store);
      store[what] = (...a: unknown[]) => { if (fails[what] > 0) { fails[what] -= 1; throw new Error("EIO"); } return real(...a); };
    }
    return { h, task, fails };
  }

  it("is started at the recheck when the start's own read fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { h, task, fails } = await setup();
      const deliver = h.service.ownerMessage.bind(h.service);
      // The message lands; the read the start makes right after fails.
      const real = (h.store as unknown as { transition: (...a: unknown[]) => unknown }).transition.bind(h.store);
      (h.store as unknown as { transition: (...a: unknown[]) => unknown }).transition = (...a: unknown[]) => {
        const out = real(...a);
        if (a[1] === "owner_message") fails.get = 1;
        return out;
      };
      expect(deliver("dm:owner", task.id, "do it now")).toMatchObject({ ok: true });
      await flush();
      expect(h.service.get(task.id)?.status).toBe("queued");
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      expect(h.service.get(task.id)?.status).toBe("active");
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is started at a later recheck when the scheduler's own read fails at the first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { h, task, fails } = await setup();
      const real = (h.store as unknown as { transition: (...a: unknown[]) => unknown }).transition.bind(h.store);
      (h.store as unknown as { transition: (...a: unknown[]) => unknown }).transition = (...a: unknown[]) => {
        const out = real(...a);
        if (a[1] === "owner_message") fails.get = 1;
        return out;
      };
      expect(h.service.ownerMessage("dm:owner", task.id, "do it now")).toMatchObject({ ok: true });
      await flush();
      // The first recheck's scheduler can't read the table either.
      fails.list = 1;
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      expect(h.service.get(task.id)?.status).toBe("queued");
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      expect(h.service.get(task.id)?.status).toBe("active");
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an owner message to a queued task, across a restart", () => {
  it("is started past the slot cap when dispatch opens, from what the table holds", async () => {
    const seed = harness({ maxRunning: 0 });
    seed.service.start();
    const task = spawn(seed);
    await flush();
    // The message landed; the process died before the start.
    seed.store.update(task.id, (r) => { appendInput(r, formatOwnerMessageEvent("do it now"), { from: "owner", words: "do it now" }); });
    seed.service.stop();
    const h = harness({ maxRunning: 0 });
    h.onTurn = () => new Promise(() => {});
    h.service.start();
    await flush();
    expect(h.service.get(task.id)?.status).toBe("active");
    expect(h.prompts.some((p) => p.includes("do it now"))).toBe(true);
    h.service.stop();
  });
});

describe("restart recovery from an older backup", () => {
  it("banks active time and recovers inputs without ever unlinking a task the backup does not know, across two starts", async () => {
    // The backup: an active task s1 with a turn in flight. The lost primary also knew s2.
    const h0 = harness();
    const t = h0.store.create({ parentKey: "dm:owner", title: "Fix CI", brief: "b" });
    h0.store.transition(t.id, "start");
    h0.store.update(t.id, (r) => {
      r.startDelivered = true;
      r.activeSeenAt = h0.clock;
      appendInput(r, "the owner's message");
    });
    const file = join(dir, "t.json");
    copyFileSync(file, `${file}.bak`);
    writeFileSync(file, "{broken");
    const registry = new Set(["task:s1", "task:s2"]);
    const unlinked: string[] = [];

    // Recovery (time banked, the task requeued) writes the recovered table before reconcile.
    const h1 = harness({}, { registry, unlinked });
    h1.onTurn = () => new Promise(() => {});
    h1.service.start();
    await flush();
    expect(unlinked).toEqual([]);
    expect(h1.store.read().untrusted).toMatchObject({ reason: "recovered" });
    expect(h1.prompts[0]).toContain("the owner's message");

    // The next start reads that table as clean: still nothing unlinked.
    const h2 = harness({}, { registry, unlinked });
    h2.onTurn = () => new Promise(() => {});
    h2.service.start();
    await flush();
    expect(h2.store.state()).toBe("ok");
    expect(unlinked).toEqual([]);
    expect(registry.has("task:s2")).toBe(true);
  });
});

describe("active time (the maxActiveHours cap counts it)", () => {
  it("does not count the time Tomo was down after a crash", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = harness({ maxActiveHours: 1 });
    first.onTurn = () => new Promise(() => {}); // the daemon dies during this turn
    first.service.start();
    const task = spawn(first);
    await flush();
    // Ten minutes in, the heartbeat records the task as still working.
    first.clock += 10 * 60 * 1000;
    vi.advanceTimersByTime(ACTIVE_HEARTBEAT_MS);
    expect(first.store.get(task.id)?.activeSeenAt).toBe(first.clock);
    first.service.stop();
    vi.useRealTimers();

    // Ten hours later, Tomo starts again.
    const second = harness({ maxActiveHours: 1 });
    second.clock = first.clock + 10 * 60 * 60 * 1000;
    second.onTurn = async () => { second.clock += 5 * 60 * 1000; return { ok: true }; };
    second.service.start();
    await flush();
    const after = second.service.get(task.id)!;
    expect(after.activeMs).toBeLessThan(60 * 60 * 1000);
    expect(after.activeMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(second.notices.some((n) => n.includes("working on its own"))).toBe(false);
    second.service.stop();
  });

  it("banks the time before a crash once, however many times recovery is cut short", () => {
    const seed = harness();
    const t = seed.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    seed.store.transition(t.id, "start");
    seed.store.update(t.id, (r) => { r.startDelivered = true; r.activeSeenAt = seed.clock + 10 * 60 * 1000; });
    const tenHoursLater = seed.clock + 10 * 60 * 60 * 1000;
    // A start that dies right after banking the time, then one that dies
    // right after requeueing the task.
    for (const step of ["update", "transition"] as const) {
      const h = harness({ maxRunning: 0 });
      h.clock = tenHoursLater + (step === "update" ? 0 : 60 * 1000);
      const store = h.store as unknown as Record<string, (...args: unknown[]) => unknown>;
      const real = store[step]!.bind(h.store);
      store[step] = (...args: unknown[]) => {
        real(...args);
        throw new Error("crash");
      };
      h.service.start();
      expect(h.service.available()).toBe(false);
    }
    const h = harness({ maxRunning: 0 });
    h.clock = tenHoursLater + 5 * 60 * 1000;
    h.service.start();
    expect(h.store.get(t.id)).toMatchObject({ status: "queued", resumeNeeded: true, activeMs: 10 * 60 * 1000 });
    h.service.stop();
  });

  it("an owner's word after the last heartbeat gives no time back after a crash", () => {
    const seed = harness();
    const t = seed.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    seed.store.transition(t.id, "start");
    // Last seen working 10 minutes in; the owner wrote at 12 minutes, then the crash.
    seed.store.update(t.id, (r) => { r.startDelivered = true; r.activeSeenAt = seed.clock + 10 * 60 * 1000; r.activeAtOwnerInputMs = 12 * 60 * 1000; });
    const h = harness({ maxRunning: 0 });
    h.clock = seed.clock + 10 * 60 * 60 * 1000;
    h.service.start();
    const after = h.store.get(t.id)!;
    expect(after.activeMs).toBe(10 * 60 * 1000);
    expect(after.activeAtOwnerInputMs).toBe(10 * 60 * 1000);
    h.service.stop();
  });

  it("is off at 0", async () => {
    const h = harness({ maxActiveHours: 0 });
    let turns = 0;
    h.onTurn = async (_prompt, key) => {
      turns += 1;
      h.clock += 48 * 60 * 60 * 1000;
      if (turns === 3) h.service.finish(key, "done");
      else h.service.postUpdate(key, `step ${turns}`);
      return { ok: true };
    };
    h.service.start();
    const task = spawn(h);
    await flush();
    expect(h.service.get(task.id)?.status).toBe("finished");
    h.service.stop();
  });
});

describe("a task is its own card", () => {
  /** A task that finishes with `action` (or none) on its first turn. */
  async function finished(h: H, action?: string): Promise<SubsessionRecord> {
    h.onTurn = (prompt, key) => {
      if (prompt.includes("subsession-start")) h.service.finish(key, "PR #12 is open.", action);
      return { ok: true };
    };
    h.service.start();
    const task = spawn(h);
    await flush();
    return h.service.get(task.id)!;
  }

  it("makes no todo, and an old record's todo id is read without it", () => {
    const seed = harness();
    const t = seed.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    const raw = JSON.parse(readFileSync(join(dir, "t.json"), "utf8")) as { tasks: Array<Record<string, unknown>> };
    raw.tasks[0].todoId = "t-1";
    writeFileSync(join(dir, "t.json"), JSON.stringify(raw));
    const h = harness();
    expect(h.store.get(t.id)).not.toHaveProperty("todoId");
  });

  it("a report that needs nothing from the owner just finishes, and says so", async () => {
    const h = harness();
    const task = await finished(h);
    expect(task.status).toBe("finished");
    expect(needsOwner(task)).toBeUndefined();
    expect(h.notes.at(-1)).toContain("It needs nothing from the owner.");
    h.service.stop();
  });

  it("a report that needs the owner keeps one line of it, and the note tells the main session", async () => {
    const h = harness();
    const task = await finished(h, "Review and merge PR #12\n(and nothing past the first line)");
    expect(needsOwner(task)).toBe("Review and merge PR #12");
    expect(h.notes.at(-1)).toContain("It needs the owner to: Review and merge PR #12.");
    expect(h.notes.at(-1)).toContain(`task_done("${task.id}", ${h.store.get(task.id)!.reportSeq})`);
    h.service.stop();
  });

  it("is cleared by the owner's word, only in its own scope, and only once", async () => {
    const h = harness();
    const task = await finished(h, "Merge PR #12");
    expect(h.service.markDone("telegram:-100", task.id)).toEqual({ ok: false, reason: "unknown" });
    expect(needsOwner(h.service.get(task.id)!)).toBe("Merge PR #12");
    const done = h.service.markDone("dm:owner", task.id);
    expect(done.ok).toBe(true);
    expect(h.service.get(task.id)).toMatchObject({ status: "finished" });
    expect(h.service.get(task.id)?.ownerAction).toBeUndefined();
    expect(h.service.markDone("dm:owner", task.id)).toEqual({ ok: false, reason: "nothing" });
    h.service.stop();
  });

  it("each finish says afresh what it asks: a later report without one clears it; a reopen hides it until the next report", async () => {
    const h = harness();
    const task = await finished(h, "Merge PR #12");
    // Woken while finished: it reopens to report again (what the prompt tells it to do).
    h.onTurn = (_prompt, key) => { h.service.reopen(key); h.service.finish(key, "Merged, all done."); return { ok: true }; };
    h.service.ownerMessage("dm:owner", task.id, "merged it");
    await flush();
    expect(needsOwner(h.service.get(task.id)!)).toBeUndefined();

    h.onTurn = (_prompt, key) => { h.service.reopen(key); h.service.finish(key, "Another PR.", "Merge PR #13"); return { ok: true }; };
    h.service.ownerMessage("dm:owner", task.id, "one more fix");
    await flush();
    expect(needsOwner(h.service.get(task.id)!)).toBe("Merge PR #13");
    h.onTurn = (_prompt, key) => { h.service.reopen(key); return new Promise(() => {}); };
    h.service.ownerMessage("dm:owner", task.id, "actually keep going");
    await flush();
    // Working again: not "Needs you", and no done to give; the ask stands until a new report says otherwise.
    expect(h.service.get(task.id)).toMatchObject({ status: "active", ownerAction: "Merge PR #13" });
    expect(needsOwner(h.service.get(task.id)!)).toBeUndefined();
    expect(h.service.markDone("dm:owner", task.id)).toEqual({ ok: false, reason: "nothing" });
    h.service.stop();
  });

  it("done clears only the ask of the report the owner saw, never a newer report's with the same words", async () => {
    const h = harness();
    const task = await finished(h, "Review and merge the PR");
    // Between the owner's read and the write, a new report lands with the same words (a second PR).
    const seen = h.store.get(task.id)!;
    h.store.transition(task.id, "reopen");
    h.store.transition(task.id, "finish", { patch: (r) => { r.reportSeq = (r.reportSeq ?? 1) + 1; r.ownerAction = "Review and merge the PR"; } });
    const get = h.store.get.bind(h.store);
    h.store.get = (id: string) => (id === task.id ? seen : get(id));
    expect(h.service.markDone("dm:owner", task.id)).toMatchObject({ ok: false, reason: "newer" });
    h.store.get = get;
    expect(needsOwner(h.store.get(task.id)!)).toBe("Review and merge the PR");
    h.service.stop();
  });

  it("done from the owning session clears the report the owner answered, never one that came after it", async () => {
    const h = harness();
    const task = await finished(h, "Merge PR #12");
    const first = h.store.get(task.id)!.reportSeq!;
    expect(h.notes.at(-1)).toContain(`task_done("${task.id}", ${first})`);
    // Reopened and finished again before the owning session acted on the owner's "merged #12".
    h.store.transition(task.id, "reopen");
    h.store.transition(task.id, "finish", { patch: (r) => { r.reportSeq = first + 1; r.ownerAction = "Merge PR #13"; } });
    expect(h.service.markDone("dm:owner", task.id, first)).toMatchObject({ ok: false, reason: "newer", record: { reportSeq: first + 1 } });
    expect(needsOwner(h.store.get(task.id)!)).toBe("Merge PR #13");
    expect(h.service.markDone("dm:owner", task.id, first + 1).ok).toBe(true);
    h.service.stop();
  });

  it("is never archived while it needs the owner; once they say it is done, it archives as usual", async () => {
    const seed = harness();
    const task = await finished(seed, "Merge PR #12");
    seed.service.stop();
    const later = 1_000_000 + FINISHED_KEEP_MS + 60_000;
    const h = harness({}, { clock: later });
    h.service.start();
    expect(h.service.get(task.id)?.status).toBe("finished");
    h.service.stop();

    const other = harness();
    other.service.start();
    expect(other.service.markDone("dm:owner", task.id).ok).toBe(true);
    other.service.stop();
    const after = harness({}, { clock: later });
    after.service.start();
    expect(after.service.get(task.id)?.status).toBe("archived");
    after.service.stop();
  });

  it("hands startup the table as read, before the sweep forgets an old task (its old todo can still be matched)", async () => {
    const seed = harness();
    const task = await finished(seed, undefined);
    seed.store.transition(task.id, "archive");
    seed.service.stop();
    const h = harness({}, { clock: 1_000_000 + ENDED_KEEP_MS + 60_000 });
    let seen: string[] = [];
    h.service.recoverAtStartup((records) => { seen = records.map((r) => r.id); return true; });
    expect(seen).toContain(task.id);
    expect(h.service.get(task.id)).toBeUndefined();
    h.service.stop();
  });

  it("forgets no record while the startup hook's work is incomplete, so the next start can still match against it", async () => {
    const seed = harness();
    const task = await finished(seed, undefined);
    seed.store.transition(task.id, "archive");
    seed.service.stop();
    const later = 1_000_000 + ENDED_KEEP_MS + 60_000;
    const failing = harness({}, { clock: later });
    failing.service.recoverAtStartup(() => false);
    expect(failing.service.get(task.id)?.status).toBe("archived");
    failing.service.stop();
    const throwing = harness({}, { clock: later });
    throwing.service.recoverAtStartup(() => { throw new Error("todo list unreadable"); });
    expect(throwing.service.get(task.id)?.status).toBe("archived");
    throwing.service.stop();
  });

  it("moves an old todo's unread result onto a finished task: Needs you, and its own ask is never overwritten", async () => {
    const seed = harness();
    const plain = await finished(seed, undefined);
    seed.service.stop();
    const h = harness();
    h.service.recoverAtStartup((_records, keepAsk) => keepAsk(plain.id, `Read ${plain.id}'s result`));
    expect(needsOwner(h.store.get(plain.id)!)).toBe(`Read ${plain.id}'s result`);
    h.service.stop();
    const again = harness();
    again.service.recoverAtStartup((_records, keepAsk) => keepAsk(plain.id, "Something else"));
    expect(needsOwner(again.store.get(plain.id)!)).toBe(`Read ${plain.id}'s result`);
    again.service.stop();
    // Moved once: an ask the owner cleared stays cleared, even when a later start still finds the old todo.
    const owner = harness();
    owner.service.start();
    expect(owner.service.markDone("dm:owner", plain.id).ok).toBe(true);
    owner.service.stop();
    const later = harness();
    let answer: boolean | undefined;
    later.service.recoverAtStartup((_records, keepAsk) => { answer = keepAsk(plain.id, `Read ${plain.id}'s result`); return true; });
    expect(answer).toBe(true);
    expect(needsOwner(later.store.get(plain.id)!)).toBeUndefined();
    later.service.stop();
  });

  it("hands the startup hook no record read from the backup, and forgets nothing while it holds any", async () => {
    const seed = harness();
    const old = await finished(seed, undefined);
    seed.store.transition(old.id, "archive");
    const fresh = spawn(seed);
    seed.store.update(fresh.id, (r) => { r.restored = true; });
    seed.service.stop();
    const h = harness({}, { clock: 1_000_000 + ENDED_KEEP_MS + 60_000 });
    let seen: string[] = [];
    h.service.recoverAtStartup((records) => { seen = records.map((r) => r.id); return true; });
    expect(seen).toContain(old.id);
    expect(seen).not.toContain(fresh.id);
    expect(h.service.get(old.id)?.status).toBe("archived");
    h.service.stop();
  });

  it("upgrades a finished task's old todo into Needs you, with the real todo list", async () => {
    const seed = harness();
    const task = await finished(seed, undefined);
    seed.service.stop();
    const todos = new TodoStore(join(dir, "todos"), DEFAULT_TODOS);
    const item = todos.add({ title: `${task.title} (${task.id})`, next: `Read ${task.id}'s result, then close this`, waiting_on: "owner", ref: task.sessionKey, session: task.parentKey, source: "self" });
    const h = harness();
    h.service.recoverAtStartup((records, keepAsk) => dropLegacyTaskTodos(todos, records, keepAsk).complete);
    expect(needsOwner(h.store.get(task.id)!)).toBe(`Read ${task.id}'s result`);
    expect(todos.list().map((i) => i.id)).not.toContain(item.id);
    h.service.start();
    expect(h.service.markDone("dm:owner", task.id, 1).ok).toBe(true);
    h.service.stop();
  });

  it("migrates a table and todo list in the shape a live install left them", () => {
    // Files as an install running the old todo link wrote them (field for
    // field: todoId and progress on the records, the todo list's own keys).
    const DAY = 24 * 60 * 60 * 1000;
    const now = 1_795_624_200_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const at = (daysAgo: number) => now - daysAgo * DAY;
    const record = (id: string, title: string, status: string, endedDaysAgo: number | undefined, extra: Record<string, unknown> = {}) => ({
      id, sessionKey: `task:${id}`, parentKey: "dm:owner", title, brief: "b", quote: ["开个子会话吧"], status,
      createdAt: at((endedDaysAgo ?? 0) + 0.1), lastActivityAt: at(endedDaysAgo ?? 0), activeMs: 1_000, resumeNeeded: false, startDelivered: true,
      interruptStreak: 0, failStreak: 0, turnsWithoutProgress: 0, restartRequested: false, reportDelivered: status === "finished" || status === "archived",
      compactPending: false, postCompactReminder: false, pendingInput: [], replyMap: [], ownerMessageIds: [], conversation: [], conversationSeq: 0,
      mirrorSeenSeq: 0, nextInputSeq: 2, seenThrough: 0, sent: [], transitions: [{ at: at((endedDaysAgo ?? 0) + 0.1), from: null, to: "queued", event: "spawn" }],
      todoId: `t-${id.slice(1)}`, progress: "跑 codex 第 1 轮",
      ...(endedDaysAgo !== undefined ? { endedAt: at(endedDaysAgo) } : {}),
      ...(status === "finished" || status === "archived" ? { reportSeq: 2, report: "PR 已开" } : {}),
      ...extra,
    });
    writeFileSync(join(dir, "t.json"), JSON.stringify({ version: 1, nextId: 8, tasks: [
      record("s1", "旧任务：报告还没看", "finished", 1),
      record("s2", "旧任务：做完四十天了，报告也没看", "finished", 40),
      record("s3", "旧任务：已经手动关过 todo", "finished", 1),
      record("s4", "进行中的任务", "active", undefined, { activeSince: at(0.01), activeSeenAt: at(0.01) }),
      record("s5", "被 owner 推迟过", "finished", 1),
      record("s6", "已取消", "cancelled", 0.5),
      record("s7", "归档很久了", "archived", 40),
    ] }));
    const todo = (n: number, title: string, next: string, waiting: string, extra: Record<string, unknown> = {}) => ({
      id: `t-${n}`, title, next, waiting_on: waiting, review_at: iso(now + 7 * DAY), ref: `task:s${n}`, session: "dm:owner",
      created_at: iso(at(2)), updated_at: iso(at(1)), source: "self", snoozes: 0, ...extra,
    });
    mkdirSync(join(dir, "todos"), { recursive: true });
    writeFileSync(join(dir, "todos", "todos.json"), JSON.stringify({ version: 1, next_id: 10, items: [
      todo(1, "旧任务：报告还没看 (s1)", "Read s1's result, then close this", "owner"),
      todo(2, "旧任务：做完四十天了，报告也没看 (s2)", "Read s2's result, then close this", "owner"),
      todo(4, "进行中的任务 (s4)", "s4 is working on it (/s s4)", "external"),
      todo(5, "被 owner 推迟过 (s5)", "Read s5's result, then close this", "owner", { snoozes: 1, snooze_reason: "after the trip" }),
      todo(7, "归档很久了 (s7)", "Read s7's result, then close this", "owner"),
      { id: "t-9", title: "Owner's own", next: "do it", waiting_on: "me", review_at: iso(now), session: "dm:owner", created_at: iso(at(1)), updated_at: iso(at(1)), source: "owner", snoozes: 0 },
    ] }));
    const todos = new TodoStore(join(dir, "todos"), DEFAULT_TODOS);
    const h = harness({}, { clock: now });
    h.service.recoverAtStartup((records, keepAsk) => dropLegacyTaskTodos(todos, records, keepAsk).complete);
    h.service.start();
    const open = todos.list().map((i) => i.id);
    // Unread results become the task's Needs you, however old (never archived or forgotten while they ask); their todos go.
    expect(needsOwner(h.store.get("s1")!)).toBe("Read s1's result");
    expect(h.store.get("s2")).toMatchObject({ status: "finished", ownerAction: "Read s2's result" });
    expect(open).not.toContain("t-1");
    expect(open).not.toContain("t-2");
    // A task whose todo was already closed asks nothing; an active task's line is the card now.
    expect(needsOwner(h.store.get("s3")!)).toBeUndefined();
    expect(open).not.toContain("t-4");
    // The owner snoozed it: theirs, kept, and nothing added to the card.
    expect(open).toContain("t-5");
    expect(h.store.get("s5")?.ownerAction).toBeUndefined();
    // An archived task's unread result stays the owner's todo, as before; and so does the owner's own item.
    expect(open).toEqual(expect.arrayContaining(["t-7", "t-9"]));
    // The old fields are gone from what is written back.
    const onDisk = JSON.parse(readFileSync(join(dir, "t.json"), "utf8")) as { tasks: Record<string, unknown>[] };
    expect(onDisk.tasks.find((r) => r.id === "s1")).not.toHaveProperty("todoId");
    // The answer the owner gives is to the report the task shows.
    expect(h.service.markDone("dm:owner", "s2", 1)).toMatchObject({ ok: false, reason: "newer" });
    expect(h.service.markDone("dm:owner", "s2", 2).ok).toBe(true);
    h.service.stop();
  });
});

describe("the mirror", () => {
  async function talk(h: H): Promise<SubsessionRecord> {
    h.onTurn = async (prompt, key) => {
      if (prompt.includes("subsession-start")) await h.service.ask(key, "Which branch?");
      else if (prompt.includes("subsession-owner-message")) await h.service.reply(key, "On it, using main. MEDIA:/home/x/memory/private/a.png");
      return { ok: true };
    };
    h.service.start();
    const task = spawn(h);
    await flush();
    h.service.ownerMessage("dm:owner", task.id, "use main", { files: ["/tmp/a.txt"] });
    await flush();
    return h.service.get(task.id)!;
  }

  it("keeps the conversation, wakes the owning session after each round, and shows only what it has not seen", async () => {
    const h = harness();
    const task = await talk(h);
    expect(task.conversation.map((e) => `${e.from}:${e.kind}`)).toEqual(["task:ask", "owner:message", "task:reply"]);
    expect(h.wakes.length).toBeGreaterThanOrEqual(1);
    expect(new Set(h.wakes)).toEqual(new Set(["dm:owner"]));

    const note = h.service.mirrorNote("dm:owner")!;
    expect(note.upTo).toEqual({ [task.id]: 3 });
    expect(note.text).toContain('type="subsession-activity"');
    expect(note.text).toContain(`- ${task.id} (ask): Which branch?`);
    expect(note.text).toContain("- owner: use main [1 file attached]");
    expect(note.text).toContain(`- ${task.id} (reply): On it, using main. [attachment]`);
    expect(note.text).not.toContain("memory/private");
    expect(note.text).not.toContain("/tmp/a.txt");
    expect(h.service.mirrorNote("dm:other")).toBeUndefined();

    h.service.markMirrorSeen(note.upTo);
    expect(h.service.hasUnseenMirror("dm:owner")).toBe(false);
    expect(h.service.mirrorNote("dm:owner")).toBeUndefined();
    h.service.stop();
  });

  it("asks for no silent turn for what the task said on its own, only once the owner wrote to it", async () => {
    const h = harness();
    h.onTurn = async (prompt, key) => {
      if (prompt.includes("subsession-start")) await h.service.ask(key, "Which branch?");
      else if (prompt.includes("subsession-owner-message")) await h.service.reply(key, "On it.");
      return { ok: true };
    };
    h.service.start();
    const task = spawn(h);
    await flush();
    expect(h.wakes).toEqual([]);
    h.service.ownerMessage("dm:owner", task.id, "use main");
    await flush();
    expect(h.wakes.length).toBeGreaterThanOrEqual(1);
    h.service.stop();
  });

  it("in note mode, never wakes the owning session", async () => {
    const h = harness({ mirror: "note" });
    await talk(h);
    expect(h.wakes).toEqual([]);
    expect(h.service.hasUnseenMirror("dm:owner")).toBe(true);
    h.service.stop();
  });

  it("a background turn wakes the owning session only when words the owner wrote to the task are unseen", async () => {
    const h = harness();
    h.onTurn = async (prompt, key) => {
      if (prompt.includes("subsession-start")) await h.service.ask(key, "Which branch?");
      return { ok: true };
    };
    h.service.start();
    const task = spawn(h);
    await flush();
    // The task's own question: the owner has read it; no silent turn for it.
    expect(h.wakes).toEqual([]);
    h.service.markMirrorSeen(h.service.mirrorNote("dm:owner")!.upTo);
    // A background subagent's report: the task speaks in a turn no driver ran.
    await h.service.notify(task.sessionKey, "The build finished.");
    h.service.onBackgroundReport(task.sessionKey);
    await h.service.reply(task.sessionKey, "Use main, then.");
    h.service.onBackgroundReport(task.sessionKey);
    expect(h.wakes).toEqual([]);
    expect(h.service.hasUnseenMirror("dm:owner")).toBe(true);
    // Something the owner wrote to it, still unseen: that wakes it, even with the task waiting.
    h.store.update(task.id, (r) => {
      const seq = (r.conversation.at(-1)?.seq ?? 0) + 1;
      r.conversation.push({ seq, at: h.clock, from: "owner", kind: "message", text: "use main" });
    });
    h.service.onBackgroundReport(task.sessionKey);
    expect(h.wakes).toEqual(["dm:owner"]);
    expect(h.service.get(task.id)).toMatchObject({ status: "waiting", waitingOn: "owner" });
    h.service.onBackgroundTurnFailed(task.sessionKey);
    expect(h.wakes).toEqual(["dm:owner", "dm:owner"]);
    h.service.stop();
  });

  it("takes no silent turn on the main conversation while the 5-hour window is at the quota pause", async () => {
    const h = harness();
    h.quota = 85;
    h.onTurn = async (prompt, key) => {
      if (prompt.includes("subsession-owner-message")) await h.service.reply(key, "On it.");
      return { ok: true };
    };
    h.service.start();
    const task = spawn(h);
    await flush();
    // Its own turns are paused by the gate; the owner's message runs anyway.
    expect(h.service.ownerMessage("dm:owner", task.id, "go on").ok).toBe(true);
    await flush();
    expect(h.service.get(task.id)!.conversation.map((e) => e.kind)).toContain("reply");
    expect(h.wakes).toEqual([]);
    // Still shown, with the session's next turn.
    expect(h.service.mirrorNote("dm:owner")?.text).toContain("On it.");
    h.service.stop();
  });

  it("a message the task sent but could not record still reaches the owning session, as a note", async () => {
    const notes: string[] = [];
    const h = harness();
    (h.service as unknown as { deps: { queuePendingNote(k: string, n: string): boolean } }).deps.queuePendingNote = (_k, n) => { notes.push(n); return true; };
    h.onTurn = () => new Promise(() => {});
    h.service.start();
    const task = spawn(h);
    await flush();
    const store = h.store as unknown as { update: (...a: unknown[]) => unknown };
    const real = store.update.bind(h.store);
    store.update = () => { throw new Error("disk full"); };
    expect((await h.service.notify(task.sessionKey, "Build is green.")).ok).toBe(true);
    store.update = real;
    expect(notes.some((n) => n.includes("Build is green."))).toBe(true);
    h.service.stop();
  });

  it("does not mirror a turn the task ran on its own without speaking", async () => {
    const h = harness();
    h.onTurn = async (_prompt, key) => {
      h.service.finish(key, "done");
      return { ok: true };
    };
    h.service.start();
    spawn(h);
    await flush();
    expect(h.wakes).toEqual([]);
    expect(h.service.mirrorNote("dm:owner")).toBeUndefined();
    h.service.stop();
  });

  it("cuts a long line", () => {
    const record = { id: "s1", title: "T", status: "active" } as SubsessionRecord;
    const text = formatMirrorNote([{ record, entries: [{ seq: 1, at: 0, from: "task", kind: "notify", text: "x".repeat(MIRROR_ENTRY_MAX + 50) }] }]);
    expect(text).toContain("… (cut)");
    expect(text).not.toContain("x".repeat(MIRROR_ENTRY_MAX));
  });

  it("says nothing about whether the turn it rides on is delivered (an owner turn is)", () => {
    const record = { id: "s1", title: "T", status: "active" } as SubsessionRecord;
    const text = formatMirrorNote([{ record, entries: [{ seq: 1, at: 0, from: "task", kind: "notify", text: "hi" }] }]);
    expect(text).not.toMatch(/is sent|not sent|NO_REPLY/);
  });
});
