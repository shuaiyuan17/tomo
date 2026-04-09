import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IdentityRouter } from "../src/router.js";
import { SessionStore } from "../src/sessions/store.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-router");

describe("IdentityRouter", () => {
  let sessions: SessionStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    sessions = new SessionStore(TEST_DIR, 20);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("isAllowed", () => {
    it("allows any chatId when no allowlist is configured", () => {
      const router = new IdentityRouter([], sessions, {});
      expect(router.isAllowed("telegram", "999")).toBe(true);
    });

    it("allows chatIds in the explicit allowlist", () => {
      const router = new IdentityRouter([], sessions, {
        telegram: ["123", "456"],
      });
      expect(router.isAllowed("telegram", "123")).toBe(true);
      expect(router.isAllowed("telegram", "456")).toBe(true);
      expect(router.isAllowed("telegram", "789")).toBe(false);
    });

    it("allows identity-bound chatIds automatically", () => {
      const router = new IdentityRouter(
        [{ name: "alice", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        { telegram: [] },
      );
      expect(router.isAllowed("telegram", "111")).toBe(true);
      expect(router.isAllowed("telegram", "222")).toBe(false);
    });

    it("matches iMessage identifiers by suffix", () => {
      const router = new IdentityRouter([], sessions, {
        imessage: ["+15551234567"],
      });
      expect(router.isAllowed("imessage", "iMessage;-;+15551234567")).toBe(true);
      expect(router.isAllowed("imessage", "iMessage;-;+15559999999")).toBe(false);
    });

    it("allows unknown channels (no allowlist = open)", () => {
      const router = new IdentityRouter([], sessions, { telegram: ["123"] });
      expect(router.isAllowed("discord", "anyone")).toBe(true);
    });
  });

  describe("addToAllowlist", () => {
    it("adds a chatId to an existing allowlist", () => {
      const router = new IdentityRouter([], sessions, { telegram: ["123"] });
      expect(router.isAllowed("telegram", "999")).toBe(false);

      router.addToAllowlist("telegram", "999");
      expect(router.isAllowed("telegram", "999")).toBe(true);
    });

    it("creates a new allowlist for an unknown channel", () => {
      const router = new IdentityRouter([], sessions, {});
      router.addToAllowlist("discord", "abc");
      expect(router.isAllowed("discord", "abc")).toBe(true);
      expect(router.isAllowed("discord", "xyz")).toBe(false);
    });
  });

  describe("resolve", () => {
    it("returns channel-scoped key for group chats", () => {
      const router = new IdentityRouter(
        [{ name: "alice", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      const result = router.resolve("telegram", "group-chat-123", true);
      expect(result.sessionKey).toBe("telegram:group-chat-123");
      expect(result.replyTarget).toEqual({ channelName: "telegram", chatId: "group-chat-123" });
      expect(result.identityName).toBeUndefined();
    });

    it("returns channel-scoped key for unknown users (no identity)", () => {
      const router = new IdentityRouter([], sessions, {});
      const result = router.resolve("telegram", "unknown-user", false);
      expect(result.sessionKey).toBe("telegram:unknown-user");
      expect(result.replyTarget).toEqual({ channelName: "telegram", chatId: "unknown-user" });
    });

    it("returns unified dm: key for identity-bound users", () => {
      const router = new IdentityRouter(
        [{ name: "Alice", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      const result = router.resolve("telegram", "111", false);
      expect(result.sessionKey).toBe("dm:alice");
      expect(result.identityName).toBe("Alice");
    });

    it("routes reply to current channel with last-active policy", () => {
      const router = new IdentityRouter(
        [{
          name: "Bob",
          channels: { telegram: "111", imessage: "+15551234567" },
          replyPolicy: "last-active",
        }],
        sessions,
        {},
      );

      // Message from Telegram
      const r1 = router.resolve("telegram", "111", false);
      expect(r1.replyTarget).toEqual({ channelName: "telegram", chatId: "111" });

      // Same user from iMessage → reply target updates
      const r2 = router.resolve("imessage", "+15551234567", false);
      expect(r2.sessionKey).toBe("dm:bob");
      expect(r2.replyTarget).toEqual({ channelName: "imessage", chatId: "+15551234567" });
    });

    it("routes reply to fixed channel with fixed policy", () => {
      const router = new IdentityRouter(
        [{
          name: "Carol",
          channels: { telegram: "111", imessage: "+15551234567" },
          replyPolicy: "telegram",
        }],
        sessions,
        {},
      );

      // Even when message comes from iMessage, reply goes to Telegram
      const result = router.resolve("imessage", "+15551234567", false);
      expect(result.sessionKey).toBe("dm:carol");
      expect(result.replyTarget).toEqual({ channelName: "telegram", chatId: "111" });
    });

    it("falls back to current channel if fixed policy target is invalid", () => {
      const router = new IdentityRouter(
        [{
          name: "Dave",
          channels: { telegram: "111" },
          replyPolicy: "discord", // channel not configured
        }],
        sessions,
        {},
      );

      const result = router.resolve("telegram", "111", false);
      expect(result.replyTarget).toEqual({ channelName: "telegram", chatId: "111" });
    });

    it("matches iMessage chatGuid to identity by identifier extraction", () => {
      const router = new IdentityRouter(
        [{
          name: "Eve",
          channels: { imessage: "+15551234567" },
          replyPolicy: "last-active",
        }],
        sessions,
        {},
      );

      const result = router.resolve("imessage", "iMessage;-;+15551234567", false);
      expect(result.sessionKey).toBe("dm:eve");
      expect(result.identityName).toBe("Eve");
    });
  });

  describe("session migration", () => {
    it("migrates old channel-scoped session to unified dm: key", () => {
      // Simulate an existing session under the old key
      sessions.setSdkSessionId("telegram:111", "session-old");

      const router = new IdentityRouter(
        [{ name: "Frank", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );

      const result = router.resolve("telegram", "111", false);
      expect(result.sessionKey).toBe("dm:frank");

      // Old key should be unlinked, new key should have the session
      expect(sessions.getSdkSessionId("dm:frank")).toBe("session-old");
      expect(sessions.getSdkSessionId("telegram:111")).toBeUndefined();
    });

    it("does not migrate if unified key already has a session", () => {
      sessions.setSdkSessionId("dm:grace", "session-unified");
      sessions.setSdkSessionId("telegram:111", "session-old");

      const router = new IdentityRouter(
        [{ name: "Grace", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );

      router.resolve("telegram", "111", false);

      // Both should remain — no migration occurred
      expect(sessions.getSdkSessionId("dm:grace")).toBe("session-unified");
    });
  });

  describe("getReplyTarget", () => {
    it("returns undefined for unknown session", () => {
      const router = new IdentityRouter([], sessions, {});
      expect(router.getReplyTarget("nonexistent")).toBeUndefined();
    });

    it("returns persisted reply target after resolve", () => {
      // setReplyTarget only updates an existing session entry, so create one first
      sessions.setSdkSessionId("dm:hank", "session-hank");

      const router = new IdentityRouter(
        [{ name: "Hank", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );

      router.resolve("telegram", "111", false);
      const target = router.getReplyTarget("dm:hank");
      expect(target).toEqual({ channelName: "telegram", chatId: "111" });
    });
  });

  describe("findFirstDmSession", () => {
    it("returns undefined when no dm sessions exist", () => {
      const router = new IdentityRouter([], sessions, {});
      expect(router.findFirstDmSession()).toBeUndefined();
    });

    it("returns the first dm: session key", () => {
      sessions.setSdkSessionId("dm:alice", "session-1");
      sessions.setSdkSessionId("telegram:999", "session-2");

      const router = new IdentityRouter([], sessions, {});
      expect(router.findFirstDmSession()).toBe("dm:alice");
    });
  });
});
