import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  drainQueue,
  expectNoChangeFor,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  resetConfig,
  useRealAdmission,
  waitFor,
} from "./helpers/agent-harness.js";
import { OWNER_NOTICE_WINDOW_MS } from "../src/agent/owner-error-notice.js";
import { TurnInterruptedError } from "../src/agent/live-session.js";
import type { TurnRequest } from "../src/agent/live-session.js";

installAgentTestHooks();

const OWNER_CHAT = "12345";
const GROUP_CHAT = "iMessage;+;group123";
const AUTH = "Failed to authenticate: OAuth session expired and could not be refreshed";
const SAFEGUARD = "API Error: Example Model's safeguards flagged this message (https://example.invalid/aup). This sometimes happens with safe, normal conversations.";

/** Owner DM on telegram (identity-bound), passive iMessage group. */
async function setup(): Promise<{ agent: Agent; tg: MockChannel; im: MockChannel }> {
  resetConfig({
    identities: [{ name: "owner", channels: { telegram: OWNER_CHAT }, replyPolicy: "last-active" }],
  });
  const agent = new Agent();
  const tg = new MockChannel("telegram");
  const im = new MockChannel("imessage");
  agent.addChannel(tg);
  agent.addChannel(im);

  // Establish the owner's DM session (the notice target) and the group.
  mockSdk.responseFn = () => "hi";
  await tg.simulateMessage(makeMsg({ chatId: OWNER_CHAT, text: "hello" }));
  mockSdk.responseFn = () => "NO_REPLY";
  await im.simulateMessage(makeMsg({ chatId: GROUP_CHAT, text: "chatter", isGroup: true, chatTitle: "Book Club" }));
  await drainQueue(agent);
  tg.clearDelivered();
  im.clearDelivered();
  return { agent, tg, im };
}

function failNextTurnWith(text: string): void {
  mockSdk.responseFn = () => [];
  mockSdk.nextResult = { subtype: "success", is_error: true, result: text };
}

async function groupMessageThatFails(agent: Agent, im: MockChannel, text = SAFEGUARD): Promise<void> {
  failNextTurnWith(text);
  await im.simulateMessage(makeMsg({ chatId: GROUP_CHAT, text: "another message", isGroup: true, chatTitle: "Book Club" }));
  await drainQueue(agent);
}

describe("owner notice for errors kept out of a chat", () => {
  it("passive group safeguard refusal: one owner DM, nothing in the group", async () => {
    const { agent, tg, im } = await setup();

    await groupMessageThatFails(agent, im);

    await waitFor(() => expect(tg.delivered).toHaveLength(1));
    const notice = tg.delivered[0];
    expect(notice.chatId).toBe(OWNER_CHAT);
    expect(notice.text).toContain(`group "Book Club" (imessage:${GROUP_CHAT})`);
    expect(notice.text).toContain("Kind: safety classifier refusal");
    expect(notice.text).toContain("Error: API Error: Example Model's safeguards flagged this message");
    expect(notice.text).toContain("tomo lcm compact --session-id ");
    // The group's earlier (silent, successful) turn bounds the range.
    expect(notice.text).toMatch(/--from-time \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} --to-time \d{4}-/);
    expect(notice.text).not.toContain("more time");
    expect(im.delivered).toEqual([]);

    await agent.stop();
  });

  it("rate-limits per group and error class, then reports how many failures were folded in", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    const { agent, tg, im } = await setup();

    await groupMessageThatFails(agent, im);
    await waitFor(() => expect(tg.delivered).toHaveLength(1));

    // Second and third failures inside the window: no DM.
    await groupMessageThatFails(agent, im);
    await groupMessageThatFails(agent, im);
    await expectNoChangeFor(() => expect(tg.delivered).toHaveLength(1));

    // A different error class in the same group has its own window.
    await groupMessageThatFails(agent, im, "Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}");
    await waitFor(() => expect(tg.delivered).toHaveLength(2));
    expect(tg.delivered[1].text).toContain("Kind: authentication failure");
    expect(tg.delivered[1].text).toContain("/login");

    // After the window, the next safeguard failure notifies again, with the count.
    vi.setSystemTime(Date.now() + OWNER_NOTICE_WINDOW_MS + 1000);
    await groupMessageThatFails(agent, im);
    await waitFor(() => expect(tg.delivered).toHaveLength(3));
    expect(tg.delivered[2].text).toContain("Kind: safety classifier refusal");
    expect(tg.delivered[2].text).toContain("happened 2 more times there since the last notice");
    expect(im.delivered).toEqual([]);

    await agent.stop();
  });

  it("group cron error kept out of the chat (note-only) notifies the owner, naming the job", async () => {
    resetConfig({
      identities: [{ name: "owner", channels: { telegram: OWNER_CHAT }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    mockSdk.responseFn = () => "hi";
    await tg.simulateMessage(makeMsg({ chatId: OWNER_CHAT, text: "hello" }));
    await tg.simulateMessage(makeMsg({ chatId: "-100group", text: "@tomo hi", isGroup: true, isMentioned: true, chatTitle: "Team" }));
    await drainQueue(agent);
    tg.clearDelivered();

    failNextTurnWith("Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth token has expired\"}}");
    const ok = await agent.handleCronMessage("digest", "telegram:-100group", { jobName: "weekly-digest" });
    expect(ok).toBe(false);

    await waitFor(() => expect(tg.delivered).toHaveLength(1));
    expect(tg.delivered[0].chatId).toBe(OWNER_CHAT);
    expect(tg.delivered[0].text).toContain('Cron job "weekly-digest" in group "Team" (telegram:-100group) failed');
    expect(tg.delivered[0].text).toContain("Kind: authentication failure");
    expect(tg.delivered.filter((d) => d.chatId === "-100group")).toEqual([]);

    await agent.stop();
  });

  it("does not add a notice when the owner's DM already shows the error", async () => {
    const { agent, tg, im } = await setup();

    // A DM turn: the error is delivered in the DM itself — exactly once.
    failNextTurnWith(SAFEGUARD);
    await tg.simulateMessage(makeMsg({ chatId: OWNER_CHAT, text: "question" }));
    await drainQueue(agent);

    await expectNoChangeFor(() => {
      expect(tg.delivered).toHaveLength(1);
      expect(tg.delivered[0].text).toMatch(/^\[error\] API Error: Example Model's safeguards/);
    });
    expect(im.delivered).toEqual([]);

    await agent.stop();
  });

  it("DM housekeeping cron whose error is held back (note-only): one visible notice in that DM", async () => {
    const { agent, tg, im } = await setup();

    failNextTurnWith(AUTH);
    const ok = await agent.handleCronMessage("housekeeping", "dm:owner", { suppressDelivery: true, showTyping: false });
    expect(ok).toBe(false);

    await waitFor(() => expect(tg.delivered).toHaveLength(1));
    expect(tg.delivered[0].chatId).toBe(OWNER_CHAT);
    expect(tg.delivered[0].text).toContain("A background turn in this DM session (dm:owner) failed");
    expect(tg.delivered[0].text).toContain("Kind: authentication failure");
    expect(tg.delivered[0].text).toContain("send /login in this DM");
    expect(im.delivered).toEqual([]);

    await agent.stop();
  });

  it("repeated heartbeat auth failures on the DM are rate-limited, sharing the window with crons", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    const { agent, tg } = await setup();

    failNextTurnWith(AUTH);
    await agent.handleContinuity("System: Free time.");
    await waitFor(() => expect(tg.delivered).toHaveLength(1));
    expect(tg.delivered[0].text).toContain("A heartbeat turn in this DM session (dm:owner) failed");
    expect(tg.delivered[0].text).toContain("Kind: authentication failure");

    failNextTurnWith(AUTH);
    await agent.handleContinuity("System: Free time.");
    failNextTurnWith(AUTH);
    await agent.handleCronMessage("housekeeping", "dm:owner", { suppressDelivery: true, showTyping: false });
    await expectNoChangeFor(() => expect(tg.delivered).toHaveLength(1));

    vi.setSystemTime(Date.now() + OWNER_NOTICE_WINDOW_MS + 1000);
    failNextTurnWith(AUTH);
    await agent.handleContinuity("System: Free time.");
    await waitFor(() => expect(tg.delivered).toHaveLength(2));
    expect(tg.delivered[1].text).toContain("happened 2 more times there since the last notice");

    await agent.stop();
  });

  it("is off when notifyOwnerOnSuppressedErrors is false", async () => {
    const { agent, tg, im } = await setup();
    resetConfig({
      identities: [{ name: "owner", channels: { telegram: OWNER_CHAT }, replyPolicy: "last-active" }],
      notifyOwnerOnSuppressedErrors: false,
    });

    await groupMessageThatFails(agent, im);

    await expectNoChangeFor(() => expect(tg.delivered).toEqual([]));
    expect(im.delivered).toEqual([]);

    await agent.stop();
  });

  it("never sends a notice to a stranger's private chat when the owner has no DM session yet", async () => {
    resetConfig({
      identities: [{ name: "owner", channels: { telegram: OWNER_CHAT }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    // Someone else has chatted privately; the owner has not.
    mockSdk.responseFn = () => "hello friend";
    await tg.simulateMessage(makeMsg({ chatId: "999", text: "hi tomo" }));
    mockSdk.responseFn = () => "NO_REPLY";
    await im.simulateMessage(makeMsg({ chatId: GROUP_CHAT, text: "chatter", isGroup: true, chatTitle: "Book Club" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await groupMessageThatFails(agent, im);

    // Resolved through the configured owner identity, not "the first private
    // chat that has a session".
    await waitFor(() => expect(tg.delivered).toHaveLength(1));
    expect(tg.delivered[0].chatId).toBe(OWNER_CHAT);
    await expectNoChangeFor(() => expect(tg.delivered.filter((d) => d.chatId === "999")).toEqual([]));

    await agent.stop();
  });

  it("drops the notice (no raw-chat fallback) when no owner identity is configured", async () => {
    resetConfig({ identities: [] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);
    mockSdk.responseFn = () => "hello";
    await tg.simulateMessage(makeMsg({ chatId: "999", text: "hi tomo" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await groupMessageThatFails(agent, im);

    await expectNoChangeFor(() => expect(tg.delivered).toEqual([]));
    expect(im.delivered).toEqual([]);

    await agent.stop();
  });

  describe("with several legacy identities (single owner now)", () => {
    const SECOND_CHAT = "777";
    async function setupTwo(webOwnerIdentity?: string) {
      useRealAdmission();
      resetConfig({
        identities: [
          { name: "owner", channels: { telegram: OWNER_CHAT }, replyPolicy: "last-active" },
          { name: "second", channels: { telegram: SECOND_CHAT }, replyPolicy: "last-active" },
        ],
        channelAllowlists: { imessage: [GROUP_CHAT] },
        ...(webOwnerIdentity ? { web: { ownerIdentity: webOwnerIdentity } } : {}),
      });
      const agent = new Agent();
      const tg = new MockChannel("telegram");
      const im = new MockChannel("imessage");
      agent.addChannel(tg);
      agent.addChannel(im);
      mockSdk.responseFn = () => "hi";
      await tg.simulateMessage(makeMsg({ chatId: SECOND_CHAT, senderId: SECOND_CHAT, text: "hello" }));
      await tg.simulateMessage(makeMsg({ chatId: OWNER_CHAT, senderId: OWNER_CHAT, text: "hello" }));
      await drainQueue(agent);
      mockSdk.responseFn = () => "NO_REPLY";
      await im.simulateMessage(makeMsg({ chatId: GROUP_CHAT, text: "chatter", isGroup: true, chatTitle: "Book Club" }));
      await drainQueue(agent);
      return { agent, tg, im };
    }

    it("the first identity is the owner; the other identity's DMs are no longer answered", async () => {
      const { agent, tg } = await setupTwo();
      expect(tg.delivered.map((d) => d.chatId)).toEqual([OWNER_CHAT]);
      await agent.stop();
    });

    it("web.ownerIdentity picks the owner among several identities", async () => {
      const { agent, tg } = await setupTwo("second");
      expect(tg.delivered.map((d) => d.chatId)).toEqual([SECOND_CHAT]);
      await agent.stop();
    });

    it("a group failure goes to the owner, not the first dm session", async () => {
      const { agent, tg, im } = await setupTwo();
      tg.clearDelivered();
      await groupMessageThatFails(agent, im);
      await waitFor(() => expect(tg.delivered).toHaveLength(1));
      expect(tg.delivered[0].chatId).toBe(OWNER_CHAT);
      await agent.stop();
    });

    it("a held-back failure on a former identity's dm session is not sent to that person", async () => {
      const { agent, tg } = await setupTwo();
      tg.clearDelivered();
      failNextTurnWith(AUTH);
      await agent.handleCronMessage("housekeeping", "dm:second", { suppressDelivery: true, showTyping: false });
      await expectNoChangeFor(() => expect(tg.delivered.filter((d) => d.chatId === SECOND_CHAT)).toEqual([]));
      await agent.stop();
    });

    it("a summoned group's failure is labelled as the group's and delivered to the owner's DM, with /rewind", async () => {
      const { agent, tg, im } = await setupTwo();
      tg.clearDelivered();
      (agent as unknown as { router: { summonGroup(c: string, id: string): void } })
        .router.summonGroup("imessage", GROUP_CHAT);

      await groupMessageThatFails(agent, im);

      await waitFor(() => expect(tg.delivered).toHaveLength(1));
      expect(tg.delivered[0].chatId).toBe(OWNER_CHAT);
      expect(tg.delivered[0].text).toContain(`group "Book Club" (imessage:${GROUP_CHAT})`);
      expect(tg.delivered[0].text).toContain("/rewind in this DM");
      expect(im.delivered).toEqual([]);
      await agent.stop();
    });
  });

  it("reports an agent-error RESPONSE a group cron keeps out of the chat (response: note-only)", async () => {
    const { agent, tg } = await setup();
    await tg.simulateMessage(makeMsg({ chatId: "-100group", text: "@tomo hi", isGroup: true, isMentioned: true, chatTitle: "Team" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => "API Error: 529 overloaded";
    expect(await agent.handleCronMessage("digest", "telegram:-100group", { jobName: "digest" })).toBe(false);

    await waitFor(() => expect(tg.delivered).toHaveLength(1));
    expect(tg.delivered[0].chatId).toBe(OWNER_CHAT);
    expect(tg.delivered[0].text).toContain("Error: API Error: 529 overloaded");
    expect(tg.delivered.filter((d) => d.chatId === "-100group")).toEqual([]);
    await agent.stop();
  });

  it("sends nothing for a failure that happens while Tomo is stopping", async () => {
    const { agent, tg, im } = await setup();
    (agent as unknown as { stopping: boolean }).stopping = true;
    await groupMessageThatFails(agent, im);
    await expectNoChangeFor(() => expect(tg.delivered).toEqual([]));
    (agent as unknown as { stopping: boolean }).stopping = false;
    await agent.stop();
  });

  it("a background turn stopped by /rewind is not reported; a failed one is", async () => {
    const { agent, tg } = await setup();
    await tg.simulateMessage(makeMsg({ chatId: "-100group", text: "@tomo hi", isGroup: true, isMentioned: true, chatTitle: "Team" }));
    await drainQueue(agent);
    tg.clearDelivered();
    const internals = agent as unknown as { createUnownedTurnRequest(key: string): TurnRequest | undefined };

    await internals.createUnownedTurnRequest("telegram:-100group")!.reject(new TurnInterruptedError());
    await expectNoChangeFor(() => expect(tg.delivered).toEqual([]));

    await internals.createUnownedTurnRequest("telegram:-100group")!.reject(new Error("background boom"));
    await waitFor(() => expect(tg.delivered).toHaveLength(1));
    expect(tg.delivered[0].chatId).toBe(OWNER_CHAT);
    expect(tg.delivered[0].text).toContain("A background task turn in group \"Team\"");
    await agent.stop();
  });

  it("does not follow a persisted reply target the owner identity is no longer bound to", async () => {
    // The owner chatted from 12345, which persisted dm:owner's reply target…
    const first = await setup();
    await first.agent.stop();

    // …then the identity was rebound to another chat and Tomo restarted.
    resetConfig({
      identities: [{ name: "owner", channels: { telegram: "54321" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    await groupMessageThatFails(agent, im);

    await waitFor(() => expect(tg.delivered).toHaveLength(1));
    expect(tg.delivered[0].chatId).toBe("54321");
    await agent.stop();
  });

  it("never sends a notice to a group id configured as an identity binding", async () => {
    resetConfig({
      identities: [{ name: "owner", channels: { telegram: "-100999" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    await groupMessageThatFails(agent, im);

    await expectNoChangeFor(() => expect(tg.delivered).toEqual([]));
    await agent.stop();
  });
});
