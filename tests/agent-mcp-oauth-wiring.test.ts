import { beforeEach, describe, expect, it, vi } from "vitest";

const oauthCalls = vi.hoisted(() => ({
  options: [] as unknown[],
  managerOptions: undefined as undefined | Record<string, unknown>,
  refreshSweeps: [] as unknown[],
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

    refreshExpiringTokens(servers: unknown): Promise<string[]> {
      oauthCalls.refreshSweeps.push(servers);
      return Promise.resolve([]);
    }
  },
  TOKEN_REFRESH_SWEEP_INTERVAL_MS: 60_000,
}));

import {
  Agent,
  MockChannel,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
} from "./helpers/agent-harness.js";
import { mockConfig, mockSdk } from "./helpers/agent-mocks.js";

installAgentTestHooks();

describe("Agent external MCP OAuth wiring", () => {
  beforeEach(() => {
    oauthCalls.options = [];
    oauthCalls.refreshSweeps = [];
    oauthCalls.managerOptions = undefined;
  });

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

  // Issue #299 defect 1: nothing re-read the token store while the daemon ran,
  // so a one-hour access token broke its server one hour after every login.
  it("sweeps expiring OAuth tokens from start()", async () => {
    mockConfig.mcpServers = {
      "cloudflare-api": {
        server: { type: "http", url: "https://api.example/mcp" },
        oauth: { scopes: [], tokenStoreKey: "cloudflare" },
      },
    };
    const agent = new Agent();

    await agent.start();

    expect(oauthCalls.refreshSweeps).toEqual([mockConfig.mcpServers]);
    await agent.stop();
  });

  it("does not start a sweep when no MCP server uses OAuth", async () => {
    mockConfig.mcpServers = {
      docs: { server: { type: "http", url: "https://docs.example/mcp" } },
    };
    const agent = new Agent();

    await agent.start();

    expect(oauthCalls.refreshSweeps).toEqual([]);
    await agent.stop();
  });
});
