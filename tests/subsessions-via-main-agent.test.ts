import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { randomUUID } from "node:crypto";
import { Agent, MockChannel, installAgentTestHooks, makeMsg, mockConfig, mockSdk, peekPendingNotes, resetConfig, waitFor } from "./helpers/agent-harness.js";
import { formatTomoEvent } from "../src/tomo-event.js";
import { MESSAGE_WAKE_RETRY_BASE_MS, MESSAGE_WAKE_RETRY_CAP_MS } from "../src/agent.js";
import type { BackoffTimers } from "../src/agent/keyed-backoff.js";

installAgentTestHooks();

// ---------------------------------------------------------------------------
// subsessions.ownerMessages "via-main" (the default) through the real Agent:
// a task's words reach the owning session as a note and a silent turn there;
// none goes to the owner's chat by itself.
// ---------------------------------------------------------------------------

async function boot(): Promise<{ agent: Agent; channel: MockChannel }> {
  resetConfig({
    identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    subsessions: { ...mockConfig.subsessions, enabled: true },
    tomoHome: mockConfig.tomoHome,
  });
  const channel = new MockChannel("telegram");
  const agent = new Agent();
  agent.addChannel(channel);
  await agent.start();
  return { agent, channel };
}

const prompts = (key: string) => mockSdk.promptsBySession.filter((p) => p.sessionKey === key).map((p) => p.text);
const messageNotes = (agent: Agent, key: string) => peekPendingNotes(agent, key).filter((n) => n.includes('<tomo-event type="subsession-message"'));

type RetryInternals = {
  processContinuity: (...args: unknown[]) => Promise<unknown>;
  subsessions: { deps: { queuePendingNote(k: string, n: string): boolean; messageWake(k: string): void } };
  wakes: { retry: { timerApi: BackoffTimers } };
};
const retryInternals = (agent: Agent) => agent as unknown as RetryInternals;

/** The message wake's retry timers, held for the test to fire (nothing fires by itself). */
function interceptRetryTimers(agent: Agent): Array<{ fn: () => void; ms: number; cleared: boolean }> {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  retryInternals(agent).wakes.retry.timerApi = {
    set: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clear: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  };
  return timers;
}

describe("via-main through the Agent", () => {
  it("task_ask: the main session gets the question in a silent turn, nothing reaches the owner's chat, and task_message with the answer resumes the task", async () => {
    const { agent, channel } = await boot();
    let attached: ReturnType<Agent["turnOwnerMessages"]> = [];
    let passed = false;
    mockSdk.responseFn = async (text) => {
      if (text.includes('type="subsession-start"')) {
        await agent.subsessions!.ask("task:s1", "Merge PR #12 now? A) yes B) wait");
        return "";
      }
      // The owner's answer reaches the main session: it passes it on with
      // task_message and attach_owner_message, as the tool does.
      if (!passed && text.includes("A, go") && !text.includes("subsession-relay")) {
        passed = true;
        attached = agent.turnOwnerMessages("dm:alex");
        agent.subsessions!.relay("s1", "They picked A.", attached);
        return "Passing that on.";
      }
      return "NO_REPLY";
    };
    agent.subsessions!.spawn("dm:alex", { title: "Ship it", brief: "b" });
    await waitFor(() => expect(prompts("dm:alex").some((p) => p.includes("Merge PR #12 now? A) yes B) wait") && p.includes("subsession-message"))).toBe(true));
    expect(agent.subsessions!.get("s1")).toMatchObject({ status: "waiting", waitingOn: "owner", askViaMain: { text: "Merge PR #12 now? A) yes B) wait" } });
    expect(channel.delivered.some((d) => d.text.includes("Merge PR #12"))).toBe(false);
    // The turn read the note: it is no longer pending.
    await waitFor(() => expect(messageNotes(agent, "dm:alex")).toEqual([]));
    // The owner says A in the main conversation; the main session passes it on (task_message).
    await channel.simulateMessage(makeMsg({ chatId: "12345", text: "A, go" }));
    await waitFor(() => expect(prompts("task:s1").some((p) => p.includes("The owner's answer is in their own words below") && p.includes("· telegram] A, go"))).toBe(true));
    // The harness copied the owner's message from that turn; the model did not retell it.
    expect(attached).toEqual([expect.objectContaining({ text: "A, go", channel: "telegram" })]);
    // Once that turn is over there is nothing of the owner's to attach.
    expect(agent.turnOwnerMessages("dm:alex")).toEqual([]);
    expect(agent.subsessions!.get("s1")!.askViaMain).toBeUndefined();
    await agent.stop();
  });

  it("an answer to a web task panel message stays in the panel: no note, nothing to the owner's chat", async () => {
    const { agent, channel } = await boot();
    let answered = false;
    mockSdk.responseFn = async (text) => {
      if (text.includes('type="subsession-owner-message"')) {
        answered = (await agent.subsessions!.reply("task:s1", "PANEL-ANSWER")).ok;
        return "";
      }
      // The start turn says nothing; three such turns park it in waiting(owner).
      return "NO_REPLY";
    };
    agent.subsessions!.spawn("dm:alex", { title: "Mine", brief: "b" });
    await waitFor(() => expect(agent.subsessions!.get("s1")).toMatchObject({ status: "waiting", waitingOn: "owner" }));
    await waitFor(() => expect(messageNotes(agent, "dm:alex")).toEqual([]));
    expect(agent.webSubsessions()!.message("s1", "how is it going?", randomUUID())).toMatchObject({ ok: true });
    await waitFor(() => expect(answered).toBe(true));
    expect(agent.subsessions!.get("s1")!.conversation.at(-1)).toMatchObject({ from: "task", kind: "reply", text: "PANEL-ANSWER" });
    expect(agent.subsessions!.get("s1")!.sent.at(-1)).toMatchObject({ kind: "reply", via: "panel" });
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts("dm:alex").some((p) => p.includes("PANEL-ANSWER") && p.includes("answers the owner's message to it"))).toBe(false);
    expect(messageNotes(agent, "dm:alex")).toEqual([]);
    expect(channel.delivered.some((d) => d.text.includes("PANEL-ANSWER"))).toBe(false);
    await agent.stop();
  });

  it("a group-owned task's message goes to the group's session only, never to the owner's DM", async () => {
    const { agent, channel } = await boot();
    mockSdk.responseFn = async (text) => {
      if (text.includes('type="subsession-start"')) {
        await agent.subsessions!.notify("task:s1", "GROUP-ONLY news");
        await agent.subsessions!.ask("task:s1", "go?");
        return "";
      }
      return "NO_REPLY";
    };
    agent.subsessions!.spawn("telegram:-100271", { title: "Theirs", brief: "b" });
    await waitFor(() => expect(prompts("telegram:-100271").some((p) => p.includes("GROUP-ONLY news"))).toBe(true));
    expect(prompts("dm:alex").some((p) => p.includes("GROUP-ONLY"))).toBe(false);
    expect(peekPendingNotes(agent, "dm:alex").some((n) => n.includes("GROUP-ONLY"))).toBe(false);
    expect(channel.delivered.some((d) => d.text.includes("GROUP-ONLY"))).toBe(false);
    await agent.stop();
  });

  it("a task whose turns keep failing: the main session is woken with the failure category, nothing reaches the owner's chat", async () => {
    const { agent, channel } = await boot();
    // The main session's turns are the wakes for the notes; every other turn is the task's, and fails.
    mockSdk.responseFn = (text) => text.includes('type="subsession-message"') ? "NO_REPLY"
      : 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}';
    agent.subsessions!.spawn("dm:alex", { title: "Mine", brief: "b" });
    await waitFor(() => expect(agent.subsessions!.get("s1")).toMatchObject({ status: "waiting", waitingOn: "owner" }));
    expect(agent.subsessions!.get("s1")!.lastFailure).toMatchObject({ category: "invalid_request" });
    await waitFor(() => expect(prompts("dm:alex").some((p) => p.includes("Paused: its last turns failed") && p.includes("Failure category: invalid_request"))).toBe(true));
    expect(channel.delivered.some((d) => d.text.includes("Paused"))).toBe(false);
    await agent.stop();
  });

  it("at start, a session holding an unread sub-session note is woken even when the task table names no task there", async () => {
    const { agent } = await boot();
    mockSdk.responseFn = () => "NO_REPLY";
    const internals = agent as unknown as {
      sessions: { ensureEntry(k: string): void };
      wakes: { wakeUnread(): void };
      subsessions: { deps: { queuePendingNote(k: string, n: string): boolean } };
    };
    internals.sessions.ensureEntry("telegram:-100555");
    internals.subsessions.deps.queuePendingNote("telegram:-100555", formatTomoEvent("subsession-message", "ORPHAN-NOTICE", { name: "s7:notice:1:abcdef" }));
    internals.wakes.wakeUnread();
    await waitFor(() => expect(prompts("telegram:-100555").some((p) => p.includes("ORPHAN-NOTICE"))).toBe(true));
    expect(prompts("dm:alex").some((p) => p.includes("ORPHAN-NOTICE"))).toBe(false);
    await agent.stop();
  });

  it("withdraws a DM note marked for the owner's audience (a failed write is not left in memory)", async () => {
    const { agent } = await boot();
    const deps = (agent.subsessions as unknown as { deps: { queuePendingNote(k: string, n: string): boolean; withdrawPendingNote(k: string, m: (n: string) => boolean): boolean } }).deps;
    const note = formatTomoEvent("subsession-message", "WITHDRAWN", { name: "s9:1-1" });
    deps.queuePendingNote("dm:alex", note);
    expect(peekPendingNotes(agent, "dm:alex").some((n) => n.includes("WITHDRAWN"))).toBe(true);
    expect(deps.withdrawPendingNote("dm:alex", (n) => n.includes('name="s9:1-1"'))).toBe(true);
    expect(peekPendingNotes(agent, "dm:alex").some((n) => n.includes("WITHDRAWN"))).toBe(false);
    await agent.stop();
  });

  it("a message wake whose turn failed is tried again, so an idle main session still reads the note", async () => {
    const { agent } = await boot();
    mockSdk.responseFn = () => "NO_REPLY";
    const internals = retryInternals(agent);
    const retries = interceptRetryTimers(agent);
    const turn = vi.spyOn(internals, "processContinuity").mockRejectedValueOnce(new Error("API down"));
    internals.subsessions.deps.queuePendingNote("dm:alex", formatTomoEvent("subsession-message", "RETRY-ME", { name: "s1:notify:x" }));
    internals.subsessions.deps.messageWake("dm:alex");
    await waitFor(() => expect(retries).toHaveLength(1));
    expect(retries[0].ms).toBe(MESSAGE_WAKE_RETRY_BASE_MS);
    expect(prompts("dm:alex").some((p) => p.includes("RETRY-ME"))).toBe(false);
    retries[0].fn();
    await waitFor(() => expect(prompts("dm:alex").some((p) => p.includes("RETRY-ME"))).toBe(true));
    expect(turn).toHaveBeenCalledTimes(2);
    // Read now: no further retry.
    await waitFor(() => expect(messageNotes(agent, "dm:alex")).toEqual([]));
    expect(retries).toHaveLength(1);
    await agent.stop();
  });

  it("keeps retrying past five failed turns, doubling the delay up to the cap", async () => {
    const { agent } = await boot();
    mockSdk.responseFn = () => "NO_REPLY";
    const internals = retryInternals(agent);
    const retries = interceptRetryTimers(agent);
    const failures = 8;
    const turn = vi.spyOn(internals, "processContinuity");
    for (let i = 0; i < failures; i++) turn.mockRejectedValueOnce(new Error("API down"));
    internals.subsessions.deps.queuePendingNote("dm:alex", formatTomoEvent("subsession-message", "PERSIST", { name: "s1:notify:p" }));
    internals.subsessions.deps.messageWake("dm:alex");
    for (let i = 1; i < failures; i++) {
      await waitFor(() => expect(retries).toHaveLength(i));
      retries[i - 1].fn();
    }
    await waitFor(() => expect(retries).toHaveLength(failures));
    const base = MESSAGE_WAKE_RETRY_BASE_MS;
    const cap = MESSAGE_WAKE_RETRY_CAP_MS;
    expect(retries.map((r) => r.ms)).toEqual([base, 2 * base, 4 * base, 8 * base, 16 * base, cap, cap, cap]);
    // The ninth turn reads it; nothing more is scheduled.
    retries[failures - 1].fn();
    await waitFor(() => expect(messageNotes(agent, "dm:alex")).toEqual([]));
    expect(turn).toHaveBeenCalledTimes(failures + 1);
    expect(prompts("dm:alex").some((p) => p.includes("PERSIST"))).toBe(true);
    expect(retries).toHaveLength(failures);
    await agent.stop();
  });

  it("keeps one retry timer per session when a second wake fails while one is pending", async () => {
    const { agent } = await boot();
    mockSdk.responseFn = () => "NO_REPLY";
    const internals = retryInternals(agent);
    const retries = interceptRetryTimers(agent);
    const turn = vi.spyOn(internals, "processContinuity").mockRejectedValueOnce(new Error("API down")).mockRejectedValueOnce(new Error("API down"));
    internals.subsessions.deps.queuePendingNote("dm:alex", formatTomoEvent("subsession-message", "ONE", { name: "s1:notify:1" }));
    internals.subsessions.deps.messageWake("dm:alex");
    await waitFor(() => expect(retries).toHaveLength(1));
    // Another note's wake fails too while the retry is pending.
    internals.subsessions.deps.queuePendingNote("dm:alex", formatTomoEvent("subsession-message", "TWO", { name: "s1:notify:2" }));
    internals.subsessions.deps.messageWake("dm:alex");
    await waitFor(() => expect(turn).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(retries).toHaveLength(1);
    retries[0].fn();
    await waitFor(() => expect(messageNotes(agent, "dm:alex")).toEqual([]));
    expect(retries).toHaveLength(1);
    await agent.stop();
  });

  it("starts from the base delay again once the note has been read", async () => {
    const { agent } = await boot();
    mockSdk.responseFn = () => "NO_REPLY";
    const internals = retryInternals(agent);
    const retries = interceptRetryTimers(agent);
    const turn = vi.spyOn(internals, "processContinuity").mockRejectedValueOnce(new Error("API down")).mockRejectedValueOnce(new Error("API down"));
    internals.subsessions.deps.queuePendingNote("dm:alex", formatTomoEvent("subsession-message", "FIRST", { name: "s1:notify:a" }));
    internals.subsessions.deps.messageWake("dm:alex");
    await waitFor(() => expect(retries).toHaveLength(1));
    retries[0].fn();
    await waitFor(() => expect(retries).toHaveLength(2));
    expect(retries[1].ms).toBe(2 * MESSAGE_WAKE_RETRY_BASE_MS);
    retries[1].fn();
    await waitFor(() => expect(messageNotes(agent, "dm:alex")).toEqual([]));
    // A later note whose wake fails waits the base again.
    turn.mockRejectedValueOnce(new Error("API down"));
    internals.subsessions.deps.queuePendingNote("dm:alex", formatTomoEvent("subsession-message", "SECOND", { name: "s1:notify:b" }));
    internals.subsessions.deps.messageWake("dm:alex");
    await waitFor(() => expect(retries).toHaveLength(3));
    expect(retries[2].ms).toBe(MESSAGE_WAKE_RETRY_BASE_MS);
    await agent.stop();
  });

  it("stop() drops a pending retry timer", async () => {
    const { agent } = await boot();
    mockSdk.responseFn = () => "NO_REPLY";
    const internals = retryInternals(agent);
    const retries = interceptRetryTimers(agent);
    vi.spyOn(internals, "processContinuity").mockRejectedValueOnce(new Error("API down"));
    internals.subsessions.deps.queuePendingNote("dm:alex", formatTomoEvent("subsession-message", "STOPPED", { name: "s1:notify:s" }));
    internals.subsessions.deps.messageWake("dm:alex");
    await waitFor(() => expect(retries).toHaveLength(1));
    expect(retries[0].cleared).toBe(false);
    await agent.stop();
    expect(retries[0].cleared).toBe(true);
  });
});
