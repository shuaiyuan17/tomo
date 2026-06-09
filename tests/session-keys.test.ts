import { describe, expect, it } from "vitest";
import {
  isGroupSessionKey,
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
