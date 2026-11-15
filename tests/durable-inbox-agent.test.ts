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
import { DurableInbox, INBOX_STALE_NOT_PROCESSED, type WriteFn } from "../src/agent/durable-inbox.js";
import { InboxPersistError } from "../src/agent.js";
import { writeSync } from "node:fs";

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
    const note = peekPendingNotes(second.agent, "imessage:558").join("\n");
    expect(note).toContain("may be missing or incomplete");
    // The note quotes the message itself: the turn may have died before the
    // prompt reached the transcript, and the session must be able to answer.
    expect(note).toContain("book the table");
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

/** Swap the agent's inbox for one over the same file whose writes go through `write`. */
function useWriter(agent: Agent, write: WriteFn): void {
  const internals = agent as unknown as { inbox?: DurableInbox };
  internals.inbox?.close();
  internals.inbox = new DurableInbox({ path: inboxPath(), writeSync: write });
}

const realWrite: WriteFn = (fd, buf, off, len) => writeSync(fd, buf, off, len);
const failingWrite: WriteFn = () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };

async function bootWith(channelName: string, write: WriteFn, extra: Record<string, unknown> = {}) {
  resetConfig({ inbox: true, imessageInboundSettleMs: 0, tomoHome: mockConfig.tomoHome, ...extra });
  const agent = new Agent();
  useWriter(agent, write);
  const channel = new MockChannel(channelName);
  agent.addChannel(channel);
  await agent.start();
  return { agent, channel };
}

describe("durable inbox: when a turn counts as started", () => {
  it("a crash before the prompt reaches the SDK replays the message instead of writing it off", async () => {
    const first = await boot();
    // Hold the turn while its live session is still being built: past the
    // queue, before anything was handed to the model.
    const internals = first.agent as unknown as { mcpOAuthManager: { buildServersWithAuth: (...a: unknown[]) => Promise<unknown> } };
    let building = 0;
    internals.mcpOAuthManager.buildServersWithAuth = () => { building++; return new Promise(() => {}); };
    await first.channel.simulateMessage(makeMsg({ id: "pre", chatId: "575", text: "not yet seen" }));
    await waitFor(() => expect(building).toBe(1));
    expect(openInbox().pending()[0]?.status).toBe("received");
    crash(first.agent);

    const second = await boot();
    mockSdk.responseFn = async () => "seen now";
    await waitFor(() => expect(second.channel.delivered.map((d) => d.text)).toEqual(["seen now"]));
    await second.agent.stop();
  });
});

describe("durable inbox: a write that fails at ingress", () => {
  it("imsg: does not take custody, so the cursor stays and the row is redelivered", async () => {
    let healthy = false;
    const { agent, channel } = await bootWith("imessage", (fd, buf, off, len) => (healthy ? realWrite(fd, buf, off, len) : failingWrite(fd, buf, off, len)));
    Object.assign(channel, { redeliversUnacknowledged: true });
    mockSdk.responseFn = async () => "answered";

    // A throw is the hand-off contract's "not handled": imsg's processWatchRow
    // skips the cursor advance and recoverFromGap replays the row.
    await expect(channel.simulateMessage(makeMsg({ id: "w1", chatId: "570", text: "did you get this" })))
      .rejects.toBeInstanceOf(InboxPersistError);
    await new Promise((r) => setTimeout(r, 30));
    // Not dispatched in memory either: the redelivery is the only copy.
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("did you get this"))).toBe(false);
    expect(channel.delivered).toEqual([]);

    healthy = true;
    expect(await channel.simulateMessage(makeMsg({ id: "w1", chatId: "570", text: "did you get this" }))).toBe(true);
    await waitFor(() => expect(channel.delivered.map((d) => d.text)).toEqual(["answered"]));
    expect(mockSdk.promptsBySession.filter((p) => p.text.includes("did you get this"))).toHaveLength(1);
    await agent.stop();
  });

  it("telegram: already acknowledged, so it is answered in memory and the owner is told", async () => {
    const { agent, channel } = await bootWith("telegram", failingWrite);
    const notify = vi.spyOn(agent, "notifyOwner").mockResolvedValue(true);
    mockSdk.responseFn = async () => "answered anyway";

    expect(await channel.simulateMessage(makeMsg({ id: "t1", chatId: "571", text: "hello" }))).toBe(true);
    await waitFor(() => expect(channel.delivered.map((d) => d.text)).toEqual(["answered anyway"]));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("could not save an incoming telegram message");
    await agent.stop();
  });
});

describe("durable inbox: a start mark that cannot be written", () => {
  /** Fails every single-line `start` append; everything else is written. */
  const failStartAppends: WriteFn = (fd, buf, off, len) => {
    if (Buffer.from(buf).subarray(off, off + len).toString("utf8").replace(/^\n/, "").startsWith('{"op":"start"')) {
      return failingWrite(fd, buf, off, len);
    }
    return realWrite(fd, buf, off, len);
  };

  it("leaves no replayable state behind: a crash mid-turn is not answered twice", async () => {
    const first = await bootWith("imessage", failStartAppends);
    let turns = 0;
    mockSdk.responseFn = () => { turns++; return new Promise(() => {}); };
    await first.channel.simulateMessage(makeMsg({ id: "s1", chatId: "572", text: "transfer the money" }));
    await waitFor(() => expect(turns).toBe(1));
    // The append failed twice; the rewrite recorded the start instead.
    expect(openInbox().pending()[0]?.status).toBe("started");
    crash(first.agent);

    const second = await boot();
    await new Promise((r) => setTimeout(r, 30));
    expect(mockSdk.promptsBySession.filter((p) => p.text.includes("transfer the money"))).toHaveLength(1);
    expect(peekPendingNotes(second.agent, "imessage:572").join("\n")).toContain("transfer the money");
    await second.agent.stop();
  });
});

function steers(agent: Agent, key: string): number {
  const sessions = (agent as unknown as { liveSessionManager: { liveSessions: Map<string, { steeredRequestCount(): number }> } }).liveSessionManager.liveSessions;
  return sessions.get(key)?.steeredRequestCount() ?? 0;
}

describe("durable inbox: steered into another turn", () => {
  it("stays open until the host turn finishes, so a crash before then still surfaces it", async () => {
    const { agent, channel } = await bootWith("imessage", realWrite, { steering: true });
    mockSdk.steerEcho = true;
    let releaseHost: (() => void) | null = null;
    const hostGate = new Promise<void>((r) => { releaseHost = r; });
    mockSdk.responseFn = async (text) => {
      if (text.includes("CRON JOB")) { await hostGate; return "cron reply"; }
      return "misc";
    };

    // The host is a cron turn — no inbox record of its own. Its queue task is
    // held open past its result, standing in for delivery and transcript work
    // still running when the daemon dies.
    let releaseTail: (() => void) | null = null;
    const tailGate = new Promise<void>((r) => { releaseTail = r; });
    const runner = (agent as unknown as { turnRunner: { runTurn: (spec: { source: string }) => Promise<boolean> } }).turnRunner;
    const realRunTurn = runner.runTurn.bind(runner);
    runner.runTurn = async (spec) => {
      const ok = await realRunTurn(spec);
      if (spec.source === "cron") await tailGate;
      return ok;
    };

    void agent.handleCronMessage("CRON JOB", "imessage:573");
    const live = () => (agent as unknown as { liveSessionManager: { isBusy(k: string): boolean } }).liveSessionManager.isBusy("imessage:573");
    await waitFor(() => expect(live()).toBe(true));
    await channel.simulateMessage(makeMsg({ id: "st1", chatId: "573", text: "steered question" }));
    await waitFor(() => expect(steers(agent, "imessage:573")).toBe(1));
    releaseHost!();
    // The host's result has resolved the steer as merged; its task is still open.
    await waitFor(() => expect(live()).toBe(false));
    await new Promise((r) => setTimeout(r, 30));
    expect(openInbox().pending().map((r) => r.message.id)).toEqual(["st1"]);
    crash(agent);

    const second = await boot();
    expect(peekPendingNotes(second.agent, "imessage:573").join("\n")).toContain("steered question");
    releaseTail!();
    await second.agent.stop();
  });

  it("is consumed once the host turn's task ends", async () => {
    const { agent, channel } = await bootWith("imessage", realWrite, { steering: true });
    mockSdk.steerEcho = true;
    let releaseHost: (() => void) | null = null;
    const hostGate = new Promise<void>((r) => { releaseHost = r; });
    mockSdk.responseFn = async (text) => {
      if (text.includes("CRON JOB")) { await hostGate; return "cron reply"; }
      return "misc";
    };
    const cron = agent.handleCronMessage("CRON JOB", "imessage:574");
    const live = () => (agent as unknown as { liveSessionManager: { isBusy(k: string): boolean } }).liveSessionManager.isBusy("imessage:574");
    await waitFor(() => expect(live()).toBe(true));
    await channel.simulateMessage(makeMsg({ id: "st2", chatId: "574", text: "another steer" }));
    await waitFor(() => expect(steers(agent, "imessage:574")).toBe(1));
    releaseHost!();
    await cron;
    expect(mockSdk.promptsBySession.filter((p) => p.text.includes("another steer"))).toHaveLength(0);
    expect(mockSdk.userContents.some((c) => JSON.stringify(c).includes("another steer"))).toBe(true);
    await waitFor(() => expect(openInbox().pending()).toEqual([]));
    await agent.stop();
  });
});

describe("durable inbox: the interrupted-turn note takes custody", () => {
  async function interruptedFirstRun(chatId: string, text: string): Promise<void> {
    const first = await boot();
    let turns = 0;
    mockSdk.responseFn = () => { turns++; return new Promise(() => {}); };
    await first.channel.simulateMessage(makeMsg({ id: `i-${chatId}`, chatId, text }));
    await waitFor(() => expect(turns).toBe(1));
    crash(first.agent);
  }

  it("keeps the inbox record when the note cannot be persisted", async () => {
    await interruptedFirstRun("580", "remember the milk");
    resetConfig({ inbox: true, imessageInboundSettleMs: 0, tomoHome: mockConfig.tomoHome });
    const agent = new Agent();
    const sessions = (agent as unknown as { sessions: { setPendingNotes: (k: string, n: string[]) => void } }).sessions;
    const realSet = sessions.setPendingNotes.bind(sessions);
    sessions.setPendingNotes = (k, n) => {
      if (n.some((x) => x.includes("remember the milk"))) throw new Error("EIO");
      realSet(k, n);
    };
    const channel = new MockChannel("imessage");
    agent.addChannel(channel);
    await agent.start();
    expect(openInbox().pending().map((r) => r.message.text)).toEqual(["remember the milk"]);
    crash(agent);

    // The next start still has it, and tells the session.
    const third = await boot();
    expect(peekPendingNotes(third.agent, "imessage:580").join("\n")).toContain("remember the milk");
    await third.agent.stop();
  });

  it("a crash while the note's turn is running delivers the note again", async () => {
    await interruptedFirstRun("581", "call the plumber");
    const second = await boot();
    expect(openInbox().pending()).toEqual([]);
    // The next turn takes the note and dies mid-turn.
    let turns = 0;
    mockSdk.responseFn = () => { turns++; return new Promise(() => {}); };
    await second.channel.simulateMessage(makeMsg({ id: "next-581", chatId: "581", text: "anything new?" }));
    await waitFor(() => expect(turns).toBe(1));
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("call the plumber"))).toBe(true);
    crash(second.agent);

    const third = await boot();
    expect(peekPendingNotes(third.agent, "imessage:581").join("\n")).toContain("call the plumber");
    // Taken by a turn that never finished: marked as possibly partly answered.
    expect(peekPendingNotes(third.agent, "imessage:581").join("\n")).toContain("you may already have partly answered it");
    await third.agent.stop();
  });

  it("quotes every message in full, however long, with saved attachment paths", async () => {
    const first = await boot(60_000);
    // Far past one note part: split across parts, never shortened.
    const long = `HEAD${"y".repeat(39_990)}TAIL`;
    await first.channel.simulateMessage(makeMsg({ id: "q0", chatId: "582", text: long }));
    for (let i = 1; i <= 11; i++) await first.channel.simulateMessage(makeMsg({ id: `q${i}`, chatId: "582", text: `msg number ${i}` }));
    await first.channel.simulateMessage(makeMsg({
      id: "q12", chatId: "582", text: "see photo",
      images: [{ data: "AAAA", mediaType: "image/png", savedPath: "/tmp/tomo-test-photo.png" }],
    }));
    // Mark every record started, as a turn taking them all would.
    const inbox = (first.agent as unknown as { inbox: DurableInbox }).inbox;
    inbox.markStarted(inbox.pending().map((r) => r.id));
    crash(first.agent);

    const second = await boot();
    const notes = peekPendingNotes(second.agent, "imessage:582").join("\n");
    expect(notes).toContain("HEAD");
    expect(notes).toContain("TAIL");
    expect(notes.match(/y/g)?.length ?? 0).toBeGreaterThanOrEqual(39_990);
    expect(notes).toContain("msg number 11");
    expect(notes).toContain("/tmp/tomo-test-photo.png");
    await second.agent.stop();
  });
});

describe("durable inbox: start means the SDK took it", () => {
  it("a steered message still waiting in the input queue is replayed after a crash", async () => {
    const { agent, channel } = await bootWith("imessage", realWrite, { steering: true });
    // No echo: the mock SDK does not pull the steered message while the host turn runs.
    mockSdk.responseFn = (text) => (text.includes("CRON JOB") ? new Promise(() => {}) : Promise.resolve("misc"));
    void agent.handleCronMessage("CRON JOB", "imessage:583");
    await waitFor(() => expect(steers(agent, "imessage:583")).toBe(0));
    const live = () => (agent as unknown as { liveSessionManager: { isBusy(k: string): boolean } }).liveSessionManager.isBusy("imessage:583");
    await waitFor(() => expect(live()).toBe(true));
    await channel.simulateMessage(makeMsg({ id: "q-583", chatId: "583", text: "queued not taken" }));
    await waitFor(() => expect(steers(agent, "imessage:583")).toBe(1));
    expect(openInbox().pending()[0]?.status).toBe("received");
    crash(agent);

    const second = await boot();
    mockSdk.responseFn = async () => "replayed";
    await waitFor(() => expect(second.channel.delivered.map((d) => d.text)).toEqual(["replayed"]));
    await second.agent.stop();
  });
});

describe("durable inbox: a turn that ends before the model sees it", () => {
  it("leaves the message for replay and keeps the interrupted note", async () => {
    const first = await boot();
    let turns = 0;
    mockSdk.responseFn = () => { turns++; return new Promise(() => {}); };
    await first.channel.simulateMessage(makeMsg({ id: "nb1", chatId: "590", text: "first ask" }));
    await waitFor(() => expect(turns).toBe(1));
    crash(first.agent);

    // Second run: the next turn cannot even build its session.
    const second = await boot();
    const internals = second.agent as unknown as { mcpOAuthManager: { buildServersWithAuth: (...a: unknown[]) => Promise<unknown> } };
    internals.mcpOAuthManager.buildServersWithAuth = async () => { throw new Error("session build failed"); };
    await second.channel.simulateMessage(makeMsg({ id: "nb2", chatId: "590", text: "second ask" }));
    await waitFor(() => expect(second.channel.delivered.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));
    // Never reached the model: neither the message nor the note is consumed.
    expect(openInbox().pending().map((r) => [r.message.id, r.status])).toEqual([["nb2", "received"]]);
    expect(peekPendingNotes(second.agent, "imessage:590").join("\n")).toContain("first ask");
    crash(second.agent);

    const third = await boot();
    mockSdk.responseFn = async () => "both answered";
    await waitFor(() => expect(third.channel.delivered.map((d) => d.text)).toContain("both answered"));
    const prompt = mockSdk.promptsBySession.filter((p) => p.sessionKey === "imessage:590").map((p) => p.text).join("\n");
    expect(prompt).toContain("first ask");
    expect(prompt).toContain("second ask");
    await third.agent.stop();
  });
});

describe("durable inbox: deliberate pauses do not consume", () => {
  it("a message dropped during /restore is answered after the restart", async () => {
    const first = await boot();
    (first.agent as unknown as { commands: { restoringConfig: boolean } }).commands.restoringConfig = true;
    await first.channel.simulateMessage(makeMsg({ id: "rs1", chatId: "591", text: "during restore" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(openInbox().pending().map((r) => [r.message.id, r.status])).toEqual([["rs1", "received"]]);
    crash(first.agent);

    const second = await boot();
    mockSdk.responseFn = async () => "after restore";
    await waitFor(() => expect(second.channel.delivered.map((d) => d.text)).toEqual(["after restore"]));
    await second.agent.stop();
  });

  it("a turn graceful shutdown cuts short is surfaced on the next start, like a crash", async () => {
    const first = await boot();
    let turns = 0;
    mockSdk.responseFn = () => { turns++; return new Promise(() => {}); };
    await first.channel.simulateMessage(makeMsg({ id: "gs1", chatId: "592", text: "halfway there" }));
    await waitFor(() => expect(turns).toBe(1));
    await first.agent.stop();
    expect(openInbox().pending().map((r) => [r.message.id, r.status])).toEqual([["gs1", "started"]]);

    const second = await boot();
    expect(peekPendingNotes(second.agent, "imessage:592").join("\n")).toContain("halfway there");
    await second.agent.stop();
  });
});

describe("durable inbox: an interrupted note whose turn ends on an API error", () => {
  it("is not consumed by an error response (429) and rides the next turn", async () => {
    const first = await boot();
    let turns = 0;
    mockSdk.responseFn = () => { turns++; return new Promise(() => {}); };
    await first.channel.simulateMessage(makeMsg({ id: "ae1", chatId: "594", text: "lost request" }));
    await waitFor(() => expect(turns).toBe(1));
    crash(first.agent);

    const second = await boot();
    mockSdk.responseFn = async () => "API Error: 429 rate limited";
    await second.channel.simulateMessage(makeMsg({ id: "ae2", chatId: "594", text: "anyone?" }));
    await waitFor(() => expect(mockSdk.promptsBySession.some((p) => p.text.includes("lost request") && p.text.includes("anyone?"))).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(peekPendingNotes(second.agent, "imessage:594").join("\n")).toContain("lost request");

    mockSdk.promptsBySession = [];
    mockSdk.responseFn = async () => "answered now";
    await second.channel.simulateMessage(makeMsg({ id: "ae3", chatId: "594", text: "retry" }));
    await waitFor(() => expect(mockSdk.promptsBySession.some((p) => p.text.includes("lost request") && p.text.includes("retry"))).toBe(true));
    await waitFor(() => expect(peekPendingNotes(second.agent, "imessage:594").join("\n")).not.toContain("lost request"));
    await second.agent.stop();
  });
});

describe("durable inbox: an interrupted note whose own turn is cut short", () => {
  it("is kept for the next start, marked as possibly partly answered", async () => {
    const first = await boot();
    let turns = 0;
    mockSdk.responseFn = () => { turns++; return new Promise(() => {}); };
    await first.channel.simulateMessage(makeMsg({ id: "cs1", chatId: "593", text: "original request" }));
    await waitFor(() => expect(turns).toBe(1));
    crash(first.agent);

    // Second run: the note rides into a turn the SDK takes, and graceful
    // shutdown stops that turn mid-flight.
    const second = await boot();
    expect(openInbox().pending()).toEqual([]);
    turns = 0;
    await second.channel.simulateMessage(makeMsg({ id: "cs2", chatId: "593", text: "hello again" }));
    await waitFor(() => expect(turns).toBe(1));
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("original request") && p.text.includes("hello again"))).toBe(true);
    await second.agent.stop();

    const third = await boot();
    const notes = peekPendingNotes(third.agent, "imessage:593").join("\n");
    expect(notes).toContain("original request");
    expect(notes).toContain("you may already have partly answered it");
    await third.agent.stop();
  });
});
