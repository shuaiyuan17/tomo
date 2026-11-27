import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_INTERRUPT_STREAK, MESSAGE_NOTE_MARKER, SubsessionService, type TaskTurnOutcome } from "../src/agent/subsessions/service.js";
import { HARNESS, PENDING_INPUT_MAX, appendInput } from "../src/agent/subsessions/types.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { classifyFailure, failureCategory, failureHint } from "../src/agent/subsessions/failure.js";
import { DEFAULT_SUBSESSIONS, type SubsessionConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// The harness's own notices about sub-sessions (paused: no progress, failing,
// stopped, the active-hours cap, the quota; failed; dropped check-back; the
// sub-session list itself): with ownerMessages "via-main" (the default) they
// go to the owning session as a pinned note with a wake, never straight to
// the chat; "direct" keeps sending them to the chat.
// ---------------------------------------------------------------------------

type OnTurn = (key: string, prompt: string, h: H) => TaskTurnOutcome | Promise<TaskTurnOutcome>;

interface H {
  service: SubsessionService;
  store: SubsessionStore;
  cfg: SubsessionConfig;
  notes: Map<string, string[]>;
  disk: Map<string, string[]>;
  /** noticeToScope: a task notice sent to its scope's chat. */
  chat: Array<{ parentKey: string; text: string }>;
  /** noticeOwner: a notice sent to the owner's DM. */
  dm: string[];
  messageWakes: string[];
  noteWriteFails: number;
  registryReadable: boolean;
  quota?: number;
  clock: number;
  sdk: Set<string>;
  onTurn: OnTurn;
}

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-notice-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 30; j++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 1));
  }
}

const noTool: OnTurn = () => ({ ok: true });

function harness(cfg: Partial<SubsessionConfig> = {}, onTurn: OnTurn = noTool, shared?: { disk: Map<string, string[]>; sdk: Set<string> }): H {
  const store = new SubsessionStore(join(dir, "subsessions.json"), { strictTransitions: true });
  const h = {
    store,
    cfg: { ...DEFAULT_SUBSESSIONS, enabled: true, ...cfg },
    notes: new Map(),
    disk: shared?.disk ?? new Map(),
    chat: [],
    dm: [],
    messageWakes: [],
    noteWriteFails: 0,
    registryReadable: true,
    clock: Date.parse("2026-11-25T12:00:00Z"),
    sdk: shared?.sdk ?? new Set<string>(),
    onTurn,
  } as unknown as H;
  for (const [k, v] of h.disk) h.notes.set(k, [...v]);
  h.service = new SubsessionService({
    store,
    config: () => h.cfg,
    runTaskTurn: async (key, prompt) => {
      h.sdk.add(key);
      await new Promise((r) => setImmediate(r));
      return h.onTurn(key, prompt, h);
    },
    sendToScope: async () => ({ ok: true }),
    noticeToScope: async (parentKey, text) => { h.chat.push({ parentKey, text }); },
    noticeOwner: async (text) => { h.dm.push(text); return true; },
    ownerKey: () => "dm:owner",
    queuePendingNote: (key, note) => {
      h.notes.set(key, [...(h.notes.get(key) ?? []), note]);
      if (h.noteWriteFails > 0) { h.noteWriteFails -= 1; return false; }
      h.disk.set(key, [...(h.notes.get(key) ?? [])]);
      return true;
    },
    withdrawPendingNote: (key, match) => {
      const list = h.notes.get(key) ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        if (!match(list[i])) continue;
        list.splice(i, 1);
        h.disk.set(key, [...list]);
        return true;
      }
      return false;
    },
    hasPendingNote: (key, pred) => (h.notes.get(key) ?? []).some(pred),
    persistPendingNotes: () => true,
    wakeScope: () => {},
    messageWake: (key) => { h.messageWakes.push(key); },
    contextUsage: () => undefined,
    cronJobCount: () => 0,
    removeCronJobs: () => {},
    stopSession: async () => {},
    registryReadable: () => h.registryReadable,
    hasSdkSession: (key) => h.sdk.has(key),
    ensureRegistryEntry: () => {},
    unlinkRegistryEntry: () => {},
    registryTaskKeys: () => [...h.sdk],
    isStopping: () => false,
    quotaReading: () => (h.quota === undefined ? undefined : { window: "five_hour" as const, percent: h.quota }),
    now: () => h.clock,
  });
  return h;
}

const isNotice = (n: string) => n.includes(MESSAGE_NOTE_MARKER) && /name="[^"]*:notice:/.test(n);
const notices = (h: H, key: string) => (h.notes.get(key) ?? []).filter(isNotice);
const allNoticeKeys = (h: H) => [...h.notes.entries()].filter(([, v]) => v.some(isNotice)).map(([k]) => k);

function spawn(h: H, parentKey = "dm:owner") {
  const r = h.service.spawn(parentKey, { title: "Fix CI", brief: "b" });
  if (!r.ok) throw new Error(r.error);
  return r.record;
}

/** A started task, as a restart finds it. */
function seedActive(h: H, patch?: (r: ReturnType<SubsessionStore["get"]> & object) => void): string {
  const t = h.store.create({ parentKey: "dm:owner", title: "Fix CI", brief: "b" });
  h.store.transition(t.id, "start");
  h.store.update(t.id, (r) => { r.startDelivered = true; patch?.(r); });
  h.sdk.add(t.sessionKey);
  return t.id;
}

/** Each per-task notice, how to bring it about, and the text it says. */
/** `atStart`: brought about by restart recovery, so `run` starts the service itself. */
const KINDS: Array<{ name: string; kind: string; says: string; atStart?: boolean; cfg?: Partial<SubsessionConfig>; run: (h: H) => Promise<void> }> = [
  {
    name: "no progress (stuck)", kind: "no_progress", says: "turns in a row with no progress",
    run: async (h) => { spawn(h); await flush(); },
  },
  {
    name: "failing turns", kind: "turns_failing", says: "its last turns failed",
    run: async (h) => { h.onTurn = () => ({ ok: false, failure: { refusal: "reasoning_extraction" } }); spawn(h); await flush(); },
  },
  {
    name: "stopped by the owner", kind: "stopped_by_owner", says: "Stopped.",
    run: async (h) => { h.onTurn = () => ({ ok: false, stopped: true }); spawn(h); await flush(); },
  },
  {
    name: "the 5-hour quota", kind: "quota", atStart: true, says: "of the 5-hour usage window is used",
    run: async (h) => { h.quota = 95; seedActive(h); h.service.start(); await flush(); },
  },
  {
    name: "the active-hours cap", kind: "active_hours_cap", atStart: true, says: "subsessions.maxActiveHours", cfg: { maxActiveHours: 1 },
    run: async (h) => { seedActive(h, (r) => { r.activeMs = 2 * 3_600_000; }); h.service.start(); await flush(); },
  },
  {
    name: "a self-requested restart", kind: "self_restart", atStart: true, says: "restarted at this task's own request",
    run: async (h) => { seedActive(h, (r) => { r.restartRequested = true; }); h.service.start(); await flush(); },
  },
  {
    name: "gave up after restarts", kind: "interrupted_by_restarts", atStart: true, says: "restarts cut it short",
    run: async (h) => { seedActive(h, (r) => { r.interruptStreak = MAX_INTERRUPT_STREAK; }); h.service.start(); await flush(); },
  },
  {
    name: "conversation lost", kind: "conversation_lost", atStart: true, says: "its conversation could not be found",
    run: async (h) => { const id = seedActive(h); h.sdk.delete(h.store.get(id)!.sessionKey); h.service.start(); await flush(); },
  },
  {
    name: "a dropped check-back (input full)", kind: "input_full", says: "A scheduled check-back was dropped",
    run: async (h) => {
      const t = spawn(h);
      await flush();
      // Parked, holding all it can take: the next check-back has no room.
      h.store.update(t.id, (r) => { for (let i = 0; i < PENDING_INPUT_MAX; i++) appendInput(r, `x${i}`, HARNESS); });
      h.service.onCronFire(t.sessionKey, "check");
      await flush();
    },
  },
];

describe("via-main (default): a task's harness notices go to the owning session, not the chat", () => {
  for (const k of KINDS) {
    it(`${k.name}: a pinned note on the owning session, a wake, nothing to the chat`, async () => {
      const h = harness(k.cfg);
      if (!k.atStart) h.service.start();
      await k.run(h);
      const mine = notices(h, "dm:owner").filter((n) => n.includes(k.says));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toContain(`(kind: ${k.kind})`);
      expect(mine[0]).toContain("Decide whether, when and how the owner hears it");
      // Who may let it go on: a harness limit is lifted by the session's own
      // task_message; a stop the owner made, or a self-restart, only by their word.
      const lifts = ["no_progress", "turns_failing", "quota", "active_hours_cap"].includes(k.kind);
      const ownerOnly = ["stopped_by_owner", "self_restart"].includes(k.kind);
      expect(mine[0].includes("lifts the pause (your own note is enough, no attach_owner_message needed")).toBe(lifts);
      expect(mine[0].includes("Only the owner's own word lets it go on")).toBe(ownerOnly);
      // On disk, so it survives a restart; and the session is woken for it.
      expect((h.disk.get("dm:owner") ?? []).filter((n) => isNotice(n) && n.includes(k.says))).toHaveLength(1);
      expect(h.messageWakes).toContain("dm:owner");
      expect(h.chat.filter((c) => c.text.includes(k.says))).toEqual([]);
      expect(h.dm).toEqual([]);
      h.service.stop();
    });

    it(`${k.name}: "direct" sends it to the chat as before, with no note to hand on`, async () => {
      const h = harness({ ...k.cfg, ownerMessages: "direct" });
      if (!k.atStart) h.service.start();
      await k.run(h);
      expect(h.chat.filter((c) => c.parentKey === "dm:owner" && c.text.includes(k.says))).toHaveLength(1);
      expect(allNoticeKeys(h)).toEqual([]);
      h.service.stop();
    });
  }
});

describe("via-main notices: the cause, privacy, nothing lost or twice", () => {
  it("a failing task's note names the failure category, and says resuming won't help a refusal", async () => {
    const h = harness({}, () => ({ ok: false, failure: { refusal: "reasoning_extraction", detail: "API Error: 400 refused" } }));
    h.service.start();
    spawn(h);
    await flush();
    const [note] = notices(h, "dm:owner");
    expect(note).toContain("Failure category: reasoning_extraction");
    expect(note).toContain("last error: API Error: 400 refused");
    expect(note).toContain("resuming it will likely fail again");
    expect(note).toContain("task_cancel s1");
    h.service.stop();
  });

  it("an API error's type is the category when no refusal says one; a passing one says resuming works", async () => {
    const h = harness({}, () => ({ ok: false, failure: { detail: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' } }));
    h.service.start();
    spawn(h);
    await flush();
    const [note] = notices(h, "dm:owner");
    expect(note).toContain("Failure category: overloaded");
    expect(note).toContain("resuming it later should work");
    h.service.stop();
  });

  it("failureCategory reads refusal, API error type, SDK kind and overflow", () => {
    expect(failureCategory({ refusal: "reasoning_extraction" })).toBe("reasoning_extraction");
    expect(failureCategory({ detail: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"x"}}' })).toBe("invalid_request");
    expect(failureCategory({ errorKind: "rate_limit" })).toBe("rate_limit");
    expect(failureCategory({ errorKind: "unknown", detail: "prompt is too long" })).toBe("prompt_too_long");
    expect(failureCategory({ detail: "boom" })).toBeUndefined();
  });

  it("failureHint: a refusal of any name or a bad request says start over; a missing model is configuration; an unknown cause is one more try", () => {
    const startOver = "resuming it will likely fail again";
    expect(failureHint("some_new_refusal", true)).toContain(startOver);
    expect(failureHint("invalid_request")).toContain(startOver);
    expect(failureHint("prompt_too_long")).toContain(startOver);
    expect(failureHint("model_not_found")).toContain("configuration");
    expect(failureHint("model_not_found")).not.toContain(startOver);
    expect(failureHint("something_else")).toContain("one more try");
    expect(classifyFailure({ detail: '{"api_refusal_category":"cyber"}' })).toEqual({ category: "cyber", refused: true });
  });

  it("a failing task's model is missing: the note says change the model, not start over", async () => {
    const h = harness({}, () => ({ ok: false, failure: { errorKind: "model_not_found" } }));
    h.service.start();
    spawn(h);
    await flush();
    const [note] = notices(h, "dm:owner");
    expect(note).toContain("Failure category: model_not_found");
    expect(note).not.toContain("resuming it will likely fail again");
    h.service.stop();
  });

  it("a group's task: the note goes to that group's session, never the owner's DM or a chat", async () => {
    const h = harness();
    h.service.start();
    spawn(h, "telegram:-100777");
    await flush();
    expect(notices(h, "telegram:-100777").filter((n) => n.includes("no progress"))).toHaveLength(1);
    expect(h.notes.get("dm:owner") ?? []).toEqual([]);
    expect(h.messageWakes).toEqual(["telegram:-100777"]);
    expect(h.chat).toEqual([]);
    expect(h.dm).toEqual([]);
    h.service.stop();
  });

  it("a note that cannot be saved is taken back and the notice goes to the chat instead: never lost", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    await flush();
    // The next notice's write fails.
    h.notes.clear(); h.disk.clear(); h.messageWakes = [];
    h.noteWriteFails = 1;
    h.store.update(t.id, (r) => { for (let i = 0; i < PENDING_INPUT_MAX; i++) appendInput(r, `x${i}`, HARNESS); });
    h.service.onCronFire(t.sessionKey, "check");
    await flush();
    expect(notices(h, "dm:owner")).toEqual([]);
    expect(h.chat.filter((c) => c.text.includes("A scheduled check-back was dropped"))).toHaveLength(1);
    h.service.stop();
  });

  it("two check-backs dropped are two notes: each notice is its own event", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    await flush();
    h.store.update(t.id, (r) => { for (let i = 0; i < PENDING_INPUT_MAX; i++) appendInput(r, `x${i}`, HARNESS); });
    h.service.onCronFire(t.sessionKey, "check");
    h.service.onCronFire(t.sessionKey, "check");
    await flush();
    expect(notices(h, "dm:owner").filter((n) => n.includes("check-back was dropped"))).toHaveLength(2);
    expect(h.chat).toEqual([]);
    h.service.stop();
  });

  it("a notice about the list said again at the next start, while the first is unread, is not handed over twice", async () => {
    writeFileSync(join(dir, "subsessions.json"), "{ not json");
    const shared = { disk: new Map<string, string[]>(), sdk: new Set<string>() };
    const first = harness({}, noTool, shared);
    first.service.start();
    await flush();
    first.service.stop();
    const second = harness({}, noTool, shared);
    second.service.start();
    await flush();
    expect(notices(second, "dm:owner").filter((n) => n.includes("could not read its sub-session list"))).toHaveLength(1);
    expect(second.messageWakes).toContain("dm:owner");
    expect(second.dm).toEqual([]);
    second.service.stop();
  });

  it("an unread notice note on disk is woken for again after a restart", async () => {
    const shared = { disk: new Map<string, string[]>(), sdk: new Set<string>() };
    const first = harness({}, noTool, shared);
    first.service.start();
    spawn(first);
    await flush();
    first.service.stop();
    expect((shared.disk.get("dm:owner") ?? []).filter(isNotice)).toHaveLength(1);
    const second = harness({}, noTool, shared);
    second.service.start();
    await flush();
    expect(second.messageWakes).toContain("dm:owner");
    expect(notices(second, "dm:owner")).toHaveLength(1);
    second.service.stop();
  });
});

describe("notices about the sub-session list itself", () => {
  it("an unreadable list: via-main hands it to the owner's main session", async () => {
    writeFileSync(join(dir, "subsessions.json"), "{ not json");
    const h = harness();
    h.service.start();
    await flush();
    expect(notices(h, "dm:owner").filter((n) => n.includes("could not read its sub-session list"))).toHaveLength(1);
    expect(h.messageWakes).toEqual(["dm:owner"]);
    expect(h.dm).toEqual([]);
    h.service.stop();
  });

  it("an unreadable list: direct sends it to the owner's DM", async () => {
    writeFileSync(join(dir, "subsessions.json"), "{ not json");
    const h = harness({ ownerMessages: "direct" });
    h.service.start();
    await flush();
    expect(h.dm.filter((t) => t.includes("could not read its sub-session list"))).toHaveLength(1);
    expect(allNoticeKeys(h)).toEqual([]);
    h.service.stop();
  });

  it("an unreadable session registry stays a direct DM: the main session could not load its own conversation either", async () => {
    const h = harness();
    seedActive(h);
    h.registryReadable = false;
    h.service.start();
    await flush();
    expect(h.dm.filter((t) => t.includes("can't read its session list"))).toHaveLength(1);
    expect(allNoticeKeys(h)).toEqual([]);
    h.service.stop();
  });
});
