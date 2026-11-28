import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  drainQueue,
  expectNoChangeFor,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  peekPendingNotes,
  resetConfig,
  waitFor,
} from "./helpers/agent-harness.js";
import { GROUP_PROMPT_MARK, SHARED_PROMPT_MARK } from "./helpers/agent-mocks.js";
import { SharedPromptUnavailableError } from "../src/agent/sdk-result.js";
import { log } from "../src/logger.js";

installAgentTestHooks();

// ===== Which system prompt a turn runs on =====
//
// The owner's dm: session has two prompt variants: the full one, and the
// SHARED one without private index lines and private people. A live session
// keeps the variant it was built with, so every turn is checked when it is
// dispatched, and the session is closed and resumed as the other variant
// first when it has the wrong one. The mocked buildSystemPrompt marks each
// variant in the prompt it returns, and the mocked SDK records the prompt of
// the session each user message ran on.

const OWNER = "dm:shuai";
const OWNER_CHAT = "12345";
const GROUP_CHAT = "-100270";
const GROUP = `telegram:${GROUP_CHAT}`;

type Variant = "full" | "shared" | "group";
type AgentInstance = InstanceType<typeof Agent>;

/** Every model turn whose prompt contains `match`: the session it ran on and that session's prompt variant. */
function ran(match: string): Array<{ session: string; variant: Variant }> {
  return mockSdk.promptsBySession.filter((p) => p.text.includes(match)).map((p) => ({
    session: p.sessionKey,
    variant: p.systemPrompt.includes(SHARED_PROMPT_MARK) ? "shared" : p.systemPrompt.includes(GROUP_PROMPT_MARK) ? "group" : "full",
  }));
}

interface Internals {
  router: { summonGroup(channel: string, chatId: string): void; dismissGroup(channel: string, chatId: string): boolean };
  sessions: { get(key: string): { messages: Array<{ role: string; content: string }> } };
  liveSessionManager: {
    hasSharedPrompt(key: string): boolean | undefined;
    liveSessions: Map<string, { isBusy(): boolean; pendingSteers: unknown[] }>;
  };
  promptVariantFor(key: string): { shared: boolean; required: boolean };
  steerNeedsSharedPrompt(key: string, items: unknown[]): boolean;
  runWithRetry(req: { prompt: string }): Promise<string>;
}
const internals = (agent: AgentInstance) => agent as unknown as Internals;

function setup(overrides: Parameters<typeof resetConfig>[0] = {}): { agent: AgentInstance; tg: MockChannel } {
  resetConfig({
    identities: [{ name: "shuai", channels: { telegram: OWNER_CHAT }, replyPolicy: "last-active" }],
    ...overrides,
  });
  const agent = new Agent();
  const tg = new MockChannel("telegram");
  agent.addChannel(tg);
  return { agent, tg };
}

const ownerMsg = (text: string) => makeMsg({ chatId: OWNER_CHAT, text });
const groupMsg = (text: string) => makeMsg({
  chatId: GROUP_CHAT, isGroup: true, isMentioned: true, senderName: "Alice", chatTitle: "Book club", text,
});

/** The owner's first private turn: creates the dm: session and its reply target. */
async function seed(agent: AgentInstance, tg: MockChannel): Promise<void> {
  await tg.simulateMessage(ownerMsg("seed hello"));
  await drainQueue(agent);
}

describe("the prompt variant each kind of turn runs on", () => {
  it("the owner's private message, no summon: full", async () => {
    const { agent, tg } = setup();
    await tg.simulateMessage(ownerMsg("OWNER-PLAIN"));
    await drainQueue(agent);
    expect(ran("OWNER-PLAIN")).toEqual([{ session: OWNER, variant: "full" }]);
    await agent.stop();
  });

  it("the owner's private message while a group is summoned in: shared", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    expect(ran("seed hello")).toEqual([{ session: OWNER, variant: "full" }]);
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    await tg.simulateMessage(ownerMsg("OWNER-DURING-SUMMON"));
    await drainQueue(agent);
    expect(ran("OWNER-DURING-SUMMON")).toEqual([{ session: OWNER, variant: "shared" }]);
    await agent.stop();
  });

  it("a summoned group's message (mention-required group): shared", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    await tg.simulateMessage(groupMsg("@tomo GROUP-ASK"));
    await drainQueue(agent);
    expect(ran("GROUP-ASK")).toEqual([{ session: OWNER, variant: "shared" }]);
    await agent.stop();
  });

  it("a summoned group's message (passive-listen group): shared", async () => {
    const { agent, tg } = setup({ passiveGroups: { telegram: [GROUP_CHAT] } });
    await seed(agent, tg);
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    await tg.simulateMessage(makeMsg({ chatId: GROUP_CHAT, isGroup: true, senderName: "Alice", text: "PASSIVE-CHATTER" }));
    await drainQueue(agent);
    expect(ran("PASSIVE-CHATTER")).toEqual([{ session: OWNER, variant: "shared" }]);
    await agent.stop();
  });

  it("a batch mixing the owner's message with a summoned group's: shared, even though the session was live with the full prompt", async () => {
    // No steering: what piles up behind a running turn becomes ONE follow-up turn.
    const { agent, tg } = setup({ steering: false, passiveGroups: { telegram: [GROUP_CHAT] } });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockSdk.responseFn = async (text) => { if (text.includes("FIRST")) await gate; return "ok"; };
    await tg.simulateMessage(ownerMsg("FIRST"));
    await waitFor(() => expect(ran("FIRST")).toEqual([{ session: OWNER, variant: "full" }]));
    // The summon lands while the owner's turn runs on the full prompt.
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    await tg.simulateMessage(ownerMsg("MIXED-OWNER"));
    await tg.simulateMessage(makeMsg({ chatId: GROUP_CHAT, isGroup: true, senderName: "Alice", text: "MIXED-GROUP" }));
    release();
    await drainQueue(agent);
    const mixed = ran("MIXED-GROUP");
    expect(mixed).toEqual([{ session: OWNER, variant: "shared" }]);
    // One turn holds both.
    expect(mockSdk.promptsBySession.filter((p) => p.text.includes("MIXED-OWNER") && p.text.includes("MIXED-GROUP"))).toHaveLength(1);
    await agent.stop();
  });

  it("a group session's delegate to the owner: shared, and the owner's next private turn goes back to full", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    const result = await agent.delegateToSession("shuai", "DELEGATED-ASK", GROUP);
    expect(result.ok).toBe(true);
    await drainQueue(agent);
    expect(ran("DELEGATED-ASK")).toEqual([{ session: OWNER, variant: "shared" }]);

    await tg.simulateMessage(ownerMsg("OWNER-AFTER-DELEGATE"));
    await drainQueue(agent);
    expect(ran("OWNER-AFTER-DELEGATE")).toEqual([{ session: OWNER, variant: "full" }]);
    await agent.stop();
  });

  it("a delegate the owner's own private turn asked for: full, like any turn of theirs", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    const result = await agent.delegateToSession("shuai", "OWN-DELEGATE", OWNER);
    expect(result.ok).toBe(true);
    await drainQueue(agent);
    expect(ran("OWN-DELEGATE")).toEqual([{ session: OWNER, variant: "full" }]);
    await agent.stop();
  });

  it("a summoned group's cron job, handed to the dm: session: shared", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    await agent.handleCronMessage("GROUP-CRON-JOB", GROUP, { waitForHandoff: true });
    await drainQueue(agent);
    expect(ran("GROUP-CRON-JOB")).toEqual([{ session: OWNER, variant: "shared" }]);
    await agent.stop();
  });

  it("a summoned group's restart notice, handed to the dm: session: shared", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    // The group's own session must exist for the notice to be attributed to it.
    await tg.simulateMessage(groupMsg("@tomo group hello"));
    await drainQueue(agent);
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    await agent.handleRestartForSession("System: GROUP-RESTART-NOTICE", GROUP);
    await drainQueue(agent);
    expect(ran("GROUP-RESTART-NOTICE")).toEqual([{ session: OWNER, variant: "shared" }]);
    await agent.stop();
  });

  it.each<[string, boolean, Variant]>([
    ["no summon", false, "full"],
    ["a group summoned in", true, "shared"],
  ])("the owner's own cron job on the dm: session, %s: %s", async (_label, summoned, variant) => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    if (summoned) internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    expect(await agent.handleCronMessage("OWNER-CRON-JOB", OWNER)).toBe(true);
    await drainQueue(agent);
    expect(ran("OWNER-CRON-JOB")).toEqual([{ session: OWNER, variant }]);
    await agent.stop();
  });

  it.each<[string, boolean, Variant]>([
    ["no summon", false, "full"],
    ["a group summoned in", true, "shared"],
  ])("a heartbeat, %s: %s", async (_label, summoned, variant) => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    if (summoned) internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    await agent.handleContinuity("System: HEARTBEAT-TICK");
    await drainQueue(agent);
    expect(ran("HEARTBEAT-TICK")).toEqual([{ session: OWNER, variant }]);
    await agent.stop();
  });

  it("a group's own session (not summoned): the group prompt, never a dm: variant", async () => {
    const { agent, tg } = setup();
    await tg.simulateMessage(groupMsg("@tomo GROUP-OWN-SESSION"));
    await drainQueue(agent);
    expect(ran("GROUP-OWN-SESSION")).toEqual([{ session: GROUP, variant: "group" }]);
    expect(internals(agent).promptVariantFor(GROUP)).toEqual({ shared: false, required: false });
    expect(internals(agent).promptVariantFor("task:t1")).toEqual({ shared: false, required: false });
    await agent.stop();
  });

  it("after the summon is dismissed, the owner's next turn goes back to full, with no event in between", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    await tg.simulateMessage(groupMsg("@tomo GROUP-ASK"));
    await drainQueue(agent);
    expect(internals(agent).liveSessionManager.hasSharedPrompt(OWNER)).toBe(true);

    internals(agent).router.dismissGroup("telegram", GROUP_CHAT);
    // Nothing happens until a turn is dispatched.
    expect(internals(agent).liveSessionManager.hasSharedPrompt(OWNER)).toBe(true);
    await tg.simulateMessage(ownerMsg("OWNER-AFTER-DISMISS"));
    await drainQueue(agent);
    expect(ran("OWNER-AFTER-DISMISS")).toEqual([{ session: OWNER, variant: "full" }]);
    await agent.stop();
  });

  it("after the summon lapses from inactivity, the owner's next turn finds that out itself and goes back to full", async () => {
    // The mocked config leaves the expiry unset (never lapses); production defaults to 60 minutes.
    const { agent, tg } = setup({ summonExpiryMinutes: 60 } as Parameters<typeof resetConfig>[0]);
    await seed(agent, tg);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-28T12:00:00"));
      internals(agent).router.summonGroup("telegram", GROUP_CHAT);
      await tg.simulateMessage(ownerMsg("OWNER-DURING-SUMMON"));
      await drainQueue(agent);
      expect(ran("OWNER-DURING-SUMMON")).toEqual([{ session: OWNER, variant: "shared" }]);

      // Past the default expiry (60 minutes of group silence).
      vi.setSystemTime(new Date("2026-08-28T13:30:00"));
      await tg.simulateMessage(ownerMsg("OWNER-AFTER-EXPIRY"));
      await drainQueue(agent);
      expect(ran("OWNER-AFTER-EXPIRY")).toEqual([{ session: OWNER, variant: "full" }]);
      expect(internals(agent).promptVariantFor(OWNER)).toEqual({ shared: false, required: false });
    } finally {
      vi.useRealTimers();
    }
    await agent.stop();
  });
});

describe("switching variants loses nothing", () => {
  it("owner, group and owner messages queued back to back each run once, in order, the group's on the shared prompt, and every reply is delivered", async () => {
    const { agent, tg } = setup();
    mockSdk.responseFn = (text) => (text.includes("GROUP-G1") ? "NO_REPLY" : `reply to ${/OWNER-A\d/.exec(text)?.[0] ?? "?"}`);
    await tg.simulateMessage(ownerMsg("OWNER-A1"));
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    await tg.simulateMessage(groupMsg("@tomo GROUP-G1"));
    await tg.simulateMessage(ownerMsg("OWNER-A2"));
    await drainQueue(agent);
    internals(agent).router.dismissGroup("telegram", GROUP_CHAT);
    await tg.simulateMessage(ownerMsg("OWNER-A3"));
    await drainQueue(agent);

    const order = mockSdk.promptsBySession.map((p) => /OWNER-A\d|GROUP-G1/.exec(p.text)?.[0]);
    expect(order).toEqual(["OWNER-A1", "GROUP-G1", "OWNER-A2", "OWNER-A3"]);
    expect(ran("GROUP-G1")).toEqual([{ session: OWNER, variant: "shared" }]);
    expect(ran("OWNER-A2")).toEqual([{ session: OWNER, variant: "shared" }]);
    expect(ran("OWNER-A3")).toEqual([{ session: OWNER, variant: "full" }]);
    expect(tg.delivered.filter((d) => d.chatId === OWNER_CHAT).map((d) => d.text))
      .toEqual(["reply to OWNER-A1", "reply to OWNER-A2", "reply to OWNER-A3"]);
    // Each inbound message is in the transcript once.
    const users = internals(agent).sessions.get(OWNER).messages.filter((m) => m.role === "user").map((m) => m.content);
    for (const text of ["OWNER-A1", "GROUP-G1", "OWNER-A2", "OWNER-A3"]) {
      expect(users.filter((u) => u.includes(text)), text).toHaveLength(1);
    }
    await agent.stop();
  });
});

describe("steering and the prompt variant", () => {
  /** An owner turn held mid-flight on the full prompt, then a summon. */
  async function ownerTurnInFlightThenSummon(agent: AgentInstance, tg: MockChannel): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockSdk.responseFn = async (text) => { if (text.includes("OWNER-LONG")) await gate; return "NO_REPLY"; };
    await tg.simulateMessage(ownerMsg("OWNER-LONG"));
    await waitFor(() => expect(internals(agent).liveSessionManager.liveSessions.get(OWNER)?.isBusy()).toBe(true));
    expect(internals(agent).liveSessionManager.hasSharedPrompt(OWNER)).toBe(false);
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    return release;
  }
  const passive = () => makeMsg({ chatId: GROUP_CHAT, isGroup: true, senderName: "Alice", text: "GROUP-MIDTURN" });
  const userRecords = (agent: AgentInstance, text: string) =>
    internals(agent).sessions.get(OWNER).messages.filter((m) => m.role === "user" && m.content.includes(text));

  it("a summoned group's message is not steered into the owner's turn running on the full prompt; it runs afterwards, on the shared one", async () => {
    const { agent, tg } = setup({ steering: true, passiveGroups: { telegram: [GROUP_CHAT] } });
    const release = await ownerTurnInFlightThenSummon(agent, tg);
    const live = internals(agent).liveSessionManager.liveSessions.get(OWNER)!;

    await tg.simulateMessage(passive());
    await expectNoChangeFor(() => {
      expect(live.pendingSteers).toHaveLength(0);
      expect(ran("GROUP-MIDTURN")).toEqual([]);
    });
    // While it waits behind the owner's turn, shutdown can still find it.
    const queued = [...(agent as unknown as { queuedInbound: Map<symbol, { items: Array<{ message: { text: string } }> }> }).queuedInbound.values()];
    expect(queued.some((work) => work.items.some((item) => item.message.text === "GROUP-MIDTURN"))).toBe(true);

    release();
    await drainQueue(agent);
    expect(ran("GROUP-MIDTURN")).toEqual([{ session: OWNER, variant: "shared" }]);
    expect(userRecords(agent, "GROUP-MIDTURN")).toHaveLength(1);
    // Kept out at ingress: it never got as far as an injection to be declined.
    expect(vi.mocked(log.info).mock.calls.some((call) => String(call[1]).includes("Steer declined at injection"))).toBe(false);
    await agent.stop();
  });

  it("the owner's own message still steers into their running turn while a group is summoned in", async () => {
    const { agent, tg } = setup({ steering: true, passiveGroups: { telegram: [GROUP_CHAT] } });
    const release = await ownerTurnInFlightThenSummon(agent, tg);
    const live = internals(agent).liveSessionManager.liveSessions.get(OWNER)!;
    await tg.simulateMessage(ownerMsg("OWNER-FOLLOWUP"));
    await waitFor(() => expect(live.pendingSteers).toHaveLength(1));
    release();
    await drainQueue(agent);
    expect(ran("OWNER-FOLLOWUP")).toEqual([{ session: OWNER, variant: "full" }]);
    await agent.stop();
  });

  it("a group's steer that reaches injection anyway is declined there and queued as its own turn: run once, recorded once, on the shared prompt", async () => {
    const { agent, tg } = setup({ steering: true, passiveGroups: { telegram: [GROUP_CHAT] } });
    const release = await ownerTurnInFlightThenSummon(agent, tg);
    const live = internals(agent).liveSessionManager.liveSessions.get(OWNER)!;
    // The ingress check passes (as when the session is replaced between it
    // and injection): only the manager's own check is left.
    internals(agent).steerNeedsSharedPrompt = () => false;

    await tg.simulateMessage(passive());
    await expectNoChangeFor(() => {
      expect(live.pendingSteers).toHaveLength(0);
      expect(ran("GROUP-MIDTURN")).toEqual([]);
    });
    release();
    await drainQueue(agent);
    expect(ran("GROUP-MIDTURN")).toEqual([{ session: OWNER, variant: "shared" }]);
    expect(userRecords(agent, "GROUP-MIDTURN")).toHaveLength(1);
    // The queued turn still carries the audience-switch note the declined one would have.
    expect(mockSdk.promptsBySession.find((p) => p.text.includes("GROUP-MIDTURN"))!.text).toContain("Audience switched");
    expect(vi.mocked(log.info).mock.calls.some((call) => String(call[1]).includes("Steer declined at injection"))).toBe(true);
    await agent.stop();
  });
});

describe("a coalesced batch whose steer is declined", () => {
  it("is queued whole as its own turn: run once on the shared prompt, each message recorded once, the audience note kept", async () => {
    const IM_GROUP = "any;+;chat270";
    const { agent, tg } = setup({ steering: true, imessageInboundSettleMs: 30, imessageInboundMaxSettleMs: 200 });
    const im = new MockChannel("imessage");
    agent.addChannel(im);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockSdk.responseFn = async (text) => { if (text.includes("OWNER-LONG")) await gate; return "NO_REPLY"; };
    await tg.simulateMessage(ownerMsg("OWNER-LONG"));
    await waitFor(() => expect(internals(agent).liveSessionManager.liveSessions.get(OWNER)?.isBusy()).toBe(true));
    internals(agent).router.summonGroup("imessage", IM_GROUP);
    internals(agent).steerNeedsSharedPrompt = () => false;

    // Two fragments inside the settle window: one batch, one steer.
    await im.simulateMessage(makeMsg({ chatId: IM_GROUP, isGroup: true, senderName: "Alice", text: "BATCH-ONE" }));
    await im.simulateMessage(makeMsg({ chatId: IM_GROUP, isGroup: true, senderName: "Alice", text: "BATCH-TWO" }));
    await waitFor(() => expect(vi.mocked(log.info).mock.calls.some((call) => String(call[1]).includes("Steer declined at injection"))).toBe(true));
    expect(ran("BATCH-ONE")).toEqual([]);

    release();
    await drainQueue(agent);
    expect(ran("BATCH-ONE")).toEqual([{ session: OWNER, variant: "shared" }]);
    const turn = mockSdk.promptsBySession.filter((p) => p.text.includes("BATCH-ONE"));
    expect(turn).toHaveLength(1);
    expect(turn[0].text).toContain("BATCH-TWO");
    expect(turn[0].text).toContain("Audience switched");
    const users = internals(agent).sessions.get(OWNER).messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users.filter((u) => u.includes("BATCH-ONE"))).toHaveLength(1);
    expect(users.filter((u) => u.includes("BATCH-TWO"))).toHaveLength(1);
    await agent.stop();
  });
});

describe("a group's turn that cannot get the shared prompt in time", () => {
  it("is answered with a fixed line in the group and a notice to the owner, without a model call or an error message", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    tg.clearDelivered();
    const real = internals(agent).runWithRetry.bind(agent);
    internals(agent).runWithRetry = (req) => (req.prompt.includes("GROUP-BUSY")
      ? Promise.reject(new SharedPromptUnavailableError("background tasks are running"))
      : real(req));

    await tg.simulateMessage(groupMsg("@tomo GROUP-BUSY"));
    await drainQueue(agent);

    expect(ran("GROUP-BUSY")).toEqual([]);
    expect(tg.delivered.filter((d) => d.chatId === GROUP_CHAT).map((d) => d.text)).toEqual(["Busy right now — try again in a bit."]);
    const toOwner = tg.delivered.filter((d) => d.chatId === OWNER_CHAT).map((d) => d.text);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]).toContain("Book club");
    expect(toOwner[0]).toContain("was not answered");
    expect(tg.delivered.some((d) => d.text.includes("[error]"))).toBe(false);
    // The message stays in the transcript.
    expect(internals(agent).sessions.get(OWNER).messages.some((m) => m.role === "user" && m.content.includes("GROUP-BUSY"))).toBe(true);

    // On record for the session too, for the owner's next private turn (survives a restart).
    const notes = peekPendingNotes(agent, OWNER).join("\n");
    expect(notes).toContain('type="summon-busy"');
    expect(notes).toContain("Book club");
    expect(notes).toContain("The owner has been sent a notice about it.");

    // The session is not stuck: the next turn runs.
    await tg.simulateMessage(groupMsg("@tomo GROUP-LATER"));
    await drainQueue(agent);
    expect(ran("GROUP-LATER")).toEqual([{ session: OWNER, variant: "shared" }]);
    await agent.stop();
  });
});

describe("what a refusal does not drop", () => {
  const refuse = (agent: AgentInstance, match: (prompt: string) => boolean) => {
    const real = internals(agent).runWithRetry.bind(agent);
    internals(agent).runWithRetry = (req) => (match(req.prompt)
      ? Promise.reject(new SharedPromptUnavailableError("background tasks are running"))
      : real(req));
  };

  it("the owner's own message in a refused mixed batch is queued again and answered; only the group's is refused", async () => {
    const { agent, tg } = setup({ steering: false, passiveGroups: { telegram: [GROUP_CHAT] } });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockSdk.responseFn = async (text) => {
      if (text.includes("FIRST")) { await gate; return "first done"; }
      return text.includes("MIXED-OWNER") ? "reply to MIXED-OWNER" : "NO_REPLY";
    };
    await tg.simulateMessage(ownerMsg("FIRST"));
    await waitFor(() => expect(ran("FIRST")).toHaveLength(1));
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    refuse(agent, (prompt) => prompt.includes("MIXED-GROUP"));
    await tg.simulateMessage(ownerMsg("MIXED-OWNER"));
    await tg.simulateMessage(makeMsg({ chatId: GROUP_CHAT, isGroup: true, senderName: "Alice", chatTitle: "Book club", text: "MIXED-GROUP" }));
    release();
    await drainQueue(agent);

    expect(ran("MIXED-GROUP")).toEqual([]);
    expect(ran("MIXED-OWNER")).toHaveLength(1);
    const toOwner = tg.delivered.filter((d) => d.chatId === OWNER_CHAT).map((d) => d.text);
    expect(toOwner).toContain("reply to MIXED-OWNER");
    expect(tg.delivered.filter((d) => d.chatId === GROUP_CHAT).map((d) => d.text)).toEqual(["Busy right now — try again in a bit."]);
    // Recorded once each, whichever turn it ended up in.
    const users = internals(agent).sessions.get(OWNER).messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users.filter((u) => u.includes("MIXED-OWNER"))).toHaveLength(1);
    expect(users.filter((u) => u.includes("MIXED-GROUP"))).toHaveLength(1);
    await agent.stop();
  });

  it("closes the group's inbox records only once somebody was told, and never the requeued owner ones", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    const answer = (agent as unknown as {
      answerSharedPromptUnavailable(req: unknown): Promise<void>;
    }).answerSharedPromptUnavailable.bind(agent);
    const ownerItem = { channel: tg, message: ownerMsg("OWNER-IN-BATCH"), resolution: { sessionKey: OWNER, replyTarget: { channelName: "telegram", chatId: OWNER_CHAT } }, inboxId: "inbox-owner" };
    const req = (refused: (ids?: string[]) => void) => ({
      key: OWNER, audiences: ["dm", GROUP], ownerItems: [ownerItem],
      inboxHooks: { notConsumed() {}, cutShort() {}, onPromptHandedOff() {}, refused },
    });

    const told = vi.fn();
    await answer(req(told));
    expect(told).toHaveBeenCalledWith(["inbox-owner"]);
    await drainQueue(agent);

    // Nobody can be reached, but the refusal is on record for the session: closed.
    tg.tornDown = true;
    const recorded = vi.fn();
    await answer({ ...req(recorded), ownerItems: [] });
    expect(recorded).toHaveBeenCalledWith([]);

    // Not even that (the note store refuses): the records stay open for the next start.
    const queue = (agent as unknown as { pendingNotesQueue: { queueNote(key: string, note: string): boolean } }).pendingNotesQueue;
    const realQueue = queue.queueNote.bind(queue);
    queue.queueNote = () => false;
    const untold = vi.fn();
    await answer({ ...req(untold), ownerItems: [] });
    expect(untold).not.toHaveBeenCalled();

    // One of two groups told, the owner not, nothing recorded: one group does not speak for the other.
    tg.tornDown = false;
    const partly = vi.fn();
    const realSend = tg.send.bind(tg);
    tg.send = async (msg) => { if (msg.chatId !== GROUP_CHAT) throw new Error("unreachable"); return realSend(msg); };
    await answer({ ...req(partly), audiences: [GROUP, "telegram:-100999"], ownerItems: [] });
    expect(partly).not.toHaveBeenCalled();
    tg.send = realSend;
    queue.queueNote = realQueue;
    await agent.stop();
  });

  it("a group's delegate that is refused: the group gets the busy line, the owner is told, nothing runs", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    await tg.simulateMessage(groupMsg("@tomo group hello"));
    await drainQueue(agent);
    tg.clearDelivered();
    refuse(agent, (prompt) => prompt.includes("DELEGATED-ASK"));
    await agent.delegateToSession("shuai", "DELEGATED-ASK", GROUP);
    await drainQueue(agent);
    expect(ran("DELEGATED-ASK")).toEqual([]);
    expect(tg.delivered.filter((d) => d.chatId === GROUP_CHAT).map((d) => d.text)).toEqual(["Busy right now — try again in a bit."]);
    const toOwner = tg.delivered.filter((d) => d.chatId === OWNER_CHAT).map((d) => d.text);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]).toContain("A background turn for Book club");
    expect(tg.delivered.some((d) => d.text.includes("[error]"))).toBe(false);
    await agent.stop();
  });

  it("a summoned group's cron job that is refused reports a run that did not happen, to the owner only", async () => {
    const { agent, tg } = setup();
    await seed(agent, tg);
    internals(agent).router.summonGroup("telegram", GROUP_CHAT);
    tg.clearDelivered();
    refuse(agent, (prompt) => prompt.includes("GROUP-CRON-JOB"));
    expect(await agent.handleCronMessage("GROUP-CRON-JOB", GROUP, { waitForHandoff: true })).toBe(false);
    expect(tg.delivered.filter((d) => d.chatId === GROUP_CHAT)).toEqual([]);
    const toOwner = tg.delivered.filter((d) => d.chatId === OWNER_CHAT).map((d) => d.text);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]).toContain("did not run");

    // Nobody can be told: the refusal is still on record for the session.
    tg.tornDown = true;
    expect(await agent.handleCronMessage("GROUP-CRON-JOB", GROUP, { waitForHandoff: true })).toBe(false);
    tg.tornDown = false;
    const busy = peekPendingNotes(agent, OWNER).filter((n) => n.includes('type="summon-busy"'));
    expect(busy).toHaveLength(2);
    // It names the work, and says whether telling the owner is still to do.
    expect(busy[0]).toContain("a scheduled job: GROUP-CRON-JOB");
    expect(busy[0]).toContain("The owner has been sent a notice about it.");
    expect(busy[1]).toContain("The owner could NOT be told");
    // The cap never drops it: the group's inbox record is closed on its strength.
    const queue = (agent as unknown as { pendingNotesQueue: { queueNote(key: string, note: string): boolean } }).pendingNotesQueue;
    for (let i = 0; i < 40; i++) queue.queueNote(OWNER, `<tomo-event type="audience">filler ${i}</tomo-event>`);
    expect(peekPendingNotes(agent, OWNER).filter((n) => n.includes('type="summon-busy"'))).toHaveLength(2);

    // The owner's own cron job keeps the ordinary error policy.
    tg.clearDelivered();
    internals(agent).router.dismissGroup("telegram", GROUP_CHAT);
    refuse(agent, (prompt) => prompt.includes("OWNER-CRON-JOB"));
    expect(await agent.handleCronMessage("OWNER-CRON-JOB", OWNER)).toBe(false);
    expect(tg.delivered.some((d) => d.text.includes("[error]"))).toBe(true);
    await agent.stop();
  });
});
