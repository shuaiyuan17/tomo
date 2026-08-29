import { describe, expect, it } from "vitest";
import {
  isGroupSessionKey,
  legacySessionKeysForBinding,
  matchesChannelBinding,
  rawSessionKeyForBinding,
  parseRawSessionKey,
  privateReplyTargetFromSessionKey,
  replyTargetFromRawSessionKey,
} from "../src/sessions/keys.js";

describe("session key helpers", () => {
  it("parses raw channel session keys", () => {
    expect(parseRawSessionKey("telegram:12345")).toEqual({
      channelName: "telegram",
      chatId: "12345",
    });
    expect(parseRawSessionKey("dm:shuai")).toBeUndefined();
    expect(parseRawSessionKey("not-a-session-key")).toBeUndefined();
  });

  it("detects provider group session keys", () => {
    expect(isGroupSessionKey("telegram:-100123")).toBe(true);
    expect(isGroupSessionKey("imessage:any;+;ABC123")).toBe(true);
    expect(isGroupSessionKey("telegram:12345")).toBe(false);
    expect(isGroupSessionKey("dm:shuai")).toBe(false);
  });

  it("returns private reply targets only for non-group raw sessions", () => {
    expect(privateReplyTargetFromSessionKey("telegram:12345")).toEqual({
      channelName: "telegram",
      chatId: "12345",
    });
    expect(privateReplyTargetFromSessionKey("telegram:-100123")).toBeUndefined();
    expect(privateReplyTargetFromSessionKey("imessage:any;+;ABC123")).toBeUndefined();
  });

  it("returns explicit raw targets including groups", () => {
    expect(replyTargetFromRawSessionKey("telegram:-100123")).toEqual({
      channelName: "telegram",
      chatId: "-100123",
    });
  });
});

describe("identity binding matchers", () => {
  it("matches exact chatIds on any channel and iMessage GUIDs by identifier", () => {
    expect(matchesChannelBinding("telegram", "111", "111")).toBe(true);
    expect(matchesChannelBinding("telegram", "222", "111")).toBe(false);
    expect(matchesChannelBinding("imessage", "any;-;+15551234567", "+15551234567")).toBe(true);
    expect(matchesChannelBinding("imessage", "iMessage;-;+15551234567", "+15551234567")).toBe(true);
    expect(matchesChannelBinding("imessage", "+15551234567", "+15551234567")).toBe(true);
    expect(matchesChannelBinding("imessage", "any;-;+15559999999", "+15551234567")).toBe(false);
    expect(matchesChannelBinding("imessage", "any;-;+15551234567", undefined)).toBe(false);
  });

  it("finds the legacy per-channel keys an identity binding would have routed to, excluding groups", () => {
    const keys = [
      "telegram:111",
      "telegram:-100999",
      "imessage:any;-;+15551234567",
      "imessage:any;+;groupguid",
      "imessage:any;-;+15550000000",
      "dm:someone",
    ];
    expect(legacySessionKeysForBinding(keys, "telegram", "111")).toEqual(["telegram:111"]);
    expect(legacySessionKeysForBinding(keys, "imessage", "+15551234567")).toEqual(["imessage:any;-;+15551234567"]);
    expect(legacySessionKeysForBinding(keys, "imessage", "+15557777777")).toEqual([]);
  });

  it("hands cron jobs back to the key inbound traffic actually uses, else the literal binding", () => {
    const entries = [
      { channelKey: "dm:shuai", migratedFrom: "imessage:any;-;+15551234567", replyTarget: { channelName: "imessage", chatId: "any;-;+15551234567" } },
      { channelKey: "telegram:111" },
      { channelKey: "imessage:any;+;groupguid", replyTarget: { channelName: "imessage", chatId: "any;+;groupguid" } },
    ];
    expect(rawSessionKeyForBinding("imessage", "+15551234567", entries)).toBe("imessage:any;-;+15551234567");
    expect(rawSessionKeyForBinding("telegram", "111", entries)).toBe("telegram:111");
    // No conversation seen yet: a chat GUID cannot be synthesised from a handle.
    expect(rawSessionKeyForBinding("imessage", "+15550000000", entries)).toBe("imessage:+15550000000");
  });
});
