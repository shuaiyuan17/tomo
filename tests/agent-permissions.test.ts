import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, drainQueue, installAgentTestHooks, makeMsg, mockConfig, mockSdk, resetConfig, useRealAdmission } from "./helpers/agent-harness.js";
import { agentEnv } from "./helpers/agent-mocks.js";
import { createTomoInternalMcpServer } from "../src/mcp/internal-server.js";
import { PERMISSION_NOT_SANDBOXED } from "../src/mcp/permission-tools.js";

installAgentTestHooks();

const OWNER = "+15555550123";
const OWNER_CHAT = `any;-;${OWNER}`;
const OWNER_KEY = "dm:alex";
const GROUP_CHAT = "any;+;group1";
const GROUP_KEY = `imessage:${GROUP_CHAT}`;

// Outside the workspace and the temp dirs (both are granted to every group turn).
const cacheDir = join(process.cwd(), "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const EXTERNAL = realpathSync.native(mkdtempSync(join(cacheDir, "tomo-agent-perm-")));
afterAll(() => rmSync(EXTERNAL, { recursive: true, force: true }));

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type ToolHandle = { name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> };

function setup() {
  useRealAdmission();
  resetConfig({
    channelAllowlists: { imessage: [GROUP_CHAT] },
    identities: [{ name: "alex", channels: { imessage: OWNER }, replyPolicy: "last-active" }],
  });
  const agent = new Agent();
  const im = new MockChannel("imessage");
  agent.addChannel(im);
  const tools = (sessionKey: string) => (createTomoInternalMcpServer(agent, sessionKey) as unknown as { tools: ToolHandle[] }).tools;
  const call = (sessionKey: string, args: Record<string, unknown>) => tools(sessionKey).find((t) => t.name === "request_permission")!.handler(args);
  return { agent, im, tools, call };
}

const permissionPrompts = () => mockSdk.promptsBySession.filter((p) => p.text.includes('type="permission"'));

describe("request_permission through the Agent", () => {
  beforeEach(() => { vi.clearAllMocks(); mockSdk.responseFn = () => "ok"; });

  it("is offered on group and owner sessions, and refuses on the owner's own turn", async () => {
    const { tools, call } = setup();
    expect(tools(GROUP_KEY).map((t) => t.name)).toContain("request_permission");
    const own = await call(OWNER_KEY, { path: EXTERNAL, access: "read", reason: "x" });
    expect(own).toMatchObject({ isError: true });
    expect(own.content[0].text).toBe(PERMISSION_NOT_SANDBOXED);
  });

  it("asks in the owner's DM; the coded reply is taken, and the group's session is told", async () => {
    const { agent, im, call } = setup();
    const opened = await call(GROUP_KEY, { path: EXTERNAL, access: "write", reason: "run the build" });
    const pending = JSON.parse(opened.content[0].text) as { status: string; code: string };
    expect(pending.status).toBe("pending");
    expect(im.sent).toHaveLength(1);
    expect(im.sent[0].chatId).toContain(OWNER); // the owner's own handle, never the group
    expect(im.sent[0].text.split("\n")).toHaveLength(4);
    expect(im.sent[0].text).toContain(EXTERNAL);

    await im.simulateMessage(makeMsg({ chatId: OWNER_CHAT, senderId: OWNER, text: `2 ${pending.code}`, rawText: `2 ${pending.code}` }));
    await drainQueue(agent);
    // The reply never reached a prompt as text of its own …
    expect(mockSdk.promptsBySession.some((p) => p.sessionKey === OWNER_KEY)).toBe(false);
    // … the group's session got the outcome …
    expect(permissionPrompts().map((p) => p.sessionKey)).toEqual([GROUP_KEY]);
    expect(permissionPrompts()[0].text).toContain("allowed_always");
    // … and the grant is in the config file (with a backup of the old one) and in force.
    const written = JSON.parse(readFileSync(agentEnv.configFilePath, "utf8"));
    expect(written.groupSandbox.groups[GROUP_KEY].extraWrite).toEqual([EXTERNAL]);
    expect(agent.groupSandboxFor(GROUP_KEY).groups[GROUP_KEY].extraWrite).toEqual([EXTERNAL]);
    expect(existsSync(join(mockConfig.tomoHome, "data", "permissions", "group-requests.jsonl"))).toBe(true);
    expect(im.sent.some((m) => m.text.startsWith(`Always allowed (${pending.code})`))).toBe(true);
  });

  it("a group member typing the code in the group approves nothing", async () => {
    const { agent, im, call } = setup();
    const opened = await call(GROUP_KEY, { path: EXTERNAL, access: "read", reason: "x" });
    const { code } = JSON.parse(opened.content[0].text) as { code: string };
    await im.simulateMessage(makeMsg({ chatId: GROUP_CHAT, isGroup: true, senderId: "+15555550999", text: `1 ${code}`, rawText: `1 ${code}` }));
    await drainQueue(agent);
    expect(agent.permissionBroker.views().map((v) => v.code)).toEqual([code]);
    expect(permissionPrompts()).toEqual([]);
    // The message reached the group's session as an ordinary one.
    expect(mockSdk.promptsBySession.some((p) => p.sessionKey === GROUP_KEY && p.text.includes(`1 ${code}`))).toBe(true);
  });
});
