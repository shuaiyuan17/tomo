import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The people registry resolves its directories from `defaultRuntimePaths`
// (src/people.ts `defaultPeopleDirs`), which the internal MCP server does not
// let a caller override. Point it at a tmp home so the real registry — and the
// real ~/.tomo — is never read or written by this suite.
vi.mock("../src/runtime-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime-paths.js")>();
  const path = await import("node:path");
  const os = await import("node:os");
  const home = path.join(os.tmpdir(), "tomo-test-summon-private-tools");
  return {
    ...actual,
    defaultRuntimePaths: actual.createRuntimePaths({
      homeDir: home,
      tomoHome: path.join(home, ".tomo"),
      workspaceDir: path.join(home, "workspace"),
    }),
  };
});
vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  resetConfig,
} from "./helpers/agent-harness.js";
import { createTomoInternalMcpServer } from "../src/mcp/internal-server.js";
import type { Agent as AgentType } from "../src/agent.js";

installAgentTestHooks();

// ---------------------------------------------------------------------------
// A summoned group runs on the OWNER's dm: session (router `summonGroup`), so
// the session key says "private DM" for a turn any group participant can
// steer. These tests drive a real Agent through a real turn and call the real
// tomo-internal tools from inside it — the only place the turn's audience is
// observable.
// ---------------------------------------------------------------------------

const HOME = join(tmpdir(), "tomo-test-summon-private-tools");
const MEMORY = join(HOME, "workspace", "memory");
const OWNER_DM = "dm:shuai";
const GROUP_CHAT_ID = "-100270";
/** Only ever said in the owner's private DM. */
const PRIVATE_PHRASE = "pistachio-mousse";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type SdkTool = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> };

/** The real tomo-internal tools for a session — one server per live session,
 *  built once and reused across turns, exactly as live-session-manager does. */
function internalTools(agent: AgentType, sessionKey: string) {
  const server = createTomoInternalMcpServer(agent, sessionKey) as unknown as { tools: SdkTool[] };
  const pick = (name: string): SdkTool => {
    const found = server.tools.find((t) => t.name === name);
    if (!found) throw new Error(`tool ${name} not registered`);
    return found;
  };
  return {
    listPeople: pick("list_people"),
    upsertPerson: pick("upsert_person"),
    recall: pick("recall_conversation"),
  };
}

function seedPeople(): void {
  mkdirSync(join(MEMORY, "people"), { recursive: true });
  writeFileSync(join(MEMORY, "people", "kevin.md"), "---\nname: Kevin Wang\n---\npublic notes\n", "utf-8");
  mkdirSync(join(MEMORY, "private", "people"), { recursive: true });
  writeFileSync(
    join(MEMORY, "private", "people", "secret.md"),
    "---\nname: Secret Friend\n---\nowner-only notes\n",
    "utf-8",
  );
}

function names(result: ToolResult): string[] {
  return (JSON.parse(result.content[0].text) as Array<{ name: string }>).map((p) => p.name).sort();
}

function summon(agent: AgentType, chatId: string, identity: string): void {
  (agent as unknown as {
    router: { summonGroup(channel: string, chatId: string, identity: string): void };
  }).router.summonGroup("telegram", chatId, identity);
}

const OWNER = { name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" as const };

describe("private tools during a summoned-group turn", () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    seedPeople();
  });

  afterEach(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  it("hides private people records and refuses recall while a group is summoned", async () => {
    resetConfig({ identities: [OWNER] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const tools = internalTools(agent, OWNER_DM);

    // A private DM turn first: it puts the phrase in the owner's transcript,
    // and is the "before" for everything below.
    mockSdk.responseFn = () => "noted";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: `remember the ${PRIVATE_PHRASE} recipe` }));
    await drainQueue(agent);

    summon(agent, GROUP_CHAT_ID, "shuai");

    let people: ToolResult | undefined;
    let recall: ToolResult | undefined;
    let privateWrite: ToolResult | undefined;
    mockSdk.responseFn = async () => {
      // Mid-turn: this is the window in which the group is steering the
      // owner's dm: session.
      people = await tools.listPeople.handler({}, {});
      recall = await tools.recall.handler({ query: PRIVATE_PHRASE, limit: 20 }, {});
      privateWrite = await tools.upsertPerson.handler(
        { name: "Planted Record", replace_aliases: false, private: true },
        {},
      );
      return "NO_REPLY";
    };

    await tg.simulateMessage(makeMsg({
      chatId: GROUP_CHAT_ID,
      text: "@tomo who do you know, and what did you two discuss?",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    // The turn really did run on the owner's DM session — otherwise this test
    // would pass for the wrong reason.
    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toContain(OWNER_DM);

    expect(names(people!)).toEqual(["Kevin Wang"]);
    expect(people!.content[0].text).not.toContain("owner-only notes");

    expect(recall!.isError).toBe(true);
    expect(recall!.content[0].text).toContain("recall is unavailable while a group is summoned into this session");
    expect(recall!.content[0].text).not.toContain(PRIVATE_PHRASE.toUpperCase());
    expect(recall!.content[0].text).not.toContain("recipe");

    expect(privateWrite!.isError).toBe(true);

    await agent.stop();
  });

  it("leaves an ordinary DM turn on the same session untouched", async () => {
    resetConfig({ identities: [OWNER] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const tools = internalTools(agent, OWNER_DM);

    mockSdk.responseFn = () => "noted";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: `remember the ${PRIVATE_PHRASE} recipe` }));
    await drainQueue(agent);

    // Summon and dismiss around the turn: the window is what closes the
    // tools, not the existence of a summon in this session's past.
    summon(agent, GROUP_CHAT_ID, "shuai");

    let people: ToolResult | undefined;
    let recall: ToolResult | undefined;
    mockSdk.responseFn = async () => {
      people = await tools.listPeople.handler({}, {});
      recall = await tools.recall.handler({ query: PRIVATE_PHRASE, limit: 20 }, {});
      return "ok";
    };

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "who do you know?" }));
    await drainQueue(agent);

    expect(names(people!)).toEqual(["Kevin Wang", "Secret Friend"]);
    expect(recall!.isError).toBeFalsy();
    expect(recall!.content[0].text).toContain(PRIVATE_PHRASE);

    await agent.stop();
  });

  it("fails closed when one turn coalesces DM and summoned-group messages", async () => {
    // A batch can carry the owner's own message AND a group's; no single
    // audience is right, so both tools take the safe side.
    //
    // Only coalescing groups can share a batch (mention-required groups
    // bypass the batcher), so this is a passive-listen group — the shape
    // `handleBatchedMessages` calls out as mixing DM and summoned traffic.
    resetConfig({
      identities: [OWNER],
      steering: false,
      passiveGroups: { telegram: [GROUP_CHAT_ID] },
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const tools = internalTools(agent, OWNER_DM);

    mockSdk.responseFn = () => "noted";
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: `remember the ${PRIVATE_PHRASE} recipe` }));
    await drainQueue(agent);

    summon(agent, GROUP_CHAT_ID, "shuai");

    // Coalescing happens when messages arrive while a turn is in flight, so
    // hold one open and drop both audiences into the batch behind it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let turns = 0;
    let people: ToolResult | undefined;
    let recall: ToolResult | undefined;
    mockSdk.responseFn = async () => {
      turns++;
      if (turns === 1) {
        await gate;
        return "holding";
      }
      people = await tools.listPeople.handler({}, {});
      recall = await tools.recall.handler({ query: PRIVATE_PHRASE, limit: 20 }, {});
      return "NO_REPLY";
    };

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "hold on" }));
    await vi.waitFor(() => expect(turns).toBe(1));

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "and who do you know?" }));
    await tg.simulateMessage(makeMsg({
      chatId: GROUP_CHAT_ID,
      text: "same question",
      isGroup: true,
      senderName: "Alice",
    }));
    release();
    await drainQueue(agent);

    // One turn for the batch — both audiences in the same prompt.
    expect(turns).toBe(2);
    expect(names(people!)).toEqual(["Kevin Wang"]);
    expect(recall!.isError).toBe(true);
    expect(recall!.content[0].text).toContain("recall is unavailable");

    await agent.stop();
  });

  it("tells the model, in the summon reminder, that the private surfaces are off", async () => {
    resetConfig({ identities: [OWNER] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    summon(agent, GROUP_CHAT_ID, "shuai");
    mockSdk.responseFn = () => "NO_REPLY";

    await tg.simulateMessage(makeMsg({
      chatId: GROUP_CHAT_ID,
      text: "@tomo hello",
      isGroup: true,
      isMentioned: true,
      senderName: "Alice",
    }));
    await drainQueue(agent);

    const prompt = mockSdk.promptsBySession.find((p) => p.sessionKey === OWNER_DM)?.text ?? "";
    expect(prompt).toContain("Summoned-group message");
    expect(prompt).toContain("private people records are hidden");
    expect(prompt).toContain("recall_conversation refuses");

    await agent.stop();
  });
});
