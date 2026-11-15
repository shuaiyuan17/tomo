import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
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

installAgentTestHooks();

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
    const models = (n: number) => ({
      "claude-opus": { inputTokens: 10 * n, outputTokens: 5 * n, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.25 * n },
    });

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
    (agent as unknown as { liveSessionManager: { closeLiveSession(k: string): void } }).liveSessionManager.closeLiveSession(key);
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
    const models = (n: number) => ({
      "claude-opus": { inputTokens: 10 * n, outputTokens: 5 * n, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.25 * n },
    });

    mockSdk.responseFn = () => "one";
    mockSdk.nextResult = { total_cost_usd: 1.0, modelUsage: models(4) };
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "one" }));
    await drainQueue(agent);
    // Fully settled (including the ledger's own chmod) before the file is locked.
    await (agent as unknown as { usageLedger: { idle(): Promise<void> } }).usageLedger.idle();
    expect(ledgerRows()).toHaveLength(1);

    // The ledger cannot be appended to for the second turn.
    const file = join(agentEnv.tmpDir, "data", "usage", readdirSync(join(agentEnv.tmpDir, "data", "usage")).find((f) => f.endsWith(".ndjson"))!);
    chmodSync(file, 0o400);
    mockSdk.responseFn = () => "two";
    mockSdk.nextResult = { total_cost_usd: 1.5, modelUsage: models(6) };
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "two" }));
    await drainQueue(agent);
    await (agent as unknown as { usageLedger: { idle(): Promise<void> } }).usageLedger.idle();
    chmodSync(file, 0o600);
    expect(ledgerRows()).toHaveLength(1);

    // Rebuild and resume. The registry's copy saw turn two ($1.50); the
    // ledger's last row did not ($1.00), and the ledger wins.
    (agent as unknown as { liveSessionManager: { closeLiveSession(k: string): void } }).liveSessionManager.closeLiveSession(key);
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
});
