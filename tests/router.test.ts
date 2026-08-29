import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IdentityRouter } from "../src/router.js";
import { rawSessionKeyForBinding } from "../src/sessions/keys.js";
import { SessionStore } from "../src/sessions/store.js";
import { SummonStore } from "../src/sessions/summon-store.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-router");

describe("IdentityRouter", () => {
  let sessions: SessionStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    sessions = new SessionStore(TEST_DIR, 20, join(TEST_DIR, "sdk-sessions"));
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

    it("seeds a newly created allowlist with identity-bound chatIds", () => {
      const router = new IdentityRouter(
        [{ name: "alice", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      // Channel starts open; the first add flips it to enforced but must not
      // lock out the identity's own DM.
      expect(router.isAllowed("telegram", "999")).toBe(true);
      router.addToAllowlist("telegram", "-100group");
      expect(router.isAllowed("telegram", "-100group")).toBe(true);
      expect(router.isAllowed("telegram", "111")).toBe(true);
      expect(router.isAllowed("telegram", "999")).toBe(false);
    });
  });

  describe("hasAllowlist", () => {
    it("reports whether a channel enforces an allowlist", () => {
      const router = new IdentityRouter([], sessions, { telegram: ["123"] });
      expect(router.hasAllowlist("telegram")).toBe(true);
      expect(router.hasAllowlist("imessage")).toBe(false);
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

  describe("summon", () => {
    const identities = [
      { name: "Alice", channels: { telegram: "111" }, replyPolicy: "last-active" },
    ];

    it("routes a summoned group to the dm: session with the PRIVATE dm reply target", () => {
      const router = new IdentityRouter(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");

      const result = router.resolve("telegram", "-987", true);
      expect(result.sessionKey).toBe("dm:alice");
      // Direct turn output goes to the owner's DM; group replies happen only
      // via an explicit send_message tool call.
      expect(result.replyTarget).toEqual({ channelName: "telegram", chatId: "111" });
      expect(result.identityName).toBe("alice");
    });

    it("prefers the dm session's persisted reply target over the config-derived one", () => {
      sessions.setSdkSessionId("dm:alice", "session-alice");
      sessions.setReplyTarget("dm:alice", { channelName: "imessage", chatId: "+15551234567" });

      const router = new IdentityRouter(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");

      const result = router.resolve("telegram", "-987", true);
      expect(result.replyTarget).toEqual({ channelName: "imessage", chatId: "+15551234567" });
    });

    it("expires after the configured group inactivity and notifies via callback", () => {
      const summons = new SummonStore(null, 1000);
      const router = new IdentityRouter(identities, sessions, {}, summons);
      const expired: string[] = [];
      router.onSummonExpired = (ch, chatId, identity, notifyGroup) =>
        expired.push(`${ch}:${chatId}:${identity}:${notifyGroup}`);

      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        router.summonGroup("telegram", "-987", "Alice");

        vi.setSystemTime(1_000_500);
        expect(router.resolve("telegram", "-987", true).sessionKey).toBe("dm:alice");

        // Activity above reset the clock; expiry counts from last activity
        vi.setSystemTime(1_001_600);
        const result = router.resolve("telegram", "-987", true);
        expect(result.sessionKey).toBe("telegram:-987");
        // Routing path: notify the group as well as the dm session
        expect(expired).toEqual(["telegram:-987:alice:true"]);
        expect(router.getSummonedIdentity("telegram", "-987")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("migrates an old channel-scoped session when summon is the first dm: interaction", () => {
      // Upgraded user: session still lives under the old channel-scoped key
      sessions.setSdkSessionId("telegram:111", "old-session");
      sessions.setReplyTarget("telegram:111", { channelName: "telegram", chatId: "111" });

      const router = new IdentityRouter(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");

      const result = router.resolve("telegram", "-987", true);
      expect(result.sessionKey).toBe("dm:alice");
      // The summon must resume the real main session, not capture a fresh one
      expect(sessions.getSdkSessionId("dm:alice")).toBe("old-session");
      expect(sessions.getSdkSessionId("telegram:111")).toBeUndefined();
    });

    it("clears the dm session on a guard read but suppresses the group notice", () => {
      const summons = new SummonStore(null, 1000);
      const router = new IdentityRouter(identities, sessions, {}, summons);
      const expired: string[] = [];
      router.onSummonExpired = (ch, chatId, identity, notifyGroup) =>
        expired.push(`${ch}:${chatId}:${identity}:${notifyGroup}`);

      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        router.summonGroup("telegram", "-987", "Alice");

        // Past the inactivity window — a re-summon's "already summoned?" guard
        // (getSummonedIdentity) still fires the callback so the dm session's
        // stale "summoned" context is cleared, but with notifyGroup=false so
        // the group never sees a spurious "expired — handed back" message.
        vi.setSystemTime(1_001_001);
        expect(router.getSummonedIdentity("telegram", "-987")).toBeUndefined();
        expect(expired).toEqual(["telegram:-987:alice:false"]);

        // And the entry is gone, so a fresh summon proceeds cleanly.
        router.summonGroup("telegram", "-987", "Alice");
        expect(router.getSummonedIdentity("telegram", "-987")).toBe("alice");
        expect(expired).toEqual(["telegram:-987:alice:false"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not persist the group as the dm session's reply target", () => {
      sessions.setSdkSessionId("dm:alice", "session-alice");
      sessions.setReplyTarget("dm:alice", { channelName: "telegram", chatId: "111" });

      const router = new IdentityRouter(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");
      router.resolve("telegram", "-987", true);

      // Cron/continuity must still deliver to the private DM
      expect(router.getReplyTarget("dm:alice")).toEqual({ channelName: "telegram", chatId: "111" });
    });

    it("does not affect other groups or DMs", () => {
      const router = new IdentityRouter(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");

      expect(router.resolve("telegram", "-555", true).sessionKey).toBe("telegram:-555");
      expect(router.resolve("telegram", "111", false).sessionKey).toBe("dm:alice");
    });

    it("dismiss restores group routing", () => {
      const router = new IdentityRouter(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");
      expect(router.dismissGroup("telegram", "-987")).toBe(true);

      const result = router.resolve("telegram", "-987", true);
      expect(result.sessionKey).toBe("telegram:-987");
      expect(router.getSummonedIdentity("telegram", "-987")).toBeUndefined();
    });

    it("drops a stale summon when no private reply target exists for the identity", () => {
      const router = new IdentityRouter(identities, sessions, {});
      // Simulates a summons.json written before the identity was renamed/removed
      router.summonGroup("telegram", "-987", "Ghost");

      const result = router.resolve("telegram", "-987", true);
      // Must NOT route dm output to the group — the summon is dropped instead
      expect(result.sessionKey).toBe("telegram:-987");
      expect(result.replyTarget).toEqual({ channelName: "telegram", chatId: "-987" });
      expect(router.getSummonedIdentity("telegram", "-987")).toBeUndefined();
    });

    it("dismiss on a non-summoned group returns false", () => {
      const router = new IdentityRouter(identities, sessions, {});
      expect(router.dismissGroup("telegram", "-987")).toBe(false);
    });

    it("identityForSender matches provider-verified sender ids", () => {
      const router = new IdentityRouter(identities, sessions, {});
      expect(router.identityForSender("telegram", "111")?.name).toBe("Alice");
      expect(router.identityForSender("telegram", "222")).toBeUndefined();
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

    it("migrates a GUID-keyed iMessage session bound by bare handle", () => {
      // Inbound iMessage sessions are keyed by chat GUID, while the identity
      // binds the bare handle — the two never compare equal as strings.
      sessions.setSdkSessionId("imessage:any;-;+15551234567", "session-imsg");
      sessions.setSdkSessionId("imessage:any;+;groupguid", "session-group");

      const router = new IdentityRouter(
        [{ name: "Ivy", channels: { imessage: "+15551234567" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );

      const result = router.resolve("imessage", "any;-;+15551234567", false);
      expect(result.sessionKey).toBe("dm:ivy");
      expect(sessions.getSdkSessionId("dm:ivy")).toBe("session-imsg");
      expect(sessions.getSdkSessionId("imessage:any;-;+15551234567")).toBeUndefined();
      // Groups are never migration candidates.
      expect(sessions.getSdkSessionId("imessage:any;+;groupguid")).toBe("session-group");
    });

    it("can hand cron jobs back to the GUID-keyed iMessage session after the raw GUID → dm: lifecycle", () => {
      // Raw GUID-keyed session → identity added → one-candidate migration
      // re-keys it in place (no raw entry survives) → identity removed. The
      // restore key must be the GUID the next inbound iMessage turn will use.
      sessions.setSdkSessionId("imessage:any;-;+15551234567", "session-imsg");
      const identity = { name: "Ivy", channels: { imessage: "+15551234567" }, replyPolicy: "last-active" };
      const router = new IdentityRouter([identity], sessions, {});
      router.resolve("imessage", "any;-;+15551234567", false);
      expect(sessions.getEntry("imessage:any;-;+15551234567")).toBeUndefined();

      expect(rawSessionKeyForBinding("imessage", "+15551234567", sessions.listAllSessions()))
        .toBe("imessage:any;-;+15551234567");
    });

    it("follows the conversation to its current GUID when it moved after migration (SMS → iMessage)", () => {
      sessions.setSdkSessionId("imessage:SMS;-;+15551234567", "session-sms");
      const identity = { name: "Ivy", channels: { imessage: "+15551234567" }, replyPolicy: "last-active" };
      const router = new IdentityRouter([identity], sessions, {});
      router.resolve("imessage", "SMS;-;+15551234567", false);
      // The contact turned on iMessage; the same handle now arrives under a
      // different chat GUID and the router keeps the reply target current.
      router.resolve("imessage", "iMessage;-;+15551234567", false);

      expect(sessions.getEntry("dm:ivy")?.migratedFrom).toBe("imessage:SMS;-;+15551234567");
      expect(rawSessionKeyForBinding("imessage", "+15551234567", sessions.listAllSessions(), "dm:ivy"))
        .toBe("imessage:iMessage;-;+15551234567");
    });

    it("recovers the iMessage restore key from the persisted reply target when nothing was migrated", () => {
      // The dm: session was born unified (identity configured before the
      // first message): no migratedFrom, but resolve() persisted the GUID the
      // router last replied to.
      const identity = { name: "Jo", channels: { imessage: "+15551234567" }, replyPolicy: "last-active" };
      const router = new IdentityRouter([identity], sessions, {});
      router.resolve("imessage", "iMessage;-;+15551234567", false);
      sessions.setSdkSessionId("dm:jo", "session-jo");

      expect(rawSessionKeyForBinding("imessage", "+15551234567", sessions.listAllSessions()))
        .toBe("imessage:iMessage;-;+15551234567");
    });

    it("prefers the migrated-from key over an unchosen, unlinked raw candidate", () => {
      sessions.setSdkSessionId("imessage:any;-;+15551234567", "session-chosen");
      sessions.setSdkSessionId("imessage:SMS;-;+15551234567", "session-other");
      // `tomo config` picked the first and unlinked the second.
      sessions.migrateSessionKey("imessage:any;-;+15551234567", "dm:kim");
      sessions.clearSdkSessionId("imessage:SMS;-;+15551234567");

      expect(rawSessionKeyForBinding("imessage", "+15551234567", sessions.listAllSessions()))
        .toBe("imessage:any;-;+15551234567");
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
