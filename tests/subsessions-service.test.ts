import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBSESSIONS, type SubsessionConfig } from "../src/config.js";
import { CRON_RECHECK_MS, ENDED_KEEP_MS, EXTERNAL_WAIT_CHECK_MS, FINISHED_KEEP_MS, MAX_FINISH_REFUSALS, MAX_INTERRUPT_STREAK, REGISTRY_RECHECK_MS, REPORT_RETRY_MS, SETTLE_RETRY_MS, SubsessionService, validateTaskModel, type TaskTurnOutcome } from "../src/agent/subsessions/service.js";
import { PENDING_INPUT_MAX, DONE_STEPS_KEEP, PLAN_MAX_STEPS, PLAN_STEP_MAX, UPDATES_KEEP, appendInput } from "../src/agent/subsessions/types.js";
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
  /** The next N sends to the owning scope fail. */
  sendFails: number;
  /** Sends that throw (a channel failure surfacing as an exception). */
  sendThrows: number;
  registryReadable: boolean;
  /** The 5-hour window's share used; "throw": the samples cannot be read. */
  quota?: number | "throw";
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
    sendFails: 0,
    sendThrows: 0,
    registryReadable: true,
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
    sendToScope: async (parentKey, text) => {
      if (h.sendFails > 0) { h.sendFails -= 1; return { ok: false, error: "channel down" }; }
      if (h.sendThrows > 0) { h.sendThrows -= 1; throw new Error("channel send threw"); }
      h.sent.push({ parentKey, text });
      return { ok: true };
    },
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
    registryReadable: () => h.registryReadable,
    hasSdkSession: (key) => h.sdk.has(key),
    ensureRegistryEntry: (key) => { h.registry.add(key); },
    unlinkRegistryEntry: (key) => { h.unlinked.push(key); h.registry.delete(key); h.sdk.delete(key); },
    registryTaskKeys: () => [...h.registry],
    isStopping: () => false,
    sessionQuotaPercent: () => {
      if (h.quota === "throw") throw new Error("limits.ndjson unreadable");
      return h.quota;
    },
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
    const note = h.notes.get("dm:owner")!.find((n) => n.includes('type="subsession-report" name="s1#1"'));
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
    // Still on the record, unmarked, until that turn's result is written.
    expect(h.store.get(t.id)).toMatchObject({ seenThrough: 0, pendingInput: [{ seq: 1 }] });
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
    expect(h.store.get(t.id)?.pendingInput.some((p) => p.text.includes("note this"))).toBe(true);
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

  it("holds a finished task's unanswered input after two failed turns, or at once when stopped, and says so", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)?.status).toBe("finished");
    h.onTurn = () => ({ ok: false });
    h.service.relay(t.id, "one more thing");
    await flush();
    expect(h.turns).toHaveLength(3);
    // Never deleted: held, and no further turn until the owner writes again.
    let record = h.store.get(t.id)!;
    expect(record).toMatchObject({ status: "finished", failStreak: 0, heldThrough: 1 });
    expect(record.pendingInput.map((i) => i.text).join()).toContain("one more thing");
    expect(h.notices.at(-1)?.text).toContain("Couldn't answer the message it was sent");
    // The durable copy: the owning session gets what the task was sent, as a note.
    const handed = h.notes.get("dm:owner")?.filter((n) => n.includes('type="subsession-unanswered"') && n.includes("one more thing"));
    expect(handed).toHaveLength(1);
    expect(h.wakes).toContain("dm:owner"); // and the owning session is woken to deal with it
    h.onTurn = () => ({ ok: false, stopped: true });
    h.service.relay(t.id, "and another");
    await flush();
    expect(h.turns).toHaveLength(4);
    record = h.store.get(t.id)!;
    expect(record.pendingInput).toHaveLength(2);
    expect(record.heldThrough).toBe(2);
    // The next message brings everything held back, said to be possibly seen.
    h.onTurn = () => ({ ok: true });
    h.service.relay(t.id, "third");
    await flush();
    expect(h.turns).toHaveLength(5);
    expect(h.turns[4].prompt).toContain("one more thing");
    expect(h.turns[4].prompt).toContain("and another");
    expect(h.turns[4].prompt).toContain('type="subsession-redelivery"');
    expect(h.store.get(t.id)?.pendingInput).toEqual([]);
    // Held inputs survive a restart without a turn being started for them.
    h.onTurn = () => ({ ok: false, stopped: true });
    h.service.relay(t.id, "fourth");
    await flush();
    expect(h.turns).toHaveLength(6);
    h.service.stop();
    const h2 = harness();
    h2.service.start();
    await flush();
    expect(h2.turns).toHaveLength(0);
    expect(h2.store.get(t.id)?.pendingInput.map((i) => i.text).join()).toContain("fourth");
  });

  it("keeps the input a turn answered when its message could not be delivered, and sends it again", async () => {
    let n = 0;
    const h = harness({}, async (turn, hh) => {
      n += 1;
      if (n === 1) { hh.service.noteToolUse(turn.key); hh.store.transition("s1", "stuck"); return { ok: true }; }
      // Answer the relay; the send may fail.
      await hh.service.reply(turn.key, `answer ${n}`);
      if (n >= 3) hh.service.finish(turn.key, "done");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)?.waitingOn).toBe("owner");
    h.sendFails = 1;
    h.service.relay(t.id, "what is the status?");
    await flush();
    // Turn 2's answer was lost: the relay stayed and turn 3 got it again.
    expect(h.turns).toHaveLength(3);
    expect(h.turns[2].prompt).toContain("what is the status?");
    expect(h.turns[2].prompt).toContain('name="answer"');
    expect(h.sent.map((m) => m.text).join()).toContain("answer 3");
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
    await h.service.reply(t.sessionKey, "the answer");
    expect(h.sent).toEqual([{ parentKey: "telegram:-100123", text: "[s1 · group thing] the answer" }]);
    // A notice is handed to that scope, never to the owner's DM.
    await h.service.notify(t.sessionKey, "need a decision");
    expect(h.notes.get("telegram:-100123")?.some((n) => n.includes('type="subsession-notice"') && n.includes("need a decision"))).toBe(true);
    expect(h.notes.has("dm:owner")).toBe(false);
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
    expect(h.store.get(t.id)).toMatchObject({ status: "active", seenThrough: 0 });
    expect(h.store.get(t.id)?.pendingInput[0].text).toContain("note this");
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
    expect(h2.store.get(t.id)).toMatchObject({ status: "finished", pendingInput: [] });
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
    expect(pending[0].text).toContain("m0");
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

  describe("a check-back that goes away while Tomo runs", () => {
    const timers = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;
    /** First turn schedules a check-back and waits on it; any later turn finishes. */
    const parkThenFinish = () => {
      let calls = 0;
      return working((turn, hh) => {
        calls += 1;
        if (calls === 1) hh.cron.set(turn.key, 1);
        else hh.service.finish(turn.key, "ok");
      });
    };

    it("wakes a task whose job was disabled or removed mid-run, within the check interval", async () => {
      vi.useFakeTimers({ toFake: [...timers] });
      try {
        const h = harness({}, parkThenFinish());
        h.service.start();
        const t = spawn(h);
        await flush();
        expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "external" });
        // The one-shot was disabled (an interrupt, retries used up) or removed by hand.
        h.cron.set(t.sessionKey, 0);
        vi.advanceTimersByTime(EXTERNAL_WAIT_CHECK_MS - 1);
        await flush();
        expect(h.turns).toHaveLength(1);
        vi.advanceTimersByTime(1);
        await flush();
        expect(h.turns).toHaveLength(2);
        expect(h.turns[1].prompt).toContain("check-back is missing");
        expect(h.store.get(t.id)?.status).toBe("finished");
        h.service.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves a task alone while its job is still there", async () => {
      vi.useFakeTimers({ toFake: [...timers] });
      try {
        const h = harness({}, parkThenFinish());
        h.service.start();
        const t = spawn(h);
        await flush();
        vi.advanceTimersByTime(3 * EXTERNAL_WAIT_CHECK_MS);
        await flush();
        expect(h.turns).toHaveLength(1);
        expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "external", pendingInput: [] });
        h.service.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops looking once the service stops", async () => {
      vi.useFakeTimers({ toFake: [...timers] });
      try {
        const h = harness({}, parkThenFinish());
        h.service.start();
        const t = spawn(h);
        await flush();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        h.service.stop();
        // Every interval and timeout the service armed is gone, not just skipped.
        expect(vi.getTimerCount()).toBe(0);
        h.cron.set(t.sessionKey, 0);
        vi.advanceTimersByTime(2 * EXTERNAL_WAIT_CHECK_MS);
        await flush();
        expect(h.turns).toHaveLength(1);
        expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "external" });
      } finally {
        vi.useRealTimers();
      }
    });
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

  it("writes nothing to the table between taking a slot and running the turn", async () => {
    let atTurn = "";
    let afterStart = "";
    const h = harness({}, (turn, hh) => { atTurn = readFileSync(path, "utf8"); hh.service.finish(turn.key, "ok"); return { ok: true }; });
    h.service.start();
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.service.relay(t.id, "an input");
    const realKick = h.store.transition.bind(h.store);
    h.store.transition = ((id, event, opts) => {
      const out = realKick(id, event, opts);
      if (event === "start") afterStart = readFileSync(path, "utf8");
      return out;
    }) as typeof h.store.transition;
    h.service.schedule();
    await flush();
    expect(afterStart).not.toBe("");
    expect(atTurn).toBe(afterStart);
  });

  it("resumes a task that asked the owner during a turn a crash cut short, with that turn's input", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    const id = seed(h, "active", (s, i) => {
      s.update(i, (r) => { appendInput(r, "the owner's message"); });
      s.transition(i, "ask"); // task_ask ran; the turn never settled
    });
    h.service.start();
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].prompt).toContain("the owner's message");
    expect(h.turns[0].prompt).toContain('type="subsession-resume"');
    expect(h.store.get(id)).toMatchObject({ status: "finished", pendingInput: [] });
    expect(h.turns[0].prompt).toContain('type="subsession-redelivery"');
  });

  it("resumes a task that asked the owner during a first turn a crash cut short", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.store.transition(t.id, "start");
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
    h.notes.set("dm:owner", ['<tomo-event type="subsession-report" name="s1#1" ts="x">R</tomo-event>']);
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
    seed(h0, "active", (s, i) => s.update(i, (r) => { appendInput(r, "m"); }));
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

describe("SubsessionService: append-only inputs and one recovery phase", () => {
  /** What recovery decides, without timestamps. */
  function snapshot(store: SubsessionStore) {
    return store.list().map((t) => ({
      id: t.id, status: t.status, waitingOn: t.waitingOn, resumeNeeded: t.resumeNeeded,
      interruptStreak: t.interruptStreak, seenThrough: t.seenThrough, heldThrough: t.heldThrough,
      pendingInput: t.pendingInput, events: t.transitions.map((x) => x.event),
    }));
  }

  /** s1 active with an input, s2 waiting(owner) after task_ask in a turn cut short, s3 waiting(owner) paused with its input held. */
  function seedThree(h: Harness): void {
    for (let i = 0; i < 3; i++) {
      const t = h.store.create({ parentKey: "dm:owner", title: `t${i}`, brief: "b" });
      h.store.transition(t.id, "start");
      h.store.update(t.id, (r) => { r.startDelivered = true; appendInput(r, `input of ${t.id}`); });
      h.registry.add(t.sessionKey);
      h.sdk.add(t.sessionKey);
    }
    h.store.transition("s2", "ask");
    h.store.transition("s3", "stuck", { patch: (r) => { r.heldThrough = 1; } });
  }

  it("starts a task that was queued at startup exactly once, as a fresh start", async () => {
    const h0 = harness();
    h0.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    h.service.start();
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].prompt).toContain('type="subsession-start"');
    expect(h.turns[0].prompt).not.toContain('type="subsession-resume"');
    expect(h.store.get("s1")!.transitions.map((x) => x.event)).toEqual(["spawn", "start", "finish"]);
  });

  it("wakes a task whose check-back is missing only after recovery, and never mistakes it for a cut-short turn", async () => {
    const h0 = harness();
    const a = h0.store.create({ parentKey: "dm:owner", title: "active", brief: "b" });
    h0.store.transition(a.id, "start");
    h0.store.update(a.id, (r) => { r.startDelivered = true; });
    const w = h0.store.create({ parentKey: "dm:owner", title: "waits", brief: "b" });
    h0.store.transition(w.id, "start");
    h0.store.update(w.id, (r) => { r.startDelivered = true; });
    h0.store.transition(w.id, "wait_external"); // its cron job is gone
    const h = harness({ maxRunning: 1 }, () => new Promise(() => {}));
    for (const k of [a.sessionKey, w.sessionKey]) { h.registry.add(k); h.sdk.add(k); }
    h.service.start();
    await flush();
    // The resumed task first (it was cut short), the woken one queued behind it.
    expect(h.turns.map((x) => x.key)).toEqual([a.sessionKey]);
    expect(h.store.get(a.id)!.transitions.map((x) => x.event)).toEqual(["spawn", "start", "restart", "start"]);
    expect(h.store.get(w.id)).toMatchObject({ status: "queued", resumeNeeded: false });
    expect(h.store.get(w.id)!.transitions.map((x) => x.event)).toEqual(["spawn", "start", "wait_external", "cron_wake"]);
  });

  it("recovers the same way after two crashes in the middle of recovery as after one clean pass", async () => {
    const seeded = harness();
    seedThree(seeded);
    const seedFile = readFileSync(path, "utf8");

    const fresh = (): Harness => {
      const h = harness({ maxRunning: 0 }); // no slot: no turn runs
      for (const k of ["task:s1", "task:s2", "task:s3"]) { h.registry.add(k); h.sdk.add(k); }
      return h;
    };
    // Reference: one clean recovery.
    const ref = fresh();
    ref.service.start();
    const expected = snapshot(ref.store);
    expect(expected.map((t) => [t.status, t.interruptStreak, t.seenThrough])).toEqual([
      ["queued", 1, 1], ["queued", 1, 1], ["waiting", 0, 0],
    ]);

    // Two starts in a row that each die right after their first recovery write.
    writeFileSync(path, seedFile);
    for (let run = 0; run < 2; run++) {
      const h = fresh();
      const real = h.store.transition.bind(h.store);
      h.store.transition = ((...args: Parameters<typeof real>) => {
        real(...args);
        throw new Error("crash");
      }) as typeof real;
      h.service.start();
      expect(h.service.available()).toBe(false); // half a recovery is never scheduled on
    }
    const after = fresh();
    after.service.start();
    expect(snapshot(after.store)).toEqual(expected);
    // And once more: recovery is idempotent.
    const again = fresh();
    again.service.start();
    expect(snapshot(again.store)).toEqual(expected);
  });

  it("keeps a completed turn's inputs when its result cannot be written, and says they may have been seen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let failNext = false;
      let n = 0;
      const h = harness({}, working((turn, hh) => {
        n += 1;
        if (n === 1) failNext = true;
        else hh.service.finish(turn.key, "ok");
      }));
      const realUpdate = h.store.update.bind(h.store);
      h.store.update = ((...args: Parameters<typeof realUpdate>) => {
        if (failNext) { failNext = false; throw new Error("disk full"); }
        return realUpdate(...args);
      }) as typeof realUpdate;
      h.service.start();
      const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
      h.service.relay(t.id, "the owner's ask");
      h.service.schedule();
      await flush();
      expect(h.turns).toHaveLength(1);
      expect(h.store.get(t.id)?.pendingInput.map((i) => i.text)).toEqual([expect.stringContaining("the owner's ask")]);
      vi.advanceTimersByTime(SETTLE_RETRY_MS);
      await flush();
      expect(h.turns).toHaveLength(2);
      expect(h.turns[1].prompt).toContain('type="subsession-redelivery"');
      expect(h.turns[1].prompt).toContain("the owner's ask");
      expect(h.store.get(t.id)).toMatchObject({ status: "finished", pendingInput: [] });
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes only the inputs a turn carried, not ones that arrived during it", async () => {
    let n = 0;
    const h = harness({}, working((turn, hh) => {
      n += 1;
      if (n === 1) hh.service.relay("s1", "second");
      else hh.service.finish(turn.key, "ok");
    }));
    h.service.start();
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.service.relay(t.id, "first");
    h.service.schedule();
    await flush();
    expect(h.turns[0].prompt).toContain("first");
    expect(h.turns[0].prompt).not.toContain("second");
    expect(h.turns[1].prompt).toContain("second");
    expect(h.turns[1].prompt).not.toContain("first");
    expect(h.store.get(t.id)?.pendingInput).toEqual([]);
  });

  it("keeps a stopped task's inputs for the owner, and recovery does not wake it", async () => {
    const h = harness({}, () => ({ ok: false, stopped: true }));
    h.service.start();
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.service.relay(t.id, "kept");
    h.service.schedule();
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner", heldThrough: 1, seenThrough: 1 });
    const h2 = harness();
    h2.service.start();
    await flush();
    expect(h2.turns).toHaveLength(0);
    expect(h2.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner", pendingInput: [{ seq: 1 }] });
  });

  // -------------------------------------------------------------------------
  // Round 5: the invariants, each driven from its real entry point
  // -------------------------------------------------------------------------

  function seed(h: Harness, state: "active" | "finished", patch?: (s: SubsessionStore, id: string) => void): string {
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.store.transition(t.id, "start");
    h.store.update(t.id, (r) => { r.startDelivered = true; });
    // A completed turn: its conversation is linked in the registry.
    h.sdk.add(t.sessionKey);
    if (state === "finished") h.store.transition(t.id, "finish", { patch: (r) => { r.report = "R"; } });
    patch?.(h.store, t.id);
    return t.id;
  }

  it("admits nothing before recovery and runs no turn before start(), so recovery never touches a live task", async () => {
    const h0 = harness();
    seed(h0, "active"); // s1: its turn was cut short by the restart
    const w = h0.store.create({ parentKey: "dm:owner", title: "w", brief: "b" }); // s2: waits for the owner
    h0.store.transition(w.id, "start");
    h0.store.update(w.id, (r) => { r.startDelivered = true; });
    h0.store.transition(w.id, "stuck", { patch: (r) => { r.heldThrough = 0; } });
    const h = harness({ maxRunning: 3 }, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    for (const k of ["task:s1", "task:s2"]) { h.registry.add(k); h.sdk.add(k); }
    // Channels not up yet, recovery not run: every entry point refuses.
    expect(h.service.available()).toBe(false);
    expect(h.service.relay("s2", "too early").ok).toBe(false);
    expect(h.service.spawn("dm:owner", { title: "x", brief: "y" }).ok).toBe(false);
    expect(h.service.onCronFire("task:s2", "check")).toBe(false);
    expect(h.store.get("s2")?.pendingInput).toEqual([]);
    h.service.recoverAtStartup();
    expect(h.store.get("s1")).toMatchObject({ status: "queued", resumeNeeded: true });
    // Channels ingest from here: input is taken, nothing runs until start().
    expect(h.service.relay("s2", "while starting").ok).toBe(true);
    expect(h.service.spawn("dm:owner", { title: "x", brief: "y" }).ok).toBe(true);
    await flush();
    expect(h.turns).toHaveLength(0);
    expect(h.store.get("s2")).toMatchObject({ status: "active", resumeNeeded: false });
    // Recovery is done with: calling it again does not mistake s2 for a turn cut short.
    h.service.recoverAtStartup();
    expect(h.store.get("s2")).toMatchObject({ status: "active", resumeNeeded: false, interruptStreak: 0 });
    h.service.start();
    await flush();
    expect(new Set(h.turns.map((t) => t.key))).toEqual(new Set(["task:s1", "task:s2", "task:s3"]));
    const s2 = h.turns.find((t) => t.key === "task:s2")!.prompt;
    expect(s2).toContain("while starting");
    expect(s2).not.toContain('type="subsession-resume"');
    expect(h.turns.find((t) => t.key === "task:s1")!.prompt).toContain('type="subsession-resume"');
  });

  it("holds recovery's notices and report wakes until start()", () => {
    const h0 = harness();
    seed(h0, "finished"); // its report was never delivered
    const h = harness();
    h.registry.add("task:s1"); h.sdk.add("task:s1");
    h.service.recoverAtStartup();
    expect(h.notes.get("dm:owner")?.some((n) => n.includes('type="subsession-report"'))).toBe(true);
    expect(h.wakes).toEqual([]);
    h.service.start();
    expect(h.wakes).toEqual(["dm:owner"]);
  });

  it("does no destructive cleanup of a task restored from a backup, on this start or the next", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const h0 = harness();
    const id = seed(h0, "finished", (s, i) => s.update(i, (r) => { r.reportDelivered = true; r.endedAt = Date.now() - FINISHED_KEEP_MS - DAY; }));
    copyFileSync(path, `${path}.bak`); // the backup says finished 8 days ago
    writeFileSync(path, "{broken");    // the lost primary had reopened it
    const startAgain = (): Harness => {
      const h = harness();
      h.registry.add("task:s1"); h.sdk.add("task:s1");
      h.cron.set("task:s1", 1);
      h.service.start();
      return h;
    };
    const h1 = startAgain();
    expect(h1.store.get(id)).toMatchObject({ status: "finished", restored: true });
    expect(h1.unlinked).toEqual([]);
    expect(h1.cron.get("task:s1")).toBe(1);
    // Its check-back fires: ignored, and the job is not removed either.
    expect(h1.service.onCronFire("task:s1", "check")).toBe(false);
    expect(h1.cron.get("task:s1")).toBe(1);
    // The next start finds nothing unknown in the registry, but the table is
    // not trusted again while a record is still restored.
    const h2 = startAgain();
    expect(h2.store.read().untrusted).toBeDefined();
    expect(h2.store.get(id)).toMatchObject({ status: "finished", restored: true });
    expect(h2.unlinked).toEqual([]);
    expect(h2.cron.get("task:s1")).toBe(1);
  });

  it("still owes a continue turn after that turn's result could not be written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let failNext = false;
      let n = 0;
      const h = harness({}, working((turn, hh) => {
        n += 1;
        if (n === 2) failNext = true;
        if (n === 3) hh.service.finish(turn.key, "ok");
      }));
      const realUpdate = h.store.update.bind(h.store);
      h.store.update = ((...args: Parameters<typeof realUpdate>) => {
        if (failNext) { failNext = false; throw new Error("disk full"); }
        return realUpdate(...args);
      }) as typeof realUpdate;
      h.service.start();
      const t = spawn(h);
      await flush();
      // Turn 2 was a continue with no input, and its result was not written.
      expect(h.turns).toHaveLength(2);
      expect(h.turns[1].prompt).toContain('type="subsession-continue"');
      expect(h.store.get(t.id)?.status).toBe("active");
      vi.advanceTimersByTime(SETTLE_RETRY_MS);
      await flush();
      expect(h.turns).toHaveLength(3);
      expect(h.turns[2].prompt).toContain('type="subsession-continue"');
      expect(h.store.get(t.id)?.status).toBe("finished");
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // Fresh review of round 5
  // -------------------------------------------------------------------------

  it("keeps the input when the send of its answer throws, not only when it fails", async () => {
    let n = 0;
    const h = harness({}, async (turn, hh) => {
      n += 1;
      if (n === 1) { hh.service.noteToolUse(turn.key); hh.store.transition("s1", "stuck"); return { ok: true }; }
      const sent = await hh.service.reply(turn.key, `answer ${n}`);
      if (n === 2) expect(sent.ok).toBe(false);
      if (n >= 3) hh.service.finish(turn.key, "done");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.sendThrows = 1;
    h.service.relay(t.id, "what is the status?");
    await flush();
    expect(h.turns).toHaveLength(3);
    expect(h.turns[2].prompt).toContain("what is the status?");
    expect(h.turns[2].prompt).toContain('name="answer"');
    expect(h.sent.map((m) => m.text).join()).toContain("answer 3");
  });

  it("counts an answer as delivered when the same message is sent again and goes out, and a turn with no input never keeps anything", async () => {
    let n = 0;
    const h = harness({}, async (turn, hh) => {
      n += 1;
      if (n === 1) {
        // No input carried: a failed send here is no lost answer.
        hh.sendFails = 1;
        await hh.service.reply(turn.key, "progress");
        hh.service.noteToolUse(turn.key);
        hh.store.transition("s1", "stuck");
        return { ok: true };
      }
      hh.sendFails = 1;
      await hh.service.reply(turn.key, "status: halfway");
      await hh.service.reply(turn.key, "status: halfway");
      hh.service.finish(turn.key, "done");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", failStreak: 0 });
    h.service.relay(t.id, "status?");
    await flush();
    expect(h.turns).toHaveLength(2);
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", pendingInput: [] });
  });

  it("keeps the input when a send failed and a later send of OTHER words went out: that one answered something else", async () => {
    let n = 0;
    const h = harness({}, async (turn, hh) => {
      n += 1;
      if (n === 1) { hh.service.noteToolUse(turn.key); hh.store.transition("s1", "stuck"); return { ok: true }; }
      if (n === 2) {
        hh.sendFails = 1;
        expect((await hh.service.reply(turn.key, "the answer to your question")).ok).toBe(false);
        expect((await hh.service.reply(turn.key, "unrelated: tests are running")).ok).toBe(true);
        hh.service.noteToolUse(turn.key);
        return { ok: true };
      }
      await hh.service.reply(turn.key, "the answer to your question");
      hh.service.finish(turn.key, "done");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.relay(t.id, "what is the answer?");
    await flush();
    // The turn that lost its answer kept the input; the next one got it
    // again, shown the message that never went out.
    expect(h.turns).toHaveLength(3);
    expect(h.turns[2].prompt).toContain("what is the answer?");
    expect(h.turns[2].prompt).toContain('name="answer"');
    expect(h.turns[2].prompt).toContain("the answer to your question");
    expect(h.turns[2].prompt).not.toContain("unrelated: tests are running");
    // Quoted without the harness prefix, so a copy of it is not sent with two.
    expect(h.turns[2].prompt).not.toContain("[s1 · Fix the bug] the answer");
    expect(h.sent.map((m) => m.text).filter((x) => x.includes("the answer to your question"))).toHaveLength(1);
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", pendingInput: [] });
  });

  it("holds a finished task's failing answer only through what that turn carried: input that arrived during it gets a turn", async () => {
    const h = harness();
    seed(h, "finished", (s, i) => s.update(i, (r) => { r.reportDelivered = true; }));
    let n = 0;
    h.onTurn = (turn, hh) => {
      n += 1;
      if (n === 2) hh.service.relay("s1", "newer question");
      if (n <= 2) return { ok: false };
      void hh.service.reply(turn.key, "both answered");
      return { ok: true };
    };
    h.service.start();
    h.service.relay("s1", "first question");
    await flush();
    expect(h.turns).toHaveLength(3);
    expect(h.turns[2].prompt).toContain("first question");
    expect(h.turns[2].prompt).toContain("newer question");
    expect(h.store.get("s1")).toMatchObject({ status: "finished", heldThrough: 1, pendingInput: [] });
  });

  it("still continues an active task when what follows its turn's result cannot be written", async () => {
    let n = 0;
    const h = harness({}, working((turn, hh) => {
      n += 1;
      if (n === 1) hh.cron.set(turn.key, 1);
      else { hh.cron.delete(turn.key); hh.service.finish(turn.key, "ok"); }
    }));
    const realTransition = h.store.transition.bind(h.store);
    let failWait = true;
    h.store.transition = ((...args: Parameters<typeof realTransition>) => {
      if (args[1] === "wait_external" && failWait) { failWait = false; throw new Error("disk full"); }
      return realTransition(...args);
    }) as typeof realTransition;
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.turns).toHaveLength(2);
    expect(h.turns[1].prompt).toContain('type="subsession-continue"');
    expect(h.store.get(t.id)?.status).toBe("finished");
  });

  it("does not take an unreadable registry for an empty one at start: nothing is failed, unlinked, trusted again, or run without its history", async () => {
    const h0 = harness();
    const id = seed(h0, "active");
    h0.store.markUntrusted("lost");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
      h.sdk.delete("task:s1"); // a fresh process: the unreadable registry's last-good state is empty
      h.registryReadable = false; // and so it answers: no task sessions at all
      h.service.start();
      await flush();
      expect(h.store.get(id)?.status).not.toBe("failed");
      expect(h.unlinked).toEqual([]);
      expect(h.store.read().untrusted).toBeDefined();
      // Not dispatched: a turn now would start a new conversation without its history.
      expect(h.turns).toHaveLength(0);
      expect(h.store.get(id)?.status).toBe("queued");
      expect(h.notices.filter((n) => n.to === "owner" && n.text.includes("on hold"))).toHaveLength(1);
      // An owner start is held the same way.
      expect(h.service.startTask(id, "the owner started it")).toBe(false);
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      expect(h.turns).toHaveLength(0);
      // Readable again, with its conversation: it resumes.
      h.registryReadable = true;
      h.sdk.add("task:s1");
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      expect(h.turns).toHaveLength(1);
      expect(h.turns[0].prompt).toContain('type="subsession-resume"');
      expect(h.store.get(id)?.status).toBe("finished");
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a finished task's turn while the registry is unreadable without spinning, and answers once it can be read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({}, (turn, hh) => { void hh.service.reply(turn.key, "answer"); return { ok: true }; });
      const id = seed(h, "finished", (s, i) => s.update(i, (r) => { r.reportDelivered = true; }));
      h.service.start();
      let asked = 0;
      h.registryReadable = false;
      const readable = (h.service as unknown as { deps: { registryReadable: () => boolean } }).deps;
      const real = readable.registryReadable;
      readable.registryReadable = () => {
        asked += 1;
        if (asked > 50) throw new Error("the driver is spinning on a held turn");
        return real();
      };
      expect(h.service.relay(id, "one more thing").ok).toBe(true);
      await flush();
      expect(asked).toBeLessThan(5);
      expect(h.turns).toHaveLength(0);
      expect(h.service.isHeld(id)).toBe(true);
      expect(h.store.get(id)).toMatchObject({ status: "finished", pendingInput: [{ seq: 1 }] });
      // Still unreadable at the recheck: held again, once.
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      expect(h.turns).toHaveLength(0);
      h.registryReadable = true;
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      expect(h.turns).toHaveLength(1);
      expect(h.store.get(id)).toMatchObject({ status: "finished", pendingInput: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an owner's start the registry held still passes the quota gate once it can be read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({ maxRunning: 0 }, working((turn, hh) => hh.service.finish(turn.key, "ok")));
      const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
      h.service.start();
      h.quota = 95;
      h.registryReadable = false;
      expect(h.service.startTask(t.id, "the owner started it")).toBe(false);
      expect(h.service.isHeld(t.id)).toBe(true);
      h.registryReadable = true;
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      // Not paused at the gate: the owner asked for this start.
      expect(h.turns).toHaveLength(1);
      expect(h.store.get(t.id)?.status).toBe("finished");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an owner's start keeps its gate pass through a /compact that runs first", async () => {
    const h = harness({ maxRunning: 0 }, working((turn, hh) => { if (!turn.bare) hh.service.finish(turn.key, "ok"); }));
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.store.update(t.id, (r) => { r.compactPending = true; });
    h.service.start();
    h.quota = 95;
    expect(h.service.startTask(t.id, "the owner started it")).toBe(true);
    await flush();
    // The compact, then its first real turn: not paused at the gate in between.
    expect(h.turns.some((x) => x.prompt.startsWith("/compact"))).toBe(true);
    expect(h.turns.some((x) => x.prompt.includes("subsession-start"))).toBe(true);
    expect(h.store.get(t.id)?.status).toBe("finished");
  });

  it("makes an owner's start that the registry held past the slot cap once it can be read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({ maxRunning: 0 }, working((turn, hh) => hh.service.finish(turn.key, "ok")));
      const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
      h.service.start();
      h.registryReadable = false;
      expect(h.service.startTask(t.id, "the owner started it")).toBe(false);
      expect(h.service.isHeld(t.id)).toBe(true);
      h.registryReadable = true;
      vi.advanceTimersByTime(REGISTRY_RECHECK_MS);
      await flush();
      expect(h.turns).toHaveLength(1);
      expect(h.store.get(t.id)?.status).toBe("finished");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a task with history whose conversation the readable registry no longer has, rather than start it over", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    const id = seed(h, "finished", (s, i) => s.update(i, (r) => { r.reportDelivered = true; }));
    h.service.start();
    h.sdk.delete("task:s1"); // lost after start (another process cleared it)
    h.service.relay(id, "one more thing");
    await flush();
    expect(h.turns).toHaveLength(0);
    expect(h.store.get(id)?.status).toBe("failed");
    expect(h.notices.some((n) => n.text.includes("could not be found"))).toBe(true);
  });

  it("never archives a finished task that still owes an answer, pending or held, however old", () => {
    const old = Date.now() - FINISHED_KEEP_MS - 24 * 60 * 60 * 1000;
    const h = harness();
    const held = seed(h, "finished", (s, i) => s.update(i, (r) => {
      r.reportDelivered = true;
      r.endedAt = old;
      appendInput(r, "unanswered question");
      r.heldThrough = 1;
    }));
    const pending = seed(h, "finished", (s, i) => s.update(i, (r) => {
      r.reportDelivered = true;
      r.endedAt = old;
      appendInput(r, "still owed");
    }));
    const idle = seed(h, "finished", (s, i) => s.update(i, (r) => { r.reportDelivered = true; r.endedAt = old; }));
    h.service.recoverAtStartup(); // the sweep runs here
    expect(h.store.get(held)).toMatchObject({ status: "finished", pendingInput: [{ seq: 1, text: "unanswered question" }] });
    expect(h.store.get(pending)).toMatchObject({ status: "finished", pendingInput: [{ seq: 1, text: "still owed" }] });
    expect(h.store.get(idle)?.status).toBe("archived");
    expect(h.unlinked).toEqual(["task:s3"]);
  });

  it("makes a start asked for before dispatch opened as soon as start() opens it, past the slot cap", async () => {
    const h = harness({ maxRunning: 0 }, working((turn, hh) => hh.service.finish(turn.key, "ok")));
    const t = h.store.create({ parentKey: "dm:owner", title: "t", brief: "b" });
    h.service.recoverAtStartup();
    expect(h.service.startTask(t.id, "the owner started it")).toBe(true);
    expect(h.store.get(t.id)?.status).toBe("queued");
    await flush();
    expect(h.turns).toHaveLength(0);
    h.service.start();
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.store.get(t.id)?.status).toBe("finished");
  });
});

describe("SubsessionService: no new task id while the registry can't be read", () => {
  it("refuses task_spawn with a lost table and an unreadable registry, and never reuses task:s1 once it can be read", async () => {
    const h = harness();
    // The table and its backup are gone; the registry still links an old task's conversation.
    h.registry.add("task:s1");
    h.sdk.add("task:s1");
    h.registryReadable = false;
    h.service.start();
    await flush();
    const refused = h.service.spawn("dm:owner", { title: "New job", brief: "Do the new thing." });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/registry can't be read/);
    expect(h.store.list()).toHaveLength(0);
    expect(h.store.read().nextId).toBe(1);
    expect(h.turns).toHaveLength(0);

    // Readable again: the new task gets an id past every linked task session.
    h.registryReadable = true;
    const record = spawn(h, "New job");
    expect(record.id).toBe("s2");
    expect(record.sessionKey).toBe("task:s2");
    await flush();
    expect(h.turns.map((t) => t.key)).not.toContain("task:s1");
  });
});

describe("SubsessionService: report notes are matched by report, and an unread one keeps its task", () => {
  it("never archives (or forgets) a finished task while its report note is unread", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "the whole report")));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", reportDelivered: true });
    h.store.update(t.id, (r) => { r.endedAt = Date.now() - FINISHED_KEEP_MS - 24 * 60 * 60 * 1000; });

    // A restart with the note still unread: the task stays finished.
    const h2 = harness();
    h2.notes = h.notes;
    h2.service.recoverAtStartup(); // the sweep runs here
    expect(h2.store.get(t.id)?.status).toBe("finished");
    expect(h2.unlinked).toEqual([]);

    // Read: the next start archives it.
    const h3 = harness();
    h3.service.recoverAtStartup();
    expect(h3.store.get(t.id)?.status).toBe("archived");
  });

  it("delivers a second report while the first one's note is still unread", async () => {
    let n = 0;
    const h = harness({}, working((turn, hh) => {
      n += 1;
      if (n === 2) hh.service.reopen(turn.key);
      hh.service.finish(turn.key, `report ${n}`);
    }));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", reportSeq: 1, reportDelivered: true });
    // Woken again before the owning session read the first report.
    expect(h.service.relay(t.id, "one more thing").ok).toBe(true);
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", report: "report 2", reportSeq: 2, reportDelivered: true });
    const reports = (h.notes.get("dm:owner") ?? []).filter((note) => note.includes('type="subsession-report"'));
    expect(reports).toHaveLength(2);
    expect(reports[0]).toContain('name="s1#1"');
    expect(reports[0]).toContain("report 1");
    expect(reports[1]).toContain('name="s1#2"');
    expect(reports[1]).toContain("report 2");
    expect(h.wakes).toEqual(["dm:owner", "dm:owner"]);
  });
});

describe("SubsessionService: a record from before report seqs", () => {
  it("numbers the next report past an older one that has no seq", async () => {
    const h = harness({}, working((turn, hh) => { hh.service.reopen(turn.key); hh.service.finish(turn.key, "second"); }));
    h.service.start();
    const t = spawn(h);
    h.store.update(t.id, (r) => { r.report = "first"; delete r.reportSeq; });
    h.service.finish(t.sessionKey, "second");
    expect(h.store.get(t.id)?.reportSeq).toBe(2);
  });
});

describe("SubsessionService: the wall-clock cap", () => {
  const HOUR = 3_600_000;
  it("pauses a task for the owner once it has been active on its own past maxActiveHours; the owner's word buys another stretch", async () => {
    let n = 0;
    const h = harness({ maxActiveHours: 24 }, working((turn, hh) => {
      n += 1;
      // Its first turn takes it past the cap.
      if (n === 1) hh.store.update("s1", (r) => { r.activeMs = 25 * HOUR; });
      if (n === 3) hh.service.finish(turn.key, "done");
    }));
    h.service.start();
    const t = spawn(h);
    await flush();
    // The continue after that first turn is not run.
    expect(h.turns).toHaveLength(1);
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner" });
    expect(h.store.get(t.id)?.waitingReason).toContain("maxActiveHours");
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].text).toContain("24 hours");

    // The owner says go on: that turn runs, and so does the continue after it.
    expect(h.service.relay(t.id, "keep going").ok).toBe(true);
    await flush();
    expect(h.turns).toHaveLength(3);
    expect(h.turns[1].prompt).toContain("keep going");
    expect(h.turns[2].prompt).toContain('type="subsession-continue"');
    expect(h.store.get(t.id)?.status).toBe("finished");
    expect(h.notices).toHaveLength(1);
  });

  it("is off at 0", async () => {
    let n = 0;
    const h = harness({ maxActiveHours: 0 }, working((turn, hh) => {
      n += 1;
      if (n === 1) hh.store.update("s1", (r) => { r.activeMs = 1000 * HOUR; });
      if (n === 2) hh.service.finish(turn.key, "done");
    }));
    h.service.start();
    spawn(h);
    await flush();
    expect(h.turns).toHaveLength(2);
    expect(h.store.get("s1")?.status).toBe("finished");
  });
});

describe("SubsessionService: the quota gate", () => {
  it("pauses a task's own turn at 80% of the 5-hour window, and tells the owner once", async () => {
    const h = harness({}, working());
    h.quota = 80;
    h.service.start();
    const t = spawn(h);
    await flush();
    // Not even its first turn runs.
    expect(h.turns).toHaveLength(0);
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner" });
    expect(h.store.get(t.id)?.waitingReason).toContain("80%");
    expect(h.notices.map((x) => x.text)).toEqual([expect.stringContaining("80%")]);
  });

  it("lets the owner's own word through, and runs below the threshold", async () => {
    let n = 0;
    const h = harness({}, working((turn, hh) => { n += 1; if (n === 2) hh.service.finish(turn.key, "done"); }));
    h.quota = 95;
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.turns).toHaveLength(0);
    // The owner's word runs (it carries the start too); the continue after it is held again.
    expect(h.service.relay(t.id, "go anyway").ok).toBe(true);
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].prompt).toContain("go anyway");
    expect(h.turns[0].prompt).toContain('type="subsession-start"');
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner" });
    expect(h.notices).toHaveLength(2);
    // Quota freed: the owner's next word, and the continue after it, run.
    h.quota = 79;
    expect(h.service.relay(t.id, "now go").ok).toBe(true);
    await flush();
    expect(h.turns).toHaveLength(2);
    expect(h.store.get(t.id)?.status).toBe("finished");
  });

  it("a pause that cannot be written runs no turn and does not spin; the retry timer pauses it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({}, working());
      h.quota = 90;
      const real = h.store.transition.bind(h.store);
      let failures = 1;
      vi.spyOn(h.store, "transition").mockImplementation((id, event, opts) => {
        if (event === "stuck" && failures > 0) { failures -= 1; throw new Error("disk full"); }
        return real(id, event, opts);
      });
      h.service.start();
      const t = spawn(h);
      await flush();
      expect(h.turns).toHaveLength(0);
      expect(h.store.get(t.id)?.status).toBe("active");
      vi.advanceTimersByTime(SETTLE_RETRY_MS);
      await flush();
      expect(h.turns).toHaveLength(0);
      expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner" });
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open when the quota samples cannot be read", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "done")));
    h.quota = "throw";
    h.service.start();
    spawn(h);
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.store.get("s1")?.status).toBe("finished");
  });
});

describe("SubsessionService: a later task_finish keeps an unread report", () => {
  it("keeps the first report beside the second while its note is unread; task_status shows both", async () => {
    let n = 0;
    const h = harness({}, working((turn, hh) => {
      n += 1;
      if (n === 2) hh.service.reopen(turn.key);
      hh.service.finish(turn.key, `report ${n}`);
    }));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.service.relay(t.id, "one more thing").ok).toBe(true);
    await flush();
    const record = h.store.get(t.id)!;
    expect(record).toMatchObject({ report: "report 2", reportSeq: 2, earlierReports: [{ seq: 1, text: "report 1" }] });
    const { formatTaskDetail } = await import("../src/mcp/subsession-tools.js");
    const detail = formatTaskDetail(record);
    expect(detail).toContain("Earlier report #1");
    expect(detail).toContain("report 1");
    expect(detail).toContain("Report #2:");
    const notes = (h.notes.get("dm:owner") ?? []).filter((x) => x.includes('name="s1#2"'));
    expect(notes[0]).toContain("#1");

    // Once both are read, a third finish keeps nothing new.
    h.notes.set("dm:owner", []);
    h.service.relay(t.id, "and again");
    h.onTurn = working((turn, hh) => { hh.service.reopen(turn.key); hh.service.finish(turn.key, "report 3"); });
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ report: "report 3", reportSeq: 3 });
    expect(h.store.get(t.id)?.earlierReports).toBeUndefined();
  });

  it("keeps every unread earlier report, however many (no cap drops one)", async () => {
    const h = harness({}, working((turn, hh) => { hh.service.finish(turn.key, "report 1"); }));
    h.service.start();
    const t = spawn(h);
    await flush();
    for (let n = 2; n <= 12; n++) {
      h.onTurn = working((turn, hh) => { hh.service.reopen(turn.key); hh.service.finish(turn.key, `report ${n}`); });
      expect(h.service.relay(t.id, `again ${n}`).ok).toBe(true);
      await flush();
    }
    const record = h.store.get(t.id)!;
    expect(record.reportSeq).toBe(12);
    expect(record.earlierReports?.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(record.earlierReports?.[0].text).toBe("report 1");
  });

  it("writes the note of a kept earlier report whose own note was lost, before the later report's", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "report 1")));
    h.noteWriteFails = 100; // report 1's note never reaches disk
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", reportDelivered: false });
    // Woken and reopened; Tomo restarts mid-turn, and the memory-only note dies with it.
    h.onTurn = (turn, hh) => { hh.service.reopen(turn.key); return new Promise(() => {}); };
    expect(h.service.relay(t.id, "one more thing").ok).toBe(true);
    await flush();
    expect(h.store.get(t.id)?.status).toBe("active");
    h.service.stop();

    const h2 = harness({}, working((turn, hh) => hh.service.finish(turn.key, "report 2")));
    h2.sdk.add(t.sessionKey);
    h2.service.recoverAtStartup();
    h2.service.start();
    await flush();
    expect(h2.store.get(t.id)).toMatchObject({ status: "finished", reportSeq: 2, reportDelivered: true, earlierReports: [{ seq: 1, text: "report 1", noted: true }] });
    const notes = (h2.notes.get("dm:owner") ?? []).filter((n) => n.includes('type="subsession-report"'));
    expect(notes.find((n) => n.includes('name="s1#1"'))).toContain("report 1");
    expect(notes.find((n) => n.includes('name="s1#2"'))).toContain("report 2");
  });

  it("never archives a task holding an earlier report whose note was never written", async () => {
    const h = harness({}, working((turn, hh) => hh.service.finish(turn.key, "report 2")));
    h.service.start();
    const t = spawn(h);
    await flush();
    h.store.update(t.id, (r) => { r.earlierReports = [{ seq: 1, text: "report 1" }]; r.endedAt = Date.now() - FINISHED_KEEP_MS - 60_000; });
    const h2 = harness(); // every note read
    h2.service.recoverAtStartup();
    expect(h2.store.get(t.id)?.status).toBe("finished");
  });

  it("keeps a finished task while an earlier kept report is unread", async () => {
    let n = 0;
    const h = harness({}, working((turn, hh) => {
      n += 1;
      if (n === 2) hh.service.reopen(turn.key);
      hh.service.finish(turn.key, `report ${n}`);
    }));
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.relay(t.id, "one more thing");
    await flush();
    // The second report's note was read, the first's was not.
    h.notes.set("dm:owner", (h.notes.get("dm:owner") ?? []).filter((x) => !x.includes('name="s1#2"')));
    h.store.update(t.id, (r) => { r.endedAt = Date.now() - FINISHED_KEEP_MS - 60_000; });
    const h2 = harness();
    h2.notes = h.notes;
    h2.service.recoverAtStartup();
    expect(h2.store.get(t.id)?.status).toBe("finished");
  });
});

describe("SubsessionService: task_finish never leaves input unread", () => {
  it("refuses while input arrived during the turn; the task stays active and gets it next turn", async () => {
    const results: unknown[] = [];
    const h = harness({}, working((turn, hh) => {
      if (hh.turns.length === 1) hh.service.relay("s1", "also do the docs");
      results.push(hh.service.finish(turn.key, `report ${hh.turns.length}`));
    }));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(results[0]).toMatchObject({ ok: false, unread: 1 });
    // The refused turn's report never went out; the relay was its next turn.
    expect(h.turns).toHaveLength(2);
    expect(h.turns[1].prompt).toContain("also do the docs");
    expect(results[1]).toMatchObject({ ok: true });
    const done = h.store.get(t.id)!;
    expect(done).toMatchObject({ status: "finished", report: "report 2", reportSeq: 1, pendingInput: [] });
    expect(done.transitions.filter((x) => x.event === "finish")).toHaveLength(1);
  });

  it("the input the turn carries does not block it, nor does a finish outside a turn", async () => {
    const h = harness({}, working((turn, hh) => {
      if (turn.prompt.includes("finish up")) hh.service.finish(turn.key, "ok");
      else hh.cron.set(turn.key, 1);
    }));
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.relay(t.id, "finish up");
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", pendingInput: [] });
    expect(h.turns).toHaveLength(2);
    // No turn in flight (no task calls a tool there): nothing to refuse for.
    const h2 = harness({}, () => new Promise(() => {}));
    h2.service.recoverAtStartup();
    const t2 = spawn(h2);
    h2.store.transition(t2.id, "start");
    h2.store.update(t2.id, (r) => { appendInput(r, "x"); });
    expect(h2.service.finish(t2.sessionKey, "ok").ok).toBe(true);
  });

  it("retrying in the same turn stays refused; after MAX_FINISH_REFUSALS turns with unread input not going down it finishes and quotes it", async () => {
    const results: Array<{ ok: boolean; unread?: number }> = [];
    let n = 0;
    const h = harness({}, working((turn, hh) => {
      n += 1;
      if (n > 4) return;
      // More keeps arriving every turn, as fast as it is read.
      hh.service.relay("s1", `relay ${n}`);
      for (let i = 0; i < 3; i++) results.push(hh.service.finish(turn.key, `report ${n}`) as { ok: boolean; unread?: number });
    }));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(MAX_FINISH_REFUSALS).toBe(3);
    // Three turns refused (every retry in them too), the fourth goes through.
    expect(results.slice(0, 9).every((r) => !r.ok && r.unread === 1)).toBe(true);
    expect(results[9]).toMatchObject({ ok: true });
    const rec = h.store.get(t.id)!;
    expect(rec.report).toMatch(/^report 4\n\n\[Tomo: this task finished with 1 input it never read[^]*1\. relay 4/);
    // Not dropped: a finished task still answers it (the turn after the finish).
    expect(h.turns[4].prompt).toContain("relay 4");
    expect(rec.status).toBe("finished");
  });

  it("refused turns count only in a row: a turn without a refusal starts the streak over", async () => {
    const results: Array<{ ok: boolean }> = [];
    // Turns 1-3 refused, turn 4 handles its input without finishing, then
    // turns 5-7 are refused again: only the eighth may be forced through.
    const h = harness({}, working((turn, hh) => {
      const k = hh.turns.length;
      if (k === 4) return;
      if (k <= 8) hh.service.relay("s1", `r${k}`);
      results.push(hh.service.finish(turn.key, "done") as { ok: boolean });
    }));
    h.service.start();
    spawn(h);
    await flush();
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false, false, false, true]);
  });

  it("a refused turn with less unread than the last does not count, and alternating cannot refuse forever", async () => {
    const results: Array<{ ok: boolean }> = [];
    // Unread per turn: 2, 1, 2, 1, 2 — counted 1, (not), 2, (not), 3; then forced.
    const arrivals = [2, 1, 2, 1, 2, 1, 0];
    const h = harness({}, working((turn, hh) => {
      const k = hh.turns.length - 1;
      for (let i = 0; i < arrivals[k]; i++) hh.service.relay("s1", `r${k}.${i}`);
      results.push(hh.service.finish(turn.key, "done") as { ok: boolean });
    }));
    h.service.start();
    spawn(h);
    await flush();
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false, false, true]);
  });

  it("a retry in the same turn that sees more unread does not reset the streak next turn", async () => {
    const results: Array<{ ok: boolean }> = [];
    // Each turn: refused with 1 unread, one more lands, retried (2 unread).
    const h = harness({}, working((turn, hh) => {
      const k = hh.turns.length;
      if (k > 4) return;
      hh.service.relay("s1", `a${k}`);
      results.push(hh.service.finish(turn.key, "done") as { ok: boolean });
      if (k === 4) return;
      hh.service.relay("s1", `b${k}`);
      results.push(hh.service.finish(turn.key, "done") as { ok: boolean });
    }));
    h.service.start();
    spawn(h);
    await flush();
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false, false, false, true]);
  });

  it("once three refused turns in a row are done, the next finish goes through even if less is unread", async () => {
    const results: Array<{ ok: boolean }> = [];
    const arrivals = [2, 2, 2, 1, 0];
    const h = harness({}, working((turn, hh) => {
      const k = hh.turns.length - 1;
      for (let i = 0; i < (arrivals[k] ?? 0); i++) hh.service.relay("s1", `r${k}.${i}`);
      results.push(hh.service.finish(turn.key, "done") as { ok: boolean });
    }));
    h.service.start();
    spawn(h);
    await flush();
    expect(results.slice(0, 4).map((r) => r.ok)).toEqual([false, false, false, true]);
  });
});

describe("SubsessionService: a failed task hands back what it never answered", () => {
  it("quotes the owner's unanswered messages in the failure notice", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    await flush();
    // Waiting for the owner now (no progress).
    expect(h.store.get(t.id)?.status).toBe("waiting");
    // The owner answers; before its turn runs, the conversation is gone.
    h.onTurn = () => new Promise(() => {});
    h.sdk.delete(t.sessionKey);
    h.notices.length = 0;
    expect(h.service.relay(t.id, "use the staging database, not prod").ok).toBe(true);
    await flush();
    expect(h.store.get(t.id)?.status).toBe("failed");
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].text).toContain("use the staging database, not prod");
    // The owning session's note says the same.
    expect((h.notes.get("dm:owner") ?? []).at(-1)).toContain("use the staging database, not prod");
    expect(h.store.get(t.id)?.handedBack).toBe(true);
  });

  it("hands every unanswered message back in full, in a pinned note; the record is forgotten only once that note is written", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)?.status).toBe("waiting");
    h.onTurn = () => new Promise(() => {});
    // Six long messages: the notice shows a few excerpts, the note has them all.
    const long = (n: number) => `message ${n}: ${"x".repeat(500)} END-${n}`;
    h.store.update(t.id, (r) => { for (let n = 1; n <= 5; n++) appendInput(r, `<relay>${long(n)}</relay>`, { from: "owner", words: long(n) }); });
    h.sdk.delete(t.sessionKey);
    h.noteWriteFails = 2; // the activity note and the handback note both fail to write
    expect(h.service.relay(t.id, long(6)).ok).toBe(true);
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "failed" });
    expect(h.store.get(t.id)?.handedBack).toBeUndefined();
    // 30 days on, the sweep tries the handback again before it forgets.
    h.store.update(t.id, (r) => { r.endedAt = Date.now() - ENDED_KEEP_MS - 60_000; });
    const h2 = harness();
    h2.notes = h.notes;
    h2.noteWriteFails = 1;
    h2.service.recoverAtStartup();
    expect(h2.store.get(t.id)?.status).toBe("failed"); // kept: the handback could not be written
    const h3 = harness();
    h3.service.recoverAtStartup();
    expect(h3.store.get(t.id)).toBeUndefined();
    const handback = (h3.notes.get("dm:owner") ?? []).find((n) => n.includes('type="subsession-handback"'))!;
    for (let n = 1; n <= 6; n++) expect(handback).toContain(`END-${n}`);
  });

  it("says nothing extra when nothing of the owner's is pending", async () => {
    // It schedules a check-back and waits on it.
    const h = harness({}, working((turn, hh) => { hh.cron.set(turn.key, 1); }));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "external" });
    h.sdk.delete(t.sessionKey);
    h.notices.length = 0;
    // The check-back (not the owner's) wakes it into the missing conversation.
    h.service.onCronFire(t.sessionKey, "check CI");
    await flush();
    expect(h.store.get(t.id)?.status).toBe("failed");
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].text).not.toContain("check CI");
  });
});

describe("progress, plan and updates", () => {
  /** Started, with a first turn that never ends: the record only moves when the test says. */
  const idle = () => { const h = harness({}, () => new Promise(() => {})); h.service.start(); return h; };

  it("files a done step once, even when the whole done list is sent again, and never shows it ahead too", () => {
    const h = idle();
    const t = spawn(h);
    h.service.setPlan(t.sessionKey, [{ step: "A", status: "in_progress" }, { step: "B" }, { step: "C" }]);
    h.service.setPlan(t.sessionKey, [{ step: "B", status: "in_progress" }, { step: "C" }], [{ step: "A", result: "ok" }]);
    h.service.setPlan(t.sessionKey, [{ step: "C", status: "in_progress" }], [{ step: "A", result: "ok" }, { step: "B" }]);
    // Sent as done while still listed ahead: it is done.
    h.service.setPlan(t.sessionKey, [{ step: "C", status: "in_progress" }], [{ step: "A" }, { step: "B" }, { step: "C" }]);
    const r = h.store.get(t.id)!;
    expect(r.doneSteps?.map((d) => d.text)).toEqual(["A", "B", "C"]);
    expect(r.plan).toBeUndefined();
    expect(r.updates).toBeUndefined();
    // Sent again with another result: that result replaces the one it had.
    h.service.setPlan(t.sessionKey, [], [{ step: "A", result: "better" }]);
    expect(h.store.get(t.id)?.doneSteps?.map((d) => [d.text, d.result])).toEqual([["A", "better"], ["B", undefined], ["C", undefined]]);
  });

  it("files a step done again when it was added back to the plan and finished again", () => {
    const h = idle();
    const t = spawn(h);
    h.service.setPlan(t.sessionKey, [{ step: "Wait for CI", status: "in_progress" }]);
    h.service.setPlan(t.sessionKey, [], [{ step: "Wait for CI" }]);
    h.service.setPlan(t.sessionKey, [{ step: "Wait for CI", status: "in_progress" }]);
    h.service.setPlan(t.sessionKey, [], [{ step: "Wait for CI" }]);
    expect(h.store.get(t.id)?.doneSteps?.map((d) => d.text)).toEqual(["Wait for CI", "Wait for CI"]);
  });

  it("a refused or unchanged plan writes nothing to the table", () => {
    let writes = 0;
    const h = idle();
    const t = spawn(h);
    h.service.setPlan(t.sessionKey, [{ step: "A", status: "in_progress" }, { step: "B" }]);
    const store = new SubsessionStore(path, { onChange: () => { writes += 1; } });
    const before = readFileSync(path, "utf8");
    store.update(t.id, () => {});
    store.update(t.id, (r) => { r.plan = [{ text: "A", status: "in_progress" }, { text: "B", status: "pending" }]; });
    expect(writes).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(h.service.setPlan(t.sessionKey, [{ step: "C" }])).toEqual({ ok: false, error: "reason_required" });
    expect(h.service.setPlan(t.sessionKey, [{ step: "A", status: "in_progress" }, { step: "B" }]).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
    store.update(t.id, (r) => { r.plan = [{ text: "A", status: "in_progress" }]; });
    expect(writes).toBe(1);
  });

  it("refuses two steps that read the same, so a done step is never ambiguous", () => {
    const h = idle();
    const t = spawn(h);
    const before = readFileSync(path, "utf8");
    // Alike once trimmed and cut to one line, too.
    for (const steps of [[{ step: "run tests" }, { step: "build" }, { step: "run tests" }], [{ step: "run tests" }, { step: " run tests\nnow" }]]) {
      expect(h.service.setPlan(t.sessionKey, steps)).toEqual({ ok: false, error: "duplicate_step" });
    }
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(h.store.get(t.id)!.plan).toBeUndefined();
    // Steps that differ only past the length a step is cut at are alike too.
    expect(h.service.setPlan(t.sessionKey, [{ step: `${"x".repeat(PLAN_STEP_MAX)}1` }, { step: `${"x".repeat(PLAN_STEP_MAX)}2` }])).toEqual({ ok: false, error: "duplicate_step" });
    // Its own words for the second: saved, and finishing the first leaves the second.
    h.service.setPlan(t.sessionKey, [{ step: "run tests", status: "in_progress" }, { step: "build" }, { step: "run tests again" }]);
    const call = () => h.service.setPlan(t.sessionKey, [{ step: "build", status: "in_progress" }, { step: "run tests again" }], [{ step: "run tests" }]);
    expect(call().ok).toBe(true);
    // The same call again (a retry) changes nothing: the other step stays, nothing is filed twice.
    expect(call().ok).toBe(true);
    expect(h.store.get(t.id)!.plan?.map((s) => s.text)).toEqual(["build", "run tests again"]);
    expect(h.store.get(t.id)!.doneSteps?.map((d) => d.text)).toEqual(["run tests"]);
    // The same step twice in one done list is filed once.
    expect(h.service.setPlan(t.sessionKey, [{ step: "run tests again" }], [{ step: "build" }, { step: "build" }]).ok).toBe(true);
    expect(h.store.get(t.id)!.doneSteps?.map((d) => d.text)).toEqual(["run tests", "build"]);
  });

  it("reads a stored plan with two steps alike as one", () => {
    const h = idle();
    const t = spawn(h);
    const table = JSON.parse(readFileSync(path, "utf8"));
    table.tasks[0].plan = [{ text: "a", status: "in_progress" }, { text: "b" }, { text: "a" }];
    writeFileSync(path, JSON.stringify(table));
    expect(new SubsessionStore(path).get(t.id)!.plan).toEqual([{ text: "a", status: "in_progress" }, { text: "b", status: "pending" }]);
    // The step in progress is kept in progress, whichever copy held it.
    table.tasks[0].plan = [{ text: "a" }, { text: "b" }, { text: "a", status: "in_progress" }];
    writeFileSync(path, JSON.stringify(table));
    expect(new SubsessionStore(path).get(t.id)!.plan).toEqual([{ text: "a", status: "in_progress" }, { text: "b", status: "pending" }]);
  });

  it("a refused plan files none of its done steps either", () => {
    const h = idle();
    const t = spawn(h);
    h.service.setPlan(t.sessionKey, [{ step: "A", status: "in_progress" }, { step: "B" }]);
    expect(h.service.setPlan(t.sessionKey, [{ step: "C" }], [{ step: "A" }])).toEqual({ ok: false, error: "reason_required" });
    expect(h.store.get(t.id)?.doneSteps).toBeUndefined();
    expect(h.store.get(t.id)?.plan?.map((s) => s.text)).toEqual(["A", "B"]);
  });

  it("keeps each decision or change with its time, a repeat once, blanks never, newest UPDATES_KEEP", () => {
    const h = idle();
    const t = spawn(h);
    h.service.postUpdate(t.sessionKey, "Went with approach B");
    h.service.postUpdate(t.sessionKey, "Went with approach B");
    h.service.postUpdate(t.sessionKey, "  ");
    h.service.postUpdate(t.sessionKey, "Blocked on CI\ndetails");
    expect(h.store.get(t.id)!.updates?.map((u) => u.text)).toEqual(["Went with approach B", "Blocked on CI"]);
    expect(h.store.get(t.id)!.updates?.every((u) => typeof u.at === "number")).toBe(true);
    for (let i = 0; i < UPDATES_KEEP + 5; i++) h.service.postUpdate(t.sessionKey, `u${i}`);
    const updates = h.store.get(t.id)!.updates!;
    expect(updates).toHaveLength(UPDATES_KEEP);
    expect(updates.at(-1)?.text).toBe(`u${UPDATES_KEEP + 4}`);
  });

  it("bounds a plan, keeps done steps with their results, and files a step reported done twice in a row once", () => {
    const h = idle();
    const t = spawn(h);
    const many = Array.from({ length: PLAN_MAX_STEPS + 3 }, (_, i) => ({ step: `s${i} ${"x".repeat(PLAN_STEP_MAX)}` }));
    h.service.setPlan(t.sessionKey, many);
    const plan = h.store.get(t.id)!.plan!;
    expect(plan).toHaveLength(PLAN_MAX_STEPS);
    expect(Array.from(plan[0].text)).toHaveLength(PLAN_STEP_MAX);
    expect(h.service.setPlan(t.sessionKey, [], [{ step: "a", result: "ok" }], "replanned").ok).toBe(true);
    h.service.setPlan(t.sessionKey, [], [{ step: "a", result: "ok" }]);
    expect(h.store.get(t.id)!.doneSteps).toEqual([{ at: expect.any(Number), text: "a", result: "ok" }]);
    expect(h.store.get(t.id)!.plan).toBeUndefined();
    for (let i = 0; i < DONE_STEPS_KEEP + 2; i++) h.service.setPlan(t.sessionKey, [], [{ step: `d${i}` }]);
    expect(h.store.get(t.id)!.doneSteps).toHaveLength(DONE_STEPS_KEEP);
  });

  it("asks for a reason to drop, reword or reorder a step still ahead, and files it as an update", () => {
    const h = idle();
    const t = spawn(h);
    expect(h.service.setPlan(t.sessionKey, [{ step: "A", status: "in_progress" }, { step: "B" }, { step: "C" }]).ok).toBe(true);
    // Free: a status move, a step done, steps added at the end.
    expect(h.service.setPlan(t.sessionKey, [{ step: "B", status: "in_progress" }, { step: "C" }, { step: "D" }], [{ step: "A" }]).ok).toBe(true);
    // Dropping C, rewording C, reordering: refused without a reason, nothing written.
    for (const steps of [[{ step: "B" }, { step: "D" }], [{ step: "B" }, { step: "C, faster" }, { step: "D" }], [{ step: "C" }, { step: "B" }, { step: "D" }]]) {
      expect(h.service.setPlan(t.sessionKey, steps)).toEqual({ ok: false, error: "reason_required" });
    }
    // Inserting before a kept step is a reorder too; done in the same call never needs one.
    expect(h.service.setPlan(t.sessionKey, [{ step: "X" }, { step: "B" }, { step: "C" }, { step: "D" }]).ok).toBe(false);
    expect(h.store.get(t.id)!.plan?.map((s) => s.text)).toEqual(["B", "C", "D"]);
    expect(h.store.get(t.id)!.updates).toBeUndefined();
    expect(h.service.setPlan(t.sessionKey, [{ step: "D", status: "in_progress" }], [{ step: "B" }], "C turned out to be unnecessary").ok).toBe(true);
    expect(h.store.get(t.id)!.updates).toEqual([{ at: expect.any(Number), kind: "plan", text: "C turned out to be unnecessary" }]);
    // A reason with no change to the plan files nothing.
    h.service.setPlan(t.sessionKey, [{ step: "D", status: "in_progress" }], [], "again");
    expect(h.store.get(t.id)!.updates).toHaveLength(1);
    // Clearing the plan at the end, with every step done, needs none.
    expect(h.service.setPlan(t.sessionKey, [], [{ step: "D" }]).ok).toBe(true);
  });

  it("a changed plan or an update counts as progress; the same plan again does not on its own", async () => {
    let n = 0;
    const h = harness({}, (turn, hh) => {
      n += 1;
      if (n % 2) hh.service.setPlan(turn.key, [{ step: `step ${n}`, status: "in_progress" }], n > 1 ? [{ step: `step ${n - 2}` }] : []);
      else hh.service.postUpdate(turn.key, `decided ${n}`);
      if (n === 6) hh.service.finish(turn.key, "done");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)?.status).toBe("finished");
    expect(h.store.get(t.id)?.updates?.map((u) => u.text)).toEqual(["decided 2", "decided 4", "decided 6"]);

    // Called here directly, with no tool call: the first turn set it
    // (progress); the next three changed nothing.
    const same = harness({}, (turn, hh) => { hh.service.setPlan(turn.key, [{ step: "stuck" }]); return { ok: true }; });
    same.service.start();
    const u = spawn(same);
    await flush();
    expect(same.turns).toHaveLength(4);
    expect(same.store.get(u.id)).toMatchObject({ status: "waiting", waitingOn: "owner" });

    // Through the tool, the call itself counts as using a tool, as any tool
    // call does: a task_plan or task_update that changed nothing never trips
    // the pause.
    let calls = 0;
    const other = harness({}, (turn, hh) => {
      calls += 1;
      hh.service.setPlan(turn.key, [{ step: "stuck" }]);
      hh.service.postUpdate(turn.key, "same line");
      hh.service.noteToolUse(turn.key);
      if (calls > 5) hh.service.finish(turn.key, "ok");
      return { ok: true };
    });
    other.service.start();
    const v = spawn(other);
    await flush();
    expect(other.turns.length).toBeGreaterThan(4);
    expect(other.store.get(v.id)?.status).toBe("finished");
  });

  it("loads a record written before plans and updates existed, and drops malformed entries", () => {
    const h = idle();
    const t = spawn(h);
    const table = JSON.parse(readFileSync(path, "utf8"));
    // The old task_progress line: read without it.
    table.tasks[0].progress = "x";
    writeFileSync(path, JSON.stringify(table));
    const old = new SubsessionStore(path).get(t.id)!;
    expect(old).not.toHaveProperty("progress");
    expect(old.plan).toBeUndefined();
    expect(old.doneSteps).toBeUndefined();
    expect(old.updates).toBeUndefined();
    const events = table.tasks[0].transitions.map((x: { event: string }) => x.event);
    table.tasks[0].transitions.push(null, { at: 1e20, from: "queued", to: "active", event: "start" }, { at: 9, to: 3, event: "start" });
    table.tasks[0].updates = [{ at: 1e20, text: "far future" }, { at: -1, text: "before the epoch" }, { at: 0.5, text: "why", kind: "plan" }, { at: 0.7, text: "odd kind", kind: "nope" }, { at: 1, text: "ok" }, { at: "1", text: "bad time" }, { at: 2 }, null, { at: 3, text: "line\nmore" }, { at: 5, text: " " }];
    table.tasks[0].doneSteps = [{ at: Number.MAX_VALUE, text: "huge" }, { at: 4, text: "done", result: 7 }, { at: 6, text: "also", result: "fine" }, "nope"];
    table.tasks[0].plan = [{ text: "a", status: "in_progress" }, { text: "b", status: "weird" }, { text: 3 }, "c"];
    writeFileSync(path, JSON.stringify(table));
    const loaded = new SubsessionStore(path).get(t.id)!;
    expect(loaded.updates).toEqual([{ at: 0.5, text: "why", kind: "plan" }, { at: 0.7, text: "odd kind" }, { at: 1, text: "ok" }, { at: 3, text: "line" }]);
    expect(loaded.doneSteps).toEqual([{ at: 4, text: "done" }, { at: 6, text: "also", result: "fine" }]);
    expect(loaded.plan).toEqual([{ text: "a", status: "in_progress" }, { text: "b", status: "pending" }]);
    expect(loaded.transitions.map((x) => x.event)).toEqual(events);
  });
});
