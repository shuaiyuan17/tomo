import { afterEach, describe, it, expect, vi } from "vitest";
import { type ImsgCapabilities } from "../src/channels/imessage-imsg.js";
import {
  CAPS_FULL,
  CAPS_BASIC,
  makeChannel,
  DM_GUID,
  GROUP_GUID,
  inboundMessage,
  settle,
} from "./helpers/fake-imsg.js";

// ImsgChannel tests, split by concern (fakes in tests/helpers/fake-imsg.ts).
// Message actions on the mutation lane: tapback, unsend, edit, group rename,
// typing, and mark-as-read.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Tapback / unsend / edit -----------------------------------------------------

describe("imsg tapback, unsend, and edit", () => {
  it("sends a targeted tapback over RPC with the `kind` param (NOT `reaction`)", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await channel.reactToMessage(DM_GUID, "target-guid", "love");

    const tapback = requests().find((r) => r.method === "tapback");
    // imsg's shipped tapback RPC honors `kind` (the CLI --kind flag); a
    // `reaction` field is silently ignored → defaults to 👍. Assert the exact
    // param name so a rename back to `reaction` regresses loudly.
    expect(tapback?.params).toEqual({
      chat_guid: DM_GUID,
      message_guid: "target-guid",
      kind: "love",
      remove: false,
      part_index: 0,
    });
    expect(tapback?.params).not.toHaveProperty("reaction");
    await channel.stop();
  });

  it("removes a tapback with remove: true", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await channel.reactToMessage(DM_GUID, "target-guid", "like", true);

    expect(requests().find((r) => r.method === "tapback")?.params).toMatchObject({ kind: "like", remove: true });
    await channel.stop();
  });

  it("unsends via message.unsend and drops the cached row", async () => {
    const { channel, children, requests } = makeChannel();
    await channel.start();
    channel.onMessage(vi.fn(async () => true));

    children[0].notifyMessage(inboundMessage({ guid: "mine-1", text: "oops wrong chat", is_from_me: true }));
    await settle();
    expect(channel.recentMessages(DM_GUID)).toHaveLength(1);

    await channel.unsendMessage(DM_GUID, "mine-1");

    expect(requests().find((r) => r.method === "message.unsend")?.params).toEqual({
      chat_guid: DM_GUID,
      message_guid: "mine-1",
      part_index: 0,
    });
    expect(channel.recentMessages(DM_GUID)).toHaveLength(0);
    await channel.stop();
  });

  it("edits via message.edit when a selector probe confirms support", async () => {
    const caps: ImsgCapabilities = {
      ...CAPS_FULL,
      selectors: { ...CAPS_FULL.selectors, editMessageItem: true },
    };
    const { channel, requests } = makeChannel({ caps });
    await channel.start();

    await channel.editMessage(DM_GUID, "mine-1", "fixed text");

    expect(requests().find((r) => r.method === "message.edit")?.params).toEqual({
      chat_guid: DM_GUID,
      message_guid: "mine-1",
      text: "fixed text",
      backwards_compatibility_message: "Edited to: fixed text",
      part_index: 0,
    });
    await channel.stop();
  });

  it("edits via message.edit when only the macOS 26+ translation-aware selector is probed", async () => {
    // Ground truth for macOS 26/27: editMessageItem and editMessage are gone,
    // but editMessageItem:atPartIndex:withNewPartText:newPartTranslation:
    // backwardCompatabilityText: exists and imsg reports it as
    // editMessageItemTranslation (live-verified on macOS 27, imsg 0.15.9).
    const caps: ImsgCapabilities = {
      ...CAPS_FULL,
      selectors: { ...CAPS_FULL.selectors, editMessageItemTranslation: true },
    };
    const { channel, requests } = makeChannel({ caps });
    await channel.start();

    expect(channel.isEditSupported()).toBe(true);
    await channel.editMessage(DM_GUID, "mine-1", "fixed text");

    expect(requests().find((r) => r.method === "message.edit")?.params).toMatchObject({
      chat_guid: DM_GUID,
      message_guid: "mine-1",
      text: "fixed text",
    });
    await channel.stop();
  });

  it("rejects empty edited text without calling the API", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await expect(channel.editMessage(DM_GUID, "mine-1", "  ")).rejects.toThrow(/cannot be empty/i);
    expect(requests().map((r) => r.method)).not.toContain("message.edit");
    await channel.stop();
  });
});

// --- Group rename / typing ----------------------------------------------------

describe("imsg group rename and typing", () => {
  it("renames a group via group.rename", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await channel.setChatTitle(GROUP_GUID, "New Title");

    expect(requests().find((r) => r.method === "group.rename")?.params).toEqual({
      chat_guid: GROUP_GUID,
      name: "New Title",
    });
    await channel.stop();
  });

  it("starts typing over RPC and always stops it on cleanup", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    const stopTyping = channel.startTyping(DM_GUID);
    await settle();
    await stopTyping();
    await settle();

    const typing = requests().filter((r) => r.method === "typing");
    expect(typing.length).toBeGreaterThanOrEqual(2);
    expect(typing[0].params).toMatchObject({ chat_guid: DM_GUID, typing: true });
    expect(typing[typing.length - 1].params).toMatchObject({ chat_guid: DM_GUID, typing: false });
    await channel.stop();
  });

  it("degrades typing to a no-op when the bridge lacks typing indicators", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_BASIC });
    await channel.start();

    const stopTyping = channel.startTyping(DM_GUID);
    await settle();
    await stopTyping();

    expect(requests().map((r) => r.method)).not.toContain("typing");
    await channel.stop();
  });
});

// --- Mark read ------------------------------------------------------------------

describe("imsg mark-as-read", () => {
  it("marks the chat read after an inbound message when read receipts work", async () => {
    const { channel, children, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    channel.onMessage(vi.fn(async () => true));

    children[0].notifyMessage(inboundMessage());
    await settle();

    expect(requests().find((r) => r.method === "read")?.params).toEqual({ chat_guid: DM_GUID });
    await channel.stop();
  });

  it("skips the read call without the bridge", async () => {
    const { channel, children, requests } = makeChannel({ caps: CAPS_BASIC });
    await channel.start();
    channel.onMessage(vi.fn(async () => true));

    children[0].notifyMessage(inboundMessage());
    await settle();

    expect(requests().map((r) => r.method)).not.toContain("read");
    await channel.stop();
  });
});
