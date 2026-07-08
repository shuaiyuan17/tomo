import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSdkSessionPath } from "../src/sessions/index.js";
import { getCompactTriggerPath } from "../src/lcm/compact.js";

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

  it("splits newline-delimited cron responses and preserves literal newline escapes", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    mockSdk.responseFn = () => "  first brief  \nsecond[[NL]]detail\n\n  third brief  ";

    await agent.handleCronMessage("Morning briefing", "telegram:12345");

    expect(tg.sent.map((msg) => msg.text)).toEqual([
      "first brief",
      "second\ndetail",
      "third brief",
    ]);

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
  // handleCronMessage -> TurnRunner.runSendTurn, which has no per-block
  // delivery (unlike stream turns) — it collects the whole multi-block
  // response into one string and only then decides whether to deliver it.
  // A trailing bare-NO_REPLY block silences the ENTIRE turn (owner decision
  // 2026-07-08): the narration is housekeeping, not for the channel. This
  // inverts the #222 delivery of mid-turn text; the #222 protection that
  // remains is that inline mentions of NO_REPLY do not silence (next test).
  it("suppresses the whole send-turn when it ends in a trailing NO_REPLY block", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "seeded";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    tg.clearDelivered();

    // Mirrors the reported repro shape: text -> tool_use -> tool_use -> NO_REPLY.
    mockSdk.responseFn = () => [
      "housekeeping narration not meant for the channel",
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/b" } },
      "NO_REPLY",
    ];
    await expect(agent.handleCronMessage("System: background task done", "telegram:12345")).resolves.toBe(true);

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
