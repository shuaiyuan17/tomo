import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { WebChannel } from "../src/channels/web.js";
import { WebRequestJournal } from "../src/web/request-journal.js";
import { WatchBus } from "../src/watch/bus.js";
import type { WebEvent } from "../src/web/protocol.js";
import { randomUUID } from "node:crypto";

installAgentTestHooks();

const FAKE = "fake-agent-credential-51be";
const OWNER = "+15555550123";
const OWNER_CHAT = `any;-;${OWNER}`;
const OWNER_KEY = "dm:alex";
const GROUP_KEY = "imessage:any;+;group1";
const TG_OWNER = "1001";

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type ToolHandle = { name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> };

/** A Telegram channel that can delete the owner's incoming messages, as the real one can in a private chat. */
class DeletingChannel extends MockChannel {
  deleted: string[] = [];
  refuseDelete = false;
  async deleteInboundMessage(_chatId: string, messageId: string): Promise<void> {
    if (this.refuseDelete) throw new Error("Bad Request: message can't be deleted");
    this.deleted.push(messageId);
  }
}

type Registry = { begin(k: string, a: string[], o?: Array<{ channelName: string; chatId: string }>): number; end(k: string, id: number): void };

function setup(enabled = true) {
  useRealAdmission();
  resetConfig({
    channelAllowlists: { imessage: ["any;+;group1"] },
    identities: [{ name: "alex", channels: { imessage: OWNER, telegram: TG_OWNER }, replyPolicy: "last-active" }],
  });
  (mockConfig as unknown as { credentialBroker: { enabled: boolean } }).credentialBroker = { enabled };
  const agent = new Agent();
  const im = new MockChannel("imessage");
  const tg = new DeletingChannel("telegram");
  agent.addChannel(im);
  agent.addChannel(tg);
  const registry = (agent as unknown as { turnAudiences: Registry }).turnAudiences;
  const tools = (sessionKey: string) =>
    (createTomoInternalMcpServer(agent, sessionKey) as unknown as { tools: ToolHandle[] }).tools;
  const call = (sessionKey: string, name: string, args: Record<string, unknown>) =>
    tools(sessionKey).find((t) => t.name === name)!.handler(args);
  /** As if the owner's turn on `channelName` were in flight (runUserTurn registers it so). */
  const ownTurn = (channelName = "imessage", chatId = channelName === "imessage" ? OWNER_CHAT : TG_OWNER) =>
    registry.begin(OWNER_KEY, ["dm"], [{ channelName, chatId }]);
  return { agent, im, tg, registry, tools, call, ownTurn };
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
    const { agent, im, call, ownTurn } = setup();
    mockSdk.responseFn = () => "ok";
    ownTurn();

    const opened = await call(OWNER_KEY, "request_credential", { name: "github", purpose: "push" });
    expect(opened.isError).toBeUndefined();
    expect(JSON.parse(opened.content[0].text)).toMatchObject({ status: "pending", secret_ref: "secret://github" });
    expect(im.sent[0].chatId).toBe(OWNER_CHAT);

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
    const { agent, im, call, ownTurn } = setup();
    mockSdk.responseFn = () => "ok";
    ownTurn();
    await call(OWNER_KEY, "request_credential", { name: "github", purpose: "push" });
    await im.simulateMessage(makeMsg({ chatId: OWNER_CHAT, senderId: OWNER, text: FAKE, rawText: FAKE, attachmentCount: 0 }));
    await im.simulateMessage(makeMsg({ chatId: OWNER_CHAT, senderId: OWNER, text: "thanks", rawText: "thanks", attachmentCount: 0 }));
    await drainQueue(agent);
    expect(mockSdk.promptsBySession.map((p) => p.text).join("\n")).toContain("thanks");
  });

  describe("refused off the owner's own turn", () => {
    const every: Array<[string, Record<string, unknown>]> = [
      ["request_credential", { name: "x", purpose: "p" }],
    ];

    it.each(every)("%s, in a group session", async (name, args) => {
      const { call, im } = setup();
      const result = await call(GROUP_KEY, name, args);
      expect(result).toMatchObject({ isError: true, content: [{ text: CREDENTIAL_SCOPE_REFUSAL }] });
      expect(im.sent).toEqual([]);
    });

    it.each(every)("%s, on a summoned group's turn on the owner's dm: key", async (name, args) => {
      const { registry, call, im } = setup();
      registry.begin(OWNER_KEY, [GROUP_KEY], [{ channelName: "imessage", chatId: "any;+;group1" }]);
      const result = await call(OWNER_KEY, name, args);
      expect(result).toMatchObject({ isError: true, content: [{ text: CREDENTIAL_SCOPE_REFUSAL }] });
      expect(im.sent).toEqual([]);
    });

    it("request_credential, on a batch mixing the owner and a group", async () => {
      const { registry, call } = setup();
      registry.begin(OWNER_KEY, ["dm", GROUP_KEY], [{ channelName: "imessage", chatId: OWNER_CHAT }, { channelName: "imessage", chatId: "any;+;group1" }]);
      const result = await call(OWNER_KEY, "request_credential", { name: "x", purpose: "p" });
      expect(result.isError).toBe(true);
    });
  });

  it("a message in a group is never captured while a DM request is open", async () => {
    const { agent, im, call, ownTurn } = setup();
    mockSdk.responseFn = () => "NO_REPLY";
    ownTurn();
    await call(OWNER_KEY, "request_credential", { name: "x", purpose: "p" });
    await im.simulateMessage(makeMsg({ chatId: "any;+;group1", isGroup: true, senderId: OWNER, text: "group chatter", rawText: "group chatter", attachmentCount: 0 }));
    await drainQueue(agent);
    const backend = (agent.credentialBroker as unknown as { deps: { backend: MemoryBackend } }).deps.backend;
    expect(backend.items.size).toBe(0);
    agent.credentialBroker?.shutdown();
  });

  it("refuses a turn nobody is typing in: no live turn (cron, heartbeat), and a batch across two chats", async () => {
    const { call, registry, im, tg } = setup();
    expect(await call(OWNER_KEY, "request_credential", { name: "x", purpose: "p" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("scheduled job") }] });
    const id = registry.begin(OWNER_KEY, ["dm"], [{ channelName: "imessage", chatId: OWNER_CHAT }, { channelName: "telegram", chatId: TG_OWNER }]);
    expect((await call(OWNER_KEY, "request_credential", { name: "x", purpose: "p" })).isError).toBe(true);
    registry.end(OWNER_KEY, id);
    // A background turn registered with no origin (a delegated turn) refuses too.
    registry.begin(OWNER_KEY, ["dm"]);
    expect((await call(OWNER_KEY, "request_credential", { name: "x", purpose: "p" })).isError).toBe(true);
    expect([...im.sent, ...tg.sent]).toEqual([]);
  });

  // The whole path on Telegram: the owner's message starts a real turn, the
  // model calls the tool during it, the prompt goes back to THAT chat, the
  // reply is captured, deleted from the chat, and reaches nothing else.
  it("asks on Telegram when the turn came in on Telegram, captures the reply, and deletes it from the chat", async () => {
    const { agent, im, tg, call } = setup();
    let opened: ToolResult | undefined;
    mockSdk.responseFn = async (text) => {
      if (text.includes("set up github")) opened = await call(OWNER_KEY, "request_credential", { name: "github", purpose: "push" });
      return "ok";
    };
    await tg.simulateMessage(makeMsg({ chatId: TG_OWNER, senderId: TG_OWNER, text: "please set up github", rawText: "please set up github", attachmentCount: 0 }));
    await drainQueue(agent);
    expect(opened?.isError).toBeUndefined();
    expect(JSON.parse(opened!.content[0].text)).toMatchObject({ asked_on: "telegram", read_with: expect.stringContaining("-a github -w") });
    expect(tg.sent.some((m) => m.chatId === TG_OWNER && m.text.includes("Tomo is asking for a credential"))).toBe(true);
    expect(im.sent).toEqual([]);

    const custody = await tg.simulateMessage(makeMsg({ id: "4242", chatId: TG_OWNER, senderId: TG_OWNER, text: FAKE, rawText: FAKE, attachmentCount: 0 }));
    expect(custody).toBe(true);
    await drainQueue(agent);
    expect(tg.deleted).toEqual(["4242"]);
    const backend = (agent.credentialBroker as unknown as { deps: { backend: MemoryBackend } }).deps.backend;
    expect(backend.items.get("github")).toBe(FAKE);
    const prompts = mockSdk.promptsBySession.map((p) => p.text).join("\n");
    expect(prompts).toContain("secret://github");
    expect(prompts).not.toContain(FAKE);
    expect(onDisk(mockConfig.tomoHome)).not.toContain(FAKE);
    expect(logged()).not.toContain(FAKE);
    expect(JSON.stringify([tg.sent, im.sent])).not.toContain(FAKE);
    agent.credentialBroker?.shutdown();
  });

  it("passes the owner's ordinary Telegram messages through once the request is over", async () => {
    const { agent, tg, call, ownTurn } = setup();
    mockSdk.responseFn = () => "ok";
    ownTurn("telegram");
    await call(OWNER_KEY, "request_credential", { name: "x", purpose: "p" });
    tg.refuseDelete = true;
    await tg.simulateMessage(makeMsg({ id: "1", chatId: TG_OWNER, senderId: TG_OWNER, text: FAKE, rawText: FAKE, attachmentCount: 0 }));
    expect(tg.sent.at(-1)?.text).toContain("delete it from this chat yourself");
    await tg.simulateMessage(makeMsg({ id: "2", chatId: TG_OWNER, senderId: TG_OWNER, text: "thanks", rawText: "thanks", attachmentCount: 0 }));
    await drainQueue(agent);
    const prompts = mockSdk.promptsBySession.map((p) => p.text).join("\n");
    expect(prompts).toContain("thanks");
    expect(prompts).not.toContain(FAKE);
  });

  // The web UI through the real Agent: the owner's web message starts a turn,
  // the tool asks there (a card, not a chat prompt), the card's answer goes to
  // the broker, and the value reaches no prompt, transcript, journal, event or
  // log. Telegram and iMessage stay untouched, and the web chat keeps working.
  it("asks through the web card when the turn came in on the web UI; the value reaches nothing else", async () => {
    const { agent, im, tg, call } = setup();
    const bus = new WatchBus();
    const web = new WebChannel(mockConfig.owner, bus, {
      journal: new WebRequestJournal(join(mockConfig.tomoHome, "data", "web", "requests.jsonl")),
      credentials: { current: () => agent.credentialBroker!.formRequest("web"), submit: (id, input) => agent.credentialBroker!.fulfill(id, input) },
    });
    agent.addChannel(web);
    const events: WebEvent[] = [];
    web.events.subscribe(({ event }) => events.push(event));
    let opened: ToolResult | undefined;
    mockSdk.responseFn = async (text) => {
      if (text.includes("set up github")) opened = await call(OWNER_KEY, "request_credential", { name: "github", purpose: "push" });
      return "ok";
    };
    await web.receive({ requestId: randomUUID(), text: "please set up github" });
    await drainQueue(agent);
    expect(JSON.parse(opened!.content[0].text)).toMatchObject({ asked_on: "web" });
    expect([...im.sent, ...tg.sent]).toEqual([]);
    const card = events.find((e) => e.type === "credential-request" && e.request) as Extract<WebEvent, { type: "credential-request" }>;
    expect(card.request).toMatchObject({ name: "github", purpose: "push" });
    expect(web.snapshot().credentialRequest).toEqual(card.request);

    // The web chat is not held while the card is open.
    await web.receive({ requestId: randomUUID(), text: "still chatting" });
    await drainQueue(agent);
    expect(mockSdk.promptsBySession.map((p) => p.text).join("\n")).toContain("still chatting");

    expect(await web.submitCredential(card.request!.id, { value: FAKE })).toEqual({ status: "stored" });
    await drainQueue(agent);
    const backend = (agent.credentialBroker as unknown as { deps: { backend: MemoryBackend } }).deps.backend;
    expect(backend.items.get("github")).toBe(FAKE);
    expect(events.at(-1)).toEqual({ type: "credential-request", request: null });
    expect(web.snapshot().credentialRequest).toBeUndefined();
    await expect(web.submitCredential(card.request!.id, { value: FAKE })).rejects.toMatchObject({ status: 409 });

    const prompts = mockSdk.promptsBySession.map((p) => p.text).join("\n");
    expect(prompts).toContain("secret://github");
    expect(prompts).not.toContain(FAKE);
    expect(onDisk(mockConfig.tomoHome)).toContain("still chatting");
    expect(onDisk(mockConfig.tomoHome)).not.toContain(FAKE);
    expect(onDisk(mockConfig.sessionsDir)).not.toContain(FAKE);
    expect(JSON.stringify(events)).not.toContain(FAKE);
    expect(logged()).not.toContain(FAKE);
    agent.credentialBroker?.shutdown();
    await web.stop();
  });

  // Codex finding 1, through the Agent: this is the path the review found open.
  it("an unreadable state file keeps the owner's reply out of the prompt, transcript and log", async () => {
    const dir = join(mockConfig.tomoHome, "data", "credentials");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "{ not json");
    const { agent, im, call, ownTurn } = setup();
    mockSdk.responseFn = () => "ok";
    expect(await im.simulateMessage(makeMsg({ chatId: OWNER_CHAT, senderId: OWNER, text: FAKE, rawText: FAKE, attachmentCount: 0 }))).toBe(true);
    await drainQueue(agent);
    expect(mockSdk.promptsBySession).toEqual([]);
    expect(logged()).not.toContain(FAKE);
    expect(onDisk(mockConfig.sessionsDir)).not.toContain(FAKE);
    expect(JSON.stringify(im.sent)).not.toContain(FAKE);
    const before = im.sent.length;
    ownTurn();
    expect((await call(OWNER_KEY, "request_credential", { name: "x", purpose: "p" })).isError).toBe(true);
    expect(im.sent).toHaveLength(before);
    rmSync(dir, { recursive: true, force: true });
  });
});
