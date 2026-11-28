/**
 * Model-based tests for the sub-session service: random sequences of events
 * (spawn, owner messages, notes, check-backs, turns that start and end, the
 * task's own tool calls, cancel, the quota gate and its release, restarts and
 * injected faults) run against the REAL SubsessionService and SubsessionStore
 * (a table on disk), with every collaborator faked. After every step the
 * invariants in docs/subsessions-invariants.md that can be observed from the
 * outside are checked; at the end the world is drained and the liveness ones
 * are checked too.
 *
 * Reproducible: the seed is fixed (FC_SEED overrides it, FC_RUNS the number of
 * runs). A failure prints the seed, the path and the shrunk op list, which can
 * be replayed with `fc.assert(..., { seed, path })`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBSESSIONS, type SubsessionConfig } from "../src/config.js";
import { SubsessionService, messageNoteNameOf, type TaskTurnOutcome } from "../src/agent/subsessions/service.js";
import { SubsessionStore, type TransitionOptions, type TransitionOutcome } from "../src/agent/subsessions/store.js";
import { nextStatus, type SubsessionEvent } from "../src/agent/subsessions/state-machine.js";
import { TERMINAL_STATUSES, activeTotalMs, type SubsessionRecord } from "../src/agent/subsessions/types.js";
import type { CreateTaskInput } from "../src/agent/subsessions/store.js";

// The table is fsynced on every write (four fsyncs with its backup), which is
// most of this file's run time and tests nothing here: a crash is modelled by
// the store going dead, not by the disk losing a write.
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()), fsyncSync: () => {} }));

const SEED = Number(process.env.FC_SEED ?? 20261127);
const RUNS = Number(process.env.FC_RUNS ?? 100);
/** A CI bound: past it no new run starts (the runs so far still count), so a slow runner cannot time the test out. */
const TIME_LIMIT_MS = Number(process.env.FC_TIME_LIMIT_MS ?? 20_000);
const PARENT = "dm:owner";
const DAY = 24 * 3_600_000;
const STATS = new Map<string, number>();

// ---------------------------------------------------------------------------
// Faults: a store whose writes can fail (nothing written, like a failed
// atomic rename), and that is dead after a crash (the old process writes
// nothing more).
// ---------------------------------------------------------------------------

class FaultyStore extends SubsessionStore {
  failWrites = 0;
  /** Writes that still go through before the failing ones (so a fault can land on the second or third write of one call). */
  skipWrites = 0;
  dead = false;
  onFault: () => void = () => {};

  private gate(): void {
    if (this.dead) throw new Error("process is gone");
    if (this.failWrites > 0 && this.skipWrites > 0) {
      this.skipWrites -= 1;
      return;
    }
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      this.onFault();
      throw new Error("injected: disk write failed");
    }
  }

  override read(): ReturnType<SubsessionStore["read"]> {
    if (this.dead) throw new Error("process is gone");
    return super.read();
  }

  override create(input: CreateTaskInput): SubsessionRecord {
    this.gate();
    return super.create(input);
  }

  override update(id: string, fn: (record: SubsessionRecord) => void): SubsessionRecord | undefined {
    this.gate();
    return super.update(id, fn);
  }

  override transition(id: string, event: SubsessionEvent, opts: TransitionOptions = {}): TransitionOutcome {
    this.gate();
    return super.transition(id, event, opts);
  }
}

// ---------------------------------------------------------------------------
// The world: one table on disk, the owning session's pending notes, the cron
// store and the registry outlive a process; a process is a store + service.
// ---------------------------------------------------------------------------

/**
 * How the runner reports a turn. An SDK error is `fail` (ok: false with its
 * failure): the real runner (Agent.runTaskTurn) catches everything and never
 * rejects, which is the contract on SubsessionServiceDeps.runTaskTurn.
 */
type TurnEnd = "ok" | "silent" | "fail" | "stopped";

interface InFlight {
  key: string;
  prompt: string;
  tokens: number[];
  /** A task_reply or task_ask of this turn was not delivered: the turn did not answer what it carried. */
  lost?: boolean;
  resolve: (o: TaskTurnOutcome) => void;
}

interface Proc {
  store: FaultyStore;
  service: SubsessionService;
  dead: boolean;
  startedAt: number;
}

interface Note { text: string; durable: boolean }

class World {
  readonly cfg: SubsessionConfig;
  proc!: Proc;
  notes: Note[] = [];
  cron = new Map<string, number>();
  background = new Set<string>();
  registry = new Set<string>();
  sdk = new Set<string>();
  quota: number | undefined;
  inflight = new Map<string, InFlight>();
  faults = { noteWrites: 0, sends: 0, notices: 0 };
  violations: string[] = [];
  /** Tokens carried by a turn that the runner reported as completed (ok). */
  carriedOk = new Set<number>();
  /** Tokens that left pendingInput: a completed turn answered them. */
  consumed = new Set<number>();
  /** Tokens seen in any task prompt so far. */
  prompted = new Set<number>();
  /** Report notes ever written durably, by name ("s1#1"). */
  reportNotes = new Set<string>();
  /** Owner tokens handed back in a durable `subsession-handback` note. */
  handedBack = new Set<number>();
  /**
   * Tasks on the table when a table write last failed, until they next start
   * waiting with no fault armed: a turn whose result could not be written is,
   * to restart recovery, a turn cut short (by design).
   */
  faulted = new Set<string>();
  /** Tasks that ever got the owner's own input: they may pass the slot cap. */
  bypass = new Set<string>();
  /** Time some process was up (ms): active time can never exceed it. */
  uptime = 0;
  snapshot = new Map<string, SubsessionRecord>();
  /** Failed turns in a row per task key, since new input or a store fault (a pause that could not be written). */
  failRun = new Map<string, number>();
  nextToken = 1;
  lastMessageId = new Map<string, string>();
  step = 0;

  constructor(readonly path: string, cfg: Partial<SubsessionConfig>) {
    this.cfg = { ...DEFAULT_SUBSESSIONS, enabled: true, maxActiveHours: 24, ...cfg };
  }

  violate(what: string): void {
    if (process.env.FC_TRACE) console.log(`VIOLATION step ${this.step}: ${what}\n${new Error().stack}`);
    this.violations.push(`step ${this.step}: ${what}`);
  }

  boot(): void {
    const store = new FaultyStore(this.path, { strictTransitions: false });
    store.onFault = () => {
      // A pause that could not be written lets the task go on (by design).
      this.failRun.clear();
      for (const id of this.snapshot.keys()) this.faulted.add(id);
    };
    const proc: Proc = { store, dead: false, startedAt: Date.now(), service: undefined as unknown as SubsessionService };
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the fakes below are closures over the world
    const w = this;
    proc.service = new SubsessionService({
      store,
      config: () => w.cfg,
      runTaskTurn: (key, prompt) => new Promise<TaskTurnOutcome>((resolve) => {
        if (proc.dead) { resolve({ ok: false, shutdown: true }); return; }
        if (w.inflight.has(key)) w.violate(`two turns at once on ${key}`);
        const tokens = [...new Set(tokensOf(prompt))];
        const news = tokens.some((t) => !w.prompted.has(t));
        for (const t of tokens) {
          if (w.consumed.has(t)) w.violate(`T${t} delivered again after a completed turn consumed it (${key})`);
          if (w.prompted.has(t) && !prompt.includes('<tomo-event type="subsession-redelivery"')) {
            w.violate(`T${t} delivered a second time with no redelivery note (${key})`);
          }
          w.prompted.add(t);
        }
        if (process.env.FC_TRACE) console.log(`TURN step ${w.step} ${key}: ${prompt.slice(0, 300)}\n${new Error().stack}`);
        if (news) w.failRun.delete(key);
        if ((w.failRun.get(key) ?? 0) >= 2) w.violate(`a third failed turn in a row ran on ${key} with nothing new for it (MAX_FAIL_STREAK)`);
        w.sdk.add(key);
        w.inflight.set(key, { key, prompt, tokens, resolve });
      }),
      sendToScope: async () => {
        if (w.faults.sends > 0) { w.faults.sends -= 1; return { ok: false, error: "injected: channel down" }; }
        return { ok: true };
      },
      noticeToScope: async () => {
        if (w.faults.notices > 0) { w.faults.notices -= 1; throw new Error("injected: notice send failed"); }
      },
      noticeOwner: async () => {
        if (w.faults.notices > 0) { w.faults.notices -= 1; throw new Error("injected: owner DM send failed"); }
      },
      queuePendingNote: (_key, text) => {
        const durable = w.faults.noteWrites <= 0;
        if (!durable) w.faults.noteWrites -= 1;
        w.notes.push({ text, durable });
        const report = /type="subsession-report" name="([^"]+)"/.exec(text)?.[1];
        if (report && durable) w.reportNotes.add(report);
        if (durable && text.startsWith('<tomo-event type="subsession-handback"')) for (const t of tokensOf(text)) w.handedBack.add(t);
        return durable;
      },
      withdrawPendingNote: (_key, match) => {
        for (let i = w.notes.length - 1; i >= 0; i--) {
          if (match(w.notes[i].text)) {
            w.notes.splice(i, 1);
            return true;
          }
        }
        return false;
      },
      persistPendingNotes: () => {
        if (w.faults.noteWrites > 0) { w.faults.noteWrites -= 1; return false; }
        for (const n of w.notes) {
          n.durable = true;
          const report = /type="subsession-report" name="([^"]+)"/.exec(n.text)?.[1];
          if (report) w.reportNotes.add(report);
        }
        return true;
      },
      hasPendingNote: (_key, pred) => w.notes.some((n) => pred(n.text)),
      wakeScope: () => {},
      messageWake: () => {},
      mirrorWake: () => {},
      contextUsage: () => undefined,
      cronJobCount: (key) => w.cron.get(key) ?? 0,
      removeCronJobs: (key) => { w.cron.delete(key); },
      stopSession: async () => {},
      registryReadable: () => true,
      hasSdkSession: (key) => w.sdk.has(key),
      ensureRegistryEntry: (key) => { w.registry.add(key); },
      unlinkRegistryEntry: (key) => { w.registry.delete(key); w.sdk.delete(key); },
      registryTaskKeys: () => [...w.registry],
      hasBackgroundWork: (key) => w.background.has(key),
      isStopping: () => proc.dead,
      quotaReading: () => (w.quota === undefined ? undefined : { window: "five_hour" as const, percent: w.quota, resetsAt: Date.now() + 30 * 60_000 }),
    });
    this.proc = proc;
    proc.service.recoverAtStartup();
    proc.service.start();
  }

  /** The process dies: nothing it holds in memory survives, its store writes nothing more. */
  crash(): void {
    const proc = this.proc;
    this.uptime += Date.now() - proc.startedAt;
    proc.dead = true;
    proc.store.dead = true;
    proc.service.stop();
    for (const f of this.inflight.values()) f.resolve({ ok: false, shutdown: true });
    this.inflight.clear();
    // Restart recovery may resume a task whose turns failed (bounded by its interrupt streak).
    this.failRun.clear();
    // A note whose write failed lived in memory only.
    this.notes = this.notes.filter((n) => n.durable);
  }

  records(): SubsessionRecord[] {
    return new SubsessionStore(this.path).list();
  }

  token(): number {
    return this.nextToken++;
  }
}

function tokensOf(text: string): number[] {
  return [...text.matchAll(/«T(\d+)»/g)].map((m) => Number(m[1]));
}

function pendingTokens(r: SubsessionRecord): number[] {
  // One input can quote its token twice (a relay with the owner's words attached).
  return r.pendingInput.flatMap((i) => [...new Set(tokensOf(i.text))]);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type Op =
  | { k: "spawn" }
  | { k: "ownerMessage"; t: number; again: boolean }
  | { k: "note"; t: number }
  | { k: "relayOwner"; t: number }
  | { k: "start"; t: number }
  | { k: "cron"; t: number }
  | { k: "setCron"; t: number; n: number }
  | { k: "background"; t: number; on: boolean }
  | { k: "bgReport"; t: number }
  | { k: "tool"; t: number }
  | { k: "reply"; t: number }
  | { k: "ask"; t: number }
  | { k: "finish"; t: number }
  | { k: "reopen"; t: number }
  | { k: "claimRestart"; t: number }
  | { k: "end"; t: number; how: TurnEnd }
  | { k: "cancel"; t: number }
  | { k: "quota"; pct: number | undefined }
  | { k: "mainReads" }
  | { k: "advance"; ms: number }
  | { k: "crash"; downMs: number }
  | { k: "faultStore"; n: number; skip: number }
  | { k: "faultNote"; n: number }
  | { k: "faultSend"; n: number }
  | { k: "faultNotice"; n: number };

const task = fc.nat({ max: 3 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.constant<Op>({ k: "spawn" }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant("ownerMessage" as const), t: task, again: fc.boolean() }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant("note" as const), t: task }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("relayOwner" as const), t: task }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("start" as const), t: task }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("cron" as const), t: task }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("setCron" as const), t: task, n: fc.constantFrom(0, 1) }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("background" as const), t: task, on: fc.boolean() }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("bgReport" as const), t: task }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("tool" as const), t: task }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant("reply" as const), t: task }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("ask" as const), t: task }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("finish" as const), t: task }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("reopen" as const), t: task }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("claimRestart" as const), t: task }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("end" as const), t: task, how: fc.constantFrom<TurnEnd>("ok", "ok", "ok", "silent", "fail", "stopped") }), weight: 8 },
  { arbitrary: fc.record({ k: fc.constant("cancel" as const), t: task }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("quota" as const), pct: fc.constantFrom(undefined, 10, 95) }), weight: 1 },
  { arbitrary: fc.constant<Op>({ k: "mainReads" }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("advance" as const), ms: fc.constantFrom(1_000, 61_000, 5 * 60_000 + 1_000, 31 * 60_000) }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("crash" as const), downMs: fc.constantFrom(1_000, 1_000, 3 * 3_600_000, 8 * DAY, 31 * DAY) }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("faultStore" as const), n: fc.integer({ min: 1, max: 2 }), skip: fc.nat({ max: 3 }) }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("faultNote" as const), n: fc.integer({ min: 1, max: 2 }) }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("faultSend" as const), n: fc.integer({ min: 1, max: 2 }) }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("faultNotice" as const), n: fc.integer({ min: 1, max: 2 }) }), weight: 1 },
);

/** Every call into the service from outside: a throw is the caller's error, never the test's. */
async function call<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

async function apply(w: World, op: Op): Promise<void> {
  const svc = w.proc.service;
  const tasks = w.records();
  const pick = (t: number) => (tasks.length === 0 ? undefined : tasks[t % tasks.length]);
  // An op on a running turn picks among the turns in flight, so it rarely misses.
  const inTurn = (t: number) => {
    const keys = [...w.inflight.keys()];
    return keys.length === 0 ? undefined : tasks.find((r) => r.sessionKey === keys[t % keys.length]);
  };
  switch (op.k) {
    case "spawn":
      await call(() => svc.spawn(PARENT, { title: `task ${tasks.length + 1}`, brief: "work" }));
      return;
    case "ownerMessage": {
      const r = pick(op.t);
      if (!r) return;
      const prev = w.lastMessageId.get(r.id);
      if (op.again && prev) {
        const before = w.records().find((x) => x.id === r.id);
        const res = await call(() => svc.ownerMessage(PARENT, r.id, `«T${prev.split("-")[1]}» again`, { messageId: prev }));
        const after = w.records().find((x) => x.id === r.id);
        if (res?.ok && !res.duplicate) w.violate(`a replayed owner message ${prev} was taken a second time`);
        if (before && after && after.nextInputSeq !== before.nextInputSeq) w.violate(`a replayed owner message ${prev} appended input`);
        return;
      }
      const tok = w.token();
      const messageId = `m-${tok}`;
      const res = await call(() => svc.ownerMessage(PARENT, r.id, `«T${tok}» from the owner`, { messageId }));
      if (res?.ok) { w.lastMessageId.set(r.id, messageId); w.bypass.add(r.id); }
      checkAck(w, r.id, tok, res?.ok === true);
      return;
    }
    case "note": {
      const r = pick(op.t);
      if (!r) return;
      const tok = w.token();
      const before = r;
      const res = await call(() => svc.relay(r.id, `«T${tok}» a note from the main session`));
      checkAck(w, r.id, tok, res?.ok === true);
      // Nothing but a release wakes a task waiting for the owner on a note alone.
      const after = w.records().find((x) => x.id === r.id);
      if (before.status === "waiting" && before.waitingOn === "owner" && after && !(after.status === "waiting" && after.waitingOn === "owner")) {
        const released = after.transitions.slice(before.transitions.length).some((x) => x.event === "release");
        const ended = after.transitions.slice(before.transitions.length).every((x) => ["release", "start", "stuck", "ask", "finish", "wait_external", "cancel", "fail"].includes(x.event));
        if (!released || !ended) w.violate(`a note alone woke ${r.id} out of waiting(owner) without a release`);
      }
      return;
    }
    case "relayOwner": {
      const r = pick(op.t);
      if (!r) return;
      const tok = w.token();
      const res = await call(() => svc.relay(r.id, `«T${tok}» passing on`, [{ text: `«T${tok}» the owner's words`, at: Date.now(), channel: "imessage" }]));
      if (res?.ok) w.bypass.add(r.id);
      checkAck(w, r.id, tok, res?.ok === true);
      return;
    }
    case "start": {
      const r = pick(op.t);
      if (!r || r.status !== "queued") return;
      if (await call(() => svc.startTask(r.id, "the owner started it"))) { w.bypass.add(r.id); w.failRun.delete(r.sessionKey); }
      return;
    }
    case "cron": {
      const r = pick(op.t);
      if (!r) return;
      const tok = w.token();
      const res = await call(() => svc.onCronFire(r.sessionKey, `«T${tok}» check-back`));
      checkAck(w, r.id, tok, res === true);
      return;
    }
    case "setCron": {
      const r = inTurn(op.t);
      if (!r) return;
      if (op.n > 0) w.cron.set(r.sessionKey, op.n);
      else w.cron.delete(r.sessionKey);
      return;
    }
    case "background": {
      const r = inTurn(op.t);
      if (!r) return;
      if (op.on) w.background.add(r.sessionKey);
      else w.background.delete(r.sessionKey);
      return;
    }
    case "bgReport": {
      const r = pick(op.t);
      if (!r || w.inflight.has(r.sessionKey)) return;
      w.background.delete(r.sessionKey);
      await call(() => svc.onBackgroundReport(r.sessionKey));
      return;
    }
    case "tool": {
      const r = inTurn(op.t);
      if (r) await call(() => svc.noteToolUse(r.sessionKey));
      return;
    }
    case "reply": {
      const r = inTurn(op.t);
      if (r) noteLost(w, r.sessionKey, await call(() => svc.reply(r.sessionKey, `reply ${w.token()}`)));
      return;
    }
    case "ask": {
      const r = inTurn(op.t);
      if (r) noteLost(w, r.sessionKey, await call(() => svc.ask(r.sessionKey, `question ${w.token()}?`)));
      return;
    }
    case "finish": {
      const r = inTurn(op.t);
      if (r) await call(() => svc.finish(r.sessionKey, `report ${w.token()}`));
      return;
    }
    case "reopen": {
      const r = inTurn(op.t);
      if (r) await call(() => svc.reopen(r.sessionKey));
      return;
    }
    case "claimRestart": {
      // The task asked for the daemon restart; the crash that follows is its own.
      const r = inTurn(op.t);
      if (r) await call(() => svc.onRestartClaimed(r.sessionKey));
      return;
    }
    case "end": {
      const r = inTurn(op.t);
      const f = r && w.inflight.get(r.sessionKey);
      if (!f) return;
      w.inflight.delete(f.key);
      endTurn(w, f, op.how);
      return;
    }
    case "cancel": {
      const r = pick(op.t);
      if (!r) return;
      // The real stopSession ends the live turn; its runner reports "stopped".
      const f = w.inflight.get(r.sessionKey);
      const res = await call(() => svc.cancel(r.id, "no longer needed"));
      if (f && res?.ok) { w.inflight.delete(f.key); f.resolve({ ok: false, stopped: true }); }
      return;
    }
    case "quota":
      w.quota = op.pct;
      return;
    case "mainReads":
      // The owning session's turn read every note it had.
      w.notes = [];
      return;
    case "advance":
      await vi.advanceTimersByTimeAsync(op.ms);
      return;
    case "crash": {
      // A wait for the owner that no turn was still running under is a
      // completed wait: a restart is not the owner, and does not end it.
      const waitingOwner = tasks.filter((r) => r.status === "waiting" && r.waitingOn === "owner" && !w.inflight.has(r.sessionKey) && !w.faulted.has(r.id));
      w.crash();
      vi.setSystemTime(Date.now() + op.downMs);
      w.boot();
      const after = new Map(w.records().map((r) => [r.id, r]));
      for (const before of waitingOwner) {
        const r = after.get(before.id);
        if (r && r.status !== "failed" && !(r.status === "waiting" && r.waitingOn === "owner")) w.violate(`${r.id}: a restart ended its wait for the owner (now ${r.status})`);
      }
      return;
    }
    case "faultStore":
      w.proc.store.failWrites = op.n;
      w.proc.store.skipWrites = op.skip ?? 0;
      return;
    case "faultNote":
      w.faults.noteWrites = op.n;
      return;
    case "faultSend":
      w.faults.sends = op.n;
      return;
    case "faultNotice":
      w.faults.notices = op.n;
      return;
  }
}

/** The task was told its words did not get through (every text here is said once, so nothing later makes up for it). */
function noteLost(w: World, key: string, result: { ok: boolean; error?: string } | undefined): void {
  const f = w.inflight.get(key);
  if (f && result && !result.ok && /could not be|injected/.test(result.error ?? "")) f.lost = true;
}

function endTurn(w: World, f: InFlight, how: TurnEnd): void {
  if (how === "fail") w.failRun.set(f.key, (w.failRun.get(f.key) ?? 0) + 1);
  else if (how !== "stopped") w.failRun.delete(f.key);
  // A turn whose answer was lost keeps its inputs, like a failed one.
  if ((how === "ok" || how === "silent") && !f.lost) for (const t of f.tokens) w.carriedOk.add(t);
  if (how === "ok") f.resolve({ ok: true });
  else if (how === "silent") f.resolve({ ok: true, response: "plain text the task wrote" });
  else if (how === "fail") f.resolve({ ok: false, failure: { detail: "injected: API error" } });
  else f.resolve({ ok: false, stopped: true });
}

/** What the caller was told matches the table: taken means on the record, refused means not. */
function checkAck(w: World, id: string, tok: number, acked: boolean): void {
  let stored: boolean;
  try {
    stored = w.records().some((r) => r.id === id && pendingTokens(r).includes(tok));
  } catch {
    return;
  }
  if (acked) w.failRun.delete(`task:${id}`);
  if (acked && !stored && !w.carriedOk.has(tok)) w.violate(`T${tok} was acknowledged but is not on ${id}`);
  if (!acked && stored) w.violate(`T${tok} was refused but is on ${id} (a retry would duplicate it)`);
}

// ---------------------------------------------------------------------------
// Invariants after every step
// ---------------------------------------------------------------------------

function legal(from: SubsessionRecord["status"] | null, to: SubsessionRecord["status"], event: string): boolean {
  if (from === null) return event === "spawn" && to === "queued";
  const ev = event as SubsessionEvent;
  return [undefined, "owner", "external"].some((on) => {
    const r = nextStatus(from, on as "owner" | "external" | undefined, ev);
    return r !== null && r !== "same" && r.status === to;
  });
}

function checkInvariants(w: World): void {
  const now = Date.now();
  const records = w.records();
  const pendingNow = new Set<number>();
  for (const r of records) {
    const before = w.snapshot.get(r.id);
    // Shape: what only holds in one state is gone outside it.
    if ((r.status === "waiting") !== (r.waitingOn !== undefined)) w.violate(`${r.id}: waitingOn ${r.waitingOn} with status ${r.status}`);
    const waitingOwner = r.status === "waiting" && r.waitingOn === "owner";
    if (r.askViaMain && !waitingOwner) w.violate(`${r.id}: askViaMain while ${r.status}`);
    if (r.pausedBy && (!waitingOwner || r.askViaMain)) w.violate(`${r.id}: pausedBy while ${r.status}${r.askViaMain ? " with a question" : ""}`);
    if (r.quotaPass && (r.status === "finished" || TERMINAL_STATUSES.has(r.status))) w.violate(`${r.id}: quotaPass on a ${r.status} task`);
    const ended = r.status === "finished" || TERMINAL_STATUSES.has(r.status);
    if (ended !== (r.endedAt !== undefined)) w.violate(`${r.id}: endedAt ${r.endedAt} with status ${r.status}`);
    if ((r.status === "active") !== (r.activeSince !== undefined)) w.violate(`${r.id}: activeSince ${r.activeSince} with status ${r.status}`);
    // Every logged transition is one the table allows; ended never changes.
    const fresh = r.transitions.slice(before ? before.transitions.length : 0);
    for (const t of fresh) if (!legal(t.from, t.to, t.event)) w.violate(`${r.id}: illegal ${t.event} ${t.from} -> ${t.to}`);
    if (fresh.some((t) => t.to === "waiting") && w.proc.store.failWrites === 0) w.faulted.delete(r.id);
    if (before && TERMINAL_STATUSES.has(before.status) && r.status !== before.status) w.violate(`${r.id}: ${before.status} changed to ${r.status}`);
    // Inputs: seqs strictly increase, nothing pending twice.
    const seqs = r.pendingInput.map((i) => i.seq);
    if (seqs.some((s, i) => i > 0 && s <= seqs[i - 1])) w.violate(`${r.id}: pendingInput out of seq order`);
    if (seqs.some((s) => s >= r.nextInputSeq)) w.violate(`${r.id}: a pending seq at or past nextInputSeq`);
    const toks = pendingTokens(r);
    if (new Set(toks).size !== toks.length) w.violate(`${r.id}: an input is pending twice`);
    for (const t of toks) pendingNow.add(t);
    // No silent drop: an input leaves only with a completed turn that carried it.
    if (before) {
      for (const t of pendingTokens(before)) {
        if (toks.includes(t)) continue;
        if (!w.carriedOk.has(t)) w.violate(`${r.id}: T${t} left pendingInput without a completed turn carrying it`);
        w.consumed.add(t);
      }
    }
    // Active time: the time a process was down never counts.
    const up = w.uptime + (now - w.proc.startedAt);
    if (activeTotalMs(r, now) > up + 5) w.violate(`${r.id}: active ${activeTotalMs(r, now)}ms but processes were up only ${up}ms`);
    if (before && r.activeMs < before.activeMs) w.violate(`${r.id}: activeMs went down`);
    // A quota go-ahead holds until its window resets: a pass is granted only
    // on leaving a quota pause, so a quota pause made while one stands is the
    // gate pausing again too early.
    const pausedAt = r.transitions.findLast((t) => t.event === "stuck")?.at;
    if (r.pausedBy?.kind === "quota" && r.quotaPass && pausedAt !== undefined && pausedAt < r.quotaPass.until) {
      w.violate(`${r.id}: paused for quota again before its go-ahead ran out`);
    }
    // A report marked delivered has its note on disk.
    if (r.status === "finished" && r.reportDelivered && r.reportSeq !== undefined && !w.reportNotes.has(`${r.id}#${r.reportSeq}`)) {
      w.violate(`${r.id}: report ${r.reportSeq} marked delivered with no note written`);
    }
    // A question note stands only for the question the task waits on.
    if (w.cfg.ownerMessages === "via-main") {
      const asks = w.notes.map((n) => messageNoteNameOf(n.text)).filter((n): n is string => !!n && n.startsWith(`${r.id}:ask:`));
      if (asks.length > 1) w.violate(`${r.id}: ${asks.length} question notes stand`);
      if (asks.length === 1 && r.askViaMain?.note !== asks[0]) w.violate(`${r.id}: question note ${asks[0]} stands while the task waits on ${r.askViaMain?.note ?? "nothing"}`);
    }
    if (r.status === "cancelled" && (w.cron.get(r.sessionKey) ?? 0) > 0) w.violate(`${r.id}: cancelled with cron jobs left`);
  }
  // A record is forgotten only once it ended for good, and a failed one's
  // unanswered owner input only once it was handed back in full.
  const present = new Set(records.map((r) => r.id));
  for (const before of w.snapshot.values()) {
    if (present.has(before.id)) continue;
    if (!TERMINAL_STATUSES.has(before.status)) w.violate(`${before.id}: forgotten while ${before.status}`);
    if (before.status === "failed") {
      for (const i of before.pendingInput) {
        if (i.from !== "owner") continue;
        for (const t of tokensOf(i.text)) if (!w.handedBack.has(t)) w.violate(`${before.id}: forgotten with the owner's T${t} never handed back`);
      }
    }
  }
  // The slot cap, for tasks that never had the owner's word.
  const autonomous = records.filter((r) => r.status === "active" && !w.bypass.has(r.id)).length;
  if (autonomous > w.cfg.maxRunning) w.violate(`${autonomous} autonomous tasks active (maxRunning ${w.cfg.maxRunning})`);
  for (const t of w.consumed) if (pendingNow.has(t)) w.violate(`T${t} pending again after it was consumed`);
  w.snapshot = new Map(records.map((r) => [r.id, r]));
}

/**
 * Faults off, the world settles: every turn ends well (an active task
 * finishes, a finished one answers), timers run. Then nothing is stuck.
 */
async function drain(w: World): Promise<void> {
  w.proc.store.failWrites = 0;
  w.proc.store.skipWrites = 0;
  w.faults = { noteWrites: 0, sends: 0, notices: 0 };
  w.quota = undefined;
  w.cron.clear();
  w.background.clear();
  let idle = 0;
  for (let round = 0; round < 80; round++) {
    await flush();
    const turns = [...w.inflight.values()];
    if (turns.length === 0) {
      // Quiet: let the timers (settle and report retries, the check-back recheck) run a while.
      if (++idle > 3) break;
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      continue;
    }
    idle = 0;
    for (const f of turns) {
      const r = w.records().find((x) => x.sessionKey === f.key);
      if (r?.status === "active") {
        w.proc.service.noteToolUse(f.key);
        w.proc.service.finish(f.key, "done");
      } else if (r?.status === "finished") {
        await w.proc.service.reply(f.key, "answer");
      }
      w.inflight.delete(f.key);
      endTurn(w, f, "ok");
    }
    await flush();
    checkInvariants(w);
  }
  await flush();
  checkInvariants(w);
  if (w.inflight.size > 0) w.violate(`drain: ${w.inflight.size} turns still in flight`);
  // What the service keeps in memory about a turn or a retry is gone once nothing runs and nothing is owed.
  const runtime = w.proc.service as unknown as Record<string, { size: number }>;
  for (const name of ["driving", "inflightThrough", "inflightTurn", "inflightRetry", "notesUsed", "panelRepeatsUsed", "settleTimers", "reportTimers", "registryHeld", "startsOwed"]) {
    if (runtime[name].size > 0) w.violate(`drain: ${runtime[name].size} left in ${name}`);
  }
  for (const r of w.records()) {
    if (r.status === "active" || r.status === "queued") w.violate(`drain: ${r.id} stuck ${r.status}`);
    if (r.status === "waiting" && r.waitingOn === "external") w.violate(`drain: ${r.id} still waiting on a check-back that is gone`);
    if (r.status === "waiting" && r.waitingOn === "owner") {
      // It waits for the owner while holding words of theirs no turn ever showed it.
      // (Not after it restarted Tomo itself: that pause keeps whatever it held, by design.)
      for (const i of r.transitions.at(-1)?.event === "self_restart" ? [] : r.pendingInput) {
        if (i.from !== "owner") continue;
        for (const t of tokensOf(i.text)) if (!w.prompted.has(t)) w.violate(`drain: ${r.id} waits for the owner with their T${t} never shown to it`);
      }
    }
    if (r.status === "finished") {
      const owed = r.pendingInput.filter((i) => i.seq > (r.heldThrough ?? 0));
      if (owed.length > 0) w.violate(`drain: finished ${r.id} never answered ${owed.length} input(s)`);
      if (!r.reportDelivered) w.violate(`drain: ${r.id}'s report never delivered`);
    }
  }
}

async function runOps(ops: Op[], cfg: Partial<SubsessionConfig>): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "tomo-subsmodel-"));
  const w = new World(join(dir, "subsessions.json"), cfg);
  // Nothing the service does may reject with nobody to catch it.
  const unhandled = (err: unknown) => w.violate(`unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
  process.on("unhandledRejection", unhandled);
  try {
    w.boot();
    // Every run has a task to act on from the first op.
    for (const op of [{ k: "spawn" } as Op, ...ops]) {
      w.step += 1;
      await apply(w, op);
      await flush();
      checkInvariants(w);
      if (w.violations.length > 0) break;
    }
    if (w.violations.length === 0) await drain(w);
    if (process.env.FC_STATS) {
      for (const r of w.records()) for (const t of r.transitions) STATS.set(`${t.from}->${t.to} ${t.event}`, (STATS.get(`${t.from}->${t.to} ${t.event}`) ?? 0) + 1);
      STATS.set("prompts", (STATS.get("prompts") ?? 0) + w.prompted.size);
      STATS.set("consumed", (STATS.get("consumed") ?? 0) + w.consumed.size);
    }
    return w.violations;
  } finally {
    w.crash();
    await flush();
    process.off("unhandledRejection", unhandled);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Counterexamples this test once found that random runs reach only rarely:
 * run first, every time, whatever the seed.
 */
const REGRESSIONS: Array<[Op[], Partial<SubsessionConfig>]> = [
  // task_ask gave the slot away mid-turn; finishing and reopening in that turn made two tasks active.
  [[{ k: "spawn" }, { k: "ask", t: 0 }, { k: "finish", t: 0 }, { k: "reopen", t: 0 }], { maxRunning: 1, ownerMessages: "via-main" }],
  // The write that marks a report delivered failed: nothing retried it.
  [[{ k: "tool", t: 0 }, { k: "faultStore", n: 1, skip: 1 }, { k: "finish", t: 0 }, { k: "end", t: 0, how: "ok" }], { maxRunning: 1, ownerMessages: "via-main" }],
  // The start of a queued task failed to write when a slot freed: it escaped the scheduler.
  [[{ k: "spawn" }, { k: "tool", t: 0 }, { k: "finish", t: 0 }, { k: "faultStore", n: 1, skip: 1 }, { k: "end", t: 0, how: "ok" }], { maxRunning: 1, ownerMessages: "via-main" }],
  // task_ask, then the turn failed: a restart ended the wait for the owner.
  [[{ k: "ask", t: 0 }, { k: "end", t: 0, how: "fail" }, { k: "crash", downMs: 1_000 }], { maxRunning: 1, ownerMessages: "via-main" }],
];

const cfgArb = fc.record({
  maxRunning: fc.constantFrom(1, 2),
  ownerMessages: fc.constantFrom<SubsessionConfig["ownerMessages"]>("via-main", "direct"),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: new Date("2026-11-01T00:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sub-session service, model-based", () => {
  // FC_OPS='[[ops...],{cfg}]' replays one counterexample (with FC_TRACE=1 for every turn and violation).
  it.runIf(!!process.env.FC_OPS)("replays FC_OPS", async () => {
    const [ops, cfg] = JSON.parse(process.env.FC_OPS!) as [Op[], Partial<SubsessionConfig>];
    expect(await runOps(ops, cfg)).toEqual([]);
  });

  it("keeps its invariants over random event sequences, restarts and faults", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 10, maxLength: 60, size: "max" }), cfgArb, async (ops, cfg) => {
        const violations = await runOps(ops, cfg);
        expect(violations).toEqual([]);
      }),
      { seed: SEED, numRuns: RUNS, examples: REGRESSIONS, endOnFailure: false, interruptAfterTimeLimit: TIME_LIMIT_MS, markInterruptAsFailure: false },
    );
    if (process.env.FC_STATS) writeFileSync(process.env.FC_STATS, [...STATS].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}\t${k}`).join("\n"));
  }, 120_000);
});
