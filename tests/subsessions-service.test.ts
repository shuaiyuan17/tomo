import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SUBSESSIONS, type SubsessionConfig } from "../src/config.js";
import { MAX_INTERRUPT_STREAK, SubsessionService, validateTaskModel, type TaskTurnOutcome } from "../src/agent/subsessions/service.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";

type Turn = { key: string; prompt: string; bare: boolean };
type TurnHandler = (turn: Turn, h: Harness) => TaskTurnOutcome | Promise<TaskTurnOutcome>;

interface Harness {
  service: SubsessionService;
  store: SubsessionStore;
  turns: Turn[];
  cron: Map<string, number>;
  notes: Map<string, string[]>;
  sent: Array<{ parentKey: string; text: string }>;
  notices: Array<{ to: string; text: string }>;
  wakes: string[];
  registry: Set<string>;
  sdk: Set<string>;
  unlinked: string[];
  stopped: string[];
  context: Map<string, { used: number; estimated: boolean }>;
  cfg: SubsessionConfig;
  onTurn: TurnHandler;
}

let dir = "";
let path = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-subsvc-"));
  path = join(dir, "subsessions.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Let the drivers run to quiet. */
async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
}

function harness(cfg: Partial<SubsessionConfig> = {}, onTurn: TurnHandler = () => ({ ok: true })): Harness {
  const store = new SubsessionStore(path, { strictTransitions: true });
  const h = {
    store,
    turns: [] as Turn[],
    cron: new Map<string, number>(),
    notes: new Map<string, string[]>(),
    sent: [] as Array<{ parentKey: string; text: string }>,
    notices: [] as Array<{ to: string; text: string }>,
    wakes: [] as string[],
    registry: new Set<string>(),
    sdk: new Set<string>(),
    unlinked: [] as string[],
    stopped: [] as string[],
    context: new Map<string, { used: number; estimated: boolean }>(),
    cfg: { ...DEFAULT_SUBSESSIONS, enabled: true, ...cfg },
    onTurn,
  } as Harness;
  h.service = new SubsessionService({
    store,
    config: () => h.cfg,
    runTaskTurn: async (key, prompt, opts) => {
      const turn = { key, prompt, bare: opts.bare };
      h.turns.push(turn);
      h.sdk.add(key);
      await new Promise((r) => setImmediate(r));
      return h.onTurn(turn, h);
    },
    sendToScope: async (parentKey, text) => { h.sent.push({ parentKey, text }); return { ok: true }; },
    noticeToScope: async (to, text) => { h.notices.push({ to, text }); },
    noticeOwner: async (text) => { h.notices.push({ to: "owner", text }); },
    queuePendingNote: (key, note) => { h.notes.set(key, [...(h.notes.get(key) ?? []), note]); return true; },
    hasPendingNote: (key, pred) => (h.notes.get(key) ?? []).some(pred),
    wakeScope: (parentKey) => { h.wakes.push(parentKey); },
    contextUsage: (key) => h.context.get(key),
    cronJobCount: (key) => h.cron.get(key) ?? 0,
    removeCronJobs: (key) => { h.cron.delete(key); },
    stopSession: async (key) => { h.stopped.push(key); },
    hasSdkSession: (key) => h.sdk.has(key),
    ensureRegistryEntry: (key) => { h.registry.add(key); },
    unlinkRegistryEntry: (key) => { h.unlinked.push(key); h.registry.delete(key); h.sdk.delete(key); },
    registryTaskKeys: () => [...h.registry],
    isStopping: () => false,
  });
  return h;
}

/** A turn that makes progress (a tool call) and then does `then`. */
function working(then?: (turn: Turn, h: Harness) => void): TurnHandler {
  return (turn, h) => {
    h.service.noteToolUse(turn.key);
    then?.(turn, h);
    return { ok: true };
  };
}

const spawn = (h: Harness, title = "Fix the bug", parentKey = "dm:owner") => {
  const r = h.service.spawn(parentKey, { title, brief: "Do the thing.", quote: ["please fix it"] });
  if (!r.ok) throw new Error(r.error);
  return r.record;
};

describe("SubsessionService", () => {
  it("starts a spawned task with its brief and the owner's words, and finishes it", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "Done: PR #1")));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].prompt).toContain('<tomo-event type="subsession-start" name="s1"');
    expect(h.turns[0].prompt).toContain("> please fix it");
    const done = h.store.get(t.id)!;
    expect(done).toMatchObject({ status: "finished", report: "Done: PR #1", reportDelivered: true, startDelivered: true });
    const note = h.notes.get("dm:owner")!.find((n) => n.includes('type="subsession-report" name="s1"'));
    expect(note).toContain("Done: PR #1");
    expect(h.wakes).toEqual(["dm:owner"]);
  });

  it("runs at most maxRunning tasks; the rest wait queued until a slot frees", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness({ maxRunning: 1 }, async (turn, hh) => {
      if (turn.key === "task:s1") await gate;
      hh.service.noteToolUse(turn.key);
      hh.service.finish(turn.key, "ok");
      return { ok: true };
    });
    h.service.start();
    spawn(h, "one");
    spawn(h, "two");
    await flush();
    expect(h.store.get("s2")?.status).toBe("queued");
    expect(h.turns.map((t) => t.key)).toEqual(["task:s1"]);
    release();
    await flush();
    expect(h.store.get("s2")?.status).toBe("finished");
  });

  it("refuses to spawn beyond maxOpen and refuses Haiku", () => {
    const h = harness({ maxOpen: 1, maxRunning: 0 + 1 }, () => new Promise(() => {}));
    h.service.start();
    spawn(h);
    const second = h.service.spawn("dm:owner", { title: "x", brief: "y" });
    expect(second.ok).toBe(false);
    expect(validateTaskModel("haiku")).toMatch(/Haiku/);
    expect(validateTaskModel("claude-haiku-4-5")).toMatch(/Haiku/);
    expect(validateTaskModel("sonnet")).toBeNull();
    expect(validateTaskModel("gpt-5")).toMatch(/unknown/);
  });

  it("auto-continues, and pauses for the owner after three turns with no progress", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.turns).toHaveLength(3);
    expect(h.turns[1].prompt).toContain('type="subsession-continue"');
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner" });
    expect(h.notices).toHaveLength(1);
    expect(h.notes.get("dm:owner")?.some((n) => n.includes('type="subsession-activity"'))).toBe(true);
  });

  it("waits on its cron check-back, and the check-back goes through the scheduler", async () => {
    let calls = 0;
    const h = harness({}, working((turn, hh) => {
      calls += 1;
      if (calls === 1) hh.cron.set(turn.key, 1);
      else hh.service.finish(turn.key, "CI green");
    }));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "external" });
    h.cron.delete(t.sessionKey);
    expect(h.service.onCronFire(t.sessionKey, "check CI")).toBe(true);
    await flush();
    expect(h.turns[1].prompt).toContain("check CI");
    const log = h.store.get(t.id)!.transitions.map((x) => `${x.event}:${x.to}`);
    expect(log).toEqual(["spawn:queued", "start:active", "wait_external:waiting", "cron_wake:queued", "start:active", "finish:finished"]);
  });

  it("ignores a cron fire on a task waiting for the owner, and removes jobs of an ended task", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)?.waitingOn).toBe("owner");
    expect(h.service.onCronFire(t.sessionKey, "check")).toBe(false);
    expect(h.store.get(t.id)?.status).toBe("waiting");
    await h.service.cancel(t.id, "no");
    h.cron.set(t.sessionKey, 1);
    expect(h.service.onCronFire(t.sessionKey, "check")).toBe(false);
    expect(h.cron.has(t.sessionKey)).toBe(false);
  });

  it("holds a message to a queued task and delivers it with the first turn", async () => {
    const h = harness({ maxRunning: 1 }, () => new Promise(() => {}));
    h.service.start();
    spawn(h, "busy");
    const t = spawn(h, "later");
    expect(h.service.relay(t.id, "use the staging db").ok).toBe(true);
    expect(h.store.get(t.id)?.status).toBe("queued");
    expect(h.store.get(t.id)?.pendingInput).toHaveLength(1);
    await flush();
    expect(h.turns.map((x) => x.key)).toEqual(["task:s1"]);
    // Free the slot by cancelling the first: the second starts with the message.
    await h.service.cancel("s1", "test");
    await flush();
    const first = h.turns.find((x) => x.key === t.sessionKey)!;
    expect(first.prompt).toContain('type="subsession-start"');
    expect(first.prompt).toContain("use the staging db");
    expect(h.store.get(t.id)?.pendingInput).toEqual([]);
  });

  it("a relay wakes a task waiting for the owner, past the slot cap", async () => {
    let n = 0;
    const h = harness({ maxRunning: 1 }, (turn, hh) => {
      n += 1;
      if (n > 3) { hh.service.noteToolUse(turn.key); hh.service.finish(turn.key, "ok"); }
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)?.waitingOn).toBe("owner");
    h.service.relay(t.id, "go ahead");
    await flush();
    expect(h.turns.at(-1)?.prompt).toContain("go ahead");
    expect(h.store.get(t.id)?.status).toBe("finished");
  });

  it("cancel is idempotent and stops the session once", async () => {
    const h = harness({}, () => new Promise(() => {}));
    h.service.start();
    const t = spawn(h);
    h.cron.set(t.sessionKey, 2);
    expect(await h.service.cancel(t.id, "x")).toMatchObject({ ok: true, changed: true });
    expect(await h.service.cancel(t.id, "x")).toMatchObject({ ok: true, changed: false });
    expect(h.stopped).toEqual([t.sessionKey]);
    expect(h.cron.has(t.sessionKey)).toBe(false);
  });

  it("compacts with a bare /compact when the context is over the limit, then reminds the task", async () => {
    let n = 0;
    const h = harness({ maxContextTokens: 1000 }, (turn, hh) => {
      n += 1;
      if (turn.bare) { hh.context.set(turn.key, { used: 100, estimated: false }); return { ok: true }; }
      hh.service.noteToolUse(turn.key);
      if (n === 1) hh.context.set(turn.key, { used: 5000, estimated: false });
      else hh.service.finish(turn.key, "done");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.turns[1]).toMatchObject({ bare: true });
    expect(h.turns[1].prompt.startsWith("/compact ")).toBe(true);
    expect(h.turns[2].prompt).toContain('type="subsession-record"');
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", compactPending: false, postCompactReminder: false });
  });

  it("does not wake a finished task just to compact it", async () => {
    const h = harness({ maxContextTokens: 1000 }, working((turn, hh) => {
      hh.context.set(turn.key, { used: 5000, estimated: false });
      hh.service.finish(turn.key, "done");
    }));
    h.service.start();
    spawn(h);
    await flush();
    expect(h.turns).toHaveLength(1);
  });

  it("does not compact on an estimated context reading", async () => {
    const h = harness({ maxContextTokens: 1000 }, working((turn, hh) => {
      hh.context.set(turn.key, { used: 5000, estimated: true });
      hh.service.finish(turn.key, "done");
    }));
    h.service.start();
    spawn(h);
    await flush();
    expect(h.turns.some((t) => t.bare)).toBe(false);
  });

  it("puts a turn's inputs back when shutdown cut it short", async () => {
    const h = harness({}, (turn) => (turn.prompt.includes("note this") ? { ok: false, shutdown: true } : new Promise(() => {})));
    h.service.start();
    const t = spawn(h);
    await flush();
    h.store.transition(t.id, "stuck");
    h.service.relay(t.id, "note this");
    await flush();
    expect(h.store.get(t.id)?.pendingInput.some((p) => p.includes("note this"))).toBe(true);
  });

  it("pauses after two failed turns in a row", async () => {
    const h = harness({}, () => ({ ok: false }));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.turns).toHaveLength(2);
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner", failStreak: 2, startDelivered: false });
    // The start event was never delivered by a completed turn: the next one carries it again.
    h.onTurn = working((turn, hh) => hh.service.finish(turn.key, "ok"));
    h.service.relay(t.id, "try again");
    await flush();
    expect(h.turns[2].prompt).toContain('type="subsession-start"');
  });

  it("gives up on a finished task's answer after two failed turns, or at once when stopped, and says so", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)?.status).toBe("finished");
    h.onTurn = () => ({ ok: false });
    h.service.relay(t.id, "one more thing");
    await flush();
    expect(h.turns).toHaveLength(3);
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", pendingInput: [], failStreak: 0 });
    expect(h.notices.at(-1)?.text).toContain("Couldn't answer the message it was sent");
    h.onTurn = () => ({ ok: false, stopped: true });
    h.service.relay(t.id, "and another");
    await flush();
    expect(h.turns).toHaveLength(4);
    expect(h.store.get(t.id)?.pendingInput).toEqual([]);
  });

  it("a background report on a task waiting on something external queues it with a continue", async () => {
    let n = 0;
    const h = harness({}, working((turn, hh) => {
      n += 1;
      if (n === 1) hh.cron.set(turn.key, 1);
      else { hh.cron.delete(turn.key); hh.service.finish(turn.key, "ok"); }
    }));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)?.waitingOn).toBe("external");
    h.service.onBackgroundReport(t.sessionKey);
    await flush();
    expect(h.store.get(t.id)!.transitions.map((x) => x.event)).toContain("background_report");
    expect(h.turns[1].prompt).toContain("A background task of yours reported back");
    expect(h.store.get(t.id)?.status).toBe("finished");
  });

  it("tells the owning scope, not a hardcoded owner key", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h, "group thing", "telegram:-100123");
    await flush();
    expect(h.notices.map((n) => n.to)).toEqual(["telegram:-100123"]);
    await h.service.notify(t.sessionKey, "need a decision");
    expect(h.sent).toEqual([{ parentKey: "telegram:-100123", text: "[s1 · group thing] need a decision" }]);
    expect(h.service.list("dm:owner")).toEqual([]);
    expect(h.service.parentKeyOf(t.sessionKey)).toBe("telegram:-100123");
  });
});

describe("SubsessionService start: restart recovery and reconcile", () => {
  function seed(h: Harness, state: "active" | "waiting-external" | "finished", patch?: (s: SubsessionStore, id: string) => void): string {
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.store.transition(t.id, "start");
    h.store.update(t.id, (r) => { r.startDelivered = true; });
    h.registry.add(t.sessionKey);
    h.sdk.add(t.sessionKey);
    if (state === "waiting-external") h.store.transition(t.id, "wait_external");
    if (state === "finished") h.store.transition(t.id, "finish", { patch: (r) => { r.report = "R"; } });
    patch?.(h.store, t.id);
    return t.id;
  }

  it("resumes an active task through the scheduler with a resume event", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    const id = seed(h, "active");
    h.service.start();
    await flush();
    expect(h.turns[0].prompt).toContain('type="subsession-resume"');
    expect(h.store.get(id)!.transitions.map((x) => x.event)).toEqual(["spawn", "start", "restart", "start", "finish"]);
    expect(h.store.get(id)).toMatchObject({ resumeNeeded: false, interruptStreak: 0 });
  });

  it("does not resume a task that restarted Tomo itself", async () => {
    const h = harness();
    const id = seed(h, "active", (s, i) => s.update(i, (r) => { r.restartRequested = true; }));
    h.service.start();
    await flush();
    expect(h.turns).toHaveLength(0);
    expect(h.store.get(id)).toMatchObject({ status: "waiting", waitingOn: "owner", restartRequested: false });
    expect(h.notices).toHaveLength(1);
  });

  it("fails a task interrupted too many times in a row", async () => {
    const h = harness();
    const id = seed(h, "active", (s, i) => s.update(i, (r) => { r.interruptStreak = MAX_INTERRUPT_STREAK; }));
    h.service.start();
    await flush();
    expect(h.store.get(id)?.status).toBe("failed");
    expect(h.turns).toHaveLength(0);
  });

  it("fails a started task whose SDK session is gone, rather than starting it over", async () => {
    const h = harness();
    const id = seed(h, "waiting-external");
    h.cron.set(`task:${id}`, 1);
    h.sdk.clear();
    h.service.start();
    await flush();
    expect(h.store.get(id)?.status).toBe("failed");
    expect(h.turns).toHaveLength(0);
  });

  it("wakes a task waiting on a check-back job that was lost", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    const id = seed(h, "waiting-external");
    h.service.start();
    await flush();
    expect(h.turns[0].prompt).toContain("check-back was lost");
    expect(h.store.get(id)?.status).toBe("finished");
  });

  it("redelivers a report that never reached the owning session, once", async () => {
    const h = harness();
    const id = seed(h, "finished");
    h.service.start();
    expect(h.store.get(id)?.reportDelivered).toBe(true);
    expect(h.notes.get("dm:owner")?.filter((n) => n.includes('type="subsession-report"'))).toHaveLength(1);
  });

  it("unlinks registry task entries the table does not know, only when the table read cleanly and holds tasks", () => {
    const h = harness();
    seed(h, "finished");
    h.registry.add("task:s99");
    h.service.start();
    expect(h.unlinked).toEqual(["task:s99"]);
  });

  it("unlinks nothing when the table is empty next to task entries in the registry", () => {
    const h = harness();
    h.registry.add("task:s1");
    h.service.start();
    expect(h.unlinked).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  it("stays off and unlinks nothing when the table is unreadable", () => {
    writeFileSync(path, "{broken");
    const h = harness();
    h.registry.add("task:s1");
    h.service.start();
    expect(h.service.available()).toBe(false);
    expect(h.unlinked).toEqual([]);
    expect(h.service.spawn("dm:owner", { title: "x", brief: "y" }).ok).toBe(false);
    expect(h.notices).toHaveLength(1);
  });

  it("archives a finished task after 7 days and unlinks it", () => {
    const h = harness();
    const id = seed(h, "finished", (s, i) => s.update(i, (r) => { r.reportDelivered = true; r.endedAt = Date.now() - 8 * 24 * 3600 * 1000; }));
    h.service.start();
    expect(h.store.get(id)?.status).toBe("archived");
    expect(h.unlinked).toEqual([`task:${id}`]);
  });
});
