import { describe, expect, it, vi } from "vitest";

const oauthCalls = vi.hoisted(() => ({
  options: [] as unknown[],
  managerOptions: undefined as undefined | Record<string, unknown>,
}));

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
vi.mock("../src/mcp/oauth.js", () => ({
  McpOAuthManager: class {
    constructor(options: Record<string, unknown>) {
      oauthCalls.managerOptions = options;
    }

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
import { mockSdk } from "./helpers/agent-mocks.js";

installAgentTestHooks();

describe("Agent external MCP OAuth wiring", () => {
  it("starts OAuth non-blocking and hot-mounts a ready server into the live query", async () => {
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    await tg.simulateMessage(makeMsg({ text: "start a live session" }));
    await drainQueue(agent);

    expect(oauthCalls.options).toEqual([{ authorizationWaitMs: 0 }]);

    const onServerAuthReady = oauthCalls.managerOptions?.onServerAuthReady as undefined | (
      (serverName: string, server: { type: "http"; url: string; headers: Record<string, string> }) => Promise<void>
    );
    expect(onServerAuthReady).toBeTypeOf("function");
    await onServerAuthReady!("docs", {
      type: "http",
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer fresh" },
    });

    expect(mockSdk.mcpServerSets).toHaveLength(1);
    expect(mockSdk.mcpServerSets[0]).toMatchObject({
      docs: {
        type: "http",
        url: "https://docs.example/mcp",
        headers: { Authorization: "Bearer fresh" },
      },
      "tomo-internal": expect.any(Object),
    });

    await agent.stop();
  });
});
