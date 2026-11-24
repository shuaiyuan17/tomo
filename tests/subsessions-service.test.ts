import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBSESSIONS, type SubsessionConfig } from "../src/config.js";
import { CRON_RECHECK_MS, MAX_INTERRUPT_STREAK, REPORT_RETRY_MS, SubsessionService, validateTaskModel, type TaskTurnOutcome } from "../src/agent/subsessions/service.js";
import { PENDING_INPUT_MAX } from "../src/agent/subsessions/types.js";
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
  /** For each wake: was any of that scope's reports already marked delivered when it was scheduled? */
  wakeSawDelivered: boolean[];
  registry: Set<string>;
  sdk: Set<string>;
  unlinked: string[];
  stopped: string[];
  context: Map<string, { used: number; estimated: boolean }>;
  cfg: SubsessionConfig;
  onTurn: TurnHandler;
  /** Runs inside every cron count, before it answers (to land input in a race window). */
  onCronCount?: (key: string) => void;
  /** null: the cron store is unreadable. */
  cronUnknown: boolean;
  /** Note writes that fail: the note is still held in memory, like the real queue. */
  noteWriteFails: number;
  /** Later re-writes of the held notes that fail. */
  persistFails: number;
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
    wakeSawDelivered: [] as boolean[],
    registry: new Set<string>(),
    sdk: new Set<string>(),
    unlinked: [] as string[],
    stopped: [] as string[],
    context: new Map<string, { used: number; estimated: boolean }>(),
    cfg: { ...DEFAULT_SUBSESSIONS, enabled: true, ...cfg },
    onTurn,
    cronUnknown: false,
    noteWriteFails: 0,
    persistFails: 0,
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
    queuePendingNote: (key, note) => {
      h.notes.set(key, [...(h.notes.get(key) ?? []), note]);
      if (h.noteWriteFails > 0) { h.noteWriteFails -= 1; return false; }
      return true;
    },
    persistPendingNotes: () => {
      if (h.persistFails > 0) { h.persistFails -= 1; return false; }
      return true;
    },
    hasPendingNote: (key, pred) => (h.notes.get(key) ?? []).some(pred),
    wakeScope: (parentKey) => { h.wakes.push(parentKey); h.wakeSawDelivered.push(h.store.list().some((t) => t.parentKey === parentKey && t.reportDelivered)); },
    contextUsage: (key) => h.context.get(key),
    cronJobCount: (key) => { h.onCronCount?.(key); return h.cronUnknown ? undefined : h.cron.get(key) ?? 0; },
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
    // Still on the record, in flight, until that turn completes.
    expect(h.store.get(t.id)).toMatchObject({ inflightInputs: 1 });
    expect(h.store.get(t.id)?.pendingInput).toHaveLength(1);
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

describe("SubsessionService: inputs are never lost", () => {
  it("keeps a turn's inputs on the record until it completes, and redelivers them after a crash", async () => {
    // Process 1: the turn carrying the message never ends (the daemon dies under it).
    const h = harness({}, (turn, hh) => {
      if (turn.prompt.includes("note this")) return new Promise(() => {});
      hh.cron.set(turn.key, 1);
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)?.status).toBe("waiting");
    h.service.relay(t.id, "note this");
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "active", inflightInputs: 1 });
    expect(h.store.get(t.id)?.pendingInput[0]).toContain("note this");
    // Process 2: same files, fresh service.
    const h2 = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    h2.sdk.add(t.sessionKey);
    h2.registry.add(t.sessionKey);
    h2.service.start();
    await flush();
    const resumed = h2.turns[0].prompt;
    expect(resumed).toContain('type="subsession-resume"');
    expect(resumed).toContain('type="subsession-redelivery"');
    expect(resumed).toContain("note this");
    expect(h2.store.get(t.id)).toMatchObject({ status: "finished", pendingInput: [], inflightInputs: 0, redeliveredInputs: 0 });
  });

  it("refuses input past the cap instead of dropping the oldest, and tells the owner about a dropped check-back", async () => {
    const h = harness({ maxRunning: 1 }, () => new Promise(() => {}));
    h.service.start();
    spawn(h, "busy");
    const t = spawn(h, "queued");
    await flush();
    for (let i = 0; i < PENDING_INPUT_MAX; i++) expect(h.service.relay(t.id, `m${i}`).ok).toBe(true);
    const refused = h.service.relay(t.id, "one too many");
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? undefined : refused.refused).toBeTruthy();
    expect(h.service.onCronFire(t.sessionKey, "check")).toBe(false);
    const pending = h.store.get(t.id)!.pendingInput;
    expect(pending).toHaveLength(PENDING_INPUT_MAX);
    expect(pending[0]).toContain("m0");
    expect(h.notices.at(-1)?.text).toContain("check-back was dropped");
  });

  it("gives input that arrived during a turn its own turn before waiting on a check-back", async () => {
    let n = 0;
    const h = harness({}, working((turn, hh) => {
      n += 1;
      if (n === 1) {
        hh.cron.set(turn.key, 1);
        hh.service.relay("s1", "arrived mid-turn"); // the driver is busy: it is only persisted
      }
    }));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.turns).toHaveLength(2);
    expect(h.turns[1].prompt).toContain("arrived mid-turn");
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "external", pendingInput: [] });
  });

  it("does not wait while input lands between the end of a turn and the wait (guarded under the lock)", async () => {
    let n = 0;
    const h = harness({}, working((turn, hh) => { n += 1; if (n === 1) hh.cron.set(turn.key, 1); }));
    let landed = false;
    h.onCronCount = () => {
      if (landed || n !== 1) return;
      landed = true;
      h.service.relay("s1", "landed in the window");
    };
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.turns.some((x) => x.prompt.includes("landed in the window"))).toBe(true);
    expect(h.store.get(t.id)?.pendingInput).toEqual([]);
  });

  it("parks on an unreadable cron store rather than auto-continuing, and does not call the check-back lost", async () => {
    const h = harness({}, working());
    h.cronUnknown = true;
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "external" });
    // A fresh start with the store still unreadable: not woken as "lost".
    const h2 = harness({}, working());
    h2.cronUnknown = true;
    h2.sdk.add(t.sessionKey);
    h2.service.start();
    await flush();
    expect(h2.turns).toHaveLength(0);
    expect(h2.store.get(t.id)?.status).toBe("waiting");
  });

  it("retries a report note that could not be written, in-process, and wakes before marking it delivered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "the result")));
      h.noteWriteFails = 1;
      h.service.start();
      const t = spawn(h);
      await flush();
      expect(h.store.get(t.id)).toMatchObject({ status: "finished", reportDelivered: false });
      expect(h.wakes).toEqual([]);
      vi.advanceTimersByTime(REPORT_RETRY_MS);
      expect(h.store.get(t.id)?.reportDelivered).toBe(true);
      expect(h.wakes).toEqual(["dm:owner"]);
      expect(h.wakeSawDelivered).toEqual([false]);
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not take a note held in memory after a failed write for a durable one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "the result")));
      h.noteWriteFails = 1;
      h.persistFails = 1;
      h.service.start();
      const t = spawn(h);
      await flush();
      // The note sits in memory (the write failed): not delivered.
      expect(h.notes.get("dm:owner")?.filter((n) => n.includes('type="subsession-report"'))).toHaveLength(1);
      vi.advanceTimersByTime(REPORT_RETRY_MS);
      // The re-write failed too: still not delivered, no wake.
      expect(h.store.get(t.id)?.reportDelivered).toBe(false);
      expect(h.wakes).toEqual([]);
      vi.advanceTimersByTime(2 * REPORT_RETRY_MS);
      expect(h.store.get(t.id)?.reportDelivered).toBe(true);
      expect(h.wakes).toEqual(["dm:owner"]);
      // Re-written, never queued twice.
      expect(h.notes.get("dm:owner")?.filter((n) => n.includes('type="subsession-report"'))).toHaveLength(1);
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks at a task parked on an unreadable cron store again, in-process, and wakes it when no job exists", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let calls = 0;
      const h = harness({}, working((turn, hh) => { calls += 1; if (calls > 1) hh.service.finish(turn.key, "ok"); }));
      h.cronUnknown = true;
      h.service.start();
      const t = spawn(h);
      await flush();
      expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "external" });
      // Still unreadable at the first look: stays parked, looked at again.
      vi.advanceTimersByTime(CRON_RECHECK_MS);
      await flush();
      expect(h.turns).toHaveLength(1);
      h.cronUnknown = false; // readable now, and the job was never saved
      vi.advanceTimersByTime(CRON_RECHECK_MS);
      await flush();
      expect(h.turns).toHaveLength(2);
      expect(h.turns[1].prompt).toContain("check-back is missing");
      expect(h.store.get(t.id)?.status).toBe("finished");
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a parked task alone when the check-back job turns out to exist", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({}, working());
      h.cronUnknown = true;
      h.service.start();
      const t = spawn(h);
      await flush();
      h.cronUnknown = false;
      h.cron.set(t.sessionKey, 1);
      vi.advanceTimersByTime(CRON_RECHECK_MS);
      await flush();
      expect(h.turns).toHaveLength(1);
      expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "external" });
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("withdraws the task's restart claim when the restart was not launched", () => {
    const h = harness();
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.service.onRestartClaimed(t.sessionKey);
    expect(h.store.get(t.id)?.restartRequested).toBe(true);
    h.service.onRestartClaimFailed(t.sessionKey);
    expect(h.store.get(t.id)?.restartRequested).toBe(false);
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

  it("starts over, with both the start event and the resume warning, a task cut short before its first turn completed", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.store.transition(t.id, "start"); // persisted; the daemon died before the SDK session existed
    h.service.start();
    await flush();
    expect(h.store.get(t.id)?.transitions.map((x) => x.event)).toContain("restart");
    expect(h.turns[0].prompt).toContain('type="subsession-start"');
    expect(h.turns[0].prompt).toContain('type="subsession-resume"');
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", startDelivered: true, resumeNeeded: false });
    expect(h.registry.has(t.sessionKey)).toBe(true);
  });

  it("fails a task whose first turn was handed to the SDK but never completed, when its conversation is gone", async () => {
    const h = harness();
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.store.transition(t.id, "start");
    h.store.update(t.id, (r) => { r.startDispatched = true; }); // it may have done things
    h.service.start();
    await flush();
    expect(h.store.get(t.id)?.status).toBe("failed");
    expect(h.turns).toHaveLength(0);
  });

  it("marks the first turn dispatched before the SDK runs it", async () => {
    let seen: boolean | undefined;
    const h = harness({}, (turn, hh) => { seen = hh.store.get("s1")?.startDispatched; hh.service.finish(turn.key, "ok"); return { ok: true }; });
    h.service.start();
    spawn(h);
    await flush();
    expect(seen).toBe(true);
  });

  it("resumes a task that asked the owner during a turn a crash cut short, with that turn's input", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    const id = seed(h, "active", (s, i) => {
      s.update(i, (r) => { r.pendingInput = ["the owner's message"]; r.inflightInputs = 1; });
      s.transition(i, "ask"); // task_ask ran; the turn never settled
    });
    h.service.start();
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].prompt).toContain("the owner's message");
    expect(h.turns[0].prompt).toContain('type="subsession-resume"');
    expect(h.store.get(id)).toMatchObject({ status: "finished", pendingInput: [], inflightInputs: 0 });
  });

  it("resumes a task that asked the owner during a first turn a crash cut short", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.store.transition(t.id, "start");
    h.store.update(t.id, (r) => { r.startDispatched = true; });
    h.store.transition(t.id, "ask");
    h.registry.add(t.sessionKey);
    h.sdk.add(t.sessionKey);
    h.service.start();
    await flush();
    expect(h.turns[0].prompt).toContain('type="subsession-start"');
    expect(h.turns[0].prompt).toContain('type="subsession-resume"');
    expect(h.store.get(t.id)?.status).toBe("finished");
  });

  it("leaves a task that asked the owner in a completed turn waiting", async () => {
    const h = harness();
    const id = seed(h, "active", (s, i) => s.transition(i, "ask"));
    h.service.start();
    await flush();
    expect(h.turns).toHaveLength(0);
    expect(h.store.get(id)).toMatchObject({ status: "waiting", waitingOn: "owner" });
  });

  it("wakes the owning session again at start for a delivered report whose note is still unread", () => {
    const h = harness();
    seed(h, "finished", (s, i) => s.update(i, (r) => { r.reportDelivered = true; }));
    h.notes.set("dm:owner", ['<tomo-event type="subsession-report" name="s1" ts="x">R</tomo-event>']);
    h.service.start();
    expect(h.wakes).toEqual(["dm:owner"]);
    expect(h.notes.get("dm:owner")).toHaveLength(1);
  });

  it("does not wake for a delivered report the owning session already read", () => {
    const h = harness();
    seed(h, "finished", (s, i) => s.update(i, (r) => { r.reportDelivered = true; }));
    h.service.start();
    expect(h.wakes).toEqual([]);
  });

  it("never unlinks orphans of a table recovered from an older backup, on this start or the next", async () => {
    const h0 = harness();
    seed(h0, "finished", (s, i) => s.update(i, (r) => { r.reportDelivered = true; }));
    copyFileSync(path, `${path}.bak`); // the backup: s1 only
    writeFileSync(path, "{broken");    // the primary, which also knew s2, is lost
    const registry = new Set(["task:s1", "task:s2"]);
    const startAgain = (): Harness => {
      const h = harness();
      for (const k of registry) { h.registry.add(k); h.sdk.add(k); }
      h.service.start();
      return h;
    };
    const h1 = startAgain();
    expect(h1.unlinked).toEqual([]);
    expect(h1.notices.filter((n) => n.to === "owner")).toHaveLength(1);
    expect(h1.store.read().untrusted).toMatchObject({ reason: "recovered" });
    // The next start reads a clean-looking table: the mark is what keeps it safe.
    const h2 = startAgain();
    expect(h2.store.state()).toBe("ok");
    expect(h2.unlinked).toEqual([]);
    expect(h2.notices).toHaveLength(0);
    expect(h2.service.spawn("dm:owner", { title: "x", brief: "y" })).toMatchObject({ ok: true, record: { id: "s3" } });
    const h3 = startAgain();
    expect(h3.unlinked).toEqual([]);
  });

  it("keeps the recovered mark when restart recovery writes the table before reconcile", async () => {
    const h0 = harness();
    seed(h0, "active", (s, i) => s.update(i, (r) => { r.pendingInput = ["m"]; r.inflightInputs = 1; }));
    copyFileSync(path, `${path}.bak`);
    writeFileSync(path, "");
    const h1 = harness(undefined, () => new Promise(() => {}));
    h1.registry.add("task:s1"); h1.sdk.add("task:s1"); h1.registry.add("task:s2");
    h1.service.start();
    expect(h1.unlinked).toEqual([]);
    const h2 = harness(undefined, () => new Promise(() => {}));
    h2.registry.add("task:s1"); h2.sdk.add("task:s1"); h2.registry.add("task:s2");
    h2.service.start();
    expect(h2.unlinked).toEqual([]);
    expect(h2.store.read().untrusted).toBeDefined();
  });

  it("trusts the table again once the registry holds no task it does not know", () => {
    const h0 = harness();
    seed(h0, "finished", (s, i) => s.update(i, (r) => { r.reportDelivered = true; }));
    h0.store.markUntrusted("lost");
    const h = harness();
    h.registry.add("task:s1"); h.sdk.add("task:s1");
    h.service.start();
    expect(h.store.read().untrusted).toBeUndefined();
  });

  it("keeps a new task off the ids of task conversations the lost table no longer knows", () => {
    const h = harness();
    h.registry.add("task:s3");
    h.service.start();
    expect(h.service.spawn("dm:owner", { title: "x", brief: "y" })).toMatchObject({ ok: true, record: { id: "s4" } });
  });

  it("stays off when the table is missing and its backup is unreadable", () => {
    writeFileSync(`${path}.bak`, "{broken");
    const h = harness();
    h.registry.add("task:s1");
    h.service.start();
    expect(h.service.available()).toBe(false);
    expect(h.service.spawn("dm:owner", { title: "x", brief: "y" }).ok).toBe(false);
  });

  it("wakes a task waiting on a check-back job that was lost", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    const id = seed(h, "waiting-external");
    h.service.start();
    await flush();
    expect(h.turns[0].prompt).toContain("check-back is missing");
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
