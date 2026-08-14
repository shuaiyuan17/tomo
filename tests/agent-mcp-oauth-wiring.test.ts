import { describe, expect, it, vi } from "vitest";

const oauthCalls = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
vi.mock("../src/mcp/oauth.js", () => ({
  McpOAuthManager: class {
    constructor(_options: unknown) {}

    buildServersWithAuth(_servers: unknown, _sendAuthorizeUrl: unknown, options: unknown): Promise<Record<string, never>> {
      oauthCalls.options.push(options);
      return Promise.resolve({});
    }
  },
}));

import {
  Agent,
  MockChannel,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

describe("Agent external MCP OAuth wiring", () => {
  it("starts live sessions with interactive OAuth configured as non-blocking", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ text: "start a live session" }));
    await drainQueue(agent);

    expect(oauthCalls.options).toEqual([{ authorizationWaitMs: 0 }]);

    await agent.stop();
  });
});
