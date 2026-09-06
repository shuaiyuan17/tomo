import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSdkSessionPath } from "../src/sessions/index.js";
import { getCompactTriggerPath } from "../src/lcm/compact.js";
import { CONTINUITY_DELIVERY_NOTE } from "../src/continuity-defaults.js";
import { formatTomoEvent } from "../src/tomo-event.js";
import { isWarmTailCandidate } from "../src/lcm/blocks.js";
import { ESTIMATED_READING_WARN_AFTER } from "../src/agent/live-session.js";
import { watchBus } from "../src/watch/bus.js";
import type { WatchEvent } from "../src/watch/protocol.js";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  agentEnv,
  drainQueue,
  expectNoChangeFor,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  resetConfig,
  waitFor,
} from "./helpers/agent-harness.js";
import { log } from "../src/logger.js";

installAgentTestHooks();

// ===== Cron delivery =====

describe("cron message delivery", () => {
  it("reports the turn's outcome to the caller (CronScheduler.markRun)", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => "All done!";
    await expect(agent.handleCronMessage("Task", "telegram:12345")).resolves.toBe(true);

    mockSdk.responseFn = () => "NO_REPLY";
    await expect(agent.handleCronMessage("Quiet task", "telegram:12345")).resolves.toBe(true);

    // An agent-level error response resolves false (never rejects) so the
    // scheduler records lastStatus "error" instead of "ok".
    mockSdk.responseFn = () => "API Error: 529 overloaded";
    await expect(agent.handleCronMessage("Failing task", "telegram:12345")).resolves.toBe(false);

    await agent.stop();
  });

  it("reports a turn the SDK ended on an error result as failed, and delivers the error to a DM", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => "got as far as this";
    mockSdk.nextResult = { subtype: "error_max_turns", is_error: true, errors: ["too many turns"] };

    const ok = await agent.handleCronMessage("Big task", "telegram:12345");

    // CronScheduler.markRun sees a failed run — not the clean success the
    // partial text used to report.
    expect(ok).toBe(false);
    expect(tg.delivered.map((d) => d.text)).toEqual([
      "got as far as this",
      "[error] cron failed: I ran out of steps trying to complete that. Can you try a simpler request?",
    ]);

    await agent.stop();
  });

  it("keeps an SDK error result out of a group cron's chat (note-only) while still reporting failure", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "-100group", text: "@tomo hi", isGroup: true, isMentioned: true }));
    await drainQueue(agent);
    tg.clearDelivered();

    // No text at all this time: the CLI died before the model said anything.
    mockSdk.responseFn = () => [];
    mockSdk.nextResult = { subtype: "error_during_execution", is_error: true, errors: ["boom"] };

    const ok = await agent.handleCronMessage("Group digest", "telegram:-100group");

    expect(ok).toBe(false);
    // Scheduled infrastructure failures must never be posted into a group.
    expect(tg.delivered).toEqual([]);

    // The failure is briefed to the next turn on that session instead.
    mockSdk.responseFn = () => "next";
    mockSdk.userContents = [];
    await tg.simulateMessage(makeMsg({ chatId: "-100group", text: "@tomo again", isGroup: true, isMentioned: true }));
    await drainQueue(agent);
    const nextPrompt = mockSdk.userContents.map((c) => c.map((b) => b.text ?? "").join("")).join("\n");
    expect(nextPrompt).toContain("cron failed");
    expect(nextPrompt).toContain("stopped early");

    await agent.stop();
  });

  it("delivers cron response to channel: session", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "Time to stretch!";

    // Establish session first
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleCronMessage("Stretch reminder", "telegram:12345");

    // Cron uses channel.send(), not streaming
    expect(tg.sent.length).toBeGreaterThanOrEqual(1);
    expect(tg.sent[0].chatId).toBe("12345");
    expect(tg.sent[0].text).toBe("Time to stretch!");

    await agent.stop();
  });

  it("delivers a multi-line cron response as one message", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => "  first brief  \nsecond detail\n\n  third brief  ";

    await agent.handleCronMessage("Morning briefing", "telegram:12345");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toBe("first brief  \nsecond detail\n\n  third brief");

    await agent.stop();
  });

  it("keeps cron MEDIA captions attached instead of newline-splitting them away from the photo", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const imagePath = join(agentEnv.tmpDir, "cron-captioned-photo.png");
    writeFileSync(imagePath, "fake image");

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => `caption line 1\ncaption line 2 MEDIA:"${imagePath}"`;

    await agent.handleCronMessage("Morning briefing", "telegram:12345");

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toMatchObject({
      chatId: "12345",
      text: "caption line 1\ncaption line 2",
      photo: imagePath,
    });

    await agent.stop();
  });

  it("delivers cron response to dm: session via identity", async () => {
    resetConfig({
      identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "Daily briefing";

    // Establish session
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleCronMessage("Morning briefing", "dm:shuai");

    expect(tg.sent.length).toBeGreaterThanOrEqual(1);
    expect(tg.sent[0].chatId).toBe("12345");

    await agent.stop();
  });

  it("suppresses NO_REPLY in cron", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "NO_REPLY";

    // Establish session
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    await agent.handleCronMessage("Check something", "telegram:12345");

    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("queues cron failures into the next turn as bounded operational context", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      runWithRetry: (req: unknown) => Promise<string>;
    };
    const originalRunWithRetry = internals.runWithRetry.bind(agent);
    internals.runWithRetry = vi.fn().mockRejectedValueOnce(
      new Error("You've hit your session limit · resets 3:10pm (America/Los_Angeles)"),
    ) as unknown as typeof internals.runWithRetry;

    await agent.handleCronMessage("Check something", "telegram:12345");

    expect(tg.sent[0].text).toBe(
      "[error] cron failed: You've hit your session limit · resets 3:10pm (America/Los_Angeles)",
    );

    internals.runWithRetry = originalRunWithRetry;
    const prompts: string[] = [];
    mockSdk.responseFn = (text) => {
      prompts.push(text);
      return "recovered";
    };

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "are you back?" }));
    await drainQueue(agent);

    expect(prompts[0]).toContain("Recent Tomo errors before this turn");
    expect(prompts[0]).toContain("[error] cron failed: You've hit your session limit");

    await agent.stop();
  });

  it("treats successful SDK session-limit text as an error and briefs the next turn", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const prompts: string[] = [];

    mockSdk.responseFn = (text) => {
      prompts.push(text);
      return prompts.length === 1
        ? "You've hit your session limit · resets 3:10pm (America/Los_Angeles)"
        : "recovered";
    };

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "first try" }));
    await drainQueue(agent);

    expect(tg.delivered.map((d) => d.text)).toEqual([
      "[error] You've hit your session limit · resets 3:10pm (America/Los_Angeles)",
    ]);

    tg.clearDelivered();
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "second try" }));
    await drainQueue(agent);

    expect(prompts[1]).toContain("Recent Tomo errors before this turn");
    expect(prompts[1]).toContain("[error] You've hit your session limit");
    expect(tg.delivered.map((d) => d.text)).toEqual(["recovered"]);

    await agent.stop();
  });

  it("caps pending error notes before injecting them into a prompt", async () => {
    const agent = new Agent();
    const internals = agent as unknown as {
      queuePendingErrorNote: (sessionKey: string, visibleError: string) => void;
      drainPendingNotes: (sessionKey: string) => string;
    };

    for (let i = 0; i < 10; i++) {
      internals.queuePendingErrorNote("telegram:12345", `[error] err-${i} ${"x".repeat(450)}`);
    }

    const drained = internals.drainPendingNotes("telegram:12345");
    const bulletCount = drained.match(/\n- /g)?.length ?? 0;

    expect(bulletCount).toBeLessThanOrEqual(3);
    expect(drained.length).toBeLessThan(1500);
    expect(drained).not.toContain("err-0");
    expect(drained).toContain("err-9");

    await agent.stop();
  });

  it("suppresses typing for silent housekeeping cron turns", async () => {
    resetConfig({ imessagePassiveTypingStartDelayMs: 0 });
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => "NO_REPLY";

    await agent.handleCronMessage(
      "System: An LCM rollup is due. After the rollup finishes, reply NO_REPLY.",
      "imessage:iMessage;+;group123",
      { showTyping: false },
    );

    expect(im.sent).toHaveLength(0);
    expect(im.typingStarts).toEqual([]);
    expect(im.typingStops).toEqual([]);

    await agent.stop();
  });

  it("never delivers LCM housekeeping output to a group", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    const responses = [
      "LCM compact completed, but I forgot to reply NO_REPLY",
      "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    ];
    mockSdk.responseFn = () => responses.shift()!;

    await agent.handleCronMessage(
      "System: An LCM rollup is due. After the rollup finishes, reply NO_REPLY.",
      "imessage:iMessage;+;group123",
      { showTyping: false, suppressDelivery: true },
    );
    await agent.handleCronMessage(
      "System: Another LCM rollup is due. After the rollup finishes, reply NO_REPLY.",
      "imessage:iMessage;+;group123",
      { showTyping: false, suppressDelivery: true },
    );

    expect(im.sent).toHaveLength(0);
    expect(im.typingStarts).toEqual([]);
    expect(im.typingStops).toEqual([]);

    await agent.stop();
  });

  it("never delivers thrown cron errors to a group", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      runWithRetry: (req: unknown) => Promise<string>;
    };
    internals.runWithRetry = vi.fn().mockRejectedValueOnce(
      new Error("Failed to authenticate. API Error: 401 Invalid authentication credentials"),
    ) as unknown as typeof internals.runWithRetry;

    await agent.handleCronMessage("Scheduled group task", "telegram:-100123");

    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("waitForHandoff resolves only after the summoned session's turn actually runs", async () => {
    resetConfig({
      identities: [
        { name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" },
      ],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      router: { summonGroup(channel: string, chatId: string, identity: string): void };
    };
    internals.router.summonGroup("telegram", "-100271", "shuai");

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let turnStarted = false;
    mockSdk.responseFn = async () => {
      turnStarted = true;
      await gate;
      return "NO_REPLY";
    };

    // The cron scheduler advances nextRunAt (and DELETES a one-shot) on this
    // boolean. Reporting "done" the moment the work is queued means the job is
    // marked complete before it runs, and a daemon that stops in between loses
    // the run with no interrupted-run trace to recover from.
    let settled = false;
    const run = agent
      .handleCronMessage("Scheduled group task", "telegram:-100271", { waitForHandoff: true })
      .then((ok) => { settled = true; return ok; });

    await waitFor(() => expect(turnStarted).toBe(true));
    expect(settled).toBe(false);

    release();
    await expect(run).resolves.toBe(true);

    const prompt = mockSdk.userContents.flat().map((block) => block.text ?? "").join("");
    expect(prompt).toContain("Scheduled group task");
    expect(prompt).toContain('type="summon-reminder"');

    await agent.stop();
  });

  it("runs group background work on the summoned dm session without reviving the group session", async () => {
    resetConfig({
      identities: [
        { name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" },
      ],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const internals = agent as unknown as {
      router: { summonGroup(channel: string, chatId: string, identity: string): void };
    };
    internals.router.summonGroup("telegram", "-100270", "shuai");
    mockSdk.responseFn = () => "NO_REPLY";

    await expect(agent.handleCronMessage("Scheduled group task", "telegram:-100270")).resolves.toBe(true);
    await drainQueue(agent);

    const prompt = mockSdk.userContents.flat().map((block) => block.text ?? "").join("");
    expect(prompt).toContain("Scheduled group task");
    expect(prompt).toContain('type="summon-reminder"');
    expect(agent.listActiveSessions().map(([key]) => key)).toContain("dm:shuai");
    expect(agent.listActiveSessions().map(([key]) => key)).not.toContain("telegram:-100270");
    expect(tg.delivered).toHaveLength(0);

    await agent.stop();
  });
});

// ===== Background task notification delivery =====

describe("background task notification delivery", () => {
  it("routes task-notification-triggered output to the session reply target", async () => {
    resetConfig({
      identities: [
        { name: "shuai", channels: { telegram: "12345", imessage: "+15551234567" }, replyPolicy: "last-active" },
      ],
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    agent.addChannel(tg);
    agent.addChannel(im);

    mockSdk.responseFn = () => "seeded";
    await im.simulateMessage(makeMsg({ chatId: "+15551234567", text: "Hi from iMessage" }));
    await drainQueue(agent);
    tg.clearDelivered();
    im.clearDelivered();

    expect(mockSdk.queryControllers).toHaveLength(1);
    mockSdk.queryControllers[0].pushTaskNotificationTurn("Background task is done.");

    await waitFor(() => expect(im.delivered).toHaveLength(1));
    expect(im.delivered[0]).toMatchObject({ chatId: "+15551234567", text: "Background task is done." });
    expect(tg.delivered).toHaveLength(0);

    await agent.stop();
  });

  it("suppresses NO_REPLY from task-notification-triggered turns", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    expect(mockSdk.queryControllers).toHaveLength(1);
    mockSdk.queryControllers[0].pushTaskNotificationTurn("NO_REPLY");

    await waitFor(() => expect(tg.typingStops).toHaveLength(1));
    expect(tg.delivered).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  // A "background task/agent" notifying another session (e.g. via the
  // delegate send_message tool, or a scheduled cron job) runs through
  // handleCronMessage -> TurnRunner, on the SAME per-block delivery path as
  // an owner reply: each completed block ships as it completes.
  //
  // NO_REPLY is therefore enforced per block (owner decision 2026-07-08, kept
  // exactly, at block scope): a block whose trailing line is the bare token
  // ships nothing at all, narration and attachments together. The #222
  // protection is unchanged — inline mentions of NO_REPLY do not silence.
  it("sends nothing for a send-turn whose narration block ends in NO_REPLY", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    // The token is inside the narration block, so the block ships nothing —
    // text and attachments together. This is the invariant that survives
    // mid-turn delivery intact.
    mockSdk.responseFn = () => [
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } },
      "housekeeping narration not meant for the channel\nNO_REPLY",
    ];
    await expect(agent.handleCronMessage("System: background task done", "telegram:12345")).resolves.toBe(true);

    expect(tg.delivered).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  /**
   * The honest cost of mid-turn delivery, asserted rather than discovered.
   *
   * The reported repro shape is text -> tool_use -> tool_use -> NO_REPLY. The
   * narration is its OWN completed block, so it reaches the channel before the
   * model ever writes the token — no end-of-turn rule can recall it, and
   * holding only the LAST block back would not have saved it either. A turn
   * that must stay silent whatever the model writes has to say so up front
   * with suppressDelivery (next test), which does not depend on the model.
   */
  it("cannot unsend an earlier narration block when a later block is NO_REPLY", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => [
      "housekeeping narration not meant for the channel",
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/b" } },
      "NO_REPLY",
    ];
    await expect(agent.handleCronMessage("System: background task done", "telegram:12345")).resolves.toBe(true);

    expect(tg.delivered.map((d) => d.text)).toEqual(["housekeeping narration not meant for the channel"]);

    await agent.stop();
  });

  it("suppressDelivery silences every block of a send-turn, mid-turn included", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => [
      "narration the channel must never see",
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } },
      "more narration",
    ];
    await expect(agent.handleCronMessage("System: background task done", "telegram:12345", {
      showTyping: false,
      suppressDelivery: true,
    })).resolves.toBe(true);

    expect(tg.delivered).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("#222: delivers send-turn prose that merely mentions NO_REPLY inline", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => "The literal token is NO_REPLY.";
    await expect(agent.handleCronMessage("System: background task done", "telegram:12345")).resolves.toBe(true);

    expect(tg.delivered).toHaveLength(1);
    expect(tg.delivered[0]).toMatchObject({ chatId: "12345", text: "The literal token is NO_REPLY." });

    await agent.stop();
  });

  it("#222: repeated trailing NO_REPLY blocks with no visible text stay silent", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => ["NO_REPLY", "NO_REPLY"];
    await expect(agent.handleCronMessage("System: housekeeping task", "telegram:12345")).resolves.toBe(true);

    expect(tg.delivered).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("#222: a send-turn whose ONLY content is NO_REPLY (even after tool calls) stays silent", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => [
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/b" } },
      "NO_REPLY",
    ];
    await expect(agent.handleCronMessage("System: housekeeping task", "telegram:12345")).resolves.toBe(true);

    expect(tg.delivered).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });

  it("#222: a bare NO_REPLY send-turn (no tool calls) still stays silent (no regression)", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => "NO_REPLY";
    await expect(agent.handleCronMessage("System: housekeeping task", "telegram:12345")).resolves.toBe(true);

    expect(tg.delivered).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);

    await agent.stop();
  });
});


describe("compact nudges", () => {
  /** Prompts of every housekeeping nudge turn the agent queued. */
  const nudgePrompts = () =>
    mockSdk.userContents
      .map((blocks) => blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""))
      .filter((t) => t.includes("Context usage is at"));

  function writeSdkSessionEvents(events: object[]) {
    const path = getSdkSessionPath("mock-sdk-session-123", join(agentEnv.tmpDir, "sdk-sessions"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  function dailyRollupSourceEvents(count = 40) {
    const todayNoon = new Date();
    todayNoon.setHours(12, 0, 0, 0);
    return Array.from({ length: count }, (_, i) => ({
      type: "user",
      timestamp: new Date(todayNoon.getTime() + i * 1000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `event ${i}` }] },
    }));
  }

  function seedDailyRollupSourceEvents(count = 40) {
    writeSdkSessionEvents(dailyRollupSourceEvents(count));
  }

  function bulkyToolResultEvents() {
    return [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "x".repeat(100_000) }],
        },
      },
    ];
  }

  /** Simulate what `tomo lcm prune-tools` / `tomo lcm daily` do on disk:
   *  write the compact trigger so the harness reloads the session. */
  function writeCompactTrigger() {
    writeFileSync(
      getCompactTriggerPath("mock-sdk-session-123", join(agentEnv.tmpDir, "sdk-sessions")),
      new Date().toISOString(),
    );
  }

  it("queues exactly one housekeeping turn when a turn lands over the compact threshold", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.contextUsage = { totalTokens: 170_000, maxTokens: 200_000 }; // 85%
    await tg.simulateMessage(makeMsg({ text: "Hi" }));
    await drainQueue(agent);

    await waitFor(() => expect(nudgePrompts()).toHaveLength(1));
    expect(nudgePrompts()[0]).toContain("lcm compact skill");

    // Still over threshold on the next turn — latched, no second nudge.
    await tg.simulateMessage(makeMsg({ text: "Hi again" }));
    await drainQueue(agent);
    await expectNoChangeFor(() => expect(nudgePrompts()).toHaveLength(1));

    await agent.stop();
  });

  it("re-nudges after a housekeeping turn that never ran, instead of latching on a failure", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // The nudge turn itself fails: the SDK answers with an error the agent
    // classifies as a failed turn, so handleCronMessage RESOLVES FALSE (it
    // never rejects). The compact was never written — but the latch had
    // already been set before dispatch, so nothing asked for it again until
    // usage fell back under nudgeResetPct, which is exactly what it cannot do
    // while the context stays full.
    mockSdk.responseFn = (text) =>
      text.includes("Context usage is at") ? "API Error: 529 overloaded" : "seeded reply";

    mockSdk.contextUsage = { totalTokens: 170_000, maxTokens: 200_000 }; // 85%
    await tg.simulateMessage(makeMsg({ text: "Hi" }));
    await drainQueue(agent);
    await waitFor(() => expect(nudgePrompts()).toHaveLength(1));

    // Still over the threshold on the next turn, and the housekeeping still
    // has not happened — so it is asked for again.
    await tg.simulateMessage(makeMsg({ text: "Hi again" }));
    await drainQueue(agent);
    await waitFor(() => expect(nudgePrompts()).toHaveLength(2));
    expect(nudgePrompts()[1]).toContain("lcm compact skill");

    await agent.stop();
  });

  it("re-nudges after a housekeeping turn that REJECTED, not just one that resolved false", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // `handleCronMessage` funnels every failure into `false` through a
    // terminal `.catch(() => false)`, so today it cannot reject — which is
    // precisely the hidden dependency being removed here. The latch rollback
    // lived only in the `.then(ok === false)` branch, so the correctness of
    // this call site rested on an implementation detail of a method three
    // layers down: give that catch a narrower predicate and the latch is
    // stuck on for the rest of the session's life, with the compact never
    // asked for again. Force the rejection directly.
    const real = agent.handleCronMessage.bind(agent);
    const spy = vi.spyOn(agent, "handleCronMessage").mockImplementation(
      async (text, key, options) => {
        if (text.includes("Context usage is at")) throw new Error("session queue exploded");
        return real(text, key, options);
      },
    );

    mockSdk.contextUsage = { totalTokens: 170_000, maxTokens: 200_000 }; // 85%
    await tg.simulateMessage(makeMsg({ text: "Hi" }));
    await drainQueue(agent);
    // The nudge never reached the model at all.
    await expectNoChangeFor(() => expect(nudgePrompts()).toHaveLength(0));

    // Still over the threshold, and the compact still has not happened — so
    // it is asked for again rather than latched out forever.
    spy.mockRestore();
    await tg.simulateMessage(makeMsg({ text: "Hi again" }));
    await drainQueue(agent);
    await waitFor(() => expect(nudgePrompts()).toHaveLength(1));
    expect(nudgePrompts()[0]).toContain("lcm compact skill");

    await agent.stop();
  });

  it("does not re-issue housekeeping after a turn whose context reading failed", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.contextUsage = { totalTokens: 170_000, maxTokens: 200_000 }; // 85%
    await tg.simulateMessage(makeMsg({ text: "Hi" }));
    await drainQueue(agent);
    await waitFor(() => expect(nudgePrompts()).toHaveLength(1));

    // The next turn cannot read context usage at all. The fallback measures
    // only that turn's own tokens; divided by a hard-coded 1M window it used
    // to land under nudgeResetPct on a 200k model — i.e. an unreadable
    // session was indistinguishable from one that had just been emptied, so
    // the latch cleared and the compact was asked for a second time.
    mockSdk.contextUsageFails = true;
    await tg.simulateMessage(makeMsg({ text: "Hi again" }));
    await drainQueue(agent);
    await expectNoChangeFor(() => expect(nudgePrompts()).toHaveLength(1));

    // A real reading, still over the threshold: the latch survived, so this
    // is not a fresh nudge either.
    mockSdk.contextUsageFails = false;
    await tg.simulateMessage(makeMsg({ text: "and again" }));
    await drainQueue(agent);
    await expectNoChangeFor(() => expect(nudgePrompts()).toHaveLength(1));

    await agent.stop();
  });

  it("warns once the context reading has failed N turns running", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const unreadableWarnings = () => vi.mocked(log.warn).mock.calls
      .filter((c) => typeof c[1] === "string" && c[1].startsWith("Context usage unreadable"));

    mockSdk.contextUsage = { totalTokens: 170_000, maxTokens: 200_000 }; // 85%
    await tg.simulateMessage(makeMsg({ text: "Hi" }));
    await drainQueue(agent);
    await waitFor(() => expect(nudgePrompts()).toHaveLength(1));

    // Skipping the ladder on an estimated reading is right per turn and
    // silent forever: a getContextUsage() that has stopped working for good
    // disables the prune/daily/compact nudges for this session, and the only
    // outward sign is a `tomo status` percentage that looks plausible and low
    // (this turn's own tokens over the window). A blip must stay quiet; a
    // standing failure must not.
    mockSdk.contextUsageFails = true;
    for (let turn = 1; turn < ESTIMATED_READING_WARN_AFTER; turn++) {
      await tg.simulateMessage(makeMsg({ text: `turn ${turn}` }));
      await drainQueue(agent);
      expect(unreadableWarnings()).toHaveLength(0);
    }

    await tg.simulateMessage(makeMsg({ text: "threshold" }));
    await drainQueue(agent);
    await waitFor(() => expect(unreadableWarnings()).toHaveLength(1));
    expect(unreadableWarnings()[0][0]).toMatchObject({ turns: ESTIMATED_READING_WARN_AFTER });

    // Once, not once per turn — a broken session should not drown the log.
    await tg.simulateMessage(makeMsg({ text: "still broken" }));
    await drainQueue(agent);
    await expectNoChangeFor(() => expect(unreadableWarnings()).toHaveLength(1));

    // And the nudge really was suppressed throughout.
    expect(nudgePrompts()).toHaveLength(1);

    await agent.stop();
  });

  it("marks the turn.stats watch event when the reading was only estimated", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const stats: Extract<WatchEvent, { type: "turn.stats" }>[] = [];
    const unsubscribe = watchBus.subscribe((e) => {
      if (e.type === "turn.stats") stats.push(e);
    });
    try {
      mockSdk.contextUsage = { totalTokens: 40_000, maxTokens: 200_000 };
      await tg.simulateMessage(makeMsg({ text: "Hi" }));
      await drainQueue(agent);
      await waitFor(() => expect(stats).toHaveLength(1));
      expect(stats[0].contextUsed).toBe(40_000);
      expect(stats[0].contextEstimated).toBeUndefined();

      // Now the reading fails. `contextUsed` becomes this turn's OWN tokens
      // over the last real window — a number a watcher would otherwise read as
      // "the session is nearly empty". The flag is what lets it say "unknown".
      mockSdk.contextUsageFails = true;
      await tg.simulateMessage(makeMsg({ text: "Hi again" }));
      await drainQueue(agent);
      await waitFor(() => expect(stats).toHaveLength(2));
      expect(stats[1].contextEstimated).toBe(true);
      expect(stats[1].contextMax).toBe(200_000); // the last window we really saw
    } finally {
      unsubscribe();
    }

    await agent.stop();
  });

  it("runs the context-pressure check on a turn recovered by the session-error retry", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // First query fails its event stream — runWithRetry's "No conversation
    // found" branch resets the session and retries on a fresh query, which
    // must still get post-turn bookkeeping (including the nudge check).
    mockSdk.contextUsage = { totalTokens: 170_000, maxTokens: 200_000 }; // 85%
    mockSdk.failNextQuery = "No conversation found";
    await tg.simulateMessage(makeMsg({ text: "Hi" }));
    await drainQueue(agent);

    await waitFor(() => expect(nudgePrompts()).toHaveLength(1));
    expect(nudgePrompts()[0]).toContain("lcm compact skill");

    await agent.stop();
  });

  it("fires the prune nudge below the compact threshold when bulky tool results are reclaimable", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeSdkSessionEvents([...bulkyToolResultEvents(), ...dailyRollupSourceEvents()]);
    // The prune housekeeping turn writes the compact trigger (as the real CLI
    // does) but its own QueryResult still reports the PRE-prune usage — the
    // in-memory session ran with the old context. Usage stays at 72% here on
    // purpose: the harness must NOT decide the next rung on that stale
    // reading, so no daily nudge may chain off the prune turn's completion.
    mockSdk.responseFn = (text) => {
      if (text.includes("prune-tools")) {
        writeCompactTrigger();
        return "NO_REPLY";
      }
      return "mock response";
    };

    mockSdk.contextUsage = { totalTokens: 144_000, maxTokens: 200_000 };
    await tg.simulateMessage(makeMsg({ text: "Hi" }));
    await drainQueue(agent);

    await waitFor(() => expect(nudgePrompts()).toHaveLength(1));
    expect(nudgePrompts()[0]).toContain("prune-tools");
    await expectNoChangeFor(() => expect(nudgePrompts()).toHaveLength(1));

    // Next turn runs on the reloaded session and gives a FRESH reading. Still
    // over the threshold → the prune latch escalates one rung to daily.
    await tg.simulateMessage(makeMsg({ text: "Hi again" }));
    await drainQueue(agent);

    await waitFor(() => expect(nudgePrompts()).toHaveLength(2));
    expect(nudgePrompts()[1]).toContain("tomo lcm daily");
    expect(nudgePrompts()[1]).not.toContain("prune-tools");

    await agent.stop();
  });

  it("falls through to daily below the compact threshold when nothing is prunable", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    seedDailyRollupSourceEvents();

    mockSdk.contextUsage = { totalTokens: 144_000, maxTokens: 200_000 };
    await tg.simulateMessage(makeMsg({ text: "Hi" }));
    await drainQueue(agent);

    await waitFor(() => expect(nudgePrompts()).toHaveLength(1));
    expect(nudgePrompts()[0]).toContain("tomo lcm daily");
    expect(nudgePrompts()[0]).not.toContain("prune-tools");

    await agent.stop();
  });

  it("fires the daily rollup below the compact threshold, escalates once, and re-arms below reset", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    seedDailyRollupSourceEvents();

    // 72% — between nudgeAtPct (70) and the compact threshold (80).
    mockSdk.contextUsage = { totalTokens: 144_000, maxTokens: 200_000 };
    await tg.simulateMessage(makeMsg({ text: "Hi" }));
    await drainQueue(agent);
    await waitFor(() => expect(nudgePrompts()).toHaveLength(1));
    expect(nudgePrompts()[0]).toContain("tomo lcm daily");

    // Crossing 80% escalates to a compact nudge even though daily fired.
    mockSdk.contextUsage = { totalTokens: 170_000, maxTokens: 200_000 };
    await tg.simulateMessage(makeMsg({ text: "more" }));
    await drainQueue(agent);
    await waitFor(() => expect(nudgePrompts()).toHaveLength(2));
    expect(nudgePrompts()[1]).toContain("lcm compact skill");

    // Dropping below nudgeResetPct (60) re-arms the latch...
    mockSdk.contextUsage = { totalTokens: 100_000, maxTokens: 200_000 };
    await tg.simulateMessage(makeMsg({ text: "compacted" }));
    await drainQueue(agent);
    await expectNoChangeFor(() => expect(nudgePrompts()).toHaveLength(2));

    // ...so the next crossing nudges again.
    mockSdk.contextUsage = { totalTokens: 144_000, maxTokens: 200_000 };
    await tg.simulateMessage(makeMsg({ text: "again" }));
    await drainQueue(agent);
    await waitFor(() => expect(nudgePrompts()).toHaveLength(3));
    expect(nudgePrompts()[2]).toContain("tomo lcm daily");

    await agent.stop();
  });
});

/**
 * Housekeeping turns are silent by CONSTRUCTION, not by cooperation.
 *
 * Every internal nudge prompt ends with "reply NO_REPLY so we don't send a
 * user-facing message for this housekeeping turn". Under #292's end-of-turn
 * delivery that instruction was load-bearing and sufficient: the whole turn
 * was joined into one response, and a trailing bare NO_REPLY suppressed all of
 * it, narration included.
 *
 * Per-block delivery makes the instruction arrive too late. A turn that writes
 * "Compacting context…", then calls a tool, then answers NO_REPLY, has already
 * put the narration on the owner's phone by the time the token is produced —
 * and a sent message cannot be recalled. These turns therefore set
 * `suppressDelivery` unconditionally, in every session type, so silence does
 * not depend on the model saying the right word at the right moment.
 */
describe("internal housekeeping turns never speak", () => {
  /** The leak shape: narration, then a tool, then the token. */
  const narrateThenNoReply = [
    "Compacting context now…",
    { type: "tool_use" as const, id: "tu-lcm", name: "Bash", input: {} },
    "NO_REPLY",
  ];

  it("sends nothing for a context-nudge turn that narrates before answering NO_REPLY (DM session)", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // A DM session — the case that used to LEAK, because suppressDelivery was
    // set only for group keys.
    mockSdk.contextUsage = { totalTokens: 170_000, maxTokens: 200_000 }; // 85%
    mockSdk.responseFn = (text) =>
      text.includes("Context usage is at") ? narrateThenNoReply : "seeded reply";

    await tg.simulateMessage(makeMsg({ text: "Hi" }));
    await drainQueue(agent);

    // The nudge turn ran...
    await waitFor(() =>
      expect(
        mockSdk.userContents.some((blocks) =>
          blocks.some((b) => (b.text ?? "").includes("Context usage is at")),
        ),
      ).toBe(true),
    );
    await drainQueue(agent);

    // ...and said nothing. The owner sees his own turn's reply and nothing
    // else: not the narration, not the token. NOTE: the delivery log is NOT
    // cleared before this assertion on purpose — the nudge turn can complete
    // before the clear would run, and clearing would hide exactly the leak
    // this test exists to catch.
    await expectNoChangeFor(() =>
      expect(tg.delivered.map((d) => d.text)).toEqual(["seeded reply"]),
    );

    await agent.stop();
  });
});

/**
 * A suppressed cron turn is a SILENT turn: its reply text is dropped ("Cron
 * output suppressed from chat delivery"), exactly like a heartbeat's. It has
 * to carry the same sentence heartbeats carry, or the model answers into a
 * void — the LCM rollup and context nudges are the turns this actually bites.
 *
 * The negative half matters just as much: an ordinary scheduled job DOES
 * deliver its reply text, so telling it otherwise would push it into
 * send_message and put the answer in the chat twice.
 */
describe("silent cron turns tell the model their reply text is dropped", () => {
  async function seededAgent(): Promise<{ agent: Agent; prompts: string[] }> {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const prompts: string[] = [];
    mockSdk.responseFn = (text) => { prompts.push(text); return "NO_REPLY"; };

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    prompts.length = 0;
    return { agent, prompts };
  }

  it("adds the delivery note to a suppressed lcm-rollup turn", async () => {
    const { agent, prompts } = await seededAgent();

    const rollup = formatTomoEvent(
      "lcm-rollup",
      "An LCM rollup is due. The completed period `daily 2026-08-28` has 5 raw events ready to consolidate.",
      { name: "daily 2026-08-28" },
    );
    await agent.handleCronMessage(rollup, "telegram:12345", { showTyping: false, suppressDelivery: true });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("An LCM rollup is due");
    expect(prompts[0]).toContain(CONTINUITY_DELIVERY_NOTE);

    await agent.stop();
  });

  it("adds it to any other suppressed cron-triggered turn", async () => {
    const { agent, prompts } = await seededAgent();

    const nudge = formatTomoEvent("cron", 'Scheduled task "housekeeping" triggered. Tidy up.', { name: "housekeeping" });
    await agent.handleCronMessage(nudge, "telegram:12345", { suppressDelivery: true });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(CONTINUITY_DELIVERY_NOTE);

    await agent.stop();
  });

  /**
   * INSIDE THE ENVELOPE, NOT AFTER IT. `</tomo-event>\nYour reply text…` reads
   * as ordinary conversation to LCM: `isWarmTailCandidate` strips the leading
   * envelopes and classifies the leftover, so a silent housekeeping nudge
   * would consume a warm-tail slot meant for something the owner actually
   * said — and the sentence would sit in the SDK JSONL as user-authored text.
   */
  it("writes the sentence into the event body, so LCM still sees a harness event", async () => {
    const { agent, prompts } = await seededAgent();

    const rollup = formatTomoEvent(
      "lcm-rollup",
      "An LCM rollup is due. The completed period `daily 2026-08-28` has 5 raw events ready to consolidate.",
      { name: "daily 2026-08-28" },
    );
    await agent.handleCronMessage(rollup, "telegram:12345", { showTyping: false, suppressDelivery: true });

    const prompt = prompts[0];
    expect(prompt).toContain(CONTINUITY_DELIVERY_NOTE);
    // The sentence is the last line of the BODY; the envelope still closes the
    // message, and the envelope's own attributes are untouched.
    expect(prompt.trimEnd().endsWith("</tomo-event>")).toBe(true);
    expect(prompt).toContain(`${CONTINUITY_DELIVERY_NOTE}\n</tomo-event>`);
    expect(prompt).toContain('type="lcm-rollup"');
    expect(prompt).toContain('name="daily 2026-08-28"');

    expect(
      isWarmTailCandidate({ type: "user", message: { role: "user", content: prompt } } as never),
    ).toBe(false);

    await agent.stop();
  });

  it("does not add it to an ordinary scheduled job, whose reply text is delivered", async () => {
    const { agent, prompts } = await seededAgent();

    const job = formatTomoEvent("cron", 'Scheduled task "standup" triggered. Post the standup.', { name: "standup" });
    await agent.handleCronMessage(job, "telegram:12345");

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(CONTINUITY_DELIVERY_NOTE);

    await agent.stop();
  });
});
