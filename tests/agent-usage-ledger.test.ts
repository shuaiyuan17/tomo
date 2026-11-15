import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    await waitFor(() => expect(ledgerRows()).toHaveLength(4));
    expect(ledgerRows().at(-1)).toMatchObject({ source: "heartbeat", trigger: "System: Free time." });

    for (const r of rows) expect(r).toMatchObject({ costUsd: expect.any(Number), tokens: expect.any(Object) });

    await agent.stop();
  });
});
