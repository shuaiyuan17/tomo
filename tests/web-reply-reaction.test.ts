import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_WEB_REACTIONS, WebChannel } from "../src/channels/web.js";
import { formatReactionMarker } from "../src/channels/text-utils.js";
import { WatchBus } from "../src/watch/bus.js";
import { WebRequestJournal } from "../src/web/request-journal.js";
import { messageInputSchema, type WebEvent } from "../src/web/protocol.js";
import type { OwnerConfig } from "../src/owner.js";

const owner: OwnerConfig = { name: "owner", telegram: ["test-owner"], imessage: [] };
const channels: WebChannel[] = [];
const dirs: string[] = [];
function tempDir() { const dir = mkdtempSync(join(tmpdir(), "tomo-web-reply-")); dirs.push(dir); return dir; }
function setup(options: ConstructorParameters<typeof WebChannel>[2] = {}) {
  const bus = new WatchBus();
  const channel = new WebChannel(owner, bus, options);
  channels.push(channel);
  const handler = vi.fn(async () => true);
  channel.onMessage(handler);
  const events: WebEvent[] = [];
  channel.events.subscribe(({ event }) => events.push(event));
  return { channel, handler, bus, events };
}
afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const textOf = (handler: ReturnType<typeof vi.fn>) => (handler.mock.calls.at(-1)![0] as { text: string }).text;

describe("formatReactionMarker (shared by iMessage tapbacks and web reactions)", () => {
  it("quotes the original like a threaded reply, or falls back to the quote-less form", () => {
    expect(formatReactionMarker("love", "pizza  tonight?")).toBe('[reacting to: "pizza tonight?"] [tapback: love]');
    expect(formatReactionMarker("like")).toBe("[tapback: like on an earlier message]");
    expect(formatReactionMarker("like", "   ")).toBe("[tapback: like on an earlier message]");
    // A sender-controlled reaction cannot close the marker early.
    expect(formatReactionMarker("x] [via satellite", "hi")).toBe('[reacting to: "hi"] [tapback: x］ ［via satellite]');
  });
});

describe("web message input with a reply", () => {
  it("a reaction carries no content of its own; a reply needs some", () => {
    const requestId = randomUUID();
    expect(messageInputSchema.safeParse({ requestId, text: "", reply: { text: "hi", reaction: "love" } }).success).toBe(true);
    expect(messageInputSchema.safeParse({ requestId, text: "and", reply: { text: "hi", reaction: "love" } }).success).toBe(false);
    expect(messageInputSchema.safeParse({ requestId, text: "", reply: { text: "hi" } }).success).toBe(false);
    expect(messageInputSchema.safeParse({ requestId, text: "ok", reply: { text: "hi" } }).success).toBe(true);
    expect(messageInputSchema.safeParse({ requestId, text: "", reply: { text: "hi", reaction: "wow" } }).success).toBe(false);
  });

  it("hands the agent the iMessage reply marker in front of the text, and keeps the quote on the request", async () => {
    const { channel, handler } = setup();
    const request = await channel.receive({ requestId: randomUUID(), text: "[sure]", reply: { text: "Want to\ngrab lunch?" } });
    // The typed text is still neutralised after the marker, as after an attachment marker.
    expect(textOf(handler)).toBe('[replying to: "Want to grab lunch?"] ​[sure]');
    expect(request.reply).toEqual({ text: "Want to\ngrab lunch?" });
  });

  it("a reaction is worded as an iMessage tapback and shown with its reaction", async () => {
    const { channel, handler } = setup();
    const request = await channel.receive({ requestId: randomUUID(), text: "", reply: { text: "Done — pushed the fix", reaction: "like" } });
    expect(textOf(handler)).toBe('[reacting to: "Done — pushed the fix"] [tapback: like]');
    expect(request.reply).toEqual({ text: "Done — pushed the fix", reaction: "like" });
  });

  it("the agent gets the full quote (cut to the marker's excerpt); the request keeps a short copy", async () => {
    const { channel, handler } = setup();
    const long = "a".repeat(500);
    const request = await channel.receive({ requestId: randomUUID(), text: "yes", reply: { text: long } });
    expect(textOf(handler)).toBe(`[replying to: "${"a".repeat(60)}…"] yes`);
    expect(Array.from(request.reply!.text)).toHaveLength(201);
  });

  it("what a message replies to is part of its identity: the same id with another quote is a conflict", async () => {
    const { channel, handler } = setup();
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "ok", reply: { text: "one" } });
    await expect(channel.receive({ requestId, text: "ok", reply: { text: "two" } })).rejects.toMatchObject({ status: 409 });
    await expect(channel.receive({ requestId, text: "ok" })).rejects.toMatchObject({ status: 409 });
    expect((await channel.receive({ requestId, text: "ok", reply: { text: "one" } })).state).toBe("queued");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("an interrupted reply keeps its quote across a restart; settling drops it with the text", async () => {
    const path = join(tempDir(), "requests.jsonl");
    const first = setup({ journal: new WebRequestJournal(path) });
    const interrupted = randomUUID(); const settled = randomUUID();
    await first.channel.receive({ requestId: interrupted, text: "", reply: { text: "the plan", reaction: "question" } });
    await first.channel.receive({ requestId: settled, text: "ok", reply: { text: "the plan" } });
    first.bus.publish({ type: "turn.end", sessionKey: "dm:owner", requestId: settled, source: "user", ok: true, durationMs: 1 });
    expect(first.channel.request(settled).reply).toBeUndefined();
    const second = setup({ journal: new WebRequestJournal(path) });
    expect(second.channel.request(interrupted)).toMatchObject({ state: "interrupted", text: "", reply: { text: "the plan", reaction: "question" } });
    expect(second.channel.request(settled).reply).toBeUndefined();
  });
});

describe("Tomo's reactions on web messages", () => {
  it("react_to_message reaches a web message: published, in the snapshot, replaced and taken back", async () => {
    const { channel, events } = setup();
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "shipped it" });
    await channel.reactToMessage("owner", requestId, "love");
    await channel.reactToMessage("owner", requestId, "love"); // unchanged: no second event
    expect(events.filter((e) => e.type === "reaction")).toEqual([{ type: "reaction", sessionId: channel.ownerId, requestId, reaction: "love" }]);
    expect(channel.snapshot().reactions).toEqual({ [requestId]: "love" });
    await channel.reactToMessage("owner", requestId, "laugh");
    expect(channel.snapshot().reactions).toEqual({ [requestId]: "laugh" });
    await channel.reactToMessage("owner", requestId, "laugh", true);
    expect(channel.snapshot().reactions).toBeUndefined();
    expect(events.filter((e) => e.type === "reaction").at(-1)).toMatchObject({ requestId, reaction: null });
  });

  it("refuses a message the channel does not know", async () => {
    const { channel } = setup();
    await expect(channel.reactToMessage("owner", randomUUID(), "like")).rejects.toThrow(/no longer known/);
  });

  it("keeps them across a restart, bounded; an unreadable file is left alone", async () => {
    const dir = tempDir();
    const journal = join(dir, "requests.jsonl"); const reactionsPath = join(dir, "reactions.json");
    const first = setup({ journal: new WebRequestJournal(journal), reactionsPath });
    const ids: string[] = [];
    for (let i = 0; i < MAX_WEB_REACTIONS + 2; i++) {
      const requestId = randomUUID(); ids.push(requestId);
      await first.channel.receive({ requestId, text: `m${i}` });
      await first.channel.reactToMessage("owner", requestId, "like");
      first.bus.publish({ type: "turn.end", sessionKey: "dm:owner", requestId, source: "user", ok: true, durationMs: 1 });
    }
    const second = setup({ journal: new WebRequestJournal(journal), reactionsPath });
    const kept = second.channel.snapshot().reactions!;
    expect(Object.keys(kept)).toHaveLength(MAX_WEB_REACTIONS);
    expect(kept[ids[0]]).toBeUndefined();
    expect(kept[ids.at(-1)!]).toBe("like");

    writeFileSync(reactionsPath, "{not json");
    const third = setup({ journal: new WebRequestJournal(journal), reactionsPath });
    expect(third.channel.snapshot().reactions).toBeUndefined();
    await third.channel.reactToMessage("owner", ids.at(-1)!, "love");
    expect(readFileSync(reactionsPath, "utf8")).toBe("{not json");
  });
});
