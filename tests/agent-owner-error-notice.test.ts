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
  waitFor,
} from "./helpers/agent-harness.js";
import { OWNER_NOTICE_WINDOW_MS } from "../src/agent/owner-error-notice.js";

installAgentTestHooks();

const OWNER_CHAT = "12345";
const GROUP_CHAT = "iMessage;+;group123";
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

  it("never sends an extra notice for the owner's own DM session", async () => {
    const { agent, tg, im } = await setup();

    // A DM turn: the error is delivered in the DM itself — exactly once.
    failNextTurnWith(SAFEGUARD);
    await tg.simulateMessage(makeMsg({ chatId: OWNER_CHAT, text: "question" }));
    await drainQueue(agent);
    // Silent housekeeping cron on the DM: suppressed on request, no notice.
    failNextTurnWith("API Error: 500 internal");
    await agent.handleCronMessage("housekeeping", "dm:owner", { suppressDelivery: true, showTyping: false });

    await expectNoChangeFor(() => {
      expect(tg.delivered).toHaveLength(1);
      expect(tg.delivered[0].text).toMatch(/^\[error\] API Error: Example Model's safeguards/);
    });
    expect(im.delivered).toEqual([]);

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
});
