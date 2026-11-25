import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatTomoEvent } from "../src/tomo-event.js";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  waitFor,
} from "./helpers/agent-harness.js";
import { mockConfig } from "./helpers/agent-mocks.js";
import { readLedgerStarted } from "../src/usage/ledger.js";

installAgentTestHooks();

/** SDK `modelUsage` for one model, scaled by n ($0.25 per step). */
function models(n: number) {
  return {
    "claude-opus": { inputTokens: 10 * n, outputTokens: 5 * n, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.25 * n },
  };
}

/** The Agent privates these tests reach: the ledger's write chain, the live session map, the registry. */
function internals(agent: Agent) {
  return agent as unknown as {
    usageLedger: { idle(): Promise<void> };
    liveSessionManager: { closeLiveSession(k: string): void };
    sessions: { getEntry(k: string): { stats: { totalCostUsd: number } } };
  };
}

function ledgerRows(): Array<Record<string, unknown>> {
  const dir = join(agentEnv.tmpDir, "data", "usage");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}\.ndjson$/.test(f))
    .flatMap((f) => readFileSync(join(dir, f), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>));
}

describe("usage ledger (agent wiring)", () => {
  it("records an owner turn, a cron job's turn and a housekeeping turn with their sources", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    mockSdk.responseFn = () => "hello";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "How much did yesterday cost?" }));
    await drainQueue(agent);

    mockSdk.responseFn = () => "digest";
    const cronPrompt = formatTomoEvent("cron", 'Scheduled task "Morning digest" triggered. Summarise the inbox', { name: "Morning digest" });
    await expect(agent.handleCronMessage(cronPrompt, "telegram:12345", { jobId: "job-42", jobName: "Morning digest" })).resolves.toBe(true);

    mockSdk.responseFn = () => "NO_REPLY";
    await agent.handleCronMessage("rollup nudge", "telegram:12345", { showTyping: false, suppressDelivery: true });

    await waitFor(() => expect(ledgerRows()).toHaveLength(3));
    const rows = ledgerRows();
    expect(rows[0]).toMatchObject({ v: 1, sessionKey: "telegram:12345", source: "owner", trigger: "How much did yesterday cost?" });
    expect(rows[1]).toMatchObject({
      source: "cron", jobId: "job-42", jobName: "Morning digest",
      trigger: 'Scheduled task "Morning digest" triggered. Summarise the inbox',
      numTurns: 1, durationMs: 100,
    });
    expect(rows[2]).toMatchObject({ source: "system", trigger: "rollup nudge" });
    expect(rows[2].jobId).toBeUndefined();
    mockSdk.responseFn = () => "NO_REPLY";
    await agent.handleContinuity("System: Free time.");
    await drainQueue(agent);
    // Shutdown waits for the queued rows: nothing is still in flight once stop() resolves.
    await agent.stop();
    expect(ledgerRows()).toHaveLength(4);
    expect(ledgerRows().at(-1)).toMatchObject({ source: "heartbeat", trigger: "System: Free time." });

    for (const r of rows) expect(r).toMatchObject({ costUsd: expect.any(Number), tokens: expect.any(Object) });
  });
});

describe("usage ledger and the resume baseline", () => {
  it("a background turn's baseline is persisted with its row, so a rebuilt session does not charge it again", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const key = "telegram:12345";

    // 1. An owner turn: the SDK's running total is $1.00.
    mockSdk.responseFn = () => "hello";
    mockSdk.nextResult = { total_cost_usd: 1.0, modelUsage: models(4) };
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "hi" }));
    await drainQueue(agent);

    // 2. The CLI starts a turn itself (a background task reported): +$0.50.
    mockSdk.nextResult = { total_cost_usd: 1.5, modelUsage: models(6) };
    mockSdk.queryControllers[0].pushTaskNotificationTurn("the review finished");
    await waitFor(() => expect(ledgerRows()).toHaveLength(2));

    // 3. The live session is rebuilt (compact reload, model switch, restart)
    //    and resumes the same SDK session, whose totals carry everything.
    internals(agent).liveSessionManager.closeLiveSession(key);
    mockSdk.responseFn = () => "again";
    mockSdk.nextResult = { total_cost_usd: 1.75, modelUsage: models(7) };
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "and now?" }));
    await drainQueue(agent);
    await agent.stop();

    expect(mockSdk.queryControllers.length).toBeGreaterThanOrEqual(2);
    const rows = ledgerRows();
    expect(rows.map((r) => r.source)).toEqual(["owner", "background", "owner"]);
    expect(rows.map((r) => r.costUsd)).toEqual([1.0, 0.5, 0.25]);
    expect(rows[2].models).toEqual({ "claude-opus": { input: 10, output: 5, cacheRead: 0, cacheCreated: 0, webSearch: 0, costUsd: 0.25 } });
    // Together they add up to the SDK's own total: nothing charged twice.
    expect(rows.reduce((sum, r) => sum + (r.costUsd as number), 0)).toBe(1.75);
  });

  it("a row that failed to land is counted by the first turn after the resume, from the ledger's last snapshot", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const key = "telegram:12345";

    mockSdk.responseFn = () => "one";
    mockSdk.nextResult = { total_cost_usd: 1.0, modelUsage: models(4) };
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "one" }));
    await drainQueue(agent);
    // Fully settled (including the ledger's own chmod) before the file is swapped out.
    await internals(agent).usageLedger.idle();
    expect(ledgerRows()).toHaveLength(1);

    // The ledger cannot be appended to for the second turn: the month's file
    // is moved aside and a DIRECTORY sits at its path, so the append fails
    // with EISDIR. (Not chmod: root writes through a read-only mode.)
    const file = join(agentEnv.tmpDir, "data", "usage", readdirSync(join(agentEnv.tmpDir, "data", "usage")).find((f) => f.endsWith(".ndjson"))!);
    renameSync(file, `${file}.aside`);
    mkdirSync(file);
    mockSdk.responseFn = () => "two";
    mockSdk.nextResult = { total_cost_usd: 1.5, modelUsage: models(6) };
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "two" }));
    await drainQueue(agent);
    await internals(agent).usageLedger.idle();
    rmSync(file, { recursive: true });
    renameSync(`${file}.aside`, file);
    expect(ledgerRows()).toHaveLength(1);

    // Rebuild and resume. The registry's copy saw turn two ($1.50); the
    // ledger's last row did not ($1.00), and the ledger wins.
    internals(agent).liveSessionManager.closeLiveSession(key);
    mockSdk.responseFn = () => "three";
    mockSdk.nextResult = { total_cost_usd: 1.75, modelUsage: models(7) };
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "three" }));
    await drainQueue(agent);
    await agent.stop();

    const rows = ledgerRows();
    expect(rows.map((r) => r.costUsd)).toEqual([1.0, 0.75]);
    expect(rows[1].models).toEqual({ "claude-opus": { input: 30, output: 15, cacheRead: 0, cacheCreated: 0, webSearch: 0, costUsd: 0.75 } });
    expect(rows.reduce((sum, r) => sum + (r.costUsd as number), 0)).toBe(1.75);
  });

  it("every write failing from the session's first turn: the registry stays at zero, so the first row that lands carries it all", async () => {
    // Not a directory: every ledger write fails from the start.
    mkdirSync(join(agentEnv.tmpDir, "data"), { recursive: true });
    writeFileSync(join(agentEnv.tmpDir, "data", "usage"), "not a directory");
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const key = "telegram:12345";
    const ledger = internals(agent).usageLedger;

    for (const [text, total] of [["one", 1.0], ["two", 1.5]] as const) {
      mockSdk.responseFn = () => text;
      mockSdk.nextResult = { total_cost_usd: total };
      await tg.simulateMessage(makeMsg({ chatId: "12345", text }));
      await drainQueue(agent);
      await ledger.idle();
    }
    // Session stats saw both turns; the ledger has nothing.
    expect(internals(agent).sessions.getEntry(key).stats.totalCostUsd).toBeCloseTo(1.5);

    // The disk recovers, the session is rebuilt and resumes.
    rmSync(join(agentEnv.tmpDir, "data", "usage"));
    internals(agent).liveSessionManager.closeLiveSession(key);
    mockSdk.responseFn = () => "three";
    mockSdk.nextResult = { total_cost_usd: 1.75 };
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "three" }));
    await drainQueue(agent);
    await agent.stop();

    const rows = ledgerRows();
    expect(rows.map((r) => r.costUsd)).toEqual([1.75]);
    expect(rows[0].noBaseline).toBeUndefined();
  });

  it("the registry copy follows landed rows, for a resume the ledger cannot answer", async () => {
    const first = new Agent();
    const tg1 = new MockChannel("telegram");
    first.addChannel(tg1);
    mockSdk.responseFn = () => "one";
    mockSdk.nextResult = { total_cost_usd: 1.0, modelUsage: models(4) };
    await tg1.simulateMessage(makeMsg({ chatId: "12345", text: "one" }));
    await drainQueue(first);
    await first.stop();
    expect(ledgerRows().map((r) => r.costUsd)).toEqual([1.0]);

    // The ledger's rows are gone (out of the look-back, or lost): a restarted
    // daemon can only resume from the registry's copy.
    const dir = join(agentEnv.tmpDir, "data", "usage");
    for (const f of readdirSync(dir)) rmSync(join(dir, f));

    const second = new Agent();
    const tg2 = new MockChannel("telegram");
    second.addChannel(tg2);
    mockSdk.responseFn = () => "two";
    mockSdk.nextResult = { total_cost_usd: 1.25, modelUsage: models(5) };
    await tg2.simulateMessage(makeMsg({ chatId: "12345", text: "two" }));
    await drainQueue(second);
    await second.stop();
    expect(ledgerRows().map((r) => r.costUsd)).toEqual([0.25]);
  });
});

describe("ledger start marker", () => {
  it("starting the daemon records when the usage ledger started, once", async () => {
    const dir = join(mockConfig.tomoHome, "data", "usage");
    expect(readLedgerStarted(dir)).toBeUndefined();
    const before = Date.now();
    const agent = new Agent();
    await agent.start();
    const first = readLedgerStarted(dir);
    expect(first).toBeGreaterThanOrEqual(before);
    await agent.stop();
    const again = new Agent();
    await again.start();
    expect(readLedgerStarted(dir)).toBe(first);
    await again.stop();
  });
});
