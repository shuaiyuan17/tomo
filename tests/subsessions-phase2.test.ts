import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBSESSIONS, type SubsessionConfig } from "../src/config.js";
import {
  SubsessionService,
  type ScopeSendResult,
  type SubsessionTodoLink,
  type TaskTurnOutcome,
} from "../src/agent/subsessions/service.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { ACTIVE_HEARTBEAT_MS } from "../src/agent/subsessions/service.js";
import { createTodoLink } from "../src/agent/subsessions/todo-link.js";
import { formatMirrorNote, MIRROR_ENTRY_MAX } from "../src/agent/subsessions/prompt.js";
import { TodoStore } from "../src/todos/store.js";
import { DEFAULT_TODOS } from "../src/todos/limits.js";
import { appendInput, type SubsessionRecord } from "../src/agent/subsessions/types.js";

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
  todoCalls: string[];
  cronJobs: number;
  onTurn: (prompt: string, key: string) => TaskTurnOutcome | Promise<TaskTurnOutcome>;
  /** The 5-hour window's share used, as the quota gate reads it. */
  quota?: number;
}

function harness(cfg: Partial<SubsessionConfig> = {}, opts: { todos?: SubsessionTodoLink; registry?: Set<string>; unlinked?: string[] } = {}): H {
  const h = { prompts: [], sent: [], notices: [], wakes: [], clock: 1_000_000, todoCalls: [], onTurn: () => ({ ok: true }) } as unknown as H;
  h.store = new SubsessionStore(join(dir, "t.json"), { strictTransitions: true, now: () => h.clock });
  const recording: SubsessionTodoLink = {
    open: (r) => { h.todoCalls.push(`open ${r.id}`); return "t-1"; },
    find: () => undefined,
    set: (id, on, next) => { h.todoCalls.push(`set ${id} ${on} ${next}`); },
    close: (id, reason) => { h.todoCalls.push(`close ${id} ${reason}`); },
  };
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
    queuePendingNote: () => true,
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
    todos: opts.todos ?? recording,
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
      else h.service.progress(key, `step ${turns}`);
      return { ok: true };
    };
    h.service.start();
    const task = spawn(h);
    await flush();
    expect(h.service.get(task.id)?.status).toBe("finished");
    h.service.stop();
  });
});

describe("the todo link", () => {
  it("opens a todo at spawn and follows the task: owner while it asks, external while it works, owner for the result", async () => {
    const h = harness();
    h.onTurn = async (prompt, key) => {
      if (prompt.includes("subsession-start")) await h.service.ask(key, "Which branch?");
      else h.service.finish(key, "Merged.");
      return { ok: true };
    };
    h.service.start();
    const task = spawn(h);
    expect(h.service.get(task.id)?.todoId).toBe("t-1");
    await flush();
    h.service.ownerMessage("dm:owner", task.id, "main");
    await flush();
    expect(h.todoCalls).toEqual([
      `open ${task.id}`,
      `set t-1 external ${task.id} is working on it (/s ${task.id})`,
      `set t-1 owner Answer ${task.id}: asked the owner: Which branch?`,
      `set t-1 external ${task.id} is working on it (/s ${task.id})`,
      `set t-1 owner Read ${task.id}'s result, then close this`,
    ]);
    h.service.stop();
  });

  it("drops it when the task is cancelled, and makes none when todos are off", async () => {
    const h = harness();
    h.service.start();
    const task = spawn(h);
    await h.service.cancel(task.id, "no longer needed");
    expect(h.todoCalls.at(-1)).toBe(`close t-1 sub-session ${task.id} cancelled`);
    h.service.stop();

    const off = harness({ todos: false });
    off.service.start();
    const other = spawn(off);
    expect(off.service.get(other.id)?.todoId).toBeUndefined();
    expect(off.todoCalls).toEqual([]);
    off.service.stop();
  });

  it("a restart fixes the todo of a task that ended just before the crash", () => {
    const seed = harness();
    const t = seed.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    seed.store.update(t.id, (r) => { r.todoId = "t-1"; });
    seed.store.transition(t.id, "cancel", { reason: "stopped" }); // the todo update never happened
    const h = harness();
    h.service.start();
    expect(h.todoCalls).toContain(`close t-1 sub-session ${t.id} cancelled`);
    h.service.stop();
  });

  it("a todo made just before a crash, its id never on the record, is adopted instead of made twice", () => {
    const todos = new TodoStore(join(dir, "todos"), DEFAULT_TODOS);
    const link = createTodoLink(todos);
    const seed = harness({}, { todos: link });
    const t = seed.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    const made = link.open(seed.store.get(t.id)!)!; // ...and the crash before the record got it
    const h = harness({ maxRunning: 0 }, { todos: link });
    h.service.start();
    expect(h.store.get(t.id)?.todoId).toBe(made);
    expect(todos.list().filter((i) => i.ref === t.sessionKey)).toHaveLength(1);
    h.service.stop();
  });

  it("never adopts a todo another scope wrote with the task's ref", () => {
    const todos = new TodoStore(join(dir, "todos"), DEFAULT_TODOS);
    const link = createTodoLink(todos);
    const seed = harness({}, { todos: link });
    const t = seed.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    const foreign = todos.add({ title: "group thing", next: "x", waiting_on: "external", ref: t.sessionKey, session: "telegram:-100", source: "self" });
    const h = harness({ maxRunning: 0 }, { todos: link });
    h.service.start();
    const mine = h.store.get(t.id)?.todoId;
    expect(mine).toBeDefined();
    expect(mine).not.toBe(foreign.id);
    expect(todos.list().find((i) => i.id === mine)).toMatchObject({ session: "dm:owner" });
    h.service.stop();
  });

  it("an ended task whose todo id never reached the record finds it and closes it, and makes none", () => {
    const todos = new TodoStore(join(dir, "todos"), DEFAULT_TODOS);
    const link = createTodoLink(todos);
    const seed = harness({}, { todos: link });
    const t = seed.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    link.open(seed.store.get(t.id)!);
    seed.store.transition(t.id, "cancel", { reason: "stopped" });
    const other = seed.store.create({ parentKey: "dm:owner", title: "u", brief: "b" });
    seed.store.transition(other.id, "cancel", { reason: "stopped" }); // never had one
    const h = harness({ maxRunning: 0 }, { todos: link });
    h.service.start();
    expect(todos.list()).toEqual([]);
    h.service.stop();
  });

  it("writes real todos through the store, and a todo the owner closed is left alone", async () => {
    const todos = new TodoStore(join(dir, "todos"), DEFAULT_TODOS);
    const link = createTodoLink(todos);
    const h = harness({}, { todos: link });
    h.service.start();
    const task = spawn(h, "A very long title ".repeat(10));
    const todoId = h.service.get(task.id)!.todoId!;
    const item = todos.list().find((i) => i.id === todoId)!;
    expect(item).toMatchObject({ waiting_on: "external", session: "dm:owner", ref: task.sessionKey, source: "self" });
    expect([...item.title].length).toBeLessThanOrEqual(DEFAULT_TODOS.titleMaxChars);

    link.set(todoId, "owner", "Answer it");
    expect(todos.list()[0]).toMatchObject({ waiting_on: "owner", next: "Answer it" });
    todos.resolve(todoId, { action: "done", by: "owner" });
    link.set(todoId, "external", "working");
    link.close(todoId, "cancelled");
    expect(todos.list()).toEqual([]);
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
