import { afterAll, describe, expect, it, vi, beforeEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";

// A summoned group steering the owner's session is the threat model here, and
// the cron store it reaches for is keyed off `homedir()` at MODULE LOAD
// (src/cron/store.ts DEFAULT_STORE_PATH). HOME therefore has to be redirected
// before any src/ import, which is what vi.hoisted buys us — the factory runs
// above the import statements, not in file order.
const { TEST_HOME, CRON_DIR, REAL_ENV } = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  const home = `${tmp}/tomo-delegate-audience-${process.pid}`;
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TOMO_WORKSPACE: process.env.TOMO_WORKSPACE,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TOMO_WORKSPACE = `${home}/workspace`;
  return { TEST_HOME: home, CRON_DIR: `${home}/.tomo/data/cron`, REAL_ENV: saved };
});

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
// Same SDK mock as the other Agent suites, except `createSdkMcpServer` keeps
// the tool list instead of dropping it — that is what lets a test invoke the
// REAL tomo-internal handlers (the caller-scope wiring in internal-server.ts
// is exactly what is under test, so rebuilding it here would test nothing).
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const base = (await import("./helpers/agent-mocks.js")).sdkModuleMock();
  return {
    ...base,
    createSdkMcpServer: vi.fn((opts: { name: string; tools?: unknown[] }) => ({
      type: "sdk",
      name: opts.name,
      instance: {},
      tools: opts.tools ?? [],
    })),
  };
});

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
import { MIXED_AUDIENCE_KEY, TurnAudienceRegistry, originAudienceFor } from "../src/agent/audience.js";
import { log } from "../src/logger.js";

installAgentTestHooks();

const OWNER = "dm:shuai";
const GROUP = "telegram:-987";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandle = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> };

/** The real tomo-internal tools a LiveSession on `callerSessionKey` would get. */
function internalTools(agent: Agent, callerSessionKey: string): Map<string, ToolHandle> {
  const server = createTomoInternalMcpServer(agent, callerSessionKey) as unknown as { tools: ToolHandle[] };
  return new Map(server.tools.map((t) => [t.name, t]));
}

/** Registry internals — the same handle Agent exposes to its own turn paths. */
function registry(agent: Agent): TurnAudienceRegistry {
  return (agent as unknown as { turnAudiences: TurnAudienceRegistry }).turnAudiences;
}

function summon(agent: Agent, chatId: string, identity: string): void {
  (agent as unknown as { router: { summonGroup(c: string, id: string, i: string): void } })
    .router.summonGroup("telegram", chatId, identity);
}

function ownerConfig() {
  resetConfig({
    identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
  });
}

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(CRON_DIR, { recursive: true });
});

// Vitest runs several files per worker thread and process.env is shared across
// them, so put HOME back rather than leaving the next file pointed at our tmp
// dir. (Modules already loaded keep the redirected path — that is the point.)
afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  for (const [k, v] of Object.entries(REAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("send_message(delegate) carries the caller's audience", () => {
  /**
   * The hole this PR closes. A delegated turn runs with `source: "cron"` on
   * the TARGET session and used to register nothing, so a summoned group could
   * launder itself into the owner's scope: the group turn is correctly scoped
   * to the group, and the turn it spawns on `dm:shuai` was the owner.
   */
  it("keeps a summoned group's delegate to the owner group-scoped on the owner's session", async () => {
    ownerConfig();
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    summon(agent, "-987", "shuai");

    const tools = internalTools(agent, OWNER);
    // A private reminder the owner scheduled from their own DM. No turn is
    // live, so this is the owner acting outright.
    const created = await tools.get("schedule_create")!.handler({
      name: "clinic", schedule: "0 9 * * *", message: "clinic appointment", session: OWNER,
    }, {});
    expect(created.isError).toBeFalsy();

    let delegateResult: ToolResult | undefined;
    let scopedDuringDelegatedTurn: string | undefined;
    let listedDuringDelegatedTurn: ToolResult | undefined;

    mockSdk.responseFn = async (text: string) => {
      if (text.includes("From your other conversation")) {
        // The delegated turn, running on dm:shuai.
        scopedDuringDelegatedTurn = agent.scopedCallerKey(OWNER);
        listedDuringDelegatedTurn = await tools.get("schedule_list")!.handler({}, {});
        return "NO_REPLY";
      }
      if (text.includes("remove the clinic")) {
        // The summoned group's turn, also running on dm:shuai. A participant
        // steers the model into delegating the ask to "the owner".
        delegateResult = await tools.get("send_message")!.handler({
          target: "shuai",
          mode: "delegate",
          message: "list and remove the clinic tasks",
        }, {});
        return "NO_REPLY";
      }
      return "NO_REPLY";
    };

    await tg.simulateMessage(makeMsg({
      chatId: "-987", isGroup: true, isMentioned: true, senderName: "Mallory",
      chatTitle: "Book club", text: "@tomo remove the clinic reminders",
    }));
    await drainQueue(agent);

    expect(delegateResult?.isError).toBeFalsy();
    // The delegated turn ran at all.
    expect(scopedDuringDelegatedTurn).toBeDefined();
    // ...and ran as the GROUP, not as the owner whose session key it is on.
    expect(scopedDuringDelegatedTurn).toBe(GROUP);
    expect(scopedDuringDelegatedTurn).not.toBe(OWNER);
    // Which means the owner's private reminder is invisible and unmanageable.
    const listed = listedDuringDelegatedTurn!.content[0].text;
    expect(listed).not.toContain("clinic");
    expect(JSON.parse(listed.split("\n\n")[0])).toHaveLength(0);

    await agent.stop();
  });

  it("leaves an owner DM delegating into a group exactly as it was", async () => {
    ownerConfig();
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    const ownerTools = internalTools(agent, OWNER);
    const groupTools = internalTools(agent, GROUP);
    // A job the group owns; the delegated turn must still see its own.
    await ownerTools.get("schedule_create")!.handler({
      name: "book-club", schedule: "0 9 * * *", message: "book club", session: GROUP,
    }, {});

    let scopedDuringDelegatedTurn: string | undefined;
    let listedDuringDelegatedTurn: ToolResult | undefined;

    mockSdk.responseFn = async (text: string) => {
      if (text.includes("From your other conversation")) {
        scopedDuringDelegatedTurn = agent.scopedCallerKey(GROUP);
        listedDuringDelegatedTurn = await groupTools.get("schedule_list")!.handler({}, {});
        return "on it, everyone";
      }
      if (text.includes("tell the book club")) {
        await ownerTools.get("send_message")!.handler({
          target: GROUP, mode: "delegate", message: "let them know I'll be late",
        }, {});
        return "NO_REPLY";
      }
      return "NO_REPLY";
    };

    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "tell the book club I'll be late" }));
    await drainQueue(agent);

    // A raw group session key was always judged as itself; carrying "dm" from
    // the owner must not change that, in either direction.
    expect(scopedDuringDelegatedTurn).toBe(GROUP);
    expect(listedDuringDelegatedTurn!.content[0].text).toContain("book-club");
    // The delegated turn still delivers its composed message to the group.
    expect(tg.sent.filter((m) => m.chatId === "-987").map((m) => m.text)).toEqual(["on it, everyone"]);

    await agent.stop();
  });

  it("refuses delegate mode outright when the calling turn spans several audiences", async () => {
    ownerConfig();
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const tools = internalTools(agent, OWNER);

    // Steering: the owner's own DM message runs concurrently with a summoned
    // group's turn on the same session. No tool call can be attributed to
    // either, so a delegate cannot know whose scope to hand on.
    registry(agent).begin(OWNER, ["dm"]);
    registry(agent).begin(OWNER, [GROUP]);
    expect(agent.scopedCallerKey(OWNER)).toBe(MIXED_AUDIENCE_KEY);

    const result = await tools.get("send_message")!.handler({
      target: "shuai", mode: "delegate", message: "clear my reminders",
    }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/more than one audience/i);
    await drainQueue(agent);
    // Nothing was dispatched — no turn ran on any session.
    expect(mockSdk.promptsBySession.some((p) => p.text.includes("From your other conversation"))).toBe(false);

    await agent.stop();
  });
});

describe("a group's background turn handed to the summoning session", () => {
  /**
   * The same hole from the other side: a job the GROUP scheduled fires on the
   * group key, gets handed to the summoning `dm:` session because the group is
   * summoned, and used to run there with the owner's scope.
   */
  it("runs under the group's audience, not the owner's", async () => {
    ownerConfig();
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    summon(agent, "-987", "shuai");
    // The dm: session needs a reply target for the handed-off turn.
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "hi" }));
    await drainQueue(agent);

    const tools = internalTools(agent, OWNER);
    await tools.get("schedule_create")!.handler({
      name: "clinic", schedule: "0 9 * * *", message: "clinic appointment", session: OWNER,
    }, {});

    let scopedDuringCronTurn: string | undefined;
    let listedDuringCronTurn: ToolResult | undefined;
    mockSdk.responseFn = async (text: string) => {
      if (text.includes("book club reminder")) {
        scopedDuringCronTurn = agent.scopedCallerKey(OWNER);
        listedDuringCronTurn = await tools.get("schedule_list")!.handler({}, {});
      }
      return "NO_REPLY";
    };

    await agent.handleCronMessage("book club reminder", GROUP, { waitForHandoff: true });
    await drainQueue(agent);

    expect(scopedDuringCronTurn).toBe(GROUP);
    expect(listedDuringCronTurn!.content[0].text).not.toContain("clinic");

    await agent.stop();
  });
});

describe("a harness-owned background turn overlapping a summoned turn", () => {
  /**
   * Deliberately still unregistered: the owner owns a scheduled job outright,
   * and registering "dm" beside a live group audience would fail the whole
   * session closed for as long as they overlap. `scopedCallerKey` takes the
   * union of what is live, though, so the cron turn is judged as the group
   * while the overlap lasts — safe, and already logged at debug (068a2b7).
   * Pinned here because "register everything that isn't a user turn" is the
   * obvious next step from this PR and would turn this into a hard refusal.
   */
  it("keeps the narrower scope and says so in the debug log", async () => {
    ownerConfig();
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "hi" }));
    await drainQueue(agent);

    let scopedDuringCronTurn: string | undefined;
    mockSdk.responseFn = async (text: string) => {
      if (text.includes("scheduled ping")) scopedDuringCronTurn = agent.scopedCallerKey(OWNER);
      return "NO_REPLY";
    };

    // A summoned group's turn is live on the owner's session for the whole
    // duration of the scheduled job's turn.
    const groupTurn = registry(agent).begin(OWNER, [GROUP]);
    try {
      await agent.handleCronMessage("scheduled ping", OWNER);
      await drainQueue(agent);
    } finally {
      registry(agent).end(OWNER, groupTurn);
    }

    expect(scopedDuringCronTurn).toBe(GROUP);
    expect(vi.mocked(log.debug)).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: OWNER, scopedTo: GROUP }),
      expect.stringContaining("narrowed to the turn's audience"),
    );

    await agent.stop();
  });
});

// The pure half, alongside scopedCallerKeyFor's own tests.
describe("originAudienceFor", () => {
  it("keeps the owner's private DM as the owner", () => {
    expect(originAudienceFor(OWNER, ["dm"])).toEqual(["dm"]);
    expect(originAudienceFor(OWNER, undefined)).toEqual(["dm"]);
    expect(originAudienceFor(OWNER, [])).toEqual(["dm"]);
  });

  it("sends a summoned group's audience along with the request", () => {
    expect(originAudienceFor(OWNER, [GROUP])).toEqual([GROUP]);
  });

  it("uses a raw session's own key, never 'dm'", () => {
    // "dm" would be read as "the owner" on whatever session the turn lands on.
    expect(originAudienceFor(GROUP, [GROUP])).toEqual([GROUP]);
    expect(originAudienceFor(GROUP, undefined)).toEqual([GROUP]);
    expect(originAudienceFor(GROUP, ["dm"])).toEqual([GROUP]);
  });

  it("refuses to name an audience for a mixed turn", () => {
    expect(originAudienceFor(OWNER, ["dm", GROUP])).toBeUndefined();
    expect(originAudienceFor(OWNER, [GROUP, "telegram:-999"])).toBeUndefined();
  });

  it("reads the live registry, per turn", () => {
    const r = new TurnAudienceRegistry();
    expect(r.originAudience(OWNER)).toEqual(["dm"]);
    const groupTurn = r.begin(OWNER, [GROUP]);
    expect(r.originAudience(OWNER)).toEqual([GROUP]);
    const steer = r.begin(OWNER, ["dm"]);
    expect(r.originAudience(OWNER)).toBeUndefined();
    r.end(OWNER, steer);
    expect(r.originAudience(OWNER)).toEqual([GROUP]);
    r.end(OWNER, groupTurn);
    expect(r.originAudience(OWNER)).toEqual(["dm"]);
  });
});
