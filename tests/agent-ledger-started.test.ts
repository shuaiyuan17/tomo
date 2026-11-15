import { expect, it, vi } from "vitest";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, installAgentTestHooks } from "./helpers/agent-harness.js";
import { mockConfig } from "./helpers/agent-mocks.js";
import { readLedgerStarted } from "../src/usage/ledger.js";

installAgentTestHooks();

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
