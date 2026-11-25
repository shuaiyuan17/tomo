import type { IncomingMessage } from "../src/channels/types.js";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { type ServiceLookup } from "../src/channels/imsg-satellite.js";
import { SATELLITE_MARKER } from "../src/channels/text-utils.js";
import {
  CAPS_FULL,
  makeChannel,
  DM_GUID,
  GROUP_GUID,
  inboundMessage,
  settle,
} from "./helpers/fake-imsg.js";

// ImsgChannel tests, split by concern (fakes in tests/helpers/fake-imsg.ts).
// Inbound rows from the watch stream: mapping to IncomingMessage, reply
// context, echo/replay dedupe, tapbacks, at-least-once cursor ordering, FIFO
// processing, shutdown quiesce, admission, satellite detection, and what the
// credential broker reads off a row.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Inbound mapping ---------------------------------------------------------

describe("imsg inbound message mapping", () => {
  it("maps a DM to an IncomingMessage with the chat.db chat_guid as chatId", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage());
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0];
    expect(msg).toMatchObject({
      id: "msg-guid-1",
      chatId: DM_GUID, // verbatim — the session key is derived from this string
      senderName: "Alice Smith",
      senderId: "+15551234567",
      text: "hello there",
      isGroup: false,
      isMentioned: false,
    });
    expect(msg.timestamp).toBe(Date.parse("2026-07-07T10:00:00.000Z"));
    await channel.stop();
  });

  it("normalizes formatted sender handles into senderId", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ sender: "+1 (555) 123-4567" }));
    await settle();

    expect(handler.mock.calls[0][0].senderId).toBe("+15551234567");
    await channel.stop();
  });

  it("maps a group message as mentioned with its chat title", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      chat_guid: GROUP_GUID,
      chat_name: "Family",
      is_group: true,
      guid: "group-msg-1",
    }));
    await settle();

    const msg = handler.mock.calls[0][0];
    expect(msg).toMatchObject({
      chatId: GROUP_GUID,
      isGroup: true,
      isMentioned: true,
      chatTitle: "Family",
    });
    await channel.stop();
  });

  it("prefixes reply context from the inline reply_to_text (no lookup round-trip)", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      guid: "reply-guid-1",
      text: "sounds good",
      reply_to_guid: "orig-guid",
      reply_to_text: "dinner friday?",
      reply_to_sender: "+15551234567",
      thread_originator_guid: "orig-guid",
    }));
    await settle();

    expect(handler.mock.calls[0][0].text).toBe('[replying to: "dinner friday?"] sounds good');
    await channel.stop();
  });

  it("attaches NO reply context when thread_originator_guid is absent (reply_to_guid alone is not a reply)", async () => {
    // chat.db populates message.reply_to_guid on virtually every row (it
    // points at the preceding message — usually our own last outbound), and
    // imsg resolves reply_to_text from it. Keying reply context on it tagged
    // every plain inbound send as [replying to: "<our latest message>"].
    // Only thread_originator_guid marks a genuine long-press → Reply.
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      guid: "plain-guid-1",
      text: "Morning!",
      reply_to_guid: "our-last-outbound-guid",
      reply_to_text: "our latest outbound message",
      reply_to_sender: "me",
    }));
    await settle();

    expect(handler.mock.calls[0][0].text).toBe("Morning!");
    await channel.stop();
  });

  it("quotes the thread originator from the recent ring when imsg left reply_to_text unresolved", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    // Seed the ring with the originator (an is_from_me watch row).
    children[0].notifyMessage(inboundMessage({
      id: 100,
      guid: "orig-guid-ring",
      text: "dinner friday?",
      is_from_me: true,
    }));
    await settle();
    children[0].notifyMessage(inboundMessage({
      id: 101,
      guid: "reply-guid-3",
      text: "sounds good",
      thread_originator_guid: "orig-guid-ring",
    }));
    await settle();

    expect(handler.mock.calls[0][0].text).toBe('[replying to: "dinner friday?"] sounds good');
    await channel.stop();
  });

  it("degrades to a quote-less reply marker when the originator text is unavailable", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      guid: "reply-guid-2",
      text: "still arrives",
      thread_originator_guid: "orig-gone",
    }));
    await settle();

    expect(handler.mock.calls[0][0].text).toBe("[replying to an earlier message] still arrives");
    await channel.stop();
  });

  it("drops empty ghost rows", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "ghost-1", text: "   " }));
    await settle();

    expect(handler).not.toHaveBeenCalled();
    await channel.stop();
  });

  it("dispatches slash commands with a normalized senderId", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const commandHandler = vi.fn(async () => true);
    channel.onCommand(commandHandler);

    children[0].notifyMessage(inboundMessage({
      guid: "cmd-1",
      text: "/model sonnet",
      sender: "+1 (555) 123-4567",
      sender_name: "Shuai",
    }));
    await settle();

    expect(commandHandler).toHaveBeenCalledWith("model", DM_GUID, "Shuai", "sonnet", "+15551234567");
    await channel.stop();
  });

  it("dispatches /task and /tasks in any case and with padding as the tasks command", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const commandHandler = vi.fn(async () => true);
    const messageHandler = vi.fn(async () => true);
    channel.onCommand(commandHandler);
    channel.onMessage(messageHandler);

    children[0].notifyMessage(inboundMessage({ guid: "tasks-1", text: "/Task", sender: "+15551234567", sender_name: "Shuai" }));
    children[0].notifyMessage(inboundMessage({ guid: "tasks-2", text: "  /TASKS all ", sender: "+15551234567", sender_name: "Shuai" }));
    await settle();

    expect(commandHandler.mock.calls).toEqual([
      ["tasks", DM_GUID, "Shuai", "", "+15551234567"],
      ["tasks", DM_GUID, "Shuai", "all", "+15551234567"],
    ]);
    expect(messageHandler).not.toHaveBeenCalled();
    await channel.stop();
  });
});

// --- Echo + dedupe -----------------------------------------------------------

describe("imsg echo and replay dedupe", () => {
  it("never dispatches is_from_me rows but records them for substring targeting", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "own-1", text: "our own send", is_from_me: true }));
    await settle();

    expect(handler).not.toHaveBeenCalled();
    const recent = channel.recentMessages(DM_GUID);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ id: "own-1", fromMe: true });
    expect(recent[0].senderName).toBeUndefined();
    await channel.stop();
  });

  it("drops a replayed GUID within one process", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "dup-1" }));
    children[0].notifyMessage(inboundMessage({ guid: "dup-1" }));
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    await channel.stop();
  });

  it("drops a replayed GUID across channel restarts via the persistent store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-dedupe-"));
    const dedupeStorePath = join(dir, "seen.json");
    try {
      const first = makeChannel({ config: { dedupeStorePath } });
      await first.channel.start();
      const firstHandler = vi.fn(async () => true);
      first.channel.onMessage(firstHandler);
      first.children[0].notifyMessage(inboundMessage({ guid: "persist-1" }));
      await settle();
      expect(firstHandler).toHaveBeenCalledTimes(1);
      await first.channel.stop();

      const second = makeChannel({ config: { dedupeStorePath } });
      await second.channel.start();
      const secondHandler = vi.fn(async () => true);
      second.channel.onMessage(secondHandler);
      second.children[0].notifyMessage(inboundMessage({ guid: "persist-1" }));
      await settle();
      expect(secondHandler).not.toHaveBeenCalled();
      await second.channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes the watch from the persisted rowid cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-cursor-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const first = makeChannel({ config: { cursorStorePath } });
      await first.channel.start();
      first.channel.onMessage(vi.fn(async () => true));
      first.children[0].notifyMessage(inboundMessage({ id: 4242, guid: "cursor-1" }));
      await settle();
      await first.channel.stop();

      const second = makeChannel({ config: { cursorStorePath } });
      await second.channel.start();
      const subscribe = second.requests().find((r) => r.method === "watch.subscribe");
      expect(subscribe?.params.since_rowid).toBe(4242);
      await second.channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Inbound tapbacks ---------------------------------------------------------

describe("imsg inbound tapbacks", () => {
  it("surfaces another sender's tapback add with the original excerpt", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "orig-1", text: "pizza tonight?" }));
    children[0].notifyMessage(inboundMessage({
      id: 101,
      guid: "react-1",
      text: "Loved “pizza tonight?”",
      is_reaction: true,
      reaction_type: "love",
      is_reaction_add: true,
      reacted_to_guid: "orig-1",
    }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

    // Reaction rows dispatch synchronously while regular rows await
    // attachment loading, so select by id rather than call order.
    const reaction = handler.mock.calls.map((c) => c[0]).find((m) => m.id === "react-1");
    expect(reaction?.text).toBe('[reacting to: "pizza tonight?"] [tapback: love]');
    expect(reaction?.isMentioned).toBe(false);
    expect(reaction?.isReaction).toBe(true);
    await channel.stop();
  });

  it("ignores tapback removals and our own tapbacks", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      id: 102, guid: "react-2", is_reaction: true, reaction_type: "like", is_reaction_add: false, reacted_to_guid: "x",
    }));
    children[0].notifyMessage(inboundMessage({
      id: 103, guid: "react-3", is_reaction: true, reaction_type: "like", is_reaction_add: true, is_from_me: true, reacted_to_guid: "x",
    }));
    await settle();

    expect(handler).not.toHaveBeenCalled();
    await channel.stop();
  });
});

// --- recentMessages addressing ---------------------------------------------------

describe("imsg recent-message cache addressing", () => {
  it("resolves a bare DM handle to its chat-GUID ring, but never a group", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    channel.onMessage(vi.fn(async () => true));

    children[0].notifyMessage(inboundMessage({ guid: "g-dm", text: "direct message" }));
    children[0].notifyMessage(inboundMessage({
      guid: "g-group", text: "group message", chat_guid: GROUP_GUID, is_group: true,
    }));
    // Rows process through a FIFO chain, so wait for the second to land.
    await vi.waitFor(() => expect(channel.recentMessages(GROUP_GUID)).toHaveLength(1));

    expect(channel.recentMessages("+1 (555) 123-4567").map((m) => m.id)).toEqual(["g-dm"]);
    expect(channel.recentMessages("+15551234567").map((m) => m.id)).toEqual(["g-dm"]);
    expect(channel.recentMessages(GROUP_GUID).map((m) => m.id)).toEqual(["g-group"]);
    expect(channel.recentMessages("a70f2f5b3ea847759d38c0b8e3cba57d")).toEqual([]);
    await channel.stop();
  });
});

// --- Session-key passthrough (Codex adjudication: no normalization) --------------

describe("imsg session-key passthrough", () => {
  it("emits chat_guid verbatim so keys match the on-disk any-format sessions", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    // DMs on macOS 26 are stored as any;-;+E164; groups as any;+;<hex>.
    // These map to ~/.tomo/data/sessions/imessage_any_-__<E164>.jsonl and
    // imessage_any___<hex>.jsonl — passthrough (no normalization) is what
    // keeps existing session keys valid; rewriting the GUID orphans them.
    children[0].notifyMessage(inboundMessage({ guid: "dm-1", text: "hi", chat_guid: "any;-;+15551234567" }));
    children[0].notifyMessage(inboundMessage({ guid: "grp-1", text: "yo", chat_guid: "any;+;a70f2f5b3ea847759d38c0b8e3cba57d", is_group: true }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

    const byId = Object.fromEntries(handler.mock.calls.map((c) => [c[0].id, c[0]]));
    expect(byId["dm-1"].chatId).toBe("any;-;+15551234567");
    expect(byId["dm-1"].isGroup).toBe(false);
    expect(byId["grp-1"].chatId).toBe("any;+;a70f2f5b3ea847759d38c0b8e3cba57d");
    expect(byId["grp-1"].isGroup).toBe(true);
    await channel.stop();
  });
});

// --- Satellite (iMessageLite) detection via chat.db service lookup ---------------

describe("imsg satellite detection", () => {
  const makeLookup = (services: Record<string, string>): { lookup: ServiceLookup; spy: ReturnType<typeof vi.fn> } => {
    const spy = vi.fn((guid: string) => services[guid]);
    return { lookup: { serviceForGuid: spy, close: () => {} }, spy };
  };

  it("prefixes the satellite marker when message.service is iMessageLite", async () => {
    const { lookup } = makeLookup({ "sat-1": "iMessageLite" });
    const { channel, children } = makeChannel({ config: { serviceLookup: lookup } });
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "sat-1", text: "we are off-grid" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(handler.mock.calls[0][0].text).toBe(`${SATELLITE_MARKER} we are off-grid`);
    await channel.stop();
  });

  it("does not tag standard iMessage rows", async () => {
    const { lookup } = makeLookup({ "plain-1": "iMessage" });
    const { channel, children } = makeChannel({ config: { serviceLookup: lookup } });
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "plain-1", text: "normal message" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(handler.mock.calls[0][0].text).toBe("normal message");
    await channel.stop();
  });

  it("skips the sqlite lookup entirely for attachment-only rows (no text)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-sat-"));
    const imgPath = join(dir, "photo.png");
    writeFileSync(imgPath, Buffer.from("89504e470d0a1a0a", "hex"));
    try {
      const { lookup, spy } = makeLookup({});
      const { channel, children } = makeChannel({ config: { serviceLookup: lookup } });
      await channel.start();
      const handler = vi.fn(async () => true);
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({
        guid: "att-only-1",
        text: "",
        attachments: [{ mime_type: "image/png", original_path: imgPath, total_bytes: 8, missing: false }],
      }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      expect(spy).not.toHaveBeenCalled();
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- At-least-once cursor / GUID ordering (Codex HIGH #1) ------------------------

describe("imsg at-least-once persist ordering", () => {
  it("advances the cursor and records the GUID only AFTER a successful dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-atleastonce-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath } });
      await channel.start();
      const handler = vi.fn(async () => true);
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({ id: 900, guid: "ok-1", text: "delivered" }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      // A replay of the same GUID is now dropped (recorded after dispatch).
      children[0].notifyMessage(inboundMessage({ id: 900, guid: "ok-1", text: "delivered" }));
      await settle();
      expect(handler).toHaveBeenCalledTimes(1);

      await vi.waitFor(() => {
        expect(existsSync(cursorStorePath)).toBe(true);
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(900);
      });
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT advance the cursor when dispatch throws, so the row replays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-replay-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath } });
      await channel.start();
      // Succeeds for row 400, throws for row 500.
      channel.onMessage(async (m) => { if (m.id === "throws-1") throw new Error("boom"); return true; });

      children[0].notifyMessage(inboundMessage({ id: 400, guid: "good-1", text: "ok" }));
      children[0].notifyMessage(inboundMessage({ id: 500, guid: "throws-1", text: "will throw" }));
      // Cursor commits to 400 (the last successful row) and never advances to 500.
      await vi.waitFor(() => {
        expect(existsSync(cursorStorePath)).toBe(true);
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);
      });
      await settle();
      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);

      // A restart therefore resubscribes from 400 — the throwing row replays.
      await channel.stop();
      const second = makeChannel({ config: { cursorStorePath } });
      await second.channel.start();
      const resubscribe = second.requests().find((r) => r.method === "watch.subscribe");
      expect(resubscribe?.params.since_rowid).toBe(400);
      await second.channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT let a LATER row commit the cursor past a failed row (round-2 #1)", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-gap-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      // Long backoff so the gap-recovery restart doesn't fire during the test.
      const { channel, children } = makeChannel({ config: { cursorStorePath, restartDelaysMs: [60_000] } });
      await channel.start();
      const seen: string[] = [];
      channel.onMessage(async (m) => {
        if (m.id === "throws-1") throw new Error("boom");
        seen.push(m.id);
        return true;
      });

      children[0].notifyMessage(inboundMessage({ id: 400, guid: "good-1", text: "ok" }));
      children[0].notifyMessage(inboundMessage({ id: 500, guid: "throws-1", text: "will throw" }));
      // A later row queued behind the failure — it must not commit past 500.
      children[0].notifyMessage(inboundMessage({ id: 600, guid: "later-1", text: "after the gap" }));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);
      });
      await settle();

      // Cursor stays at 400 (never 500, never 600) and the later row is not
      // delivered out of order (the chain was halted for gap recovery).
      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);
      expect(seen).toEqual(["good-1"]);
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not wedge the cursor floor when a row WITHOUT a rowid fails to dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-norowid-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath } });
      await channel.start();
      channel.onMessage(async (m) => { if (m.id === "no-rowid") throw new Error("boom"); return true; });

      // A malformed row with no numeric rowid (parses to 0) whose dispatch
      // throws can't be replayed by since_rowid. Flooring at 0 would block
      // every future cursor commit forever — instead the failure is logged,
      // the child stays up, and a later good row still commits.
      children[0].notifyMessage(inboundMessage({ id: undefined, guid: "no-rowid", text: "will throw" }));
      children[0].notifyMessage(inboundMessage({ id: 700, guid: "good-after-norowid", text: "ok" }));
      await vi.waitFor(() => {
        expect(existsSync(cursorStorePath)).toBe(true);
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(700);
      });
      expect(children[0].killed).toBe(false);
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advanceCursor refuses to skip a known-failed lower rowid, then clears on replay", () => {
    const { channel } = makeChannel();
    const internals = (channel as unknown as { rpc: {
      lastRowId: number;
      failedRowId: number | null;
      advanceCursor(rowId: number): void;
    } }).rpc;
    internals.lastRowId = 100;
    internals.failedRowId = 200;

    internals.advanceCursor(300); // past the gap → refused
    expect(internals.lastRowId).toBe(100);
    expect(internals.failedRowId).toBe(200);

    internals.advanceCursor(150); // before the gap → allowed
    expect(internals.lastRowId).toBe(150);
    expect(internals.failedRowId).toBe(200);

    internals.advanceCursor(200); // reaching the failed row (successful replay) → clears + advances
    expect(internals.lastRowId).toBe(200);
    expect(internals.failedRowId).toBeNull();

    internals.advanceCursor(300); // gap closed → normal advance resumes
    expect(internals.lastRowId).toBe(300);
  });

  it("halts on a failing COMMAND row so a later row can't advance past it (round-3 #2)", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-cmdgap-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath, restartDelaysMs: [60_000] } });
      await channel.start();
      const seen: string[] = [];
      channel.onMessage(async (m) => { seen.push(m.id); return true; });
      // A slash-command handler that throws.
      channel.onCommand(async (command) => { if (command === "model") throw new Error("cmd boom"); });

      children[0].notifyMessage(inboundMessage({ id: 400, guid: "good-1", text: "hi" }));
      children[0].notifyMessage(inboundMessage({ id: 500, guid: "cmd-1", text: "/model sonnet" }));
      // A later real row queued behind the failing command.
      children[0].notifyMessage(inboundMessage({ id: 600, guid: "later-1", text: "after cmd" }));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);
      });
      await settle();

      // The failing command row (500) never lets the cursor advance to 600.
      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);
      expect(seen).toEqual(["good-1"]); // "later-1" not delivered out of order
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a STALE-generation row failure that rejects after replay advanced the cursor (round-4 #1)", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-stalegen-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, watchChildren } = makeChannel({ config: { cursorStorePath, restartDelaysMs: [1_000] } });
      await channel.start();

      const seen: string[] = [];
      let gateReject: ((e: Error) => void) | null = null;
      let allowReplay = false;
      channel.onMessage(async (m) => {
        if (m.id === "row-500" && !allowReplay) {
          // The OLD-generation delivery hangs until we reject it later.
          await new Promise<void>((_, rej) => { gateReject = rej; });
          return true;
        }
        seen.push(m.id);
        return true;
      });

      // Old generation: row 500 arrives and hangs mid-dispatch.
      watchChildren()[0].notifyMessage(inboundMessage({ id: 500, guid: "row-500", text: "row 500" }));
      await vi.waitFor(() => expect(gateReject).not.toBeNull());

      // The child restarts (generation bump). The new child replays 500 + 600
      // successfully, advancing the committed cursor to 600.
      allowReplay = true;
      watchChildren()[0].emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(watchChildren()).toHaveLength(2);
      watchChildren()[1].notifyMessage(inboundMessage({ id: 500, guid: "row-500", text: "row 500" }));
      watchChildren()[1].notifyMessage(inboundMessage({ id: 600, guid: "row-600", text: "row 600" }));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(600);
      });

      // NOW the OLD row 500 finally rejects. Because its generation is stale, it
      // must be a no-op: no floor, no kill, no cursor wedge.
      const childCountBefore = watchChildren().length;
      gateReject!(new Error("stale boom"));
      await settle();

      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(600);
      expect((channel as unknown as { rpc: { failedRowId: number | null } }).rpc.failedRowId).toBeNull();
      expect(watchChildren()).toHaveLength(childCountBefore); // no extra restart from the stale failure

      // The cursor keeps advancing — not wedged.
      watchChildren()[1].notifyMessage(inboundMessage({ id: 700, guid: "row-700", text: "row 700" }));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(700);
      });
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT dispatch a stale-generation row that blocked in attachment load (round-5)", async () => {
    // Real timers: the row blocks on a real readFile of a FIFO (no fake-timer
    // control over that IO), and restart backoff is tiny.
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-r5-"));
    const fifoPath = join(dir, "blocking.png");
    execFileSync("mkfifo", [fifoPath]);
    const normalPath = join(dir, "replay.png");
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(normalPath, pngBytes);
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath, restartDelaysMs: [10] } });
      await channel.start();
      const seen: string[] = [];
      channel.onMessage(async (m) => { seen.push(m.id); return true; });

      // Old generation: row 500 carries a FIFO attachment, so loadAttachments
      // blocks on readFile BEFORE the dispatch side effect.
      children[0].notifyMessage(inboundMessage({
        id: 500, guid: "row-500", text: "with photo",
        // No declared size: a FIFO reports 0 bytes and must still reach readFile.
        attachments: [{ mime_type: "image/png", original_path: fifoPath, missing: false }],
      }));
      await new Promise((r) => setTimeout(r, 60));
      expect(seen).toEqual([]); // still blocked in attachment load — not delivered

      // The child restarts; the replacement generation replays 500 (with a
      // NORMAL file) + 600 and delivers them exactly once, in order.
      children[0].emit("exit", 1, null);
      await vi.waitFor(() => expect(children).toHaveLength(2));
      children[1].notifyMessage(inboundMessage({
        id: 500, guid: "row-500", text: "with photo",
        attachments: [{ mime_type: "image/png", original_path: normalPath, total_bytes: 8, missing: false }],
      }));
      children[1].notifyMessage(inboundMessage({ id: 600, guid: "row-600", text: "next" }));
      await vi.waitFor(() => expect(seen).toEqual(["row-500", "row-600"]));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(600);
      });

      // Unblock the OLD row's FIFO read → it resumes SUCCESSFULLY, but its
      // generation is now stale, so it must abandon before dispatching.
      const fd = openSync(fifoPath, "w");
      writeSync(fd, pngBytes);
      closeSync(fd);
      await new Promise((r) => setTimeout(r, 80));

      // No duplicate, no out-of-order re-delivery; cursor still at 600.
      expect(seen).toEqual(["row-500", "row-600"]);
      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(600);
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- FIFO watch serialization (Codex MED #3) ------------------------------------

describe("imsg watch FIFO serialization", () => {
  it("processes watch rows strictly in order even when an earlier row blocks", async () => {
    const { channel, children } = makeChannel();
    await channel.start();

    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    channel.onMessage(async (m) => {
      order.push(`start:${m.id}`);
      if (m.id === "first") await firstGate;
      order.push(`end:${m.id}`);
      return true;
    });

    children[0].notifyMessage(inboundMessage({ id: 1, guid: "first", text: "one" }));
    children[0].notifyMessage(inboundMessage({ id: 2, guid: "second", text: "two" }));
    await vi.waitFor(() => expect(order).toContain("start:first"));

    // The second row must not have started while the first is blocked.
    expect(order).toEqual(["start:first"]);

    releaseFirst();
    await vi.waitFor(() => expect(order).toContain("end:second"));
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    await channel.stop();
  });
});

// --- Shutdown: rows already inside processWatchRow (round-6 #1) --------------
//
// The entry guard in `handleWatchMessage` only refuses rows that have not
// STARTED. A row that is already parsing — attachment load can park it for
// seconds — is past that guard, and killing the channel under it used to lose
// it in both directions at once: never dispatched (the generation bump made it
// stale), and never replayed (nothing said it had failed). The phase split
// exists for exactly this row: `closeIngestion()` shuts the door, `quiesce()`
// holds shutdown open until the row lands, `teardown()` runs afterwards.

describe("imsg shutdown quiesces rows that are mid-parse", () => {
  it("lets a row parked in attachment loading finish into the agent, then advances its cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-quiesce-"));
    const cursorStorePath = join(dir, "cursor.json");
    const heicPath = join(dir, "photo.heic");
    // Minimal HEIC: ftyp box with the `heic` major brand.
    writeFileSync(heicPath, Buffer.from("000000246674797068656963000000006d696631", "hex"));

    try {
      // The HEIC converter is the parked point: a real await inside
      // loadAttachments, i.e. squarely inside processWatchRow and past the
      // entry guard.
      let releaseConversion!: () => void;
      const conversionGate = new Promise<void>((resolve) => { releaseConversion = resolve; });
      let conversionStarted = false;
      const convertHeic = vi.fn(async (_src: string) => {
        conversionStarted = true;
        await conversionGate;
        const out = join(dir, "converted.jpg");
        writeFileSync(out, Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"));
        return out;
      });

      const { channel, children } = makeChannel({
        config: { cursorStorePath, convertHeic, probeHeicAlpha: async () => false, imageStoreBaseDir: dir },
      });
      await channel.start();
      const handler = vi.fn(async () => true);
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({
        id: 500,
        guid: "midparse-1",
        text: "",
        attachments: [{ filename: "photo.heic", mime_type: "image/heic", original_path: heicPath, missing: false }],
      }));
      await vi.waitFor(() => expect(conversionStarted).toBe(true));

      // SIGTERM lands here. Ingestion closes synchronously; the parked row is
      // NOT abandoned and the child is NOT killed.
      channel.closeIngestion();

      let quiesced = false;
      const quiescing = channel.quiesce().then(() => { quiesced = true; });
      await settle();
      // The whole point: quiesce is still holding shutdown open for this row.
      expect(quiesced).toBe(false);
      expect(handler).not.toHaveBeenCalled();

      releaseConversion();
      await quiescing;

      // The row completed into the agent, and only then was its cursor
      // committed — the ordinary at-least-once contract, unchanged by shutdown.
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].id).toBe("midparse-1");
      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(500);

      await channel.teardown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT record the GUID or advance the cursor when the agent REFUSES the row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-refused-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath } });
      await channel.start();

      // The agent answers `false` only past its shutdown drain: nothing
      // downstream is holding the message. A refusal is not a delivery, and
      // reading it as one is what acknowledged a message into oblivion.
      let refuse = true;
      const handler = vi.fn(async () => !refuse);
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({ id: 900, guid: "refused-1", text: "refused" }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      await settle();

      // Cursor never committed: the next process resubscribes from before this
      // row and redelivers it.
      expect(existsSync(cursorStorePath)).toBe(false);

      // And the GUID was never recorded, so the replay is not deduped away as
      // a "duplicate" of a message that was never actually handled.
      refuse = false;
      children[0].notifyMessage(inboundMessage({ id: 900, guid: "refused-1", text: "refused" }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(900);
      });

      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still refuses — and leaves replayable — a row that had not started when ingestion closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-entryguard-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath } });
      await channel.start();
      const handler = vi.fn(async () => true);
      channel.onMessage(handler);

      channel.closeIngestion();
      children[0].notifyMessage(inboundMessage({ id: 700, guid: "too-late", text: "after the door closed" }));
      await settle();
      await channel.quiesce();

      expect(handler).not.toHaveBeenCalled();
      expect(existsSync(cursorStorePath)).toBe(false);

      await channel.teardown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("imsg admission before spending anything on a chat", () => {
  it("does not load attachments or send a read receipt for a chat the agent will refuse, but still dispatches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-adm-"));
    const imgPath = join(dir, "photo.png");
    writeFileSync(imgPath, Buffer.from("89504e470d0a1a0a", "hex"));
    try {
      const { channel, children, requests } = makeChannel({ caps: CAPS_FULL });
      await channel.start();
      const handler = vi.fn(async () => true);
      channel.onMessage(handler);
      const asked: string[] = [];
      channel.onAdmission((chatId) => { asked.push(chatId); return false; });

      children[0].notifyMessage(inboundMessage({
        guid: "stranger-1",
        text: "hi, look at this",
        attachments: [{ filename: "photo.png", mime_type: "image/png", original_path: imgPath, missing: false }],
      }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      const msg = handler.mock.calls[0][0] as { images?: unknown[]; text: string };
      expect(asked).toEqual([DM_GUID]);
      expect(msg.images).toBeUndefined();
      expect(msg.text).toBe("hi, look at this");
      expect(requests().map((r) => r.method)).not.toContain("read");
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads attachments and marks read for an admitted chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-adm-"));
    const imgPath = join(dir, "photo.png");
    writeFileSync(imgPath, Buffer.from("89504e470d0a1a0a", "hex"));
    try {
      const { channel, children, requests } = makeChannel({ caps: CAPS_FULL });
      await channel.start();
      const handler = vi.fn(async () => true);
      channel.onMessage(handler);
      channel.onAdmission(() => true);

      children[0].notifyMessage(inboundMessage({
        guid: "owner-1",
        text: "",
        attachments: [{ filename: "photo.png", mime_type: "image/png", original_path: imgPath, missing: false }],
      }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      const msg = handler.mock.calls[0][0] as { images?: unknown[] };
      expect(msg.images).toHaveLength(1);
      expect(requests().find((r) => r.method === "read")?.params).toEqual({ chat_guid: DM_GUID });
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the admission predicate throws", async () => {
    const { channel, children, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);
    channel.onAdmission(() => { throw new Error("boom"); });

    children[0].notifyMessage(inboundMessage({ guid: "x-1" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(requests().map((r) => r.method)).not.toContain("read");
    await channel.stop();
  });

  it("normalizes the sender id with the shared handle normalizer", async () => {
    const { channel, children } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "fmt-1", sender: "+1 (555) 123-4567" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect((handler.mock.calls[0][0] as { senderId?: string }).senderId).toBe("+15551234567");
    await channel.stop();
  });
});

describe("what the credential broker needs from an inbound row", () => {
  it("carries what was typed apart from the markers, the thread id, and the attachment count", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);
    children[0].notifyMessage(inboundMessage({ guid: "reply-1", text: "fake-typed-value", thread_originator_guid: "prompt-guid" }));
    await settle();
    const message = handler.mock.calls[0][0] as IncomingMessage;
    expect(message.text).toBe("[replying to an earlier message] fake-typed-value");
    expect(message.rawText).toBe("fake-typed-value");
    expect(message.replyToId).toBe("prompt-guid");
    expect(message.attachmentCount).toBe(0);
    await channel.stop();
  });

  it("gives a tapback no rawText, so it cannot be captured as a value, and names its target", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);
    children[0].notifyMessage(inboundMessage({ id: 101, guid: "react-1", is_reaction: true, reaction_type: "like", is_reaction_add: true, reacted_to_guid: "target-guid" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const message = handler.mock.calls[0][0] as IncomingMessage;
    expect(message.rawText).toBeUndefined();
    expect(message.reactedToId).toBe("target-guid");
    await channel.stop();
  });

  it("forgetMessage removes a row from the ring that substring targeting and reply quoting read", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    channel.onMessage(vi.fn(async () => true));
    children[0].notifyMessage(inboundMessage({ guid: "secret-row", text: "fake-ring-value" }));
    await settle();
    expect(channel.recentMessages(DM_GUID).map((m) => m.id)).toContain("secret-row");
    channel.forgetMessage(DM_GUID, "secret-row");
    expect(channel.recentMessages(DM_GUID).map((m) => m.id)).not.toContain("secret-row");
    await channel.stop();
  });
});
