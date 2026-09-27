import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { WebChannel } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import { WebEvents } from "../src/web/events.js";
import { parseWebConfig } from "../src/web/config.js";
import { selectWebOwner, webSessionId } from "../src/web/owner.js";
import { MAX_BUFFER_BYTES, type WebEvent } from "../src/web/protocol.js";

const owner = { name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" as const };
const channels: WebChannel[] = [];
function setup(identities = [owner]) {
  const bus = new WatchBus();
  const channel = new WebChannel(identities, undefined, bus);
  channels.push(channel);
  const handler = vi.fn(async () => true);
  channel.onMessage(handler);
  const events: WebEvent[] = [];
  channel.events.subscribe(({ event }) => events.push(event));
  return { channel, handler, bus, events };
}
afterEach(async () => { for (const channel of channels.splice(0)) await channel.stop(); });

describe("web configuration and owner", () => {
  it("defaults to loopback port 9465 and degrades invalid optional config without reflecting values", () => {
    expect(parseWebConfig(undefined)).toEqual({ enabled: true, port: 9465 });
    expect(parseWebConfig({ enabled: false, port: 9876 })).toEqual({ enabled: false, port: 9876 });
    const diagnostic = vi.fn();
    expect(parseWebConfig({ port: "secret-value" }, diagnostic).enabled).toBe(false);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret-value");
    expect(diagnostic).toHaveBeenCalledOnce();
  });
  it("requires exactly one identity unless an explicit unique owner is selected", () => {
    const peer = { ...owner, name: "peer" };
    expect(selectWebOwner([])).toBeUndefined();
    expect(selectWebOwner([owner, peer])).toBeUndefined();
    expect(selectWebOwner([owner, peer], "OWNER")).toEqual(owner);
    expect(selectWebOwner([owner, owner], "owner")).toBeUndefined();
    expect(selectWebOwner([owner], "missing")).toBeUndefined();
  });
});

describe("WebChannel", () => {
  it("evicts settled receipts after capacity while keeping ingress and active outlets alive", async () => {
    const { channel, bus, handler } = setup();
    const active = randomUUID(); await channel.receive({ requestId: active, text: "still running" });
    let evicted = "";
    for (let i = 0; i < 4100; i++) {
      const requestId = randomUUID(); if (i === 0) evicted = requestId;
      await expect(channel.receive({ requestId, text: "settled" })).resolves.toMatchObject({ state: "queued" });
      bus.publish({ type: "turn.end", sessionKey: "dm:owner", requestId, source: "user", ok: true, durationMs: 1 });
    }
    expect(channel.request(evicted).state).toBe("unknown");
    expect(channel.request(active).state).toBe("queued");
    await expect(channel.send({ chatId: active, text: "still deliverable" })).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(4101);
  });
  it("counts unsettled failed delivery against the active cap until the turn ends", async () => {
    const { channel, bus } = setup(); let first = "";
    for (let i = 0; i < 32; i++) {
      const requestId = randomUUID(); if (!first) first = requestId;
      await channel.receive({ requestId, text: "running" });
      await expect(channel.send({ chatId: requestId, text: "x".repeat(MAX_BUFFER_BYTES) })).rejects.toThrow();
    }
    await expect(channel.receive({ requestId: randomUUID(), text: "over cap" })).rejects.toMatchObject({ status: 429 });
    bus.publish({ type: "turn.end", sessionKey: "dm:owner", requestId: first, source: "user", ok: false, durationMs: 1 });
    await expect(channel.receive({ requestId: randomUUID(), text: "next" })).resolves.toMatchObject({ state: "queued" });
  });
  it("hands ordinary owner DM input to Agent and deduplicates both pending and completed receipts", async () => {
    const { channel, handler, bus } = setup();
    const input = { requestId: randomUUID(), text: "Hello" };
    await Promise.all([channel.receive(input), channel.receive(input)]);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: input.requestId, chatId: "owner", isGroup: false, text: "Hello" }));
    bus.publish({ type: "turn.end", sessionKey: "dm:owner", source: "user", ok: true, durationMs: 1, requestId: input.requestId });
    expect((await channel.receive(input)).state).toBe("completed");
    await expect(channel.receive({ ...input, text: "different" })).rejects.toMatchObject({ status: 409 });
    expect(handler).toHaveBeenCalledOnce();
  });
  it("rejects group/unknown targets and ambiguous owners before handoff", async () => {
    const { channel, handler } = setup();
    for (const targetId of [webSessionId("telegram:-1"), "dm:owner", "../config.json"]) {
      await expect(channel.receive({ requestId: randomUUID(), text: "blocked", targetId })).rejects.toMatchObject({ status: 403 });
    }
    expect(handler).not.toHaveBeenCalled();
    const ambiguous = setup([owner, { ...owner, name: "peer" }]);
    await expect(ambiguous.channel.receive({ requestId: randomUUID(), text: "blocked" })).rejects.toMatchObject({ status: 409 });
    expect(ambiguous.handler).not.toHaveBeenCalled();
  });
  it("reports refusal and closes ingress while preserving an accepted handoff", async () => {
    const { channel, handler } = setup();
    handler.mockResolvedValueOnce(false);
    const requestId = randomUUID();
    await expect(channel.receive({ requestId, text: "refused" })).rejects.toMatchObject({ status: 503 });
    expect(channel.request(requestId).state).toBe("refused");
    channel.closeIngestion();
    await expect(channel.receive({ requestId: randomUUID(), text: "closed" })).rejects.toMatchObject({ status: 503 });
    expect(handler).toHaveBeenCalledOnce();
  });
  it("keeps per-request outlets and never attributes a late send to the next request", async () => {
    const { channel, bus, events } = setup();
    const first = randomUUID(); const second = randomUUID();
    await channel.receive({ requestId: first, text: "first" });
    await channel.send({ chatId: first, text: "first block" });
    bus.publish({ type: "turn.end", sessionKey: "dm:owner", source: "user", ok: true, durationMs: 1, requestId: first });
    await channel.receive({ requestId: second, text: "second" });
    await expect(channel.send({ chatId: first, text: "late" })).rejects.toThrow("unavailable");
    await channel.send({ chatId: second, text: "second block" });
    expect(events.filter((e) => e.type === "block").map((e) => [e.requestId, e.text])).toEqual([[first, "first block"], [second, "second block"]]);
  });
  it("bounds mailbox bytes and leaves failed delivery visible through turn completion", async () => {
    const { channel, bus } = setup();
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "large reply" });
    for (let bytes = 0; bytes < MAX_BUFFER_BYTES - 128 * 1024; bytes += 128 * 1024) await channel.send({ chatId: requestId, text: "x".repeat(128 * 1024) });
    await expect(channel.send({ chatId: requestId, text: "x".repeat(128 * 1024) })).rejects.toThrow("mailbox");
    bus.publish({ type: "turn.end", sessionKey: "dm:owner", source: "user", ok: true, durationMs: 1, requestId });
    expect(channel.request(requestId).state).toBe("failed");
    expect(channel.snapshot().blocks).toEqual([]);
    await expect(channel.send({ chatId: requestId, text: "late failed send" })).rejects.toThrow("unavailable");
  });
  it("forwards only safe attributed activity and isolates observers/lifecycle failures", async () => {
    const { channel, bus, events } = setup();
    bus.publish({ type: "tool.start", tool: "Read", detail: "secret arguments" });
    bus.publish({ type: "tool.start", sessionKey: "dm:peer", tool: "Read", detail: "private" });
    bus.publish({ type: "tool.start", sessionKey: "dm:owner", tool: "Read", detail: "secret arguments" });
    bus.publish({ type: "tool.end", sessionKey: "telegram:-1", tool: "Search", ok: true });
    expect(events).toEqual([
      { type: "tool", sessionId: webSessionId("dm:owner"), tool: "Read", state: "started" },
      { type: "tool", sessionId: webSessionId("telegram:-1"), tool: "Search", state: "completed" },
    ]);
    channel.attach({ start: async () => { throw new Error("listen failed"); }, stop: async () => { throw new Error("stop failed"); } });
    await expect(channel.start()).resolves.toBeUndefined();
    await expect(channel.stop()).resolves.toBeUndefined();
  });
});

it("replays bounded events and reports gaps or another epoch", () => {
  const events = new WebEvents();
  events.publish({ type: "invalidate" });
  const cursor = events.cursor();
  events.subscribe(() => { throw new Error("broken observer"); });
  events.publish({ type: "typing", sessionId: "test", active: true });
  expect(events.after(cursor)?.map((v) => v.event.type)).toEqual(["typing"]);
  for (let i = 0; i < 1001; i++) events.publish({ type: "invalidate" });
  expect(events.after(cursor)).toBeNull();
  expect(events.after("previous-epoch:1")).toBeNull();
  expect(events.after(events.cursor())).toEqual([]);
});

it("shares a serialized snapshot budget between queued text and completed blocks", async () => {
  const { channel } = setup(); const text = "\u0001".repeat(16_000); const ids: string[] = [];
  for (let i = 0; i < 21; i++) { const requestId = randomUUID(); ids.push(requestId); await channel.receive({ requestId, text }); }
  await expect(channel.receive({ requestId: randomUUID(), text })).rejects.toMatchObject({ status: 429 });
  await expect(channel.send({ chatId: ids[0], text: "x".repeat(200_000) })).rejects.toThrow("Web mailbox full");
  expect(Buffer.byteLength(JSON.stringify(channel.snapshot()))).toBeLessThan(MAX_BUFFER_BYTES);
  channel.settleMessage(ids[0], "refused");
  expect(channel.request(ids[0]).text).toBeUndefined();
  await expect(channel.receive({ requestId: randomUUID(), text })).resolves.toMatchObject({ state: "queued" });
});
it("releases accepted text after failed handoff and terminal settlement", async () => {
  const { channel, handler, bus } = setup(); handler.mockResolvedValue(false);
  const refused = randomUUID(); await expect(channel.receive({ requestId: refused, text: "Private draft" })).rejects.toThrow();
  expect(channel.request(refused).text).toBeUndefined();
  handler.mockResolvedValue(true); const completed = randomUUID(); await channel.receive({ requestId: completed, text: "Accepted draft" });
  bus.publish({ type: "turn.end", sessionKey: "dm:owner", requestId: completed, source: "user", ok: true, durationMs: 1 });
  expect(channel.request(completed).text).toBeUndefined();
});
