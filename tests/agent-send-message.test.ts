import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  SessionStore,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockConfig,
  mockSdk,
  peekPendingNotes,
  resetConfig,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

describe("send_message direct mode", () => {
  it("parses MEDIA/STICKER tags into ordered attachment sends", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const imagePath = join(agentEnv.tmpDir, "photo with spaces.jpg");
    writeFileSync(imagePath, "fake image");

    const result = await agent.sendToSession(
      "telegram:12345",
      `here you go MEDIA:"${imagePath}" STICKER:CAACAgQAAxkBAAE123`,
    );

    expect(result).toEqual({ ok: true });
    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "here you go", photo: undefined, sticker: undefined },
      { chatId: "12345", text: "", photo: imagePath, sticker: undefined },
      { chatId: "12345", text: "", photo: undefined, sticker: "CAACAgQAAxkBAAE123" },
    ]);

    await agent.stop();
  });

  // An attachment that fails AFTER the text has gone out. The failure used to
  // propagate: no transcript append, a tool error, and a model that reads
  // "the send failed" as "send it again" — so the reader saw the text twice
  // and the picture never. The text cannot be unsent, so the only honest
  // outcome is a partial success that says exactly what did not arrive.
  it("keeps the delivered text and reports the photo that failed", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const imagePath = join(agentEnv.tmpDir, "doomed.jpg");
    writeFileSync(imagePath, "fake image");
    const passThrough = tg.send.bind(tg);
    vi.spyOn(tg, "send").mockImplementation(async (msg) => {
      if (msg.photo) throw new Error("EPIPE: the channel died mid-send");
      await passThrough(msg);
    });

    const result = await agent.sendToSession("telegram:12345", `here you go MEDIA:"${imagePath}"`);

    expect(result.ok).toBe(true);
    const note = (result as { note?: string }).note ?? "";
    expect(note).toContain(imagePath);
    expect(note).toContain("do not send it again");
    // The text really was delivered...
    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "here you go", photo: undefined, sticker: undefined },
    ]);
    // ...and recorded, which is what stops the next turn re-sending it.
    const messages = new SessionStore(
      mockConfig.sessionsDir,
      20,
      mockConfig.sdkSessionsDir,
    ).get("telegram:12345").messages;
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: `[proactive] here you go MEDIA:"${imagePath}"`,
      channel: "telegram",
    });

    await agent.stop();
  });

  it("keeps going past a failed sticker and names it in the result", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const imagePath = join(agentEnv.tmpDir, "fine.jpg");
    writeFileSync(imagePath, "fake image");
    const passThrough = tg.send.bind(tg);
    vi.spyOn(tg, "send").mockImplementation(async (msg) => {
      if (msg.sticker) throw new Error("sticker send refused");
      await passThrough(msg);
    });

    const result = await agent.sendToSession(
      "telegram:12345",
      `two of these MEDIA:"${imagePath}" STICKER:CAACAgQAAxkBAAE123`,
    );

    expect(result.ok).toBe(true);
    const note = (result as { note?: string }).note ?? "";
    expect(note).toContain("CAACAgQAAxkBAAE123");
    expect(note).not.toContain(imagePath);
    // One attachment failing does not cancel the one that worked.
    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "two of these", photo: undefined, sticker: undefined },
      { chatId: "12345", text: "", photo: imagePath, sticker: undefined },
    ]);
    const messages = new SessionStore(
      mockConfig.sessionsDir,
      20,
      mockConfig.sdkSessionsDir,
    ).get("telegram:12345").messages;
    expect(messages.at(-1)).toMatchObject({ role: "assistant", channel: "telegram" });

    await agent.stop();
  });

  it("preserves verbatim direct text when there are no attachment tags", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const text = "  keep surrounding whitespace\n";

    const result = await agent.sendToSession("telegram:12345", text);

    expect(result).toEqual({ ok: true });
    expect(tg.delivered).toEqual([
      { chatId: "12345", text, photo: undefined, sticker: undefined },
    ]);
    const messages = new SessionStore(
      mockConfig.sessionsDir,
      20,
      mockConfig.sdkSessionsDir,
    ).get("telegram:12345").messages;
    expect(messages).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: `[proactive] ${text}`,
      channel: "telegram",
    });
    const pendingNotes = peekPendingNotes(agent, "telegram:12345");
    expect(pendingNotes).toHaveLength(1);
    expect(pendingNotes[0]).toMatch(/^<tomo-event type="direct-send" ts="[^"]+">/);
    expect(pendingNotes[0]).toContain(
      `Tomo from another session sent the following message to this conversation earlier: "${text}"`,
    );

    await agent.stop();
  });

  it("records a raw bound-chat target under the dm session so recall sees it (#203)", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const result = await agent.sendToSession("telegram:12345", "distinctive marker", "dm:shuai");

    expect(result).toEqual({ ok: true });
    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "distinctive marker", photo: undefined, sticker: undefined },
    ]);
    // The send is recorded on dm:shuai — the session recall_conversation is
    // bound to — not a parallel telegram:12345 transcript.
    const recorded = agent.searchSessionTranscript("dm:shuai", { query: "distinctive marker" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].content).toBe("[proactive] distinctive marker");
    expect(agent.searchSessionTranscript("telegram:12345", { query: "distinctive marker" })).toHaveLength(0);

    await agent.stop();
  });

  it("delegate to a raw bound-chat target delivers on the named channel, not the reply policy's (#203)", async () => {
    resetConfig({
      identities: [{
        name: "shuai",
        channels: { telegram: "12345", imessage: "+15551234567" },
        replyPolicy: "last-active",
      }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    // Make iMessage the dm session's last-active reply target.
    mockSdk.responseFn = () => "NO_REPLY";
    await im.simulateMessage(makeMsg({ chatId: "+15551234567", text: "hi" }));
    await drainQueue(agent);
    tg.clearDelivered();
    im.clearDelivered();

    mockSdk.responseFn = () => "the brief";
    const result = await agent.delegateToSession("telegram:12345", "send the brief");
    await drainQueue(agent);

    expect(result).toEqual({ ok: true });
    expect(im.sent).toHaveLength(0);
    expect(tg.sent.map((m) => m.text)).toEqual(["the brief"]);

    await agent.stop();
  });

  /**
   * Option A suppresses a CONTINUITY turn's own text — but a delegated turn's
   * output IS the message the caller asked for. Suppressing it would silently
   * break every cross-session `send_message` in delegate mode, so pin the
   * difference explicitly rather than leaving it implied.
   */
  it("keeps delivering a delegated turn's own text (option A does not touch it)", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    // The recipient session's Claude composes the message in its own voice —
    // the turn's own text blocks are the delivery path here.
    mockSdk.responseFn = () => "Happy birthday from all of us.";
    const result = await agent.delegateToSession("shuai", "wish him a happy birthday");
    await drainQueue(agent);

    expect(result).toEqual({ ok: true });
    expect(tg.sent.map((m) => m.text)).toEqual(["Happy birthday from all of us."]);

    await agent.stop();
  });

  it("attributes a summoned-group send to the summoning dm session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      router: { summonGroup(ch: string, chatId: string, identity: string): void };
      sessions: { get(key: string): { messages: Array<{ content: string }> } };
    };
    internals.router.summonGroup("telegram", "-987", "Alice");

    const result = await agent.sendToSession("telegram:-987", "hello group", "dm:alice");

    expect(result).toEqual({ ok: true });
    expect(internals.sessions.get("telegram:-987").messages.at(-1)?.content)
      .toBe("[via dm:alice (summoned)] hello group");
    const summonNotes = peekPendingNotes(agent, "telegram:-987");
    expect(summonNotes).toHaveLength(1);
    expect(summonNotes[0]).toMatch(/^<tomo-event type="direct-send" ts="[^"]+">/);
    expect(summonNotes[0]).toContain(
      `Tomo from alice's main session (dm:alice), summoned into this group at the time, sent the following message here: "hello group"`,
    );

    await agent.stop();
  });

  it("keeps neutral attribution when the caller is not the summoning session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      router: { summonGroup(ch: string, chatId: string, identity: string): void };
      sessions: { get(key: string): { messages: Array<{ content: string }> } };
    };
    internals.router.summonGroup("telegram", "-987", "Alice");

    // Bob's own session direct-sends into Alice's summoned group
    const result = await agent.sendToSession("telegram:-987", "hi from bob", "telegram:222");

    expect(result).toEqual({ ok: true });
    expect(internals.sessions.get("telegram:-987").messages.at(-1)?.content)
      .toBe("[proactive] hi from bob");
    const neutralNotes = peekPendingNotes(agent, "telegram:-987");
    expect(neutralNotes).toHaveLength(1);
    expect(neutralNotes[0]).toMatch(/^<tomo-event type="direct-send" ts="[^"]+">/);
    expect(neutralNotes[0]).toContain(
      `Tomo from another session sent the following message to this conversation earlier: "hi from bob"`,
    );

    await agent.stop();
  });

  it("caps pending notes at 15 per session, keeping the most recent", async () => {
    const agent = new Agent();
    const internals = agent as unknown as {
      queuePendingNote(key: string, note: string): void;
    };

    for (let i = 0; i < 20; i++) internals.queuePendingNote("telegram:-987", `note-${i}`);

    const notes = peekPendingNotes(agent, "telegram:-987");
    expect(notes).toHaveLength(15);
    expect(notes[0]).toBe("note-5");
    expect(notes.at(-1)).toBe("note-19");

    await agent.stop();
  });

  it("restores pending direct-send context after a restart and drains it once", async () => {
    const firstAgent = new Agent();
    const tg = new MockChannel("telegram");
    firstAgent.addChannel(tg);

    await firstAgent.sendToSession("telegram:12345", "survive restart", "dm:alice");
    await firstAgent.stop();

    const secondAgent = new Agent();
    const internals = secondAgent as unknown as {
      drainPendingNotes(key: string): string;
    };
    expect(internals.drainPendingNotes("telegram:12345")).toContain(
      'Tomo from another session sent the following message to this conversation earlier: "survive restart"',
    );
    await secondAgent.stop();

    const thirdAgent = new Agent();
    const thirdInternals = thirdAgent as unknown as {
      drainPendingNotes(key: string): string;
    };
    expect(thirdInternals.drainPendingNotes("telegram:12345")).toBe("");
    await thirdAgent.stop();
  });

  it("reports success after delivery when local persistence fails", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const sessions = (agent as unknown as { sessions: SessionStore }).sessions;
    vi.spyOn(sessions, "append").mockImplementation(() => {
      throw new Error("disk full");
    });
    vi.spyOn(sessions, "setPendingNotes").mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await agent.sendToSession("telegram:12345", "delivered once", "dm:alice");

    expect(result).toEqual({ ok: true });
    expect(tg.delivered).toEqual([
      { chatId: "12345", text: "delivered once", photo: undefined, sticker: undefined },
    ]);
    await agent.stop();
  });
});


// ===== sendNotification =====

describe("sendNotification", () => {
  it("sends to dm: session reply target", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.sendNotification("Tomo v0.4.0 is available!");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("Tomo v0.4.0 is available!");
    expect(tg.sent[0].chatId).toBe("12345");

    await agent.stop();
  });

  it("falls back to non-group channel: session without identity", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.sendNotification("Update available");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].chatId).toBe("12345");

    await agent.stop();
  });

  it("skips group sessions in fallback", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // Only a group session
    await tg.simulateMessage(makeMsg({
      chatId: "-100group",
      text: "@tomo hi",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.sendNotification("Update available");

    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("no-ops when no sessions exist", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await agent.sendNotification("Update available");

    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });
});
