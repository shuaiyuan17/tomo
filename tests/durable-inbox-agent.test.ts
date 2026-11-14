import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  installAgentTestHooks,
  makeMsg,
  mockConfig,
  mockSdk,
  peekPendingNotes,
  resetConfig,
  waitFor,
} from "./helpers/agent-harness.js";
import { DurableInbox, INBOX_STALE_NOT_PROCESSED } from "../src/agent/durable-inbox.js";

installAgentTestHooks();

// ---------------------------------------------------------------------------
// The durable inbox, end to end: a message the channel handed over is written
// to disk before custody is acknowledged, so a daemon that dies before a turn
// consumes it answers it on the next start instead of losing it.
// ---------------------------------------------------------------------------

const NOT_PROCESSED = "[not processed — shutting down]";

function transcript(sessionKey: string): string {
  const file = join(mockConfig.sessionsDir, `${sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function inboxPath(): string {
  return join(mockConfig.tomoHome, "data", "inbox.jsonl");
}

/** Read-only: a second writer would compact the file under the agent's open descriptor. */
function openInbox(): DurableInbox {
  return new DurableInbox({ path: inboxPath(), readOnly: true });
}

/**
 * What SIGKILL leaves behind: every in-memory structure gone, nothing recorded.
 * Emptying the batcher without recording stands in for the process vanishing
 * (the real one would also lose its timers and promise chains).
 */
function crash(agent: Agent): void {
  (agent as unknown as { batcher: { drainForShutdown(): unknown } }).batcher.drainForShutdown();
  (agent as unknown as { inbox?: DurableInbox }).inbox?.close();
}

async function boot(settleMs = 0): Promise<{ agent: Agent; channel: MockChannel }> {
  resetConfig({ inbox: true, imessageInboundSettleMs: settleMs, tomoHome: mockConfig.tomoHome });
  const agent = new Agent();
  const channel = new MockChannel("imessage");
  agent.addChannel(channel);
  await agent.start();
  return { agent, channel };
}

describe("durable inbox: crash and replay", () => {
  it("answers on the next start a message that was waiting when the daemon died", async () => {
    // A long settle window parks the message in the batcher: accepted by the
    // channel (cursor committed in production), no turn yet.
    const first = await boot(60_000);
    mockSdk.responseFn = async () => "answered";
    expect(await first.channel.simulateMessage(makeMsg({ id: "m1", chatId: "555", text: "are you there?" }))).toBe(true);
    expect(openInbox().pending().map((r) => r.message.id)).toEqual(["m1"]);
    crash(first.agent);
    expect(transcript("imessage:555")).toBe("");

    const second = await boot();
    await waitFor(() => expect(second.channel.delivered.map((d) => d.text)).toEqual(["answered"]));
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("are you there?"))).toBe(true);
    // Told the model it is answering late.
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("being answered late"))).toBe(true);
    // Recorded once, and consumed.
    expect(transcript("imessage:555").split("are you there?").length - 1).toBe(1);
    await waitFor(() => expect(openInbox().pending()).toEqual([]));
    await second.agent.stop();
  });

  it("replays waiting messages in the order they arrived", async () => {
    const first = await boot(60_000);
    await first.channel.simulateMessage(makeMsg({ id: "o1", chatId: "556", text: "first thing" }));
    await first.channel.simulateMessage(makeMsg({ id: "o2", chatId: "556", text: "second thing" }));
    crash(first.agent);

    const second = await boot(30);
    mockSdk.responseFn = async () => "ok";
    await waitFor(() => expect(second.channel.delivered.length).toBeGreaterThan(0));
    const prompts = mockSdk.promptsBySession.map((p) => p.text).join("\n");
    expect(prompts.indexOf("first thing")).toBeGreaterThanOrEqual(0);
    expect(prompts.indexOf("first thing")).toBeLessThan(prompts.indexOf("second thing"));
    // Settled together, so they coalesced into one turn.
    expect(mockSdk.promptsBySession.filter((p) => p.text.includes("first thing"))).toHaveLength(1);
    expect(mockSdk.promptsBySession.find((p) => p.text.includes("first thing"))?.text).toContain("second thing");
    await second.agent.stop();
  });

  it("does not answer twice when the channel redelivers a message it had not acknowledged", async () => {
    const first = await boot(60_000);
    await first.channel.simulateMessage(makeMsg({ id: "dup", chatId: "557", text: "only once please" }));
    crash(first.agent);

    const second = await boot();
    mockSdk.responseFn = async () => "once";
    // imsg never committed its cursor for this row, so it comes again.
    expect(await second.channel.simulateMessage(makeMsg({ id: "dup", chatId: "557", text: "only once please" }))).toBe(true);
    await waitFor(() => expect(second.channel.delivered).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(second.channel.delivered).toHaveLength(1);
    expect(mockSdk.promptsBySession.filter((p) => p.text.includes("only once please"))).toHaveLength(1);
    await second.agent.stop();
  });

  it("does not re-run a turn the crash interrupted, and tells the session instead", async () => {
    const first = await boot();
    let turns = 0;
    mockSdk.responseFn = () => { turns++; return new Promise(() => {}); };
    await first.channel.simulateMessage(makeMsg({ id: "mid", chatId: "558", text: "book the table" }));
    await waitFor(() => expect(turns).toBe(1));
    expect(openInbox().pending()[0]?.status).toBe("started");
    crash(first.agent);

    const second = await boot();
    expect(mockSdk.promptsBySession.filter((p) => p.text.includes("book the table"))).toHaveLength(1);
    expect(peekPendingNotes(second.agent, "imessage:558").join("\n")).toContain("may be missing or incomplete");
    expect(openInbox().pending()).toEqual([]);
    await second.agent.stop();
  });

  it("records instead of answering a message older than the replay window", async () => {
    const first = await boot(60_000);
    await first.channel.simulateMessage(makeMsg({ id: "old", chatId: "559", text: "from last week" }));
    crash(first.agent);

    resetConfig({ inbox: true, inboxReplayMaxAgeMinutes: 0, tomoHome: mockConfig.tomoHome });
    const agent = new Agent();
    const channel = new MockChannel("imessage");
    agent.addChannel(channel);
    await agent.start();
    expect(channel.delivered).toEqual([]);
    const text = transcript("imessage:559");
    expect(text).toContain("from last week");
    expect(text).toContain(INBOX_STALE_NOT_PROCESSED);
    expect(openInbox().pending()).toEqual([]);
    await agent.stop();
  });
});

describe("durable inbox: identities and startup", () => {
  it("dispatches an attachment follow-up that reuses its original message's id", async () => {
    const { agent, channel } = await boot();
    mockSdk.responseFn = async () => "ok";
    await channel.simulateMessage(makeMsg({ id: "guid-9", chatId: "562", text: "look at this" }));
    await waitFor(() => expect(channel.delivered).toHaveLength(1));
    expect(await channel.simulateMessage(makeMsg({
      id: "guid-9",
      chatId: "562",
      inboxKey: "attachments:0",
      text: "[Attachments from an earlier message finished downloading]",
    }))).toBe(true);
    await waitFor(() => expect(channel.delivered).toHaveLength(2));
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("finished downloading"))).toBe(true);
    await agent.stop();
  });

  it("replays only what the previous run left, not a message that arrives while channels start", async () => {
    const first = await boot(60_000);
    await first.channel.simulateMessage(makeMsg({ id: "left", chatId: "563", text: "left over" }));
    crash(first.agent);

    // A channel that ingests during its own start(), as both provider channels do.
    class EagerChannel extends MockChannel {
      override async start() {
        await this.simulateMessage(makeMsg({ id: "fresh", chatId: "563", text: "brand new" }));
      }
    }
    resetConfig({ inbox: true, imessageInboundSettleMs: 30 });
    const agent = new Agent();
    const channel = new EagerChannel("imessage");
    agent.addChannel(channel);
    mockSdk.responseFn = async () => "ok";
    await agent.start();
    await waitFor(() => expect(openInbox().pending()).toEqual([]));
    const prompts = mockSdk.promptsBySession.map((p) => p.text).join("\n");
    expect(prompts.split("brand new").length - 1).toBe(1);
    expect(prompts.split("left over").length - 1).toBe(1);
    expect(transcript("imessage:563").split("brand new").length - 1).toBe(1);
    await agent.stop();
  });
});

describe("durable inbox: graceful shutdown", () => {
  it("leaves a waiting message for the next start instead of marking it not processed", async () => {
    const first = await boot(60_000);
    await first.channel.simulateMessage(makeMsg({ id: "g1", chatId: "560", text: "sent during restart" }));
    await first.agent.stop();

    expect(transcript("imessage:560")).not.toContain(NOT_PROCESSED);
    expect(openInbox().pending().map((r) => r.message.id)).toEqual(["g1"]);

    const second = await boot();
    mockSdk.responseFn = async () => "back";
    await waitFor(() => expect(second.channel.delivered.map((d) => d.text)).toEqual(["back"]));
    await second.agent.stop();
  });

  it("keeps the in-memory behaviour when the inbox is off", async () => {
    resetConfig({ inbox: false, imessageInboundSettleMs: 60_000 });
    const agent = new Agent();
    const channel = new MockChannel("imessage");
    agent.addChannel(channel);
    await agent.start();
    await channel.simulateMessage(makeMsg({ id: "off", chatId: "561", text: "no inbox" }));
    await agent.stop();

    expect(transcript("imessage:561")).toContain(NOT_PROCESSED);
    expect(existsSync(inboxPath())).toBe(false);
  });
});

describe("durable inbox: what never reaches disk", () => {
  it("does not persist the group secret", async () => {
    resetConfig({ inbox: true, groupSecret: "open-sesame" });
    const agent = new Agent();
    const imessage = new MockChannel("imessage");
    agent.addChannel(imessage);
    await agent.start();
    mockSdk.responseFn = async () => "ok";
    await imessage.simulateMessage(makeMsg({ id: "s1", chatId: "chat;+;group", isGroup: true, text: "open-sesame" }));
    await new Promise((r) => setTimeout(r, 20));
    const onDisk = existsSync(inboxPath()) ? readFileSync(inboxPath(), "utf8") : "";
    expect(onDisk).not.toContain("open-sesame");
    await agent.stop();
  });
});
