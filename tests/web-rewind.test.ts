import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
const prepare = vi.hoisted(() => vi.fn());
const discard = vi.hoisted(() => vi.fn());
vi.mock("../src/agent/session-rewind.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/agent/session-rewind.js")>(), prepareSessionRewind: prepare }));
import { Agent, MockChannel, SessionStore, installAgentTestHooks, resetConfig, mockSdk, makeMsg, waitFor } from "./helpers/agent-harness.js";
import { WebChannel, type WebRewind } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import { MAX_REWIND_MARKS, RewindMarks, rewindTargetMatches } from "../src/web/rewind-marks.js";
import { rewindSchema, type WebEvent } from "../src/web/protocol.js";

installAgentTestHooks();
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const PREVIEW = "[web · Sun 11/15 04:20 UTC] Draft the announcement for Friday";
beforeEach(() => {
  discard.mockReset().mockResolvedValue(undefined);
  prepare.mockReset().mockImplementation(async (_sid: string, count: number) =>
    ({ sessionId: "fork-example", count, preview: PREVIEW, assertUnchanged: () => {}, discard }));
  resetConfig({ identities: [{ name: "example", channels: { telegram: "owner-example" }, replyPolicy: "last-active" }] });
});
function setup() {
  const agent = new Agent();
  const channel = new MockChannel("telegram");
  agent.addChannel(channel);
  const store = (agent as unknown as { sessions: InstanceType<typeof SessionStore> }).sessions;
  store.setSdkSessionId("dm:example", "source-example");
  return { agent, channel, store };
}
const clicked = (text: string) => (preview: string) => rewindTargetMatches(preview, text);

describe("rewindTargetMatches", () => {
  it("lines the model's stamped copy up with the transcript's text", () => {
    expect(rewindTargetMatches(PREVIEW, "Draft the announcement for Friday")).toBe(true);
    expect(rewindTargetMatches("[imessage · Wed 09/02 20:50 PDT · sender 09/03 12:50 GMT+9] hello  there", "hello there")).toBe(true);
    // The preview is cut at 80 characters; the clicked message is longer.
    expect(rewindTargetMatches("[web · Sun 11/15 04:20 UTC] A long message that goes on and on and o…", "A long message that goes on and on and on for a while")).toBe(true);
    // A short message at the start of a longer model-side entry (text plus an attachment note).
    expect(rewindTargetMatches("[web · Sun 11/15 04:20 UTC] ok [Sent an image, saved to: /x.png]", "ok")).toBe(true);
  });
  it("refuses another message, an empty side, and a bracket that is not a stamp", () => {
    expect(rewindTargetMatches(PREVIEW, "Something else entirely")).toBe(false);
    expect(rewindTargetMatches("", "hello")).toBe(false);
    expect(rewindTargetMatches(PREVIEW, "   ")).toBe(false);
    expect(rewindTargetMatches("[draft] the plan", "the plan")).toBe(false);
  });
});

describe("Agent.rewindFromWeb", () => {
  it("rewinds to the message the owner pointed at, and the next turn resumes the fork", async () => {
    const { agent, store } = setup();
    try {
      await expect(agent.rewindFromWeb("dm:example", 2, clicked("Draft the announcement for Friday"))).resolves.toEqual({ ok: true, count: 2, preview: PREVIEW });
      expect(prepare.mock.calls[0].slice(0, 2)).toEqual(["source-example", 2]);
      expect(store.getSdkSessionId("dm:example")).toBe("fork-example");
      expect(mockSdk.promptsBySession).toHaveLength(0);
    } finally { await agent.stop(); }
  });

  it("changes nothing when the SDK would cut somewhere else: a different message, or further back than asked", async () => {
    const { agent, store } = setup();
    try {
      await expect(agent.rewindFromWeb("dm:example", 2, clicked("A different message"))).resolves.toEqual({ ok: false, reason: "rewind_mismatch" });
      prepare.mockResolvedValueOnce({ sessionId: "fork-example", count: 3, preview: PREVIEW, assertUnchanged: () => {}, discard });
      await expect(agent.rewindFromWeb("dm:example", 2, clicked("Draft the announcement for Friday"))).resolves.toEqual({ ok: false, reason: "rewind_mismatch" });
      expect(store.getSdkSessionId("dm:example")).toBe("source-example");
      expect(discard).toHaveBeenCalledTimes(2);
    } finally { await agent.stop(); }
  });

  it("never stops a running turn: refused while one is in flight", async () => {
    const { agent, channel, store } = setup();
    try {
      let started = 0;
      let release!: (text: string) => void;
      mockSdk.responseFn = () => { started++; return new Promise<string>((resolve) => { release = resolve; }); };
      void channel.simulateMessage(makeMsg({ chatId: "owner-example", senderId: "owner-example", text: "long job" }));
      await waitFor(() => expect(started).toBe(1));
      await expect(agent.rewindFromWeb("dm:example", 1, () => true)).resolves.toEqual({ ok: false, reason: "turn_in_flight" });
      expect(prepare).not.toHaveBeenCalled();
      expect(store.getSdkSessionId("dm:example")).toBe("source-example");
      release("done");
      await waitFor(() => expect(channel.delivered.at(-1)?.text).toBe("done"));
    } finally { await agent.stop(); }
  });

  it("names a message the model no longer has, and any other failure, without changing the link", async () => {
    const { agent, store } = setup();
    try {
      prepare.mockRejectedValueOnce(new Error("Only 1 recorded human message(s) can be rewound in the current context. Older or compacted messages may be unavailable; /new starts fresh."));
      await expect(agent.rewindFromWeb("dm:example", 4, () => true)).resolves.toEqual({ ok: false, reason: "nothing_to_rewind" });
      prepare.mockRejectedValueOnce(new Error("Unreadable session history."));
      await expect(agent.rewindFromWeb("dm:example", 1, () => true)).resolves.toEqual({ ok: false, reason: "rewind_failed" });
      expect(store.getSdkSessionId("dm:example")).toBe("source-example");
    } finally { await agent.stop(); }
  });
});

describe("WebChannel.rewindOwner", () => {
  const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
  function web(rewind: WebRewind | undefined, extra: { path?: string; now?: () => number } = {}) {
    const channel = new WebChannel(owner, new WatchBus(), { rewind, rewindMarksPath: extra.path, now: extra.now });
    const events: WebEvent[] = [];
    channel.events.subscribe(({ event }) => events.push(event));
    return { channel, events };
  }

  it("asks the agent for the owner conversation, records the mark, and keeps it across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-rewind-")); dirs.push(dir);
    const path = join(dir, "data", "rewinds.json");
    const calls: Array<[string, number, boolean]> = [];
    let now = 10_000;
    const { channel, events } = web(async (key, count, matches) => { calls.push([key, count, matches(PREVIEW)]); now += 5; return { ok: true, count, preview: PREVIEW }; }, { path, now: () => now });
    const result = await channel.rewindOwner(2, "Draft the announcement for Friday", 9_000);
    const mark = { sessionId: channel.ownerId!, from: 9_000, at: 10_005, count: 2 };
    expect(result).toEqual({ count: 2, mark });
    expect(calls).toEqual([["dm:owner", 2, true]]);
    expect(events).toEqual([{ type: "rewind", mark }]);
    expect(channel.snapshot().rewinds).toEqual([mark]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([mark]);
    await channel.stop();
    const next = web(undefined, { path });
    expect(next.channel.snapshot().rewinds).toEqual([mark]);
    await next.channel.stop();
  });

  it("passes every refusal on as a named error and records nothing", async () => {
    for (const [reason, status] of [["turn_in_flight", 409], ["rewind_mismatch", 409], ["nothing_to_rewind", 409], ["rewind_failed", 503]] as const) {
      const { channel, events } = web(async () => ({ ok: false, reason }));
      await expect(channel.rewindOwner(1, "x", 1)).rejects.toMatchObject({ status, code: reason });
      expect(events).toEqual([]);
      expect(channel.snapshot().rewinds).toBeUndefined();
      await channel.stop();
    }
    const unwired = web(undefined);
    await expect(unwired.channel.rewindOwner(1, "x", 1)).rejects.toMatchObject({ status: 409, code: "owner_setup_required" });
    const future = web(async () => ({ ok: true, count: 1, preview: "" }), { now: () => 100 });
    await expect(future.channel.rewindOwner(1, "x", 200)).rejects.toMatchObject({ status: 400, code: "invalid_rewind" });
    await unwired.channel.stop(); await future.channel.stop();
  });
});

describe("rewind marks and the request shape", () => {
  it("an unreadable or foreign file reads as no marks; the list is capped", () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-rewind-")); dirs.push(dir);
    const path = join(dir, "rewinds.json");
    writeFileSync(path, "{not json");
    expect(new RewindMarks(path).list()).toEqual([]);
    writeFileSync(path, JSON.stringify([{ sessionId: "s", from: 5, at: 1, count: 1 }, { sessionId: "s", from: 1, at: 5, count: 0 }, "x", { sessionId: "s", from: 1, at: 5, count: 2 }]));
    expect(new RewindMarks(path).list()).toEqual([{ sessionId: "s", from: 1, at: 5, count: 2 }]);
    const marks = new RewindMarks(path);
    for (let i = 0; i < MAX_REWIND_MARKS + 5; i++) marks.add({ sessionId: "s", from: i, at: i + 1, count: 1 });
    expect(new RewindMarks(path).list()).toHaveLength(MAX_REWIND_MARKS);
  });
  it("a rewind needs an explicit confirm and a sane count", () => {
    const ok = { count: 2, text: "hello", from: 123, confirm: true };
    expect(rewindSchema.safeParse(ok).success).toBe(true);
    for (const bad of [{ ...ok, confirm: false }, { ...ok, count: 0 }, { ...ok, count: 501 }, { ...ok, text: "" }, { ...ok, from: -1 }, { ...ok, extra: 1 }, { count: 2, text: "x", from: 1 }]) {
      expect(rewindSchema.safeParse(bad).success).toBe(false);
    }
  });
});
