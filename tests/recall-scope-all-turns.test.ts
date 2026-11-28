import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

// One unique directory per run, created before the hoisted vi.mock factories
// below read it.
const TMP = await vi.hoisted(async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), "tomo-test-recall-scope-all-")) };
});

// The internal MCP server builds tools that resolve directories from
// `defaultRuntimePaths`; keep every one of them inside the tmp home.
vi.mock("../src/runtime-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime-paths.js")>();
  const path = await import("node:path");
  const home = TMP.home;
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
  waitFor,
} from "./helpers/agent-harness.js";
import { createTomoInternalMcpServer } from "../src/mcp/internal-server.js";
import {
  RECALL_FOREIGN_AUDIENCE_REFUSAL,
  RECALL_SCOPE_ALL_ELSEWHERE_REFUSAL,
  RECALL_SCOPE_ALL_SHARED_REFUSAL,
} from "../src/mcp/recall-tools.js";
import type { Agent as AgentType } from "../src/agent.js";

installAgentTestHooks();
afterAll(() => rmSync(TMP.home, { recursive: true, force: true }));

// ===== recall_conversation scope "all", turn by turn =====
//
// scope "all" searches the group chats from the owner's DM. It must be open
// on exactly one kind of turn: the owner's own, on the DM session, running on
// the full prompt. These drive a real Agent through each kind of turn and call
// the real tool from inside it, where the turn's audience is observable.

const OWNER_DM = "dm:shuai";
const OWNER_CHAT = "12345";
const GROUP_CHAT = "-100270";
const GROUP = `telegram:${GROUP_CHAT}`;
/** Only ever said in the group. */
const GROUP_PHRASE = "zucchini regatta";
/** Only ever said in the owner's private DM. */
const DM_PHRASE = "pistachio mousse";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type SdkTool = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> };
type AgentInstance = InstanceType<typeof Agent>;

const running = new Set<AgentType>();
afterEach(async () => {
  for (const agent of [...running]) await agent.stop();
  running.clear();
});

function toolsOf(agent: AgentType, sessionKey: string): SdkTool[] {
  return (createTomoInternalMcpServer(agent, sessionKey) as unknown as { tools: SdkTool[] }).tools;
}

function recallTool(agent: AgentType, sessionKey: string): SdkTool {
  const found = toolsOf(agent, sessionKey).find((t) => t.name === "recall_conversation");
  if (!found) throw new Error("recall_conversation not registered");
  return found;
}

interface Internals {
  router: { summonGroup(channel: string, chatId: string, identity?: string): void };
  liveSessionManager: { hasSharedPrompt(key: string): boolean | undefined };
}
const internals = (agent: AgentInstance) => agent as unknown as Internals;

const ownerMsg = (text: string) => makeMsg({ chatId: OWNER_CHAT, text });
const groupMsg = (text: string) => makeMsg({
  chatId: GROUP_CHAT, isGroup: true, isMentioned: true, senderName: "Alice", chatTitle: "Book club", text,
});

/**
 * An agent with a DM history and a group history: the group's session said
 * GROUP_PHRASE, the owner's DM said DM_PHRASE. Both turns ran on their own
 * sessions, so each transcript holds only its own phrase.
 */
async function setup(overrides: Parameters<typeof resetConfig>[0] = {}): Promise<{ agent: AgentInstance; tg: MockChannel }> {
  resetConfig({
    identities: [{ name: "shuai", channels: { telegram: OWNER_CHAT }, replyPolicy: "last-active" }],
    ...overrides,
  });
  const agent = new Agent();
  running.add(agent);
  const tg = new MockChannel("telegram");
  agent.addChannel(tg);
  mockSdk.responseFn = () => "noted";
  await tg.simulateMessage(groupMsg(`@tomo the ${GROUP_PHRASE} is on Saturday`));
  await drainQueue(agent);
  await tg.simulateMessage(ownerMsg(`remember the ${DM_PHRASE} recipe`));
  await drainQueue(agent);
  return { agent, tg };
}

/** Runs `trigger`, and from inside the turn it starts calls recall on `sessionKey` with scope "all". */
async function scopeAllDuring(
  agent: AgentInstance,
  sessionKey: string,
  match: string,
  trigger: () => Promise<unknown>,
): Promise<ToolResult> {
  const tool = recallTool(agent, sessionKey);
  let result: ToolResult | undefined;
  mockSdk.responseFn = async (text) => {
    if (text.includes(match)) result = await tool.handler({ queries: [GROUP_PHRASE, DM_PHRASE], scope: "all", limit: 20 }, {});
    return "NO_REPLY";
  };
  await trigger();
  await drainQueue(agent);
  if (!result) throw new Error(`no turn matched ${match}`);
  return result;
}

function expectSearchedGroups(result: ToolResult): void {
  expect(result.isError).toBeFalsy();
  const text = result.content[0].text;
  expect(text).toMatch(new RegExp(`\\[group "Book club"\\] \\[[^\\]]+\\].*${GROUP_PHRASE}`));
  // The owner's own DM hit, unmarked.
  expect(text).toMatch(new RegExp(`^\\[[^\\]]+\\].*${DM_PHRASE}`, "m"));
}

function expectRefused(result: ToolResult, reason: string): void {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain(reason);
  expect(result.content[0].text).not.toContain(GROUP_PHRASE);
  expect(result.content[0].text).not.toContain(DM_PHRASE);
}

describe("scope all: open on the owner's own turn on the full prompt", () => {
  it("the owner's private message, no summon: searches the group chats, each hit marked with its group", async () => {
    const { agent, tg } = await setup();
    const result = await scopeAllDuring(agent, OWNER_DM, "OWNER-ASK", () => tg.simulateMessage(ownerMsg("OWNER-ASK")));
    expectSearchedGroups(result);
    expect(result.content[0].text).toContain(`- group "Book club": searched back to`);
    expect(result.content[0].text).toContain("- this conversation: searched back to");
  });

  it("the owner's own cron job on the DM session, no summon: searches the group chats", async () => {
    const { agent } = await setup();
    const result = await scopeAllDuring(agent, OWNER_DM, "OWNER-CRON", () => agent.handleCronMessage("OWNER-CRON", OWNER_DM));
    expectSearchedGroups(result);
  });

  it("a heartbeat, no summon: searches the group chats", async () => {
    const { agent } = await setup();
    const result = await scopeAllDuring(agent, OWNER_DM, "HEARTBEAT-TICK", () => agent.handleContinuity("System: HEARTBEAT-TICK"));
    expectSearchedGroups(result);
  });

  it("scope this on the same turn stays this conversation only", async () => {
    const { agent, tg } = await setup();
    const tool = recallTool(agent, OWNER_DM);
    let result: ToolResult | undefined;
    mockSdk.responseFn = async () => {
      result = await tool.handler({ queries: [GROUP_PHRASE], limit: 20 }, {});
      return "ok";
    };
    await tg.simulateMessage(ownerMsg("plain ask"));
    await drainQueue(agent);
    expect(result!.content[0].text).toContain("No matching messages found");
  });
});

describe("scope all: refused on every turn a group can read", () => {
  it("the owner's private message while a group is summoned in (shared prompt)", async () => {
    const { agent, tg } = await setup();
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    const result = await scopeAllDuring(agent, OWNER_DM, "OWNER-DURING-SUMMON", () => tg.simulateMessage(ownerMsg("OWNER-DURING-SUMMON")));
    expectRefused(result, RECALL_SCOPE_ALL_SHARED_REFUSAL);
  });

  it("the owner's turn already running on the full prompt when a summon starts", async () => {
    const { agent, tg } = await setup();
    const tool = recallTool(agent, OWNER_DM);
    let result: ToolResult | undefined;
    mockSdk.responseFn = async (text) => {
      if (!text.includes("OWNER-MID-SUMMON")) return "ok";
      expect(internals(agent).liveSessionManager.hasSharedPrompt(OWNER_DM)).toBe(false);
      internals(agent).router.summonGroup("telegram", GROUP_CHAT);
      result = await tool.handler({ queries: [GROUP_PHRASE], scope: "all", limit: 20 }, {});
      return "ok";
    };
    await tg.simulateMessage(ownerMsg("OWNER-MID-SUMMON"));
    await drainQueue(agent);
    expectRefused(result!, RECALL_SCOPE_ALL_SHARED_REFUSAL);
  });

  it("the owner's turn on a session that has the shared prompt, even with no summon", async () => {
    const { agent, tg } = await setup();
    const tool = recallTool(agent, OWNER_DM);
    let result: ToolResult | undefined;
    mockSdk.responseFn = async (text) => {
      if (!text.includes("OWNER-ON-SHARED")) return "ok";
      const live = internals(agent).liveSessionManager;
      const spy = vi.spyOn(live, "hasSharedPrompt").mockReturnValue(true);
      result = await tool.handler({ queries: [GROUP_PHRASE], scope: "all", limit: 20 }, {});
      spy.mockReturnValue(undefined);
      const unknown = await tool.handler({ queries: [GROUP_PHRASE], scope: "all", limit: 20 }, {});
      spy.mockRestore();
      // A session whose variant cannot be read fails closed too.
      expectRefused(unknown, RECALL_SCOPE_ALL_SHARED_REFUSAL);
      return "ok";
    };
    await tg.simulateMessage(ownerMsg("OWNER-ON-SHARED"));
    await drainQueue(agent);
    expectRefused(result!, RECALL_SCOPE_ALL_SHARED_REFUSAL);
  });

  it("the owner's own cron job while a group is summoned in", async () => {
    const { agent } = await setup();
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    const result = await scopeAllDuring(agent, OWNER_DM, "OWNER-CRON-SUMMONED", () => agent.handleCronMessage("OWNER-CRON-SUMMONED", OWNER_DM));
    expectRefused(result, RECALL_SCOPE_ALL_SHARED_REFUSAL);
  });

  it("a summoned group's message: recall itself is refused", async () => {
    const { agent, tg } = await setup();
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    const result = await scopeAllDuring(agent, OWNER_DM, "GROUP-SUMMONED-ASK", () => tg.simulateMessage(groupMsg("@tomo GROUP-SUMMONED-ASK")));
    expectRefused(result, RECALL_FOREIGN_AUDIENCE_REFUSAL);
  });

  it("a batch mixing the owner's message with a summoned group's", async () => {
    const { agent, tg } = await setup({ steering: false, passiveGroups: { telegram: [GROUP_CHAT] } });
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    const tool = recallTool(agent, OWNER_DM);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    let result: ToolResult | undefined;
    mockSdk.responseFn = async (text) => {
      if (text.includes("HOLD")) { started = true; await gate; return "ok"; }
      if (text.includes("MIXED-OWNER") && text.includes("MIXED-GROUP")) {
        result = await tool.handler({ queries: [GROUP_PHRASE], scope: "all", limit: 20 }, {});
      }
      return "NO_REPLY";
    };
    await tg.simulateMessage(ownerMsg("HOLD"));
    await waitFor(() => expect(started).toBe(true));
    await tg.simulateMessage(ownerMsg("MIXED-OWNER"));
    await tg.simulateMessage(makeMsg({ chatId: GROUP_CHAT, isGroup: true, senderName: "Alice", text: "MIXED-GROUP" }));
    release();
    await drainQueue(agent);
    expectRefused(result!, RECALL_FOREIGN_AUDIENCE_REFUSAL);
  });

  it("a group session's delegate to the owner", async () => {
    const { agent } = await setup();
    const result = await scopeAllDuring(agent, OWNER_DM, "DELEGATED-ASK", async () => {
      expect((await agent.delegateToSession("shuai", "DELEGATED-ASK", GROUP)).ok).toBe(true);
    });
    expectRefused(result, RECALL_FOREIGN_AUDIENCE_REFUSAL);
  });

  it("a summoned group's cron job, handed to the DM session", async () => {
    const { agent } = await setup();
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    const result = await scopeAllDuring(agent, OWNER_DM, "GROUP-CRON-JOB", () => agent.handleCronMessage("GROUP-CRON-JOB", GROUP, { waitForHandoff: true }));
    expectRefused(result, RECALL_FOREIGN_AUDIENCE_REFUSAL);
  });

  it("a group's own session: scope all is refused, and scope this never reaches the DM", async () => {
    const { agent, tg } = await setup();
    const tool = recallTool(agent, GROUP);
    let all: ToolResult | undefined;
    let own: ToolResult | undefined;
    let gate: boolean | undefined;
    mockSdk.responseFn = async (text) => {
      if (!text.includes("GROUP-OWN-ASK")) return "ok";
      // Refused by the agent as well, not only by the tool not being given it.
      gate = agent.canRecallGroupChats(GROUP);
      all = await tool.handler({ queries: [GROUP_PHRASE, DM_PHRASE], scope: "all", limit: 20 }, {});
      own = await tool.handler({ queries: [GROUP_PHRASE, DM_PHRASE], scope: "this", limit: 20 }, {});
      return "NO_REPLY";
    };
    await tg.simulateMessage(groupMsg("@tomo GROUP-OWN-ASK"));
    await drainQueue(agent);
    expectRefused(all!, RECALL_SCOPE_ALL_ELSEWHERE_REFUSAL);
    expect(gate).toBe(false);
    expect(own!.isError).toBeFalsy();
    expect(own!.content[0].text).toContain(GROUP_PHRASE);
    expect(own!.content[0].text).not.toContain(DM_PHRASE);
  });

  it("the group-side read never opens a session that is not a group", async () => {
    const { agent } = await setup();
    const opts = { queries: [DM_PHRASE], fromTime: 0, limit: 20 };
    expect(agent.recallSessionTranscript(OWNER_DM, opts).hits).toHaveLength(1);
    expect(agent.recallGroupTranscript(OWNER_DM, opts).hits).toEqual([]);
    expect(agent.groupRecallSources().map((g) => g.key)).toEqual([GROUP]);
  });

  it("a sub-session has no recall tool at all", () => {
    resetConfig({ identities: [{ name: "shuai", channels: { telegram: OWNER_CHAT }, replyPolicy: "last-active" }] });
    const agent = new Agent();
    running.add(agent);
    expect(toolsOf(agent, "task:s1").map((t) => t.name)).not.toContain("recall_conversation");
  });
});
