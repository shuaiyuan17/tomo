import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OwnerRouter } from "../src/router.js";
import { resolveOwner, type LegacyIdentity } from "../src/owner.js";
import { rawSessionKeyForBinding } from "../src/sessions/keys.js";
import { SessionStore } from "../src/sessions/store.js";
import { SummonStore } from "../src/sessions/summon-store.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-router");

/** Build the router the way the daemon does for a legacy `identities` config:
 *  through the production owner resolver. */
function routerOf(
  identities: LegacyIdentity[],
  store: SessionStore,
  allowlists: Record<string, string[]>,
  summons?: SummonStore,
  webOwnerIdentity?: string,
): OwnerRouter {
  return new OwnerRouter(resolveOwner({ owner: undefined, identities, webOwnerIdentity }).owner, store, allowlists, summons);
}

describe("OwnerRouter", () => {
  let sessions: SessionStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    sessions = new SessionStore(TEST_DIR, 20, join(TEST_DIR, "sdk-sessions"));
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("isAllowed", () => {
    it("refuses any DM when no allowlist and no identity is configured (fails closed)", () => {
      const router = routerOf([], sessions, {});
      expect(router.isAllowed("telegram", "999")).toBe(false);
      expect(router.isAllowed("imessage", "any;-;+15555550123")).toBe(false);
    });

    it("refuses groups on a channel with no allowlist until one is activated", () => {
      const router = routerOf(
        [{ name: "alice", channels: { telegram: "111", imessage: "+15555550123" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      expect(router.isAllowed("telegram", "-100123")).toBe(false);
      expect(router.isAllowed("imessage", "any;+;chat0123456789")).toBe(false);
      router.addToAllowlist("imessage", "any;+;chat0123456789");
      expect(router.isAllowed("imessage", "any;+;chat0123456789")).toBe(true);
    });

    it("iMessage with no allowlist: only the bound owner handle is admitted, in any GUID form", () => {
      // The fresh-setup hole: `tomo config` → Enable iMessage wrote no
      // allowlist, and an open channel let ANY sender in with owner-grade tools.
      const router = routerOf(
        [{ name: "alice", channels: { telegram: "111", imessage: "+15555550123" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      expect(router.isAllowed("imessage", "any;-;+15559999999")).toBe(false);
      expect(router.isAllowed("imessage", "iMessage;-;+15555550123")).toBe(true);
      expect(router.isAllowed("imessage", "SMS;-;+15555550123")).toBe(true);
      expect(router.isAllowed("imessage", "any;-;+15555550123")).toBe(true);
    });

    it("iMessage identity bound to Telegram only: an unknown iMessage DM is refused", () => {
      const router = routerOf(
        [{ name: "alice", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      expect(router.isAllowed("imessage", "any;-;+15559999999")).toBe(false);
      expect(router.isAllowed("telegram", "111")).toBe(true);
      expect(router.isAllowed("telegram", "222")).toBe(false);
    });

    it("matches a bound handle despite formatting drift", () => {
      const router = routerOf(
        [{ name: "alice", channels: { imessage: "+1 (555) 555-0123" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      expect(router.isAllowed("imessage", "iMessage;-;+15555550123")).toBe(true);
      const byEmail = routerOf(
        [{ name: "alice", channels: { imessage: "Alice@Example.COM" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      expect(byEmail.isAllowed("imessage", "any;-;alice@example.com")).toBe(true);
      expect(byEmail.isAllowed("imessage", "any;-;bob@example.com")).toBe(false);
    });

    it("allowlists govern groups only: DM entries in them are ignored (no guest DMs)", () => {
      const router = routerOf([], sessions, {
        telegram: ["123", "-100456"],
      });
      expect(router.isAllowed("telegram", "123")).toBe(false);
      expect(router.isAllowed("telegram", "-100456")).toBe(true);
      expect(router.isAllowed("telegram", "-100789")).toBe(false);
    });

    it("allows identity-bound chatIds automatically", () => {
      const router = routerOf(
        [{ name: "alice", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        { telegram: [] },
      );
      expect(router.isAllowed("telegram", "111")).toBe(true);
      expect(router.isAllowed("telegram", "222")).toBe(false);
    });

    it("matches iMessage group identifiers under any service prefix; DM handles in the allowlist are ignored", () => {
      const router = routerOf([], sessions, {
        imessage: ["+15551234567", "chat0123456789"],
      });
      expect(router.isAllowed("imessage", "iMessage;-;+15551234567")).toBe(false);
      expect(router.isAllowed("imessage", "any;+;chat0123456789")).toBe(true);
      expect(router.isAllowed("imessage", "iMessage;+;chat0123456789")).toBe(true);
      expect(router.isAllowed("imessage", "any;+;chat9999")).toBe(false);
    });

    it("refuses DMs on a channel it knows nothing about (no allowlist is not open)", () => {
      const router = routerOf([], sessions, { telegram: ["123"] });
      expect(router.isAllowed("discord", "anyone")).toBe(false);
    });
  });

  describe("addToAllowlist", () => {
    it("adds a group to an existing allowlist", () => {
      const router = routerOf([], sessions, { telegram: ["-100123"] });
      expect(router.isAllowed("telegram", "-100999")).toBe(false);

      router.addToAllowlist("telegram", "-100999");
      expect(router.isAllowed("telegram", "-100999")).toBe(true);
    });

    it("creates a new allowlist for a channel that had none", () => {
      const router = routerOf([], sessions, {});
      router.addToAllowlist("imessage", "any;+;chatabc");
      expect(router.isAllowed("imessage", "any;+;chatabc")).toBe(true);
      expect(router.isAllowed("imessage", "any;+;chatxyz")).toBe(false);
    });

    it("creating a channel's first allowlist (group activation) never locks out the identity's DM", () => {
      const router = routerOf(
        [{ name: "alice", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      expect(router.isAllowed("telegram", "999")).toBe(false);
      expect(router.isAllowed("telegram", "111")).toBe(true);
      router.addToAllowlist("telegram", "-100group");
      expect(router.isAllowed("telegram", "-100group")).toBe(true);
      expect(router.isAllowed("telegram", "111")).toBe(true);
      expect(router.isAllowed("telegram", "999")).toBe(false);
    });
  });

  describe("hasAllowlist", () => {
    it("reports whether a channel enforces an allowlist", () => {
      const router = routerOf([], sessions, { telegram: ["123"] });
      expect(router.hasAllowlist("telegram")).toBe(true);
      expect(router.hasAllowlist("imessage")).toBe(false);
    });
  });

  describe("resolve", () => {
    it("returns channel-scoped key for group chats", () => {
      const router = routerOf(
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
      const router = routerOf([], sessions, {});
      const result = router.resolve("telegram", "unknown-user", false);
      expect(result.sessionKey).toBe("telegram:unknown-user");
      expect(result.replyTarget).toEqual({ channelName: "telegram", chatId: "unknown-user" });
    });

    it("returns unified dm: key for identity-bound users", () => {
      const router = routerOf(
        [{ name: "Alice", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      const result = router.resolve("telegram", "111", false);
      expect(result.sessionKey).toBe("dm:alice");
      expect(result.identityName).toBe("Alice");
    });

    it("routes reply to current channel with last-active policy", () => {
      const router = routerOf(
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

    it("ignores a legacy fixed replyPolicy: replies always follow the last-active channel", () => {
      const router = routerOf(
        [{
          name: "Carol",
          channels: { telegram: "111", imessage: "+15551234567" },
          replyPolicy: "telegram",
        }],
        sessions,
        {},
      );

      const result = router.resolve("imessage", "+15551234567", false);
      expect(result.sessionKey).toBe("dm:carol");
      expect(result.replyTarget).toEqual({ channelName: "imessage", chatId: "+15551234567" });
    });

    it("matches iMessage chatGuid to identity by identifier extraction", () => {
      const router = routerOf(
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
      const router = routerOf(identities, sessions, {});
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

      const router = routerOf(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");

      const result = router.resolve("telegram", "-987", true);
      expect(result.replyTarget).toEqual({ channelName: "imessage", chatId: "+15551234567" });
    });

    it("expires after the configured group inactivity and notifies via callback", () => {
      const summons = new SummonStore(null, 1000);
      const router = routerOf(identities, sessions, {}, summons);
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

      const router = routerOf(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");

      const result = router.resolve("telegram", "-987", true);
      expect(result.sessionKey).toBe("dm:alice");
      // The summon must resume the real main session, not capture a fresh one
      expect(sessions.getSdkSessionId("dm:alice")).toBe("old-session");
      expect(sessions.getSdkSessionId("telegram:111")).toBeUndefined();
    });

    it("clears the dm session on a guard read but suppresses the group notice", () => {
      const summons = new SummonStore(null, 1000);
      const router = routerOf(identities, sessions, {}, summons);
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

      const router = routerOf(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");
      router.resolve("telegram", "-987", true);

      // Cron/continuity must still deliver to the private DM
      expect(router.getReplyTarget("dm:alice")).toEqual({ channelName: "telegram", chatId: "111" });
    });

    it("does not affect other groups or DMs", () => {
      const router = routerOf(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");

      expect(router.resolve("telegram", "-555", true).sessionKey).toBe("telegram:-555");
      expect(router.resolve("telegram", "111", false).sessionKey).toBe("dm:alice");
    });

    it("dismiss restores group routing", () => {
      const router = routerOf(identities, sessions, {});
      router.summonGroup("telegram", "-987", "Alice");
      expect(router.dismissGroup("telegram", "-987")).toBe(true);

      const result = router.resolve("telegram", "-987", true);
      expect(result.sessionKey).toBe("telegram:-987");
      expect(router.getSummonedIdentity("telegram", "-987")).toBeUndefined();
    });

    it("drops a stale summon that names someone who is no longer the owner", () => {
      // A summons.json written while another identity was configured.
      const summons = new SummonStore(null);
      summons.set("telegram:-987", "ghost");
      const router = routerOf(identities, sessions, {}, summons);

      const result = router.resolve("telegram", "-987", true);
      // Must NOT route dm output to the group — the summon is dropped instead
      expect(result.sessionKey).toBe("telegram:-987");
      expect(result.replyTarget).toEqual({ channelName: "telegram", chatId: "-987" });
      expect(router.getSummonedIdentity("telegram", "-987")).toBeUndefined();
    });

    it("dismiss on a non-summoned group returns false", () => {
      const router = routerOf(identities, sessions, {});
      expect(router.dismissGroup("telegram", "-987")).toBe(false);
    });

    it("isOwnerSender matches provider-verified sender ids and fails closed", () => {
      const router = routerOf(identities, sessions, {});
      expect(router.isOwnerSender("telegram", "111")).toBe(true);
      expect(router.isOwnerSender("telegram", "222")).toBe(false);
      expect(router.isOwnerSender("telegram", undefined)).toBe(false);
      expect(routerOf([], sessions, {}).isOwnerSender("telegram", "111")).toBe(false);
    });

    it("isOwnerSender resolves an iMessage owner bound to a DM chat GUID (#393)", () => {
      const router = routerOf(
        [{ name: "Gina", channels: { imessage: "any;-;+15551234567" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      // Routing sees the chat GUID; owner checks see the bare sender handle.
      expect(router.resolve("imessage", "any;-;+15551234567", false).sessionKey).toBe("dm:gina");
      expect(router.isOwnerSender("imessage", "+15551234567")).toBe(true);
      expect(router.isOwnerSender("imessage", "+15559999999")).toBe(false);
    });
  });

  describe("session migration", () => {
    it("migrates old channel-scoped session to unified dm: key", () => {
      // Simulate an existing session under the old key
      sessions.setSdkSessionId("telegram:111", "session-old");

      const router = routerOf(
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

      const router = routerOf(
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
      const router = routerOf([identity], sessions, {});
      router.resolve("imessage", "any;-;+15551234567", false);
      expect(sessions.getEntry("imessage:any;-;+15551234567")).toBeUndefined();

      expect(rawSessionKeyForBinding("imessage", "+15551234567", sessions.listAllSessions()))
        .toBe("imessage:any;-;+15551234567");
    });

    it("follows the conversation to its current GUID when it moved after migration (SMS → iMessage)", () => {
      sessions.setSdkSessionId("imessage:SMS;-;+15551234567", "session-sms");
      const identity = { name: "Ivy", channels: { imessage: "+15551234567" }, replyPolicy: "last-active" };
      const router = routerOf([identity], sessions, {});
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
      const router = routerOf([identity], sessions, {});
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

    it("routes to the legacy key, without throwing, while the registry cannot be read — then migrates", () => {
      // The migration is a link change and refuses while the registry file is
      // unreadable. That refusal used to escape resolve() on the inbound path
      // and lose the message. Now the message goes to the session it has
      // always had, and the migration happens on the next readable message.
      sessions.setSdkSessionId("telegram:111", "session-old");
      const registry = join(TEST_DIR, "_sessions.json");
      const good = readFileSync(registry, "utf-8");
      writeFileSync(registry, good.slice(0, Math.floor(good.length / 2)));

      const router = routerOf(
        [{ name: "Frank", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );
      let result: ReturnType<typeof router.resolve> | undefined;
      expect(() => { result = router.resolve("telegram", "111", false); }).not.toThrow();
      expect(result!.sessionKey).toBe("telegram:111");
      expect(readFileSync(registry, "utf-8")).toBe(good.slice(0, Math.floor(good.length / 2)));   // untouched

      writeFileSync(registry, good);
      expect(router.resolve("telegram", "111", false).sessionKey).toBe("dm:frank");
      expect(sessions.getSdkSessionId("dm:frank")).toBe("session-old");
      expect(sessions.getSdkSessionId("telegram:111")).toBeUndefined();
    });

    it("does not migrate if unified key already has a session", () => {
      sessions.setSdkSessionId("dm:grace", "session-unified");
      sessions.setSdkSessionId("telegram:111", "session-old");

      const router = routerOf(
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
      const router = routerOf([], sessions, {});
      expect(router.getReplyTarget("nonexistent")).toBeUndefined();
    });

    it("returns persisted reply target after resolve", () => {
      // setReplyTarget only updates an existing session entry, so create one first
      sessions.setSdkSessionId("dm:hank", "session-hank");

      const router = routerOf(
        [{ name: "Hank", channels: { telegram: "111" }, replyPolicy: "last-active" }],
        sessions,
        {},
      );

      router.resolve("telegram", "111", false);
      const target = router.getReplyTarget("dm:hank");
      expect(target).toEqual({ channelName: "telegram", chatId: "111" });
    });
  });

  describe("ownerSessionKey", () => {
    it("is undefined with no owner", () => {
      sessions.setSdkSessionId("dm:alice", "session-1");
      expect(routerOf([], sessions, {}).ownerSessionKey()).toBeUndefined();
    });

    it("is the owner's dm: key, not the first dm: session in registry order", () => {
      // Another former identity's session sits first in the registry.
      sessions.setSdkSessionId("dm:sam", "session-0");
      sessions.setSdkSessionId("dm:alice", "session-1");
      const router = routerOf([{ name: "Alice", channels: { telegram: "111" }, replyPolicy: "last-active" }], sessions, {});
      expect(router.ownerSessionKey()).toBe("dm:alice");
    });
  });
});
