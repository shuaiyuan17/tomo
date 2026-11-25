import { describe, expect, it } from "vitest";
import { normalizeSendTarget } from "../src/agent/send-target.js";

describe("normalizeSendTarget", () => {
  const owner = { name: "Alex", displayName: "Alexandra", telegram: ["12345"], imessage: ["+15551234567"] };

  it("returns the owner's lowercase dm: key for the owner's name, display name or \"owner\", in any casing", () => {
    // Regression for the duplicate-session bug: a caller using the name
    // verbatim from config ("Alex") used to spawn dm:Alex, parallel to the
    // dm:alex built by the inbound path (router.ts lowercases).
    for (const name of ["Alex", "alex", "ALEX", "Alexandra", "owner", "Owner"]) {
      expect(normalizeSendTarget(name, owner)).toEqual({ sessionKey: "dm:alex", identityName: "Alex" });
    }
  });

  it("returns null for any other bare name, and for any bare name with no owner", () => {
    expect(normalizeSendTarget("Eve", owner)).toBeNull();
    expect(normalizeSendTarget("owner", undefined)).toBeNull();
  });

  it("lowercases the name part of a dm: session key", () => {
    expect(normalizeSendTarget("dm:Alex", owner)).toEqual({ sessionKey: "dm:alex" });
    expect(normalizeSendTarget("dm:ALEX", owner)).toEqual({ sessionKey: "dm:alex" });
  });

  it("does not validate dm: keys against the owner (cron / fallback paths may reference former identities)", () => {
    expect(normalizeSendTarget("dm:eve", owner)).toEqual({ sessionKey: "dm:eve" });
  });

  it("returns channel keys unchanged (case preserved for chatId hashes)", () => {
    expect(normalizeSendTarget("imessage:any;+;ABC123DEF", owner)).toEqual({ sessionKey: "imessage:any;+;ABC123DEF" });
    expect(normalizeSendTarget("telegram:-1001234567", owner)).toEqual({ sessionKey: "telegram:-1001234567" });
  });

  it("canonicalizes a raw channel key that is one of the owner's DM handles (#203)", () => {
    expect(normalizeSendTarget("telegram:12345", owner)).toEqual({
      sessionKey: "dm:alex",
      identityName: "Alex",
      rawReplyTarget: { channelName: "telegram", chatId: "12345" },
    });
    expect(normalizeSendTarget("imessage:iMessage;-;+15551234567", owner)).toEqual({
      sessionKey: "dm:alex",
      identityName: "Alex",
      rawReplyTarget: { channelName: "imessage", chatId: "iMessage;-;+15551234567" },
    });
    // Formatting drift still canonicalizes.
    expect(normalizeSendTarget("imessage:SMS;-;+1 (555) 123-4567", owner)?.sessionKey).toBe("dm:alex");
    // Group GUIDs (";+;") never canonicalize, even if the identifier collided.
    expect(normalizeSendTarget("imessage:iMessage;+;+15551234567", owner)).toEqual({
      sessionKey: "imessage:iMessage;+;+15551234567",
    });
  });

  it("leaves other chats and groups raw", () => {
    expect(normalizeSendTarget("telegram:99999", owner)).toEqual({ sessionKey: "telegram:99999" });
    expect(normalizeSendTarget("imessage:12345", owner)).toEqual({ sessionKey: "imessage:12345" });
    expect(normalizeSendTarget("telegram:-1001234567", owner)).toEqual({ sessionKey: "telegram:-1001234567" });
  });
});
