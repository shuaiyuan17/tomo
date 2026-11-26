import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { randomUUID } from "node:crypto";
import { Agent, MockChannel, installAgentTestHooks, makeMsg, mockConfig, mockSdk, peekPendingNotes, resetConfig, waitFor } from "./helpers/agent-harness.js";
import { formatTomoEvent } from "../src/tomo-event.js";
import { MESSAGE_WAKE_RETRY_MS } from "../src/agent.js";

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
    expect(prompts("dm:alex").some((p) => p.includes("PANEL-ANSWER") && p.includes('type="subsession-message"'))).toBe(false);
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
    const internals = agent as unknown as {
      processContinuity: (...args: unknown[]) => Promise<unknown>;
      subsessions: { deps: { queuePendingNote(k: string, n: string): boolean; messageWake(k: string): void } };
    };
    const retries: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === MESSAGE_WAKE_RETRY_MS) { retries.push(fn); return { unref() {} } as unknown as NodeJS.Timeout; }
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout);
    const turn = vi.spyOn(internals, "processContinuity").mockRejectedValueOnce(new Error("API down"));
    internals.subsessions.deps.queuePendingNote("dm:alex", formatTomoEvent("subsession-message", "RETRY-ME", { name: "s1:notify:x" }));
    internals.subsessions.deps.messageWake("dm:alex");
    await waitFor(() => expect(retries).toHaveLength(1));
    expect(prompts("dm:alex").some((p) => p.includes("RETRY-ME"))).toBe(false);
    retries[0]();
    await waitFor(() => expect(prompts("dm:alex").some((p) => p.includes("RETRY-ME"))).toBe(true));
    expect(turn).toHaveBeenCalledTimes(2);
    // Read now: no further retry.
    await waitFor(() => expect(messageNotes(agent, "dm:alex")).toEqual([]));
    expect(retries).toHaveLength(1);
    timers.mockRestore();
    await agent.stop();
  });
});
