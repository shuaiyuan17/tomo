import { describe, expect, it } from "vitest";
import {
  imessageHandlesMatch,
  isGroupSessionKey,
  normalizeImessageHandle,
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

describe("normalizeImessageHandle", () => {
  it.each([
    ["+1 (555) 555-0123", "+15555550123"],
    ["+1.555.555.0123", "+15555550123"],
    ["  +15555550123  ", "+15555550123"],
    ["15555550123", "+15555550123"],
    ["1 (555) 555-0123", "+15555550123"],
    // No "+" and not the NANP 11-digit shape: country unknown, kept bare.
    ["4695550123", "4695550123"],
    ["5555550123", "5555550123"],
    ["Alex@Example.COM", "alex@example.com"],
    ["iMessage;-;+15555550123", "+15555550123"],
    ["SMS;-;+1 555 555 0123", "+15555550123"],
    ["any;-;Alex@Example.com", "alex@example.com"],
    ["RCS;-;+15555550123", "+15555550123"],
    // Group GUIDs are not handles: untouched.
    ["any;+;chat0123456789", "any;+;chat0123456789"],
    // Not phone-shaped and not an email: left alone, never folded to digits.
    ["chat0123456789", "chat0123456789"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeImessageHandle(input)).toBe(expected);
  });

  it("never matches across countries: a bare number is not its +-prefixed twin (Sweden regression)", () => {
    // Binding "4695550123" must not admit Sweden's +46 95 550 123.
    expect(imessageHandlesMatch("4695550123", "+4695550123")).toBe(false);
    expect(imessageHandlesMatch("4695550123", "any;-;+4695550123")).toBe(false);
    expect(matchesChannelBinding("imessage", "any;-;+4695550123", "4695550123")).toBe(false);
    expect(imessageHandlesMatch("+4695550123", "SMS;-;+46 95 550 123")).toBe(true);
  });

  it("treats only the NANP 11-digit shape without + as E.164", () => {
    expect(imessageHandlesMatch("+15555550123", "15555550123")).toBe(true);
    expect(imessageHandlesMatch("+1 (555) 555-0123", "SMS;-;+15555550123")).toBe(true);
    // A 10-digit number is not silently widened to +1 (setup asks instead).
    expect(imessageHandlesMatch("5555550123", "+15555550123")).toBe(false);
    expect(imessageHandlesMatch("", "")).toBe(false);
  });
});

describe("identity binding matchers", () => {
  it("matches a bound iMessage handle despite formatting drift", () => {
    expect(matchesChannelBinding("imessage", "iMessage;-;+15555550123", "+1 (555) 555-0123")).toBe(true);
    expect(matchesChannelBinding("imessage", "any;-;alex@example.com", "Alex@Example.com")).toBe(true);
    expect(matchesChannelBinding("imessage", "+15555550123", "SMS;-;+15555550123")).toBe(true);
    expect(matchesChannelBinding("imessage", "any;-;+15555550124", "+1 (555) 555-0123")).toBe(false);
    expect(matchesChannelBinding("imessage", "any;-;+15555550123", "")).toBe(false);
  });

  it("matches exact chatIds on any channel and iMessage GUIDs by identifier", () => {
    expect(matchesChannelBinding("telegram", "111", "111")).toBe(true);
    expect(matchesChannelBinding("telegram", "222", "111")).toBe(false);
    expect(matchesChannelBinding("imessage", "any;-;+15551234567", "+15551234567")).toBe(true);
    expect(matchesChannelBinding("imessage", "iMessage;-;+15551234567", "+15551234567")).toBe(true);
    expect(matchesChannelBinding("imessage", "+15551234567", "+15551234567")).toBe(true);
    expect(matchesChannelBinding("imessage", "any;-;+15559999999", "+15551234567")).toBe(false);
    expect(matchesChannelBinding("imessage", "any;-;+15551234567", undefined)).toBe(false);
  });

  it("matches an iMessage binding given as a chat GUID against the bare sender handle (#393)", () => {
    // Owner checks (identityForSender) pass the provider's bare sender handle.
    expect(matchesChannelBinding("imessage", "+15551234567", "any;-;+15551234567")).toBe(true);
    expect(matchesChannelBinding("imessage", "iMessage;-;+15551234567", "any;-;+15551234567")).toBe(true);
    expect(matchesChannelBinding("imessage", "user@example.com", "iMessage;-;user@example.com")).toBe(true);
    expect(matchesChannelBinding("imessage", "+15559999999", "any;-;+15551234567")).toBe(false);
    // Group GUID bindings are never reduced: no cross-prefix or bare-id match.
    expect(matchesChannelBinding("imessage", "any;+;chat123", "iMessage;+;chat123")).toBe(false);
    expect(matchesChannelBinding("imessage", "chat123", "iMessage;+;chat123")).toBe(false);
    expect(matchesChannelBinding("imessage", "iMessage;+;chat123", "iMessage;+;chat123")).toBe(true);
    // A group chat GUID never matches a DM binding, whether GUID or bare handle.
    expect(matchesChannelBinding("imessage", "any;+;+15551234567", "any;-;+15551234567")).toBe(false);
    expect(matchesChannelBinding("imessage", "any;+;+15551234567", "+15551234567")).toBe(false);
    // Only iMessage canonicalises GUIDs.
    expect(matchesChannelBinding("telegram", "+15551234567", "any;-;+15551234567")).toBe(false);
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

  it("trusts the removed identity's own entries before another identity's leftovers", () => {
    // The binding once belonged to "old" (migrated from any;-;), was removed,
    // and was reused under "cur", whose unified session has been replying to
    // the GUID iMessage now reports for the same handle. Removing "cur" must
    // restore to cur's GUID, not old's.
    const entries = [
      { channelKey: "dm:old", migratedFrom: "imessage:any;-;+15551234567" },
      { channelKey: "dm:cur", replyTarget: { channelName: "imessage", chatId: "iMessage;-;+15551234567" } },
    ];
    expect(rawSessionKeyForBinding("imessage", "+15551234567", entries, "dm:cur")).toBe("imessage:iMessage;-;+15551234567");
    expect(rawSessionKeyForBinding("imessage", "+15551234567", entries, "dm:old")).toBe("imessage:any;-;+15551234567");
    // An owner with no evidence of its own still falls through to the rest —
    // where, as within the owner, a live reply target outranks provenance.
    expect(rawSessionKeyForBinding("imessage", "+15551234567", entries, "dm:new")).toBe("imessage:iMessage;-;+15551234567");
    // Retired copies of the owner key count as the owner's evidence too.
    const withRetired = [
      { channelKey: "dm:old", migratedFrom: "imessage:any;-;+15551234567" },
      { channelKey: "dm:cur", unlinkedAt: null },
      { channelKey: "dm:cur", unlinkedAt: 1, migratedFrom: "imessage:SMS;-;+15551234567" },
    ];
    expect(rawSessionKeyForBinding("imessage", "+15551234567", withRetired, "dm:cur")).toBe("imessage:SMS;-;+15551234567");
  });

  it("prefers the owner's live GUID-shaped reply target over where the session was migrated from", () => {
    // The session came in over SMS, was unified, and the conversation later
    // moved to iMessage: the router kept replyTarget current. Restoring to
    // the historical SMS GUID would split cron from the next inbound turn.
    const entries = [
      {
        channelKey: "dm:ivy",
        unlinkedAt: null,
        migratedFrom: "imessage:SMS;-;+15551234567",
        replyTarget: { channelName: "imessage", chatId: "iMessage;-;+15551234567" },
      },
    ];
    expect(rawSessionKeyForBinding("imessage", "+15551234567", entries, "dm:ivy")).toBe("imessage:iMessage;-;+15551234567");

    // The bare configured handle as reply target (a fixed iMessage policy)
    // is not a conversation and must not outrank provenance.
    const bareHandle = [{
      channelKey: "dm:ivy",
      unlinkedAt: null,
      migratedFrom: "imessage:SMS;-;+15551234567",
      replyTarget: { channelName: "imessage", chatId: "+15551234567" },
    }];
    expect(rawSessionKeyForBinding("imessage", "+15551234567", bareHandle, "dm:ivy")).toBe("imessage:SMS;-;+15551234567");

    // Active entry with no evidence: provenance, then a retired copy's live
    // target, in that order.
    const retiredOnly = [
      { channelKey: "dm:ivy", unlinkedAt: null },
      { channelKey: "dm:ivy", unlinkedAt: 1, replyTarget: { channelName: "imessage", chatId: "iMessage;-;+15551234567" } },
    ];
    expect(rawSessionKeyForBinding("imessage", "+15551234567", retiredOnly, "dm:ivy")).toBe("imessage:iMessage;-;+15551234567");
    const retiredBoth = [
      { channelKey: "dm:ivy", unlinkedAt: null },
      { channelKey: "dm:ivy", unlinkedAt: 1, migratedFrom: "imessage:SMS;-;+15551234567", replyTarget: { channelName: "imessage", chatId: "iMessage;-;+15551234567" } },
    ];
    expect(rawSessionKeyForBinding("imessage", "+15551234567", retiredBoth, "dm:ivy")).toBe("imessage:SMS;-;+15551234567");
  });
});
