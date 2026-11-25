import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBSESSIONS } from "../src/config.js";
import { ASK_FORWARD_GRACE_MS, CUSTODY_RETRY_MS, MAX_PENDING_NOTICES, SubsessionService, type ScopeSendResult, type TaskTurnOutcome } from "../src/agent/subsessions/service.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { buildTaskOwnerTools, buildTaskSelfTools } from "../src/mcp/subsession-tools.js";

/**
 * task_notify and task_ask go to the owning session first (a hand-off turn
 * there decides what the owner hears); task_reply stays direct.
 */

type Turn = { key: string; prompt: string };

interface Harness {
  service: SubsessionService;
  store: SubsessionStore;
  turns: Turn[];
  notes: Map<string, string[]>;
  sent: Array<{ parentKey: string; text: string }>;
  handOffs: string[];
  wakes: string[];
  onTurn: (turn: Turn, h: Harness) => TaskTurnOutcome | Promise<TaskTurnOutcome>;
  noteWriteFails: number;
  noteThrows: number;
  persistFails: number;
  sendGate?: Promise<boolean>;
  sendFails: number;
  nextId: number;
  now: number;
}

let dir = "";
let path = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-subhandoff-"));
  path = join(dir, "subsessions.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
}

function harness(opts: { handOff?: boolean; store?: SubsessionStore; notes?: Map<string, string[]> } = {}): Harness {
  const store = opts.store ?? new SubsessionStore(path, { strictTransitions: true });
  const h = {
    store,
    turns: [],
    notes: opts.notes ?? new Map<string, string[]>(),
    sent: [],
    handOffs: [],
    wakes: [],
    onTurn: () => new Promise<TaskTurnOutcome>(() => {}),
    noteWriteFails: 0,
    noteThrows: 0,
    persistFails: 0,
    sendFails: 0,
    nextId: 100,
    now: 1_000_000,
  } as unknown as Harness;
  h.service = new SubsessionService({
    store,
    config: () => ({ ...DEFAULT_SUBSESSIONS, enabled: true }),
    runTaskTurn: async (key, prompt) => {
      const turn = { key, prompt };
      h.turns.push(turn);
      await new Promise((r) => setImmediate(r));
      return h.onTurn(turn, h);
    },
    sendToScope: async (parentKey, text): Promise<ScopeSendResult> => {
      if (h.sendGate && !(await h.sendGate)) return { ok: false, error: "channel down" };
      if (h.sendFails > 0) { h.sendFails -= 1; return { ok: false, error: "channel down" }; }
      h.sent.push({ parentKey, text });
      return { ok: true, channel: "telegram", messageIds: [String(h.nextId++)] };
    },
    noticeToScope: async () => {},
    noticeOwner: async () => {},
    queuePendingNote: (key, note) => {
      if (h.noteThrows > 0) { h.noteThrows -= 1; throw new Error("disk full"); }
      if (h.noteWriteFails > 0) { h.noteWriteFails -= 1; h.notes.set(key, [...(h.notes.get(key) ?? []), note]); return false; }
      h.notes.set(key, [...(h.notes.get(key) ?? []), note]);
      return true;
    },
    hasPendingNote: (key, pred) => (h.notes.get(key) ?? []).some(pred),
    persistPendingNotes: () => {
      if (h.persistFails > 0) { h.persistFails -= 1; return false; }
      return true;
    },
    wakeScope: (parentKey) => { h.wakes.push(parentKey); },
    contextUsage: () => undefined,
    cronJobCount: () => 0,
    removeCronJobs: () => {},
    stopSession: async () => {},
    registryReadable: () => true,
    hasSdkSession: () => true,
    ensureRegistryEntry: () => {},
    unlinkRegistryEntry: () => {},
    registryTaskKeys: () => [],
    isStopping: () => false,
    now: () => h.now,
    ...(opts.handOff === false ? {} : { handOffWake: (parentKey: string) => { h.handOffs.push(parentKey); } }),
  });
  return h;
}

const spawn = (h: Harness, parentKey = "dm:owner") => {
  const r = h.service.spawn(parentKey, { title: "Fix it", brief: "b" });
  if (!r.ok) throw new Error(r.error);
  return r.record;
};

/** Start a task whose first turn asks `question` and then never settles. */
async function askingTask(h: Harness, question: string, parentKey = "dm:owner") {
  let result: Awaited<ReturnType<SubsessionService["ask"]>> | undefined;
  h.onTurn = async (turn) => {
    result = await h.service.ask(turn.key, question);
    return new Promise(() => {});
  };
  h.service.start();
  const t = spawn(h, parentKey);
  await flush();
  return { t, result: () => result };
}

describe("task_notify goes to the owning session", () => {
  it("hands the notice over as a note and wakes the owning session; nothing reaches the owner's chat", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(await h.service.notify(t.sessionKey, "  CI is green, PR #12 ready.  ")).toEqual({ ok: true, via: "main" });
    expect(h.sent).toEqual([]);
    const note = h.notes.get("dm:owner")!.find((n) => n.includes('<tomo-event type="subsession-notice"'));
    expect(note).toContain("CI is green, PR #12 ready.");
    expect(note).toContain('Sub-session s1 ("Fix it")');
    // The note carries its own instructions: a turn that takes it may not be the hand-off turn.
    expect(note).toContain("Nothing reaches them unless you send it.");
    expect(h.handOffs).toEqual(["dm:owner"]);
    const handOff = h.service.handOffFor("dm:owner")!;
    expect(handOff.prompt).toContain('<tomo-event type="subsession-handoff"');
    expect(handOff.prompt).toContain("subsession-notice");
    expect(handOff.asks).toEqual([]);
    expect(h.store.get(t.id)!.sent.at(-1)).toMatchObject({ kind: "notify", text: "CI is green, PR #12 ready.", via: "main" });
    // Not in the owner ↔ task conversation: the owner has not seen it.
    expect(h.store.get(t.id)!.conversation).toEqual([]);
  });

  it("a notice whose note could not be written is held on the record until the note is on disk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      h.service.start();
      const t = spawn(h);
      await flush();
      h.noteWriteFails = 1;
      h.persistFails = 1;
      expect(await h.service.notify(t.sessionKey, "the status")).toEqual({ ok: true, via: "main" });
      expect(h.store.get(t.id)!.unsavedNotices).toEqual([{ at: h.now, text: "the status" }]);
      vi.advanceTimersByTime(CUSTODY_RETRY_MS);
      // The write failed again: still held.
      expect(h.store.get(t.id)!.unsavedNotices).toHaveLength(1);
      vi.advanceTimersByTime(CUSTODY_RETRY_MS);
      expect(h.store.get(t.id)!.unsavedNotices).toBeUndefined();
      // Queued once: no duplicate.
      expect(h.notes.get("dm:owner")!.filter((x) => x.includes("the status"))).toHaveLength(1);
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a held notice whose note died with the process is queued again after a restart", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    await flush();
    h.noteWriteFails = 1;
    expect((await h.service.notify(t.sessionKey, "the status")).ok).toBe(true);
    h.service.stop();
    // A new process: the notes in memory are gone, the record is on disk.
    const h2 = harness({ store: new SubsessionStore(path, { strictTransitions: true }) });
    h2.service.recoverAtStartup();
    h2.service.start();
    await flush();
    expect(h2.notes.get("dm:owner")!.filter((x) => x.includes("the status"))).toHaveLength(1);
    expect(h2.store.get(t.id)!.unsavedNotices).toBeUndefined();
    expect(h2.handOffs).toContain("dm:owner");
  });

  it("refuses when the record cannot hold the notice, and the turn keeps what it carried", async () => {
    const h = harness();
    let n = 0;
    h.onTurn = async (turn, hh) => {
      n += 1;
      if (n === 1) { hh.service.noteToolUse(turn.key); hh.store.transition("s1", "stuck"); return { ok: true }; }
      if (n === 2) {
        const update = hh.store.update.bind(hh.store);
        hh.store.update = (() => { hh.store.update = update; throw new Error("disk full"); }) as SubsessionStore["update"];
        expect((await hh.service.notify(turn.key, "the status")).ok).toBe(false);
        expect(hh.notes.get("dm:owner")?.some((x) => x.includes("subsession-notice")) ?? false).toBe(false);
        hh.service.noteToolUse(turn.key);
        return { ok: true };
      }
      await hh.service.notify(turn.key, "the status");
      hh.service.finish(turn.key, "done");
      return { ok: true };
    };
    h.service.start();
    const t = spawn(h);
    await flush();
    h.service.relay(t.id, "what is the status?");
    await flush();
    expect(h.turns).toHaveLength(3);
    expect(h.turns[2].prompt).toContain("what is the status?");
    expect(h.turns[2].prompt).toContain('name="answer"');
    expect(h.store.get(t.id)).toMatchObject({ status: "finished", pendingInput: [] });
  });

  it("in a turn that answers the owner's message, it goes straight to the owner like task_reply", async () => {
    const h = harness();
    let n = 0;
    let result: Awaited<ReturnType<SubsessionService["notify"]>> | undefined;
    h.onTurn = async (turn, hh) => {
      n += 1;
      if (n === 1) { hh.service.noteToolUse(turn.key); hh.store.transition("s1", "stuck"); return { ok: true }; }
      result = await hh.service.notify(turn.key, "It is at step 3.");
      hh.service.noteToolUse(turn.key);
      hh.store.transition("s1", "stuck");
      return { ok: true };
    };
    h.service.start();
    const t = spawn(h);
    await flush();
    expect(h.service.ownerMessage("dm:owner", t.id, "how far along?").ok).toBe(true);
    await flush();
    expect(result).toEqual({ ok: true, via: "direct" });
    expect(h.sent).toEqual([{ parentKey: "dm:owner", text: "[s1 · Fix it] It is at step 3." }]);
    expect(h.notes.get("dm:owner")?.some((x) => x.includes("subsession-notice")) ?? false).toBe(false);
  });

  it("refuses past the cap of unread notices from one task", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    await flush();
    for (let i = 0; i < MAX_PENDING_NOTICES; i++) expect((await h.service.notify(t.sessionKey, `n${i}`)).ok).toBe(true);
    const over = await h.service.notify(t.sessionKey, "one more");
    expect(over.ok).toBe(false);
    expect(over.error).toContain("not read");
  });

  it("goes to a group-owned task's own scope", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h, "telegram:-100123");
    await flush();
    await h.service.notify(t.sessionKey, "done");
    expect(h.notes.get("telegram:-100123")?.some((n) => n.includes("subsession-notice"))).toBe(true);
    expect(h.notes.has("dm:owner")).toBe(false);
    expect(h.handOffs).toEqual(["telegram:-100123"]);
  });

  it("without a hand-off turn, still wakes the owning session for the notice", async () => {
    const h = harness({ handOff: false });
    h.service.start();
    const t = spawn(h);
    await flush();
    await h.service.notify(t.sessionKey, "done");
    expect(h.sent).toEqual([]);
    expect(h.wakes).toEqual(["dm:owner"]);
  });
});

describe("task_reply stays direct", () => {
  it("sends the answer straight to the owner's chat, with the prefix", async () => {
    const h = harness();
    h.service.start();
    const t = spawn(h);
    await flush();
    expect((await h.service.reply(t.sessionKey, "Merged.")).ok).toBe(true);
    expect(h.sent).toEqual([{ parentKey: "dm:owner", text: "[s1 · Fix it] Merged." }]);
    expect(h.handOffs).toEqual([]);
    expect(h.notes.get("dm:owner") ?? []).not.toContainEqual(expect.stringContaining("subsession-notice"));
  });
});

describe("task_ask goes through the owning session, word for word", () => {
  it("waits for the owner at once, sends nothing itself, and shows the question verbatim to the hand-off turn", async () => {
    const h = harness();
    const question = "Merge PR #12?\n- yes: merge and deploy\n- no: leave it open";
    const { t, result } = await askingTask(h, question);
    expect(result()).toEqual({ ok: true, via: "main" });
    expect(h.store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "owner", pendingAsk: { text: question } });
    expect(h.sent).toEqual([]);
    expect(h.handOffs).toEqual(["dm:owner"]);
    const handOff = h.service.handOffFor("dm:owner")!;
    expect(handOff.asks).toEqual([{ id: "s1", at: h.store.get(t.id)!.pendingAsk!.at }]);
    expect(handOff.prompt).toContain("task_forward_question");
    expect(handOff.prompt).toContain("> Merge PR #12?\n> - yes: merge and deploy\n> - no: leave it open");
  });

  it("task_forward_question sends it word for word with the prefix, once, and the owner's reply to it routes back as their words", async () => {
    const h = harness();
    const { t } = await askingTask(h, "Merge PR #12?");
    const owner = buildTaskOwnerTools({ service: () => h.service, scope: () => "dm:owner" });
    const forward = owner.find((x) => x.name === "task_forward_question")!;
    const out = await forward.handler({ id: "s1" } as never, undefined as never) as { content: Array<{ text: string }>; isError?: boolean };
    expect(out.isError).toBeUndefined();
    expect(h.sent).toEqual([{ parentKey: "dm:owner", text: "[s1 · Fix it] Merge PR #12?" }]);
    const again = await forward.handler({ id: "s1" } as never, undefined as never) as { content: Array<{ text: string }> };
    expect(again.content[0].text).toContain("already forwarded");
    expect(h.sent).toHaveLength(1);
    const record = h.store.get(t.id)!;
    expect(record.pendingAsk?.forwardedAt).toBeDefined();
    expect(record.conversation.at(-1)).toMatchObject({ from: "task", kind: "ask", text: "Merge PR #12?" });
    // Nothing left for the fallback.
    await h.service.afterHandOff("dm:owner", [{ id: "s1", at: record.pendingAsk!.at }]);
    expect(h.sent).toHaveLength(1);
    expect(h.service.handOffFor("dm:owner")).toBeUndefined();
    // The owner replies to the forwarded message: their own words, to the task.
    const messageId = record.replyMap.at(-1)!.messageId;
    expect(h.service.taskForReply("dm:owner", "telegram", messageId)?.id).toBe("s1");
    expect(h.service.ownerMessage("dm:owner", "s1", "yes, merge it").ok).toBe(true);
    const after = h.store.get(t.id)!;
    expect(after.status).toBe("active");
    expect(after.pendingAsk).toBeUndefined();
    expect(after.pendingInput.map((i) => i.text).join("\n")).toContain('<tomo-event type="subsession-owner-message"');
  });

  it("an owner message that ends the wait before the question went out tells the task its question was never forwarded", async () => {
    const h = harness();
    const { t } = await askingTask(h, "Merge PR #12?");
    expect(h.service.ownerMessage("dm:owner", t.id, "also, rename the branch").ok).toBe(true);
    const after = h.store.get(t.id)!;
    expect(after.pendingAsk).toBeUndefined();
    const input = after.pendingInput.map((i) => i.text).join("\n");
    expect(input).toContain("had not been forwarded to the owner");
    expect(input).toContain("> Merge PR #12?");
  });

  it("a forward whose record write failed after the send is not sent again", async () => {
    const h = harness();
    await askingTask(h, "Merge PR #12?");
    const update = h.store.update.bind(h.store);
    let fail = 1;
    h.store.update = ((...args: Parameters<SubsessionStore["update"]>) => {
      if (fail > 0) { fail -= 1; throw new Error("disk full"); }
      return update(...args);
    }) as SubsessionStore["update"];
    const asks = h.service.handOffFor("dm:owner")!.asks;
    await h.service.afterHandOff("dm:owner", asks);
    await h.service.afterHandOff("dm:owner", asks);
    expect(h.sent).toHaveLength(1);
    expect(h.service.handOffFor("dm:owner")).toBeUndefined();
    // The owner's reply to it routes to the task before the write is retried…
    const messageId = String(h.nextId - 1);
    expect(h.store.get("s1")!.replyMap).toEqual([]);
    expect(h.service.taskForReply("dm:owner", "telegram", messageId)?.id).toBe("s1");
    // …and the kept write lands (here: the last try on stop), forward mark and all.
    h.service.stop();
    const record = h.store.get("s1")!;
    expect(record.replyMap.map((m) => m.messageId)).toEqual([messageId]);
    expect(record.pendingAsk?.forwardedAt).toBeDefined();
  });

  it("a wake while the question is being forwarded tells the task once the send settles: it reached the owner", async () => {
    const h = harness();
    const { t } = await askingTask(h, "Merge PR #12?");
    let open!: (ok: boolean) => void;
    h.sendGate = new Promise<boolean>((r) => { open = r; });
    const forward = h.service.afterHandOff("dm:owner", h.service.handOffFor("dm:owner")!.asks);
    await flush();
    expect(h.service.ownerMessage("dm:owner", t.id, "also, rename the branch").ok).toBe(true);
    // Not guessed while the send is pending.
    expect(h.store.get(t.id)!.pendingInput.map((i) => i.text).join("\n")).not.toContain("question");
    open(true);
    await forward;
    await flush();
    const input = h.store.get(t.id)!.pendingInput.map((i) => i.text).join("\n");
    expect(input).toContain("reached the owner after all");
    expect(input).not.toContain("not shown");
    // Their reply to it still comes back to the task.
    expect(h.service.taskForReply("dm:owner", "telegram", String(h.nextId - 1))?.id).toBe("s1");
  });

  it("a wake while the question is being forwarded tells the task once the send settles: it failed", async () => {
    const h = harness();
    const { t } = await askingTask(h, "Merge PR #12?");
    let open!: (ok: boolean) => void;
    h.sendGate = new Promise<boolean>((r) => { open = r; });
    const forward = h.service.afterHandOff("dm:owner", h.service.handOffFor("dm:owner")!.asks);
    await flush();
    expect(h.service.ownerMessage("dm:owner", t.id, "also, rename the branch").ok).toBe(true);
    open(false);
    await forward;
    await flush();
    const input = h.store.get(t.id)!.pendingInput.map((i) => i.text).join("\n");
    expect(input).toContain("was not shown to the owner");
    expect(h.sent).toEqual([]);
  });

  it("another scope cannot forward it", async () => {
    const h = harness();
    await askingTask(h, "Merge?");
    const group = buildTaskOwnerTools({ service: () => h.service, scope: () => "telegram:-1" });
    const out = await group.find((x) => x.name === "task_forward_question")!.handler({ id: "s1" } as never, undefined as never) as { isError?: boolean };
    expect(out.isError).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it("the harness forwards it when the hand-off turn did not", async () => {
    const h = harness();
    await askingTask(h, "Which branch?");
    const handOff = h.service.handOffFor("dm:owner")!;
    await h.service.afterHandOff("dm:owner", handOff.asks);
    expect(h.sent).toEqual([{ parentKey: "dm:owner", text: "[s1 · Fix it] Which branch?" }]);
  });

  it("a question that never got forwarded (failed send, no turn) goes out from the periodic check after the grace", async () => {
    const h = harness();
    await askingTask(h, "Which branch?");
    h.sendFails = 1;
    await h.service.afterHandOff("dm:owner", h.service.handOffFor("dm:owner")!.asks);
    expect(h.sent).toEqual([]);
    const check = () => (h.service as unknown as { forwardOverdueQuestions(): void }).forwardOverdueQuestions();
    check();
    await flush();
    expect(h.sent).toEqual([]);
    h.now += ASK_FORWARD_GRACE_MS;
    check();
    await flush();
    expect(h.sent.map((m) => m.text)).toEqual(["[s1 · Fix it] Which branch?"]);
  });

  it("a waiting question survives a restart and gets a hand-off turn again", async () => {
    const h = harness();
    // A turn that asks and completes (one cut short is run again after a restart instead).
    h.onTurn = async (turn, hh) => { hh.service.noteToolUse(turn.key); await hh.service.ask(turn.key, "Which branch?"); return { ok: true }; };
    h.service.start();
    spawn(h);
    await flush();
    expect(h.store.get("s1")).toMatchObject({ status: "waiting", waitingOn: "owner" });
    h.service.stop();
    const h2 = harness({ store: new SubsessionStore(path, { strictTransitions: true }) });
    h2.service.start();
    await flush();
    expect(h2.store.get("s1")).toMatchObject({ status: "waiting", waitingOn: "owner", pendingAsk: { text: "Which branch?" } });
    expect(h2.handOffs).toEqual(["dm:owner"]);
  });

  it("with input pending that the turn does not carry, the task does not wait and the question goes straight out", async () => {
    const h = harness();
    let result: Awaited<ReturnType<SubsessionService["ask"]>> | undefined;
    h.onTurn = async (turn, hh) => {
      hh.service.relay("s1", "a later thought");
      result = await hh.service.ask(turn.key, "Merge it?");
      return new Promise(() => {});
    };
    h.service.start();
    spawn(h);
    await flush();
    expect(result).toEqual({ ok: true, via: "direct" });
    expect(h.sent.map((m) => m.text)).toEqual(["[s1 · Fix it] Merge it?"]);
    expect(h.store.get("s1")).toMatchObject({ status: "active" });
    expect(h.store.get("s1")!.pendingAsk).toBeUndefined();
  });

  it("a group-owned task's hand-off turn is told the harness forwards (it has no forward tool)", async () => {
    const h = harness();
    await askingTask(h, "Which branch?", "telegram:-100123");
    const handOff = h.service.handOffFor("telegram:-100123")!;
    expect(handOff.prompt).not.toContain("task_forward_question");
    expect(handOff.prompt).toContain("The harness forwards each question");
  });

  it("the task's tool result says where the question went", async () => {
    const h = harness();
    let text = "";
    h.onTurn = async (turn) => {
      const self = buildTaskSelfTools({ service: () => h.service, key: turn.key });
      const out = await self.find((x) => x.name === "task_ask")!.handler({ question: "Merge?" } as never, undefined as never) as { content: Array<{ text: string }> };
      text = out.content[0].text;
      return new Promise(() => {});
    };
    h.service.start();
    spawn(h);
    await flush();
    expect(text).toContain("main session passes your question to the owner word for word");
  });
});

describe("the stored question", () => {
  it("is dropped by any transition out of waiting(owner), and on load from a record that is not waiting", async () => {
    const store = new SubsessionStore(path, { strictTransitions: true });
    const t = store.create({ parentKey: "dm:owner", title: "x", brief: "b" });
    store.transition(t.id, "start");
    store.transition(t.id, "ask", { patch: (r) => { r.pendingAsk = { at: 1, text: "q" }; } });
    expect(new SubsessionStore(path).get(t.id)?.pendingAsk).toEqual({ at: 1, text: "q" });
    store.transition(t.id, "relay", { patch: () => {} });
    expect(store.get(t.id)?.pendingAsk).toBeUndefined();
  });
});
