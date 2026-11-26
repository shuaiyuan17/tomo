import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  SessionStore,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockConfig,
  mockSdk,
  ownerIdentity,
  queryState,
  resetConfig,
  seedSession,
  waitFor,
  type Delivery,
} from "./helpers/agent-harness.js";
import type { MockResponse } from "./helpers/agent-mocks.js";

installAgentTestHooks();

// ===== Outbound delivery, end to end (iMessage + Telegram) =====
//
// Delivery is non-streaming but not end-of-turn: each content block ships as
// ONE channel message the moment the SDK closes it, newlines and all. Nothing
// pattern-matches the model's words — block TYPE decides what ships.
//
// The unit-level twins of these shapes live in tests/turn-runner.test.ts and
// tests/per-block-delivery.test.ts (the DeliveryPipeline / LiveSession seam);
// this file is the one Agent-level table, through both ingress paths a turn
// can take: an owner message, and handleCronMessage (cron jobs, background
// sends, delegate notifications), which runs on the SAME per-block path.

type Ingress = "user" | "cron";

const IM_DM = { channel: "imessage", chatId: "iMessage;-;+15551112222" } as const;
const IM_GROUP = { channel: "imessage", chatId: "iMessage;+;group123", isGroup: true } as const;
const TG_DM = { channel: "telegram", chatId: "12345" } as const;

interface Where {
  channel: "imessage" | "telegram";
  chatId: string;
  isGroup?: boolean;
}

/**
 * Run one turn answering `response` and return what reached the channel.
 * `user`: the turn is the owner's message. `cron`: a seeded session gets a
 * handleCronMessage turn, which must report success.
 */
async function deliver(response: MockResponse, where: Where = TG_DM, ingress: Ingress = "user"): Promise<Delivery[]> {
  const agent = new Agent();
  const channel = new MockChannel(where.channel);
  agent.addChannel(channel);
  if (ingress === "cron") await seedSession(agent, channel, where.chatId);
  mockSdk.responseFn = () => response;
  if (ingress === "user") {
    await channel.simulateMessage(makeMsg({ chatId: where.chatId, text: "go", ...(where.isGroup ? { isGroup: true, senderName: "Alice" } : {}) }));
    await drainQueue(agent);
  } else {
    await expect(agent.handleCronMessage("System: background task done", `${where.channel}:${where.chatId}`)).resolves.toBe(true);
  }
  await agent.stop();
  return channel.delivered;
}

const READ_A = { type: "tool_use" as const, name: "Read", input: { file_path: "/tmp/a" } };
const READ_B = { type: "tool_use" as const, name: "Read", input: { file_path: "/tmp/b" } };

describe("what a turn ships, block by block", () => {
  it.each<{ name: string; response: MockResponse; expected: string[]; where?: Where; ingress?: Ingress }>([
    // --- one block, one message ---
    { name: "a single block ships as one message", where: IM_DM, response: "single block reply", expected: ["single block reply"] },
    { name: "each block of a multi-block turn is its own iMessage", where: IM_DM, response: ["first block", "second block", "third block"], expected: ["first block", "second block", "third block"] },
    // Mid-turn there is nothing to merge WITH: when "alpha" completes, "beta"
    // has not been written yet. One completed block is one message.
    { name: "adjacent text blocks are never merged (Telegram)", response: ["alpha", "beta", "gamma"], expected: ["alpha", "beta", "gamma"] },
    { name: "a three-line reply stays one iMessage, newlines kept", where: IM_DM, response: "line A\nline B\nline C", expected: ["line A\nline B\nline C"] },
    { name: "interior blank lines are kept, the block's outer whitespace trimmed", response: "  first burst\n\nsecond burst  ", expected: ["first burst\n\nsecond burst"] },
    { name: "a multi-line cron reply ships as one message", ingress: "cron", response: "  first brief  \nsecond detail\n\n  third brief  ", expected: ["first brief  \nsecond detail\n\n  third brief"] },
    { name: "a line-formatted list stays together in an iMessage group", where: IM_GROUP, response: "List 🦀\n· Running shoes ×3\n· Winter coat ×1\n\nPickup: Saturday, in store.", expected: ["List 🦀\n· Running shoes ×3\n· Winter coat ×1\n\nPickup: Saturday, in store."] },
    // #291 P1: no word of the model's is treated as a control token.
    { name: "a one-word `count` reply ships verbatim (#291)", where: IM_DM, response: "count", expected: ["count"] },
    { name: "a text block that opens with Thinking: ships verbatim (#291)", where: IM_DM, response: "Thinking: I suggest two steps. First back up. Then migrate.", expected: ["Thinking: I suggest two steps. First back up. Then migrate."] },
    { name: "whitespace-only blocks are dropped, the others ship", where: IM_DM, response: ["   ", "real content", ""], expected: ["real content"] },
    // Filtering the JOINED response would truncate at the marker and lose B.
    { name: "a scaffold leak cuts only the leaking block", where: IM_DM, response: ["A", "<system-reminder>internal note</system-reminder>", "B"], expected: ["A", "B"] },

    // --- NO_REPLY is enforced per block (owner decision 2026-07-08) ---
    { name: "NO_REPLY as the whole response ships nothing", where: IM_DM, response: "NO_REPLY", expected: [] },
    { name: "NO_REPLY as the whole cron response ships nothing (#222: no regression)", ingress: "cron", response: "NO_REPLY", expected: [] },
    { name: "a mid-turn bare NO_REPLY block drops, the blocks around it ship", where: IM_DM, response: ["before", "NO_REPLY", "after"], expected: ["before", "after"] },
    // The middle block is housekeeping narration marked not-for-the-channel:
    // neither the narration nor the token ships, the blocks around it do.
    { name: "a mid-turn block whose trailing line is NO_REPLY drops, narration and all", where: IM_DM, response: ["A", "housekeeping\nNO_REPLY", "B"], expected: ["A", "B"] },
    { name: "a cron turn whose narration block ends in NO_REPLY ships nothing", ingress: "cron", response: [READ_A, "housekeeping narration not meant for the channel\nNO_REPLY"], expected: [] },
    // Under end-of-turn delivery a trailing token suppressed the earlier
    // narration too. Mid-turn it cannot: the narration was its OWN completed
    // block and was already sent when the model wrote the token. No
    // end-of-turn rule can recall it; a turn that must stay silent whatever
    // the model writes says so up front with suppressDelivery
    // (tests/agent-cron.test.ts, "suppressDelivery silences every block").
    { name: "a trailing bare NO_REPLY suppresses only itself", where: IM_DM, response: ["did the housekeeping", "NO_REPLY"], expected: ["did the housekeeping"] },
    { name: "a later NO_REPLY cannot unsend an earlier cron narration block", ingress: "cron", response: ["housekeeping narration not meant for the channel", READ_A, READ_B, "NO_REPLY"], expected: ["housekeeping narration not meant for the channel"] },
    // #222: only the bare token on a block's trailing line silences.
    { name: "#222: cron prose that merely mentions NO_REPLY inline is delivered", ingress: "cron", response: "The literal token is NO_REPLY.", expected: ["The literal token is NO_REPLY."] },
    { name: "#222: repeated NO_REPLY blocks with no visible text stay silent", ingress: "cron", response: ["NO_REPLY", "NO_REPLY"], expected: [] },
    { name: "#222: a cron turn whose only text is NO_REPLY after tool calls stays silent", ingress: "cron", response: [READ_A, READ_B, "NO_REPLY"], expected: [] },
  ])("$name", async ({ response, expected, where, ingress }) => {
    const delivered = await deliver(response, where, ingress);
    expect(delivered.map((d) => d.text)).toEqual(expected);
    // Every message reached the chat the turn belongs to.
    for (const d of delivered) expect(d.chatId).toBe((where ?? TG_DM).chatId);
  });
});

describe("attachments ship where the model put them", () => {
  // `IMG` stands for a real file written into the per-test tmp dir.
  const IMG = "<img>";
  const at = (text: string, photo?: string, sticker?: string): Delivery => ({ chatId: "12345", text, photo, sticker });

  it.each<{ name: string; response: (img: string) => MockResponse; expected: Delivery[]; ingress?: Ingress }>([
    { name: "a MEDIA caption stays attached instead of being newline-split from the photo", response: (img) => `caption line 1\ncaption line 2 MEDIA:"${img}"`, expected: [at("caption line 1\ncaption line 2", IMG)] },
    { name: "a cron MEDIA caption stays attached too", ingress: "cron", response: (img) => `caption line 1\ncaption line 2 MEDIA:"${img}"`, expected: [at("caption line 1\ncaption line 2", IMG)] },
    { name: "an attachment block ships in place: A, photo, B", response: (img) => ["A", `MEDIA:${img}`, "B"], expected: [at("A"), at("", IMG), at("B")] },
    { name: "a caption stays with the media of its OWN block", response: (img) => ["A", `here it is MEDIA:${img}`, "B"], expected: [at("A"), at("here it is", IMG), at("B")] },
    // A block marked not-for-the-channel ships NOTHING — text, media and
    // stickers alike (owner decision 2026-07-08).
    { name: "a mid-turn NO_REPLY block drops its ATTACHMENTS too, not just its text", response: (img) => ["A", `MEDIA:${img}\nNO_REPLY`, "B"], expected: [at("A"), at("B")] },
    { name: "a STICKER tag ships as a sticker send, the tag kept out of the text", response: () => "here you go STICKER:CAACAgQAAxkBAAE123", expected: [at("here you go"), at("", undefined, "CAACAgQAAxkBAAE123")] },
  ])("$name", async ({ response, expected, ingress }) => {
    const imagePath = join(agentEnv.tmpDir, "photo.png");
    writeFileSync(imagePath, "fake image");
    const delivered = await deliver(response(imagePath), TG_DM, ingress);
    expect(delivered).toEqual(expected.map((d) => ({ ...d, photo: d.photo === IMG ? imagePath : d.photo })));
    expect(delivered.map((d) => d.text).join("\n")).not.toMatch(/MEDIA:|STICKER:/);
  });
});

describe("thinking blocks", () => {
  // NOTE on the fixture: "the user probably wants X" is a synthetic block SHAPE —
  // a thinking block that still carries text. Under real `display: "omitted"`
  // actual reasoning arrives EMPTY (signature only) and is dropped; the only
  // non-empty thinking blocks observed in practice were misplaced replies. This
  // test does not assert that reasoning should ever be delivered.
  //
  // The whole mechanism is the block-TYPE gate in renderBlock: the same turn,
  // the same two blocks, only the flag differs. With the flag ON the thinking
  // block ships as its own message, marked 💭, BEFORE the answer rather than
  // glued to it. With the flag OFF it is DROPPED (shipBlock logs the drop and
  // its length): under `omitted` its text is a summary of what the model
  // wrote, not the words, and a summary delivered as a reply puts words in the
  // model's mouth. Delete the marker and the showThinking:true row fails; ship
  // non-empty thinking unconditionally and the showThinking:false row fails.
  it.each([
    { showThinking: false, expected: ["public answer"] },
    { showThinking: true, expected: ["💭 the user probably wants X", "public answer"] },
  ])("renders a thinking + text turn by block type (showThinking=$showThinking)", async ({ showThinking, expected }) => {
    resetConfig({ showThinking });
    const delivered = await deliver([
      { type: "thinking", thinking: "the user probably wants X" },
      "public answer",
    ]);

    expect(delivered.map((d) => d.text)).toEqual(expected);
    // Spelled out both ways so the assertion cannot pass by coincidence.
    const all = delivered.map((d) => d.text).join("\n");
    expect(all.includes("the user probably wants X")).toBe(showThinking);
    expect(all.includes("💭 ")).toBe(showThinking);
  });
});

describe("typing on a passive group turn that answers NO_REPLY", () => {
  it("shows no iMessage group typing for a quick passive turn", async () => {
    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = () => "NO_REPLY";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;+;group123", text: "side chatter", isGroup: true }));
    await drainQueue(agent);

    expect(im.delivered).toHaveLength(0);
    expect(im.typingStarts).toEqual([]);
    expect(im.typingStops).toEqual([]);

    await agent.stop();
  });

  it("delays iMessage typing and clears it when a slow passive turn answers NO_REPLY", async () => {
    vi.useFakeTimers();
    resetConfig({ imessagePassiveTypingStartDelayMs: 100 });

    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    mockSdk.responseFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return "NO_REPLY";
    };

    await im.simulateMessage(makeMsg({ chatId: "iMessage;+;group123", text: "side chatter", isGroup: true }));
    const drained = drainQueue(agent);

    await vi.advanceTimersByTimeAsync(99);
    expect(im.typingStarts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(im.typingStarts).toEqual(["iMessage;+;group123"]);

    await vi.advanceTimersByTimeAsync(50);
    await drained;

    expect(im.delivered).toHaveLength(0);
    expect(im.typingStops).toEqual([
      { chatId: "iMessage;+;group123", options: { clear: true } },
    ]);

    await agent.stop();
  });
});

describe("delivery failures and shutdown", () => {
  it("regression: a failing channel send does not re-run the turn", async () => {
    // Delivery happens after the turn resolves, outside the SDK event loop,
    // so a channel failure must surface as an error message — never as a
    // session reset that re-runs the turn (and repeats its side effects).
    const agent = new Agent();
    const im = new MockChannel("imessage");
    let firstSend = true;
    const realSend = im.send.bind(im);
    im.send = async (msg) => {
      if (firstSend) {
        firstSend = false;
        throw new Error("transient iMessage transport error");
      }
      return realSend(msg);
    };
    agent.addChannel(im);

    mockSdk.responseFn = () => "the reply";

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "go" }));
    await drainQueue(agent);

    expect(queryState.maxConcurrent).toBe(1);

    // P0-5: the failure is SURFACED — a note for the next turn, persisted so
    // it survives a restart (a fresh store reads it back from disk), and the
    // transcript does not claim the reply arrived.
    const fresh = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir, { dbPath: mockConfig.dbPath });
    const key = "imessage:iMessage;-;+15551112222";
    const notes = fresh.getPendingNotes(key);
    expect(notes.some((n) => n.includes("delivery failed") && n.includes("the reply"))).toBe(true);
    const assistant = fresh.get(key).messages.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(assistant).toEqual(["[delivery failed] the reply"]);

    await agent.stop();
  });

  it("preserves the sdk session link when stopping during an in-flight turn", async () => {
    resetConfig({ identities: [ownerIdentity("Shuai", { imessage: "+15551112222" })] });
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir, { dbPath: mockConfig.dbPath });
    store.setSdkSessionId("dm:shuai", "old-session-id");
    store.setReplyTarget("dm:shuai", { channelName: "imessage", chatId: "+15551112222" });

    const agent = new Agent();
    const im = new MockChannel("imessage");
    agent.addChannel(im);

    let release: (() => void) | undefined;
    mockSdk.responseFn = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return "late reply";
    };

    await im.simulateMessage(makeMsg({ chatId: "iMessage;-;+15551112222", text: "restart now" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));

    await agent.stop();
    release?.();

    const after = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir, { dbPath: mockConfig.dbPath }).getEntry("dm:shuai");
    expect(after?.sdkSessionId).toBe("old-session-id");
    expect(after?.unlinkedAt).toBeNull();
  });
});
