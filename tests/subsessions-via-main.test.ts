import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBSESSIONS, type SubsessionConfig } from "../src/config.js";
import { ENDED_KEEP_MS, MESSAGE_NOTE_MARKER, SETTLE_RETRY_MS, SubsessionService, type TaskTurnOutcome } from "../src/agent/subsessions/service.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { buildSubsessionPrompt } from "../src/agent/subsessions/prompt.js";

// ---------------------------------------------------------------------------
// subsessions.ownerMessages: a task's task_reply / task_notify / task_ask go
// to the owning session first ("via-main", the default), except an answer to
// a message the owner wrote in the web task panel; "direct" sends them
// straight to the owner's chat, as before.
// ---------------------------------------------------------------------------

type OnTurn = (key: string, prompt: string, h: H) => TaskTurnOutcome | Promise<TaskTurnOutcome>;

interface H {
  service: SubsessionService;
  store: SubsessionStore;
  cfg: SubsessionConfig;
  prompts: Array<{ key: string; prompt: string }>;
  /** Pending notes per session, as the real queue holds them (memory). */
  notes: Map<string, string[]>;
  /** What is on disk per session. */
  disk: Map<string, string[]>;
  sent: Array<{ parentKey: string; text: string }>;
  messageWakes: string[];
  /** The next N note writes fail (the note stays in memory, like the real queue). */
  noteWriteFails: number;
  /** Runs inside a note write (to land something in that window). */
  duringNoteWrite?: () => void;
  onTurn: OnTurn;
}

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-viamain-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Let the drivers run to quiet (generous: the full suite runs under load). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 30; j++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 1));
  }
}

function harness(cfg: Partial<SubsessionConfig> = {}, onTurn: OnTurn = () => ({ ok: true }), shared?: { disk: Map<string, string[]>; sdk?: Set<string> }): H {
  const store = new SubsessionStore(join(dir, "subsessions.json"), { strictTransitions: true });
  const h: H = {
    store,
    cfg: { ...DEFAULT_SUBSESSIONS, enabled: true, ...cfg },
    prompts: [],
    notes: new Map(),
    disk: shared?.disk ?? new Map(),
    sent: [],
    messageWakes: [],
    noteWriteFails: 0,
    onTurn,
  } as unknown as H;
  // A fresh process reads the notes from disk.
  for (const [k, v] of h.disk) h.notes.set(k, [...v]);
  // The registry and SDK sessions outlive a restart when shared.
  const sdk = shared?.sdk ?? new Set<string>();
  const registry = sdk;
  h.service = new SubsessionService({
    store,
    config: () => h.cfg,
    runTaskTurn: async (key, prompt) => {
      h.prompts.push({ key, prompt });
      sdk.add(key);
      await new Promise((r) => setImmediate(r));
      return h.onTurn(key, prompt, h);
    },
    sendToScope: async (parentKey, text) => { h.sent.push({ parentKey, text }); return { ok: true }; },
    noticeToScope: async () => {},
    noticeOwner: async () => {},
    queuePendingNote: (key, note) => {
      h.notes.set(key, [...(h.notes.get(key) ?? []), note]);
      h.duringNoteWrite?.();
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
    registryReadable: () => true,
    hasSdkSession: (key) => sdk.has(key) || registry.has(key),
    ensureRegistryEntry: (key) => { registry.add(key); },
    unlinkRegistryEntry: (key) => { registry.delete(key); },
    registryTaskKeys: () => [...registry],
    isStopping: () => false,
  });
  return h;
}

function spawn(h: H, parentKey = "dm:owner") {
  const r = h.service.spawn(parentKey, { title: "Fix CI", brief: "b" });
  if (!r.ok) throw new Error(r.error);
  return r.record;
}

const messageNotes = (h: H, key: string) => (h.notes.get(key) ?? []).filter((n) => n.includes(MESSAGE_NOTE_MARKER));

/** A first turn that says `what` through the given tool, then finishes nothing (waits on the owner after). */
function sayOnFirstTurn(tool: "notify" | "ask", text: string): OnTurn {
  let n = 0;
  return async (key, _prompt, h) => {
    n += 1;
    h.service.noteToolUse(key);
    if (n === 1) {
      if (tool === "notify") await h.service.notify(key, text);
      else await h.service.ask(key, text);
    }
    if (n === 2 && tool === "notify") h.service.finish(key, "done");
    return { ok: true };
  };
}

describe("subsessions.ownerMessages", () => {
  it("defaults to via-main (file parsing: config-sections.test.ts)", () => {
    expect(DEFAULT_SUBSESSIONS.ownerMessages).toBe("via-main");
  });

  it("tells the task where its words go, by mode", () => {
    const viaMain = buildSubsessionPrompt({ agentName: "T", ownerName: "O" });
    expect(viaMain).toContain("goes to the main session first");
    expect(viaMain).toContain("stays in that panel");
    const direct = buildSubsessionPrompt({ agentName: "T", ownerName: "O", ownerMessages: "direct" });
    expect(direct).not.toContain("main session first");
    expect(direct).toContain("The owner only sees what you send through these tools");
  });
});

describe("via-main (default): a task's words go to the owning session first", () => {
  it("task_notify becomes a pinned note to the owning session, labeled and in full, plus a wake; nothing goes to the owner's chat", async () => {
    const h = harness({}, sayOnFirstTurn("notify", "CI is green, PR #12 ready"));
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.sent).toEqual([]);
    const notes = messageNotes(h, "dm:owner");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`Sub-session ${t.id} ("Fix CI")`);
    expect(notes[0]).toContain("CI is green, PR #12 ready");
    expect(notes[0]).toContain("task_notify");
    expect(h.disk.get("dm:owner")).toEqual(h.notes.get("dm:owner"));
    expect(h.messageWakes).toContain("dm:owner");
    const r = h.store.get(t.id)!;
    expect(r.sent.at(-1)).toMatchObject({ kind: "notify", via: "main", text: "CI is green, PR #12 ready" });
    // Logged for the panel, but not shown to the session a second time through the mirror.
    expect(r.conversation.at(-1)).toMatchObject({ from: "task", kind: "notify", noted: true });
    expect(h.service.mirrorNote("dm:owner")).toBeUndefined();
  });

  it("task_reply to the owner's /s message goes to the owning session too, not to the owner's chat", async () => {
    const h = harness({}, async (key, prompt, hh) => {
      if (prompt.includes("subsession-owner-message")) await hh.service.reply(key, "yes, it's the flaky test");
      // (no tool call: three such turns park it in waiting(owner))
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.notes.clear();
    h.messageWakes = [];
    expect(h.service.ownerMessage("dm:owner", t.id, "is it the flaky test?").ok).toBe(true);
    await flush();
    expect(h.sent).toEqual([]);
    const notes = messageNotes(h, "dm:owner");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("answers the owner's message");
    expect(notes[0]).toContain("yes, it's the flaky test");
    expect(h.messageWakes).toEqual(["dm:owner"]);
    expect(h.store.get(t.id)!.sent.at(-1)).toMatchObject({ kind: "reply", via: "main" });
    // The owner's own words are still mirrored; the task's answer is in the note.
    const mirror = h.service.mirrorNote("dm:owner")!.text;
    expect(mirror).toContain("is it the flaky test?");
    expect(mirror).not.toContain("yes, it's the flaky test");
  });

  it("a group-owned task's words go to that group's session, never to the owner's DM", async () => {
    const h = harness({}, sayOnFirstTurn("notify", "group-only news"));
    h.service.start();
    spawn(h, "telegram:-100777");
    await flush();
    expect(messageNotes(h, "telegram:-100777")).toHaveLength(1);
    expect(messageNotes(h, "telegram:-100777")[0]).toContain("group-only news");
    expect([...h.notes.keys()].filter((k) => k !== "telegram:-100777").flatMap((k) => h.notes.get(k)!)).toEqual([]);
    expect(h.messageWakes).toEqual(["telegram:-100777"]);
    expect(h.sent).toEqual([]);
  });

  it("an answer to a message the owner wrote in the web task panel stays in the panel; the owning session sees it through the mirror", async () => {
    const h = harness({}, async (key, prompt, hh) => {
      if (prompt.includes("from the panel")) await hh.service.reply(key, "panel answer");
      else if (prompt.includes("from the phone")) await hh.service.reply(key, "phone answer");
      // (no tool call: three such turns park it in waiting(owner))
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.notes.clear();
    h.messageWakes = [];
    expect(h.service.ownerMessage("dm:owner", t.id, "hi from the panel", { messageId: "web:1", source: "panel" }).ok).toBe(true);
    await flush();
    expect(h.sent).toEqual([]);
    expect(messageNotes(h, "dm:owner")).toEqual([]);
    expect(h.messageWakes).toEqual([]);
    const r = h.store.get(t.id)!;
    expect(r.sent.at(-1)).toMatchObject({ kind: "reply", via: "panel", text: "panel answer" });
    expect(r.conversation.at(-1)).toMatchObject({ from: "task", kind: "reply", text: "panel answer" });
    expect(r.conversation.at(-1)!.noted).toBeUndefined();
    const mirror = h.service.mirrorNote("dm:owner")!.text;
    expect(mirror).toContain("hi from the panel");
    expect(mirror).toContain("panel answer");
    // The same owner writing with /s from their phone: back to the main session.
    expect(h.service.ownerMessage("dm:owner", t.id, "hi from the phone").ok).toBe(true);
    await flush();
    expect(messageNotes(h, "dm:owner")).toHaveLength(1);
    expect(messageNotes(h, "dm:owner")[0]).toContain("phone answer");
    expect(h.sent).toEqual([]);
  });

  it("the panel source survives a restart: the input on disk still answers into the panel", () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    h.service.ownerMessage("dm:owner", t.id, "from the panel", { messageId: "web:9", source: "panel" });
    const reread = new SubsessionStore(join(dir, "subsessions.json")).get(t.id)!;
    expect(reread.pendingInput.at(-1)).toMatchObject({ from: "owner", source: "panel" });
  });

  it("direct: task_notify and task_reply go straight to the owner's chat with the prefix, and no note", async () => {
    let n = 0;
    const h = harness({ ownerMessages: "direct" }, async (key, prompt, hh) => {
      n += 1;
      if (n === 1) await hh.service.notify(key, "direct news");
      if (prompt.includes("from the panel")) await hh.service.reply(key, "direct answer");
      if (n === 2) await hh.service.ask(key, "ok?");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.sent.map((s) => s.text)).toEqual([`[${t.id} · Fix CI] direct news`, `[${t.id} · Fix CI] ok?`]);
    h.service.ownerMessage("dm:owner", t.id, "from the panel", { source: "panel" });
    await flush();
    expect(h.sent.at(-1)!.text).toBe(`[${t.id} · Fix CI] direct answer`);
    expect(messageNotes(h, "dm:owner")).toEqual([]);
    expect(h.messageWakes).toEqual([]);
    expect(h.store.get(t.id)!.askViaMain).toBeUndefined();
  });
});

describe("via-main: task_ask round trip", () => {
  it("the question reaches the owning session in full and the task waits; task_message with the answer ends the wait, marked as the owner's answer", async () => {
    let n = 0;
    const h = harness({}, async (key, _prompt, hh) => {
      n += 1;
      hh.service.noteToolUse(key);
      if (n === 1) {
        const asked = await hh.service.ask(key, "Merge now? A) yes B) wait for review");
        expect(asked).toMatchObject({ ok: true, via: "main", waiting: true });
      } else if (n === 2) {
        hh.service.finish(key, "merged");
      }
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.sent).toEqual([]);
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner", askViaMain: { text: "Merge now? A) yes B) wait for review" } });
    const note = messageNotes(h, "dm:owner")[0];
    expect(note).toContain("asks the owner (task_ask)");
    expect(note).toContain("Merge now? A) yes B) wait for review");
    expect(note).toContain(`task_message ${t.id}`);
    // Waiting(owner) is not woken by the harness: only the answer does it.
    expect(h.prompts).toHaveLength(1);
    // The main session asked the owner, who said A; it passes that on.
    const relayed = h.service.relay(t.id, "A, merge it");
    expect(relayed.ok).toBe(true);
    await flush();
    expect(h.prompts).toHaveLength(2);
    const answer = h.prompts[1].prompt;
    expect(answer).toContain("take it as their answer to that question");
    expect(answer).toContain("Merge now? A) yes B) wait for review");
    expect(answer).toContain("A, merge it");
    expect(answer).not.toContain("not the owner's own approval");
    expect(h.store.get(t.id)!.askViaMain).toBeUndefined();
    // A later relay, with no question standing, is a colleague's word again.
    h.service.relay(t.id, "also bump the version");
    await flush();
    expect(h.prompts.at(-1)!.prompt).toContain("not the owner's own approval");
  });

  it("keeps the standing question across a restart, and the answer after it still ends the wait as the owner's answer", async () => {
    const disk = new Map<string, string[]>();
    const sdk = new Set<string>();
    const h = harness({}, sayOnFirstTurn("ask", "Deploy to prod?"), { disk, sdk });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.store.get(t.id)!.askViaMain?.text).toBe("Deploy to prod?");
    h.service.stop();
    // A new process: the note is still on disk, unread; the wake is owed again.
    const h2 = harness({}, (key, _p, hh) => { hh.service.noteToolUse(key); hh.service.finish(key, "deployed"); return { ok: true }; }, { disk, sdk });
    h2.service.start();
    await flush();
    expect(h2.messageWakes).toEqual(["dm:owner"]);
    expect(h2.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner", askViaMain: { text: "Deploy to prod?" } });
    h2.service.relay(t.id, "yes");
    await flush();
    expect(h2.prompts.at(-1)!.prompt).toContain("take it as their answer");
    expect(h2.prompts.at(-1)!.prompt).toContain("Deploy to prod?");
  });

  it("input that lands while the question is being handed over keeps the task from waiting on it (no stale wait)", async () => {
    let n = 0;
    let asked: unknown;
    const h = harness({}, async (key, _p, hh) => {
      n += 1;
      if (n === 1) {
        hh.duringNoteWrite = () => { hh.duringNoteWrite = undefined; hh.service.relay(t.id, "never mind, use main"); };
        asked = await hh.service.ask(key, "which branch?");
      }
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(asked).toMatchObject({ ok: true, via: "main", waiting: false, withdrawn: true });
    // The question was taken back before anything read it, and not logged as sent.
    expect(messageNotes(h, "dm:owner")).toEqual([]);
    expect((h.disk.get("dm:owner") ?? []).filter((x) => x.includes(MESSAGE_NOTE_MARKER))).toEqual([]);
    expect(h.store.get(t.id)!.sent).toEqual([]);
    // Not parked on the question: the relay got its own turn.
    expect(h.prompts.length).toBeGreaterThanOrEqual(2);
    expect(h.prompts[1].prompt).toContain("never mind, use main");
    expect(h.store.get(t.id)!.askViaMain).toBeUndefined();
    expect(h.sent).toEqual([]);
  });
});

describe("via-main: nothing lost, nothing twice", () => {
  it("a note whose write fails is taken back and the task is told: the owner's message stays owed and is answered again, once", async () => {
    const h = harness({}, async (key, prompt, hh) => {
      // (no tool call: three such turns park it in waiting(owner))
      if (prompt.includes("subsession-owner-message")) {
        const r = await hh.service.reply(key, "the answer");
        replies.push(r);
      }
      return { ok: true };
    });
    const replies: unknown[] = [];
    h.service.start();
    const t = spawn(h);
    await flush();
    h.notes.clear();
    h.disk.clear();
    h.messageWakes = [];
    h.noteWriteFails = 1;
    h.service.ownerMessage("dm:owner", t.id, "status?");
    await flush();
    expect(replies[0]).toMatchObject({ ok: false });
    expect(replies.at(-1)).toMatchObject({ ok: true, via: "main" });
    // Exactly one copy in memory and on disk: the failed one was withdrawn.
    expect(messageNotes(h, "dm:owner")).toHaveLength(1);
    expect(h.disk.get("dm:owner")!.filter((x) => x.includes(MESSAGE_NOTE_MARKER))).toHaveLength(1);
    // The owner's message was answered by the second turn and then consumed.
    expect(h.store.get(t.id)!.pendingInput).toEqual([]);
    expect(h.store.get(t.id)!.sent.filter((m) => m.kind === "reply")).toHaveLength(1);
  });

  it("wakes the owning session at start for task messages still unread on disk, and not when there are none", () => {
    const disk = new Map<string, string[]>([["telegram:-100777", ['<tomo-event type="subsession-message" name="s1:1-1" ts="x">hi</tomo-event>']]]);
    const sdk = new Set<string>();
    const h = harness({}, undefined, { disk, sdk });
    h.service.start();
    spawn(h, "telegram:-100777");
    spawn(h, "dm:owner");
    h.service.stop();
    const h2 = harness({}, undefined, { disk, sdk });
    h2.service.start();
    expect(h2.messageWakes).toEqual(["telegram:-100777"]);
  });

  it("the message note is pinned: the pending-notes cap never drops it", async () => {
    const { PendingNotesQueue } = await import("../src/agent/pending-notes-queue.js");
    const saved = new Map<string, string[]>();
    const q = new PendingNotesQueue({ getPendingNotes: (k: string) => saved.get(k) ?? [], setPendingNotes: (k: string, n: string[]) => { saved.set(k, n); } } as never);
    q.queueNote("dm:owner", '<tomo-event type="subsession-message" name="s1:1-1" ts="x">keep me</tomo-event>');
    for (let i = 0; i < 200; i++) q.queueNote("dm:owner", `<tomo-event type="note" name="n${i}" ts="x">filler</tomo-event>`);
    expect(q.peekNotes("dm:owner").some((n) => n.includes("keep me"))).toBe(true);
    // And a withdrawn one is gone from memory and disk.
    const note = '<tomo-event type="subsession-message" name="s1:2-2" ts="x">withdraw me</tomo-event>';
    q.queueNote("dm:owner", note);
    expect(q.withdrawNote("dm:owner", (n) => n.includes('name="s1:2-2"'))).toBe(true);
    expect(q.peekNotes("dm:owner").some((n) => n.includes("withdraw me"))).toBe(false);
    expect(saved.get("dm:owner")!.some((n) => n.includes("withdraw me"))).toBe(false);
  });

  it("the same words handed over again while the first note is unread add no second note (a retried turn)", async () => {
    let n = 0;
    const results: unknown[] = [];
    const h = harness({}, async (key) => {
      n += 1;
      if (n <= 2) {
        results.push(await h.service.notify(key, "PR is up"));
        // The first turn fails after its notify (as a crash would): it runs again.
        if (n === 1) return { ok: false, error: "boom" };
        await h.service.ask(key, "merge?");
      }
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(results).toEqual([{ ok: true, via: "main" }, { ok: true, via: "main" }]);
    expect(messageNotes(h, "dm:owner").filter((x) => x.includes("PR is up"))).toHaveLength(1);
    expect(h.store.get(t.id)!.sent.filter((m) => m.kind === "notify")).toHaveLength(1);
  });

  it("an owner who answers the task directly takes its unread question back from the main session", async () => {
    let n = 0;
    const h = harness({}, async (key) => {
      n += 1;
      if (n === 1) await h.service.ask(key, "Deploy?");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(messageNotes(h, "dm:owner")).toHaveLength(1);
    h.service.ownerMessage("dm:owner", t.id, "yes deploy", { source: "panel" });
    await flush();
    expect(messageNotes(h, "dm:owner")).toEqual([]);
    expect(h.disk.get("dm:owner")!.some((x) => x.includes("Deploy?"))).toBe(false);
  });

  it("a question the main session already read is called off with a note when the wait ends otherwise", async () => {
    let n = 0;
    const h = harness({}, async (key) => {
      n += 1;
      if (n === 1) await h.service.ask(key, "Deploy?");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    // The main session's turn read the note.
    h.notes.set("dm:owner", []);
    await h.service.cancel(t.id, "test");
    const notes = messageNotes(h, "dm:owner");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("no longer waits on its question");
    expect(notes[0]).toContain("Deploy?");
  });

  it("asking a new question while one stands takes the old one back", async () => {
    let n = 0;
    const h = harness({}, async (key) => {
      n += 1;
      if (n === 1) {
        await h.service.ask(key, "First?");
        await h.service.ask(key, "Second?");
      }
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    const notes = messageNotes(h, "dm:owner");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Second?");
    expect(h.store.get(t.id)!.askViaMain?.text).toBe("Second?");
  });

  it("a panel answer with a file goes to the main session, which can send the file", async () => {
    const h = harness({}, async (key, prompt) => {
      if (prompt.includes("subsession-owner-message")) await h.service.reply(key, "here\nMEDIA:/tmp/report.pdf");
      // (no tool call: three such turns park it in waiting(owner))
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.notes.clear();
    h.service.ownerMessage("dm:owner", t.id, "send me the report", { source: "panel" });
    await flush();
    expect(messageNotes(h, "dm:owner")).toHaveLength(1);
    expect(messageNotes(h, "dm:owner")[0]).toContain("MEDIA:/tmp/report.pdf");
    expect(h.store.get(t.id)!.sent.at(-1)).toMatchObject({ kind: "reply", via: "main" });
  });

  it("a retried turn hands over again only what the main session already read, marked as a possible repeat", async () => {
    let tries = 0;
    const seen: string[][] = [];
    const h = harness({}, async (key, prompt) => {
      if (!prompt.includes("subsession-owner-message")) return { ok: true };
      tries += 1;
      await h.service.reply(key, "Yes");
      seen.push(messageNotes(h, "dm:owner").filter((x) => x.includes("Yes")));
      // The first time, the main session reads the note; then the turn fails and runs again.
      if (tries === 1) h.notes.set("dm:owner", []);
      return tries === 1 ? { ok: false, error: "boom" } : { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "ship it?");
    await flush();
    expect(tries).toBe(2);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0][0]).not.toContain("may repeat");
    expect(seen[1]).toHaveLength(1);
    expect(seen[1][0]).toContain("may repeat something it already handed you");
  });

  it("a retried turn's answer while the first note is still unread adds no second note", async () => {
    let tries = 0;
    const h = harness({}, async (key, prompt) => {
      if (!prompt.includes("subsession-owner-message")) return { ok: true };
      tries += 1;
      await h.service.reply(key, "Yes");
      return tries === 1 ? { ok: false, error: "boom" } : { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "ship it?");
    await flush();
    expect(tries).toBe(2);
    expect(messageNotes(h, "dm:owner").filter((x) => x.includes("Yes"))).toHaveLength(1);
  });

  it("a retried turn's same panel answer is shown once", async () => {
    let tries = 0;
    const h = harness({}, async (key, prompt) => {
      if (!prompt.includes("subsession-owner-message")) return { ok: true };
      tries += 1;
      await h.service.reply(key, "panel yes");
      return tries === 1 ? { ok: false, error: "boom" } : { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "ok?", { source: "panel" });
    await flush();
    expect(tries).toBe(2);
    expect(h.store.get(t.id)!.conversation.filter((e) => e.text === "panel yes")).toHaveLength(1);
  });

  it("the same words answering two different messages are two notes", async () => {
    const h = harness({}, async (key, prompt) => {
      if (prompt.includes("subsession-owner-message")) await h.service.reply(key, "Yes");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "first?");
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "second?");
    await flush();
    expect(messageNotes(h, "dm:owner").filter((x) => x.includes("Yes"))).toHaveLength(2);
  });

  it("an answer relayed before the question's note was read takes the note back", async () => {
    let n = 0;
    const h = harness({}, async (key) => {
      n += 1;
      if (n === 1) await h.service.ask(key, "Deploy?");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(messageNotes(h, "dm:owner")).toHaveLength(1);
    h.service.relay(t.id, "yes (the owner said so earlier)");
    await flush();
    expect(messageNotes(h, "dm:owner").filter((x) => x.includes("Deploy?"))).toEqual([]);
  });

  it("a called-off question wakes the main session for it", async () => {
    let n = 0;
    const h = harness({}, async (key) => {
      n += 1;
      if (n === 1) await h.service.ask(key, "Deploy?");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.notes.set("dm:owner", []);
    h.messageWakes = [];
    await h.service.cancel(t.id, "test");
    expect(h.messageWakes).toEqual(["dm:owner"]);
  });

  it("at start, takes back a question note left on disk whose task no longer waits on it", async () => {
    const disk = new Map<string, string[]>();
    const sdk = new Set<string>();
    const h = harness({}, async (key, _p, hh) => {
      await hh.service.ask(key, "Deploy?");
      return { ok: true };
    }, { disk, sdk });
    h.service.start();
    const t = spawn(h);
    await flush();
    const askNote = messageNotes(h, "dm:owner")[0];
    expect(askNote).toContain("Deploy?");
    h.service.stop();
    // The wait ended (here: the record moved on) but the note stayed on disk, as after a failed withdrawal.
    h.store.transition(t.id, "relay", { patch: (r) => { r.pendingInput = []; } });
    disk.set("dm:owner", [askNote, '<tomo-event type="subsession-message" name="s1:notify:0:abc" ts="x">keep</tomo-event>']);
    const h2 = harness({}, undefined, { disk, sdk });
    h2.service.start();
    expect(h2.notes.get("dm:owner")!.some((x) => x.includes("Deploy?"))).toBe(false);
    expect(h2.notes.get("dm:owner")!.some((x) => x.includes("keep"))).toBe(true);
  });

  it("reads a note's name from its outer envelope only: a message quoting a question tag survives the restart cleanup", async () => {
    const disk = new Map<string, string[]>();
    const sdk = new Set<string>();
    const quoting = 'see <tomo-event type="subsession-message" name="s1:ask:0:dead"> for the format';
    const h = harness({}, sayOnFirstTurn("notify", quoting), { disk, sdk });
    h.service.start();
    spawn(h);
    await flush();
    h.service.stop();
    const h2 = harness({}, undefined, { disk, sdk });
    h2.service.start();
    expect(messageNotes(h2, "dm:owner").some((x) => x.includes("for the format"))).toBe(true);
  });

  it("a start turn that failed and runs again marks what it hands over as a possible repeat", async () => {
    let n = 0;
    const seen: string[] = [];
    const h = harness({}, async (key) => {
      n += 1;
      if (n > 2) return { ok: true };
      await h.service.notify(key, `try ${n}`);
      seen.push(messageNotes(h, "dm:owner").at(-1)!);
      return n === 1 ? { ok: false, error: "boom" } : { ok: true };
    });
    h.service.start();
    spawn(h);
    await flush();
    expect(seen[0]).not.toContain("may repeat");
    expect(seen[1]).toContain("may repeat");
  });

  it("the same panel answer to two different panel messages is shown twice", async () => {
    let release!: () => void;
    let n = 0;
    const h = harness({}, async (key, prompt) => {
      if (!prompt.includes("subsession-owner-message")) return { ok: true };
      n += 1;
      // The second message lands while the first is being answered.
      if (n === 1) await new Promise<void>((r) => { release = r; });
      await h.service.reply(key, "done");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "A?", { source: "panel" });
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "B?", { source: "panel" });
    release();
    await flush();
    expect(n).toBe(2);
    expect(h.store.get(t.id)!.conversation.filter((e) => e.from === "task" && e.text === "done")).toHaveLength(2);
  });

  it("a start whose result could not be written runs again, and what it hands over is marked as a possible repeat", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const settle = async () => { for (let i = 0; i < 300; i++) await new Promise((r) => setImmediate(r)); };
    try {
      let n = 0;
      let failNext = false;
      const seen: string[] = [];
      const h = harness({}, async (key) => {
        n += 1;
        if (n > 2) return { ok: true };
        await h.service.notify(key, "PR opened");
        seen.push(messageNotes(h, "dm:owner").at(-1)!);
        h.notes.set("dm:owner", []);
        // The next write is this turn's result: it fails.
        if (n === 1) failNext = true;
        return { ok: true };
      });
      const realUpdate = h.store.update.bind(h.store);
      h.store.update = ((...args: Parameters<typeof realUpdate>) => {
        if (failNext) { failNext = false; throw new Error("disk full"); }
        return realUpdate(...args);
      }) as typeof realUpdate;
      h.service.start();
      spawn(h);
      await settle();
      expect(seen).toHaveLength(1);
      vi.advanceTimersByTime(SETTLE_RETRY_MS);
      await settle();
      expect(seen).toHaveLength(2);
      expect(seen[0]).not.toContain("may repeat");
      expect(seen[1]).toContain("may repeat");
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a retry carrying a newer panel message too shows the repeated answer once and the new answer", async () => {
    let n = 0;
    let release!: () => void;
    const h = harness({}, async (key, prompt) => {
      if (!prompt.includes("subsession-owner-message")) return { ok: true };
      n += 1;
      if (n === 1) {
        await h.service.reply(key, "done");
        // B lands while A's turn runs; then A's turn fails.
        await new Promise<void>((r) => { release = r; });
        return { ok: false, error: "boom" };
      }
      // The retry carries A and B, and answers both the same way.
      await h.service.reply(key, "done");
      await h.service.reply(key, "done");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "A?", { source: "panel" });
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "B?", { source: "panel" });
    release();
    await flush();
    expect(n).toBe(2);
    expect(h.store.get(t.id)!.conversation.filter((e) => e.from === "task" && e.text === "done")).toHaveLength(2);
  });

  it("a retry carrying a newer message too does not hand the earlier answer over again while its note is unread", async () => {
    let n = 0;
    let release!: () => void;
    const h = harness({}, async (key, prompt) => {
      if (!prompt.includes("subsession-owner-message")) return { ok: true };
      n += 1;
      if (n === 1) {
        await h.service.reply(key, "A: yes");
        await new Promise<void>((r) => { release = r; });
        return { ok: false, error: "boom" };
      }
      await h.service.reply(key, "A: yes");
      await h.service.reply(key, "B: no");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "A?");
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "B?");
    release();
    await flush();
    expect(n).toBe(2);
    expect(messageNotes(h, "dm:owner").filter((x) => x.includes("A: yes"))).toHaveLength(1);
    expect(messageNotes(h, "dm:owner").filter((x) => x.includes("B: no"))).toHaveLength(1);
  });

  it("a turn carrying both a phone and a panel message answers through the main session", async () => {
    let release!: () => void;
    let n = 0;
    const h = harness({}, async (key, prompt) => {
      if (!prompt.includes("subsession-owner-message")) return { ok: true };
      n += 1;
      if (n === 1) { await new Promise<void>((r) => { release = r; }); return { ok: true }; }
      await h.service.reply(key, "both answered");
      return { ok: true };
    });
    h.service.start();
    const t = spawn(h);
    await flush();
    // A first message holds a turn; a phone and a panel message then wait together for the next one.
    h.service.ownerMessage("dm:owner", t.id, "hold");
    await flush();
    h.service.ownerMessage("dm:owner", t.id, "from the phone");
    h.service.ownerMessage("dm:owner", t.id, "from the panel", { source: "panel" });
    release();
    await flush();
    expect(h.store.get(t.id)!.sent.at(-1)).toMatchObject({ text: "both answered", via: "main" });
    expect(messageNotes(h, "dm:owner").some((x) => x.includes("both answered"))).toBe(true);
  });

  it("the sweep does not forget an ended task while a message it handed over is unread", async () => {
    const disk = new Map<string, string[]>();
    const sdk = new Set<string>();
    const h = harness({}, sayOnFirstTurn("notify", "LAST WORDS"), { disk, sdk });
    h.service.start();
    const t = spawn(h);
    await flush();
    await h.service.cancel(t.id, "test");
    h.service.stop();
    h.store.update(t.id, (r) => { r.endedAt = Date.now() - ENDED_KEEP_MS - 60_000; });
    // Only the task's message is left unread.
    disk.set("dm:owner", disk.get("dm:owner")!.filter((x) => x.includes("LAST WORDS")));
    expect(disk.get("dm:owner")).toHaveLength(1);
    const h2 = harness({}, undefined, { disk, sdk });
    h2.service.start();
    expect(h2.store.get(t.id)).toBeDefined();
    expect(h2.messageWakes).toEqual(["dm:owner"]);
    // Read: the next sweep forgets it.
    disk.set("dm:owner", []);
    h2.service.stop();
    const h3 = harness({}, undefined, { disk, sdk });
    h3.service.start();
    expect(h3.store.get(t.id)).toBeUndefined();
  });
});
