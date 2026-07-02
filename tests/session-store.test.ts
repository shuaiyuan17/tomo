import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore as SessionStoreImpl } from "../src/sessions/store.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-sessions");

class SessionStore extends SessionStoreImpl {
  constructor(dir: string, historyLimit: number, sdkSessionsDir = join(dir, "sdk-sessions")) {
    super(dir, historyLimit, sdkSessionsDir);
  }
}

describe("SessionStore", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("appends messages and persists as JSONL", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.append("telegram:123", {
      role: "user",
      content: "hello",
      channel: "telegram",
      senderName: "Test",
      timestamp: Date.now(),
    });
    store.append("telegram:123", {
      role: "assistant",
      content: "hi",
      channel: "telegram",
      timestamp: Date.now(),
    });

    const session = store.get("telegram:123");
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].content).toBe("hello");
    expect(session.messages[1].content).toBe("hi");
  });

  it("limits history by user turns", () => {
    const store = new SessionStore(TEST_DIR, 2);
    for (let i = 0; i < 5; i++) {
      store.append("test", {
        role: "user",
        content: `msg ${i}`,
        channel: "test",
        timestamp: Date.now(),
      });
      store.append("test", {
        role: "assistant",
        content: `reply ${i}`,
        channel: "test",
        timestamp: Date.now(),
      });
    }

    const history = store.getHistory("test");
    // Should only include last 2 user turns + their replies
    const userMsgs = history.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0].content).toBe("msg 3");
    expect(userMsgs[1].content).toBe("msg 4");
  });

  it("manages SDK session IDs", () => {
    const store = new SessionStore(TEST_DIR, 20);

    expect(store.getSdkSessionId("key1")).toBeUndefined();

    store.setSdkSessionId("key1", "session-abc");
    expect(store.getSdkSessionId("key1")).toBe("session-abc");

    store.clearSdkSessionId("key1");
    expect(store.getSdkSessionId("key1")).toBeUndefined();
  });

  it("tracks unlinked sessions with expiry", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.setSdkSessionId("key1", "session-abc");
    store.clearSdkSessionId("key1");

    const all = store.listAllSessions();
    expect(all).toHaveLength(1);
    expect(all[0].unlinkedAt).toBeTruthy();
    expect(all[0].expiresAt).toBeTruthy();
    expect(all[0].expiresAt! - all[0].unlinkedAt!).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("cleans expired SDK files from the injected SDK sessions directory", () => {
    const sdkSessionsDir = join(TEST_DIR, "custom-sdk-sessions");
    mkdirSync(sdkSessionsDir, { recursive: true });
    const sdkFile = join(sdkSessionsDir, "expired-session.jsonl");
    writeFileSync(sdkFile, "{}\n");
    writeFileSync(join(TEST_DIR, "_sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        sdkSessionId: "expired-session",
        channelKey: "dm:expired",
        createdAt: 1,
        lastActiveAt: 1,
        unlinkedAt: 1,
        expiresAt: 1,
      }],
    }));

    const store = new SessionStore(TEST_DIR, 20, sdkSessionsDir);

    expect(existsSync(sdkFile)).toBe(false);
    expect(store.listAllSessions()).toEqual([]);
  });

  it("lists only active sessions", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.setSdkSessionId("active", "session-1");
    store.setSdkSessionId("unlinked", "session-2");
    store.clearSdkSessionId("unlinked");

    const active = store.listSdkSessionIds();
    expect(active).toHaveLength(1);
    expect(active[0][0]).toBe("active");
  });

  it("persists registry across instances", () => {
    const store1 = new SessionStore(TEST_DIR, 20);
    store1.setSdkSessionId("key1", "session-xyz");

    const store2 = new SessionStore(TEST_DIR, 20);
    expect(store2.getSdkSessionId("key1")).toBe("session-xyz");
  });

  it("persists pending notes across instances until cleared", () => {
    const store1 = new SessionStore(TEST_DIR, 20);
    store1.setPendingNotes("telegram:-987", ["first", "second"]);

    const store2 = new SessionStore(TEST_DIR, 20);
    expect(store2.getPendingNotes("telegram:-987")).toEqual(["first", "second"]);

    store2.setPendingNotes("telegram:-987", []);
    const store3 = new SessionStore(TEST_DIR, 20);
    expect(store3.getPendingNotes("telegram:-987")).toEqual([]);
  });

  it("list APIs see external registry changes from another store instance", () => {
    // Simulates the daemon's long-lived store vs a CLI process (`tomo
    // sessions clear`) rewriting the same registry file.
    const daemonStore = new SessionStore(TEST_DIR, 20);
    daemonStore.setSdkSessionId("telegram:1", "session-1");

    const cliStore = new SessionStore(TEST_DIR, 20);
    expect(cliStore.listSdkSessionIds()).toEqual([["telegram:1", "session-1"]]);
    cliStore.clearSdkSessionId("telegram:1");

    // The daemon's store must observe the external clear without any
    // intervening mutation of its own.
    expect(daemonStore.listSdkSessionIds()).toEqual([]);
    const all = daemonStore.listAllSessions();
    expect(all).toHaveLength(1);
    expect(all[0].unlinkedAt).toBeTruthy();
  });

  it("picks up direct external rewrites of the registry file", () => {
    // Regression guard for the mtime/size read cache: a rewrite by another
    // process (not via a SessionStore instance) must still be observed.
    const store = new SessionStore(TEST_DIR, 20);
    store.setSdkSessionId("key1", "session-abc");
    expect(store.getSdkSessionId("key1")).toBe("session-abc");

    writeFileSync(join(TEST_DIR, "_sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        sdkSessionId: "session-external",
        channelKey: "key1",
        createdAt: 1,
        lastActiveAt: 1,
        unlinkedAt: null,
        expiresAt: null,
      }],
    }));

    expect(store.getSdkSessionId("key1")).toBe("session-external");
  });

  it("mutators do not resurrect an externally cleared session", () => {
    const daemonStore = new SessionStore(TEST_DIR, 20);
    daemonStore.setSdkSessionId("telegram:1", "session-1");

    const cliStore = new SessionStore(TEST_DIR, 20);
    cliStore.clearSdkSessionId("telegram:1");

    // updateStats on the stale daemon store must not revert the clear.
    daemonStore.updateStats("telegram:1", {
      costUsd: 1, inputTokens: 1, outputTokens: 1,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      contextUsed: 10, contextMax: 100,
    });
    expect(cliStore.getSdkSessionId("telegram:1")).toBeUndefined();
    expect(daemonStore.listSdkSessionIds()).toEqual([]);
  });

  it("retires a poisoned SDK session while preserving active metadata", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.setChatTitle("telegram:-987", "Ski Trip");
    store.addParticipant("telegram:-987", "Alice");
    store.setSdkSessionId("telegram:-987", "session-poisoned");

    const retired = store.retireSdkSessionId("telegram:-987");

    expect(retired).toBe("session-poisoned");
    expect(store.getSdkSessionId("telegram:-987")).toBeUndefined();
    expect(store.listSdkSessionIds()).toEqual([]);

    const active = store.getEntry("telegram:-987");
    expect(active?.sdkSessionId).toBe("");
    expect(active?.chatTitle).toBe("Ski Trip");
    expect(active?.participants).toEqual(["Alice"]);

    const unlinked = store.listAllSessions().find((e) => e.sdkSessionId === "session-poisoned");
    expect(unlinked?.unlinkedAt).toBeTruthy();
    expect(unlinked?.expiresAt).toBeTruthy();
  });

  it("migrates pending notes with a unified session key", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.setSdkSessionId("telegram:111", "session-old");
    store.setPendingNotes("telegram:111", ["queued before migration"]);

    store.migrateSessionKey("telegram:111", "dm:alice");

    expect(store.getPendingNotes("telegram:111")).toEqual([]);
    expect(store.getPendingNotes("dm:alice")).toEqual(["queued before migration"]);
  });

  it("touches session lastActiveAt", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.setSdkSessionId("key1", "session-abc");

    const before = store.listAllSessions()[0].lastActiveAt;
    // Small delay to ensure timestamp differs
    store.touchSession("key1");
    const after = store.listAllSessions()[0].lastActiveAt;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  describe("metadata-only stubs", () => {
    it("persists chat title and participants before any SDK session exists", () => {
      const store = new SessionStore(TEST_DIR, 20);
      store.setChatTitle("telegram:-987", "Ski Trip");
      store.addParticipant("telegram:-987", "Alice");
      store.addParticipant("telegram:-987", "Bob");

      const reloaded = new SessionStore(TEST_DIR, 20);
      const entry = reloaded.getEntry("telegram:-987");
      expect(entry?.chatTitle).toBe("Ski Trip");
      expect(entry?.participants).toEqual(["Alice", "Bob"]);
    });

    it("persists reply target before any SDK session exists", () => {
      const store = new SessionStore(TEST_DIR, 20);
      store.setReplyTarget("dm:alice", { channelName: "imessage", chatId: "+15551234567" });

      const reloaded = new SessionStore(TEST_DIR, 20);
      expect(reloaded.getReplyTarget("dm:alice")).toEqual({
        channelName: "imessage",
        chatId: "+15551234567",
      });
      expect(reloaded.listSdkSessionIds()).toEqual([]);
    });

    it("upgrades the stub in place when an SDK session is linked", () => {
      const store = new SessionStore(TEST_DIR, 20);
      store.setChatTitle("telegram:-987", "Ski Trip");
      store.addParticipant("telegram:-987", "Alice");

      store.setSdkSessionId("telegram:-987", "session-xyz");

      const entry = store.getEntry("telegram:-987");
      expect(entry?.sdkSessionId).toBe("session-xyz");
      expect(entry?.chatTitle).toBe("Ski Trip");
      expect(entry?.participants).toEqual(["Alice"]);
      // Upgraded, not replaced — exactly one entry for the key
      expect(store.listAllSessions().filter((e) => e.channelKey === "telegram:-987")).toHaveLength(1);
    });

    it("clear removes a metadata-only stub outright (no 30-day TTL)", () => {
      const store = new SessionStore(TEST_DIR, 20);
      store.setChatTitle("telegram:-987", "Ski Trip");

      store.clearSdkSessionId("telegram:-987");

      // Gone entirely — not lingering as an unlinked entry
      expect(store.listAllSessions()).toHaveLength(0);
      const reloaded = new SessionStore(TEST_DIR, 20);
      expect(reloaded.getEntry("telegram:-987")).toBeUndefined();
    });

    it("excludes stubs from listSdkSessionIds but lists them as active entries", () => {
      const store = new SessionStore(TEST_DIR, 20);
      store.setChatTitle("telegram:-987", "Ski Trip");
      store.setSdkSessionId("dm:alice", "session-alice");

      expect(store.listSdkSessionIds()).toEqual([["dm:alice", "session-alice"]]);
      const activeKeys = store.listActiveEntries().map((e) => e.channelKey).sort();
      expect(activeKeys).toEqual(["dm:alice", "telegram:-987"]);
    });
  });
});
