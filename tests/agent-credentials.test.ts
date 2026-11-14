import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
// The Agent builds a KeychainBackend. No test here may reach the real keychain.
vi.mock("../src/credentials/store.js", async (original) => {
  const actual = await original<typeof import("../src/credentials/store.js")>();
  return { ...actual, KeychainBackend: actual.MemoryBackend };
});

import { log } from "../src/logger.js";
import { Agent, MockChannel, drainQueue, installAgentTestHooks, makeMsg, mockConfig, mockSdk, resetConfig, useRealAdmission } from "./helpers/agent-harness.js";
import { createTomoInternalMcpServer } from "../src/mcp/internal-server.js";
import { CREDENTIAL_SCOPE_REFUSAL } from "../src/mcp/credential-tools.js";
import { clearSecretValuesForTests } from "../src/credentials/redactor.js";
import type { MemoryBackend } from "../src/credentials/store.js";

installAgentTestHooks();

const FAKE = "fake-agent-credential-51be";
const OWNER = "+15555550123";
const OWNER_CHAT = `any;-;${OWNER}`;
const OWNER_KEY = "dm:alex";
const GROUP_KEY = "imessage:any;+;group1";

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type ToolHandle = { name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> };

function setup(enabled = true) {
  useRealAdmission();
  resetConfig({
    channelAllowlists: { imessage: ["any;+;group1"] },
    identities: [{ name: "alex", channels: { imessage: OWNER }, replyPolicy: "last-active" }],
  });
  (mockConfig as unknown as { credentialBroker: { enabled: boolean } }).credentialBroker = { enabled };
  const agent = new Agent();
  const im = new MockChannel("imessage");
  agent.addChannel(im);
  const tools = (sessionKey: string) =>
    (createTomoInternalMcpServer(agent, sessionKey) as unknown as { tools: ToolHandle[] }).tools;
  const call = (sessionKey: string, name: string, args: Record<string, unknown>) =>
    tools(sessionKey).find((t) => t.name === name)!.handler(args);
  return { agent, im, tools, call };
}

function onDisk(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

function logged(): string {
  return JSON.stringify(Object.values(log).flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls));
}

describe("credential broker through the Agent", () => {
  beforeEach(() => {
    clearSecretValuesForTests();
    vi.clearAllMocks();
  });

  it("off by default: no tools, and the next message is an ordinary one", async () => {
    const { agent, im, tools } = setup(false);
    expect(agent.credentialBroker).toBeNull();
    expect(tools(OWNER_KEY).map((t) => t.name)).not.toContain("request_credential");
    mockSdk.responseFn = () => "hi";
    await im.simulateMessage(makeMsg({ chatId: OWNER_CHAT, senderId: OWNER, text: "hello" }));
    await drainQueue(agent);
    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual([OWNER_KEY]);
  });

  it("the captured reply reaches no prompt, transcript or log, and the session learns the outcome", async () => {
    const { agent, im, call } = setup();
    mockSdk.responseFn = () => "ok";

    const opened = await call(OWNER_KEY, "request_credential", { name: "github", purpose: "push" });
    expect(opened.isError).toBeUndefined();
    expect(JSON.parse(opened.content[0].text)).toMatchObject({ status: "pending", secret_ref: "secret://github" });
    expect(im.sent[0].chatId).toBe(OWNER);

    const custody = await im.simulateMessage(makeMsg({ id: "secret-guid", chatId: OWNER_CHAT, senderId: OWNER, text: FAKE, rawText: FAKE, attachmentCount: 0 }));
    expect(custody).toBe(true);
    await drainQueue(agent);

    const backend = (agent.credentialBroker as unknown as { deps: { backend: MemoryBackend } }).deps.backend;
    expect(backend.items.get("github")).toBe(FAKE);

    const prompts = mockSdk.promptsBySession.map((p) => p.text).join("\n");
    expect(prompts).toContain('type="credential"');
    expect(prompts).toContain("secret://github");
    expect(prompts).not.toContain(FAKE);
    expect(onDisk(mockConfig.tomoHome)).not.toContain(FAKE);
    expect(logged()).not.toContain(FAKE);
    expect(JSON.stringify(im.sent)).not.toContain(FAKE);
    agent.credentialBroker?.shutdown();
  });

  it("an ordinary message still flows after the request is answered", async () => {
    const { agent, im, call } = setup();
    mockSdk.responseFn = () => "ok";
    await call(OWNER_KEY, "request_credential", { name: "github", purpose: "push" });
    await im.simulateMessage(makeMsg({ chatId: OWNER_CHAT, senderId: OWNER, text: FAKE, rawText: FAKE, attachmentCount: 0 }));
    await im.simulateMessage(makeMsg({ chatId: OWNER_CHAT, senderId: OWNER, text: "thanks", rawText: "thanks", attachmentCount: 0 }));
    await drainQueue(agent);
    expect(mockSdk.promptsBySession.map((p) => p.text).join("\n")).toContain("thanks");
  });

  describe("refused off the owner's own turn", () => {
    const every: Array<[string, Record<string, unknown>]> = [
      ["request_credential", { name: "x", purpose: "p" }],
      ["run_with_secrets", { command: "true", secrets: {}, timeout_ms: 1000 }],
    ];

    it.each(every)("%s, in a group session", async (name, args) => {
      const { call, im } = setup();
      const result = await call(GROUP_KEY, name, args);
      expect(result).toMatchObject({ isError: true, content: [{ text: CREDENTIAL_SCOPE_REFUSAL }] });
      expect(im.sent).toEqual([]);
    });

    it.each(every)("%s, on a summoned group's turn on the owner's dm: key", async (name, args) => {
      const { agent, call, im } = setup();
      const registry = (agent as unknown as { turnAudiences: { begin(k: string, a: string[]): number } }).turnAudiences;
      registry.begin(OWNER_KEY, [GROUP_KEY]);
      const result = await call(OWNER_KEY, name, args);
      expect(result).toMatchObject({ isError: true, content: [{ text: CREDENTIAL_SCOPE_REFUSAL }] });
      expect(im.sent).toEqual([]);
    });

    it("request_credential, on a batch mixing the owner and a group", async () => {
      const { agent, call } = setup();
      const registry = (agent as unknown as { turnAudiences: { begin(k: string, a: string[]): number } }).turnAudiences;
      registry.begin(OWNER_KEY, ["dm", GROUP_KEY]);
      const result = await call(OWNER_KEY, "request_credential", { name: "x", purpose: "p" });
      expect(result.isError).toBe(true);
    });
  });

  it("a message in a group is never captured while a DM request is open", async () => {
    const { agent, im, call } = setup();
    mockSdk.responseFn = () => "NO_REPLY";
    await call(OWNER_KEY, "request_credential", { name: "x", purpose: "p" });
    await im.simulateMessage(makeMsg({ chatId: "any;+;group1", isGroup: true, senderId: OWNER, text: "group chatter", rawText: "group chatter", attachmentCount: 0 }));
    await drainQueue(agent);
    const backend = (agent.credentialBroker as unknown as { deps: { backend: MemoryBackend } }).deps.backend;
    expect(backend.items.size).toBe(0);
    agent.credentialBroker?.shutdown();
  });

  it("run_with_secrets resolves a ref into the environment and never into the result", async () => {
    const { agent, im, call } = setup();
    await call(OWNER_KEY, "request_credential", { name: "t", purpose: "p" });
    await im.simulateMessage(makeMsg({ chatId: OWNER_CHAT, senderId: OWNER, text: FAKE, rawText: FAKE, attachmentCount: 0 }));
    const result = await call(OWNER_KEY, "run_with_secrets", { command: 'printf "%s" "$T"', secrets: { T: "secret://t" }, cwd: tmpdir(), timeout_ms: 20_000 });
    expect(result.content[0].text).toContain("[REDACTED secret://t]");
    expect(result.content[0].text).not.toContain(FAKE);
    const unknown = await call(OWNER_KEY, "run_with_secrets", { command: "true", secrets: { T: "secret://nope" }, timeout_ms: 1000 });
    expect(unknown.isError).toBe(true);
    await drainQueue(agent);
  });

  // Codex finding 1, through the Agent: this is the path the review found open.
  it("an unreadable state file keeps the owner's reply out of the prompt, transcript and log", async () => {
    const dir = join(mockConfig.tomoHome, "data", "credentials");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "{ not json");
    const { agent, im, call } = setup();
    mockSdk.responseFn = () => "ok";
    expect(await im.simulateMessage(makeMsg({ chatId: OWNER_CHAT, senderId: OWNER, text: FAKE, rawText: FAKE, attachmentCount: 0 }))).toBe(true);
    await drainQueue(agent);
    expect(mockSdk.promptsBySession).toEqual([]);
    expect(logged()).not.toContain(FAKE);
    expect(onDisk(mockConfig.sessionsDir)).not.toContain(FAKE);
    expect(JSON.stringify(im.sent)).not.toContain(FAKE);
    const before = im.sent.length;
    expect((await call(OWNER_KEY, "request_credential", { name: "x", purpose: "p" })).isError).toBe(true);
    expect(im.sent).toHaveLength(before);
    rmSync(dir, { recursive: true, force: true });
  });
});
