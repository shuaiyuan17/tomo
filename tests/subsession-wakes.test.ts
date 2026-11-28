import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { MESSAGE_WAKE_RETRY_BASE_MS, MESSAGE_WAKE_RETRY_CAP_MS, SubsessionWakes } from "../src/agent/subsessions/wakes.js";
import type { SubsessionService } from "../src/agent/subsessions/service.js";
import type { BackoffTimers } from "../src/agent/keyed-backoff.js";

// ---------------------------------------------------------------------------
// The owning session's wakes, with every collaborator faked: a serial turn
// queue per session, a note table, and retry timers the test fires by hand.
// docs/subsessions-invariants.md: "a wake is eventually followed by a turn
// that reads the note" was not checked by anything. This checks the wake
// side of it: whatever the turns do (throw, end without reading, never run),
// another wake comes until a turn ran that read the note. That such a turn's
// prompt carries the note is the turn runner's half, checked through the
// real Agent in subsessions-via-main-agent.test.ts.
// ---------------------------------------------------------------------------

/** What one wake's turn does: reads the note, throws, ends without reading it, or never runs (the queue rejects). */
type Outcome = "read" | "throw" | "unread" | "reject";

type Timer = { fn: () => void; ms: number; cleared: boolean; fired: boolean };

interface World {
  wakes: SubsessionWakes;
  /** Unread message notes per session. */
  notes: Map<string, number>;
  /** Owner words a mirror round has not shown yet, per session. */
  unseenOwnerWords: Set<string>;
  mirrorAllowed: boolean;
  /** Mirror note text per session (takeMirrorNote). */
  mirror: Map<string, { text: string; upTo: number }>;
  audienceOk: (key: string) => boolean;
  outcomes: Outcome[];
  turns: Array<{ key: string; kind: string; outcome: Outcome; prompt: string }>;
  timers: Timer[];
  stopping: boolean;
  enabled: boolean;
  activeKeys: string[];
  /** Runs queued work and fires due retry timers until nothing is left. */
  drain(): Promise<void>;
}

function world(opts: { outcomes?: Outcome[] } = {}): World {
  const queues = new Map<string, Promise<unknown>>();
  let inFlight = 0;
  const w = {
    notes: new Map<string, number>(),
    unseenOwnerWords: new Set<string>(),
    mirrorAllowed: true,
    mirror: new Map<string, { text: string; upTo: number }>(),
    audienceOk: () => true,
    outcomes: [...(opts.outcomes ?? [])],
    turns: [],
    timers: [],
    stopping: false,
    enabled: true,
    activeKeys: [],
  } as unknown as World;
  const service = {
    hasMessageNote: (k: string) => (w.notes.get(k) ?? 0) > 0,
    hasUnseenOwnerWords: (k: string) => w.unseenOwnerWords.has(k),
    mirrorTurnAllowed: () => w.mirrorAllowed,
    mirrorNote: (k: string) => w.mirror.get(k),
  } as unknown as SubsessionService;
  const next = (): Outcome => w.outcomes.shift() ?? "read";
  w.wakes = new SubsessionWakes({
    enqueue: (key, task) => {
      inFlight++;
      const prev = queues.get(key) ?? Promise.resolve();
      const run = prev.then(async () => {
        // The outcome of a queue that rejects is decided when the task would start.
        if (w.outcomes[0] === "reject") {
          w.outcomes.shift();
          w.turns.push({ key, kind: "rejected", outcome: "reject", prompt: "" });
          throw new Error("queue rejected");
        }
        return task();
      });
      const settled = run.then(() => {}, () => {}).finally(() => { inFlight--; });
      queues.set(key, settled);
      return run;
    },
    subsessions: () => (w.enabled ? service : undefined),
    isStopping: () => w.stopping,
    isOwnAudienceTurn: (key) => w.audienceOk(key),
    listActiveEntries: () => w.activeKeys.map((channelKey) => ({ channelKey })),
    runRelayTurn: async (prompt, key, turnKind) => {
      const outcome = next();
      const kind = String(turnKind);
      w.turns.push({ key, kind, outcome, prompt });
      if (outcome === "throw") throw new Error("API down");
      if (outcome === "unread") return;
      // A turn reads every note pending for its session (they ride in as its prefix).
      w.notes.delete(key);
      w.unseenOwnerWords.delete(key);
    },
  });
  const timerApi: BackoffTimers = {
    set: (fn, ms) => { const t: Timer = { fn, ms, cleared: false, fired: false }; w.timers.push(t); return t; },
    clear: (h) => { (h as Timer).cleared = true; },
  };
  (w.wakes as unknown as { retry: { timerApi: BackoffTimers } }).retry.timerApi = timerApi;
  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
    while (inFlight > 0) await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  w.drain = async () => {
    for (let guard = 0; guard < 500; guard++) {
      await settle();
      const due = w.timers.find((t) => !t.cleared && !t.fired);
      if (!due) return;
      due.fired = true;
      due.fn();
    }
    throw new Error("wakes never went quiet");
  };
  return w;
}

const pendingTimers = (w: World) => w.timers.filter((t) => !t.cleared && !t.fired);
const messageTurns = (w: World, key: string) => w.turns.filter((t) => t.key === key && t.kind !== "rejected" && t.prompt.includes("subsession-message"));

describe("SubsessionWakes: message wakes", () => {
  it("a wake for an unread note is followed by a turn that reads it", async () => {
    const w = world();
    w.notes.set("dm:owner", 1);
    w.wakes.message("dm:owner");
    await w.drain();
    expect(w.notes.has("dm:owner")).toBe(false);
    expect(messageTurns(w, "dm:owner")).toHaveLength(1);
    expect(messageTurns(w, "dm:owner")[0].prompt).toContain('type="subsession-message"');
    expect(w.timers).toHaveLength(0);
  });

  it("a turn that throws, ends without reading, or is rejected by the queue is woken again with backoff until one reads the note", async () => {
    const w = world({ outcomes: ["throw", "unread", "reject", "throw"] });
    w.notes.set("dm:owner", 1);
    w.wakes.message("dm:owner");
    await w.drain();
    expect(w.notes.has("dm:owner")).toBe(false);
    expect(w.turns.map((t) => t.outcome)).toEqual(["throw", "unread", "reject", "throw", "read"]);
    const base = MESSAGE_WAKE_RETRY_BASE_MS;
    expect(w.timers.map((t) => t.ms)).toEqual([base, 2 * base, 4 * base, 8 * base]);
  });

  it("no turn when another turn already read the note, and no retry", async () => {
    const w = world();
    w.wakes.message("dm:owner");
    await w.drain();
    expect(w.turns).toHaveLength(0);
    expect(w.timers).toHaveLength(0);
  });

  it("wakes asked for while one is queued merge into it", async () => {
    const w = world();
    w.notes.set("dm:owner", 3);
    w.wakes.message("dm:owner");
    w.wakes.message("dm:owner");
    w.wakes.message("dm:owner");
    await w.drain();
    expect(messageTurns(w, "dm:owner")).toHaveLength(1);
    expect(w.notes.has("dm:owner")).toBe(false);
  });

  it("wakeUnread wakes every non-task session holding a note, and a failure in the registry is swallowed", async () => {
    const w = world();
    w.activeKeys = ["dm:owner", "telegram:-1001", "task:s1", "dm:quiet"];
    w.notes.set("dm:owner", 1);
    w.notes.set("telegram:-1001", 1);
    w.notes.set("task:s1", 1);
    w.wakes.wakeUnread();
    await w.drain();
    expect(w.turns.map((t) => t.key).sort()).toEqual(["dm:owner", "telegram:-1001"]);
    expect(w.notes.get("task:s1")).toBe(1);

    const broken = world();
    (broken.wakes as unknown as { deps: { listActiveEntries: () => never } }).deps.listActiveEntries = () => { throw new Error("registry unreadable"); };
    expect(() => broken.wakes.wakeUnread()).not.toThrow();
  });

  it("stop() drops a pending retry, and a stopping agent runs no wake turn and arms no retry", async () => {
    const w = world({ outcomes: ["throw"] });
    w.notes.set("dm:owner", 1);
    w.wakes.message("dm:owner");
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(pendingTimers(w)).toHaveLength(1);
    w.stopping = true;
    w.wakes.stop();
    expect(w.timers[0].cleared).toBe(true);
    w.wakes.message("dm:owner");
    await w.drain();
    expect(w.turns).toHaveLength(1);
    expect(w.timers).toHaveLength(1);
  });

  it("with sub-sessions off, a wake does nothing", async () => {
    const w = world();
    w.enabled = false;
    w.notes.set("dm:owner", 1);
    w.wakes.message("dm:owner");
    w.wakes.wakeUnread();
    await w.drain();
    expect(w.turns).toHaveLength(0);
    expect(w.timers).toHaveLength(0);
  });

  it("property: whatever the turns do and whenever new notes come, every wake is followed by a turn that reads the note, with at most one retry timer per session", async () => {
    const outcome = fc.constantFrom<Outcome>("read", "throw", "unread", "reject");
    const step = fc.record({ key: fc.constantFrom("dm:owner", "telegram:-1001"), outcomes: fc.array(outcome, { maxLength: 3 }) });
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 6 }), async (steps) => {
      const w = world();
      let maxPending = 0;
      const origSet = (w.wakes as unknown as { retry: { timerApi: BackoffTimers } }).retry.timerApi.set;
      (w.wakes as unknown as { retry: { timerApi: BackoffTimers } }).retry.timerApi.set = (fn, ms) => {
        const h = origSet(fn, ms);
        maxPending = Math.max(maxPending, pendingTimers(w).length);
        return h;
      };
      for (const s of steps) {
        w.outcomes.push(...s.outcomes);
        // A task hands the session a note and asks for its wake, as the service does.
        w.notes.set(s.key, (w.notes.get(s.key) ?? 0) + 1);
        w.wakes.message(s.key);
        await Promise.resolve();
      }
      await w.drain();
      // One retry timer per session at most: never more pending than sessions.
      expect(maxPending).toBeLessThanOrEqual(new Set(steps.map((s) => s.key)).size);
      for (const s of steps) expect(w.notes.has(s.key)).toBe(false);
      for (const key of new Set(steps.map((s) => s.key))) {
        const last = messageTurns(w, key).at(-1);
        expect(last?.outcome).toBe("read");
      }
      expect(pendingTimers(w)).toHaveLength(0);
    }), { numRuns: 200 });
  });

  it("retries at the cap with no attempt limit", async () => {
    const failures = 9;
    const w = world({ outcomes: Array<Outcome>(failures).fill("throw") });
    w.notes.set("dm:owner", 1);
    w.wakes.message("dm:owner");
    await w.drain();
    expect(w.notes.has("dm:owner")).toBe(false);
    expect(w.timers).toHaveLength(failures);
    expect(w.timers.at(-1)!.ms).toBe(MESSAGE_WAKE_RETRY_CAP_MS);
  });
});

describe("SubsessionWakes: mirror", () => {
  it("a mirror wake runs one silent turn while there are owner words it has not shown", async () => {
    const w = world();
    w.unseenOwnerWords.add("dm:owner");
    w.wakes.mirror("dm:owner");
    w.wakes.mirror("dm:owner");
    await w.drain();
    expect(w.turns).toHaveLength(1);
    expect(w.turns[0].prompt).toContain('type="subsession-activity"');
    // Nothing unseen: no turn.
    w.wakes.mirror("dm:owner");
    await w.drain();
    expect(w.turns).toHaveLength(1);
  });

  it("a mirror wake is held back when the quota does not allow it, and is not retried", async () => {
    const w = world();
    w.unseenOwnerWords.add("dm:owner");
    w.mirrorAllowed = false;
    w.wakes.mirror("dm:owner");
    await w.drain();
    expect(w.turns).toHaveLength(0);
    expect(w.timers).toHaveLength(0);
  });

  it("takeMirrorNote: one note in flight per session until released, and none for another audience's turn", () => {
    const w = world();
    w.mirror.set("dm:owner", { text: "MIRROR", upTo: 7 });
    expect(w.wakes.takeMirrorNote("dm:owner")).toEqual({ key: "dm:owner", prefix: "MIRROR\n\n", upTo: 7 });
    expect(w.wakes.takeMirrorNote("dm:owner")).toBeUndefined();
    w.wakes.releaseMirror("dm:owner");
    expect(w.wakes.takeMirrorNote("dm:owner")).toEqual({ key: "dm:owner", prefix: "MIRROR\n\n", upTo: 7 });
    w.wakes.releaseMirror("dm:owner");
    w.audienceOk = () => false;
    expect(w.wakes.takeMirrorNote("dm:owner")).toBeUndefined();
    w.audienceOk = () => true;
    w.mirror.clear();
    // No note: nothing is held in flight.
    expect(w.wakes.takeMirrorNote("dm:owner")).toBeUndefined();
    w.mirror.set("dm:owner", { text: "LATER", upTo: 9 });
    expect(w.wakes.takeMirrorNote("dm:owner")?.upTo).toBe(9);
  });
});
