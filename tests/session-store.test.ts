import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore as SessionStoreImpl } from "../src/sessions/store.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { SessionMessage } from "../src/sessions/types.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-sessions");

class SessionStore extends SessionStoreImpl {
  constructor(
    dir: string,
    historyLimit: number,
    sdkSessionsDir = join(dir, "sdk-sessions"),
    opts?: { tailMessages?: number; rotateBytes?: number },
  ) {
    super(dir, historyLimit, sdkSessionsDir, opts);
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

  it("accumulates per-turn cost across updateStats calls", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.setSdkSessionId("telegram:1", "session-1");

    const turn = {
      inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      contextUsed: 10, contextMax: 100,
    };
    store.updateStats("telegram:1", { ...turn, costUsd: 0.5 });
    store.updateStats("telegram:1", { ...turn, costUsd: 0.25 });

    const entry = store.getEntry("telegram:1");
    expect(entry?.stats.totalCostUsd).toBeCloseTo(0.75);
    expect(entry?.stats.totalQueries).toBe(2);
    expect(entry?.stats.totalInputTokens).toBe(20);
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

  it("tracks display names per stable sender id", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.addParticipant("telegram:-987", "kw 🚀", "12345678");
    store.addParticipant("telegram:-987", "kw 🚀", "12345678"); // duplicate — no-op
    store.addParticipant("telegram:-987", "Kevin Wang", "12345678"); // profile rename
    store.addParticipant("telegram:-987", "No Id Person");

    const entry = store.getEntry("telegram:-987");
    expect(entry?.participants).toEqual(["kw 🚀", "Kevin Wang", "No Id Person"]);
    expect(entry?.participantIds).toEqual({ "12345678": ["kw 🚀", "Kevin Wang"] });
  });

  it("preserves participantIds when retiring a poisoned SDK session", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.addParticipant("telegram:-987", "Alice", "42");
    store.setSdkSessionId("telegram:-987", "session-poisoned");

    store.retireSdkSessionId("telegram:-987");

    const active = store.getEntry("telegram:-987");
    expect(active?.participantIds).toEqual({ "42": ["Alice"] });
  });

  it("migrates pending notes with a unified session key", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.setSdkSessionId("telegram:111", "session-old");
    store.setPendingNotes("telegram:111", ["queued before migration"]);

    store.migrateSessionKey("telegram:111", "dm:alice");

    expect(store.getPendingNotes("telegram:111")).toEqual([]);
    expect(store.getPendingNotes("dm:alice")).toEqual(["queued before migration"]);
  });

  it("remembers the raw key a unified session was migrated from, across chained migrations", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.setSdkSessionId("imessage:any;-;+15551234567", "session-old");

    store.migrateSessionKey("imessage:any;-;+15551234567", "dm:alice");
    expect(store.getEntry("dm:alice")?.migratedFrom).toBe("imessage:any;-;+15551234567");

    // A rename of the identity keeps the ORIGINAL raw key.
    store.migrateSessionKey("dm:alice", "dm:alicia");
    expect(store.getEntry("dm:alicia")?.migratedFrom).toBe("imessage:any;-;+15551234567");
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

  describe("transcript tail-loading and rotation", () => {
    const msg = (overrides: Partial<SessionMessage> = {}) => ({
      role: "user" as const,
      content: "hello",
      channel: "telegram",
      timestamp: Date.now(),
      ...overrides,
    });

    function writeTranscript(key: string, messages: unknown[]): void {
      const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
      writeFileSync(join(TEST_DIR, `${safe}.jsonl`), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    }

    it("loads only the transcript tail into memory and keeps seq continuity", () => {
      writeTranscript("test", Array.from({ length: 30 }, (_, i) => msg({ content: `msg ${i + 1}`, seq: i + 1 })));

      const store = new SessionStore(TEST_DIR, 20, undefined, { tailMessages: 10 });
      const session = store.get("test");
      expect(session.messages).toHaveLength(10);
      expect(session.messages[0].content).toBe("msg 21");

      // seq continues from the true transcript tail, not from 0
      store.append("test", msg({ content: "new" }));
      expect(session.messages[session.messages.length - 1].seq).toBe(31);
    });

    it("bounds the in-memory cache as messages are appended", () => {
      const store = new SessionStore(TEST_DIR, 20, undefined, { tailMessages: 10 });
      for (let i = 0; i < 25; i++) {
        store.append("test", msg({ content: `msg ${i}` }));
      }
      const session = store.get("test");
      expect(session.messages.length).toBeLessThanOrEqual(20);
      // Everything is still on disk
      expect(store.searchTranscript("test", { limit: 100 })).toHaveLength(25);
    });

    it("searchTranscript returns the most recent matches in chronological order", () => {
      writeTranscript("test", Array.from({ length: 40 }, (_, i) =>
        msg({ content: i % 2 === 0 ? `even ${i}` : `odd ${i}`, seq: i + 1, timestamp: 1000 + i })));

      const store = new SessionStore(TEST_DIR, 20);
      const results = store.searchTranscript("test", { query: "even", limit: 3 });
      expect(results.map((r) => r.content)).toEqual(["even 34", "even 36", "even 38"]);

      // Range filters still apply
      const ranged = store.searchTranscript("test", { fromSeq: 5, toSeq: 8, limit: 10 });
      expect(ranged.map((r) => r.seq)).toEqual([5, 6, 7, 8]);
    });

    it("rotates prior months into archive files and searches across them", () => {
      const jan = Date.UTC(2020, 0, 15);
      const feb = Date.UTC(2020, 1, 15);
      writeTranscript("test", [
        msg({ content: "jan one", seq: 1, timestamp: jan }),
        msg({ content: "jan two", seq: 2, timestamp: jan + 1000 }),
        msg({ content: "feb one", seq: 3, timestamp: feb }),
        msg({ content: "now one", seq: 4 }),
        msg({ content: "now two", seq: 5 }),
      ]);

      const store = new SessionStore(TEST_DIR, 20, undefined, { rotateBytes: 1 });
      const session = store.get("test");

      // Prior months rolled out of the active file...
      expect(existsSync(join(TEST_DIR, "_archive_test_2020-01.jsonl"))).toBe(true);
      expect(existsSync(join(TEST_DIR, "_archive_test_2020-02.jsonl"))).toBe(true);
      expect(session.messages.map((m) => m.content)).toEqual(["now one", "now two"]);
      expect(store.countRecentUserMessages("test")).toBe(2);

      // ...but createdAt and search still span the whole history
      expect(session.createdAt).toBe(jan);
      const all = store.searchTranscript("test", { limit: 100 });
      expect(all.map((m) => m.content)).toEqual(["jan one", "jan two", "feb one", "now one", "now two"]);
      expect(store.searchTranscript("test", { query: "jan", limit: 10 })).toHaveLength(2);
    });

    it("continues seq from the newest archive when rotation empties the active file", () => {
      // A session idle across a month boundary: every message is prior-month,
      // so rotation leaves the active transcript empty.
      const jan = Date.UTC(2020, 0, 15);
      writeTranscript("test", [
        msg({ content: "one", seq: 1, timestamp: jan }),
        msg({ content: "two", seq: 2, timestamp: jan + 1000 }),
      ]);

      const store = new SessionStore(TEST_DIR, 20, undefined, { rotateBytes: 1 });
      store.append("test", msg({ content: "three" }));

      const session = store.get("test");
      expect(session.messages.map((m) => m.seq)).toEqual([3]);
      const all = store.searchTranscript("test", { limit: 10 });
      expect(all.map((m) => [m.content, m.seq])).toEqual([["one", 1], ["two", 2], ["three", 3]]);
    });

    it("re-running rotation does not duplicate archived messages", () => {
      const jan = Date.UTC(2020, 0, 15);
      const oldMessages = [
        msg({ content: "jan one", seq: 1, timestamp: jan }),
        msg({ content: "jan two", seq: 2, timestamp: jan + 1000 }),
      ];
      const current = msg({ content: "now", seq: 3 });
      writeTranscript("test", [...oldMessages, current]);

      new SessionStore(TEST_DIR, 20, undefined, { rotateBytes: 1 }).get("test");

      // Simulate a crash between archive-append and active-file rewrite: the
      // active file still contains the already-archived messages.
      writeTranscript("test", [...oldMessages, current]);
      const store = new SessionStore(TEST_DIR, 20, undefined, { rotateBytes: 1 });
      store.get("test");

      const archived = readFileSync(join(TEST_DIR, "_archive_test_2020-01.jsonl"), "utf-8")
        .trim().split("\n");
      expect(archived).toHaveLength(2);
      expect(store.searchTranscript("test", { limit: 100 })).toHaveLength(3);
    });

    it("migrates rotation archives with the session key", () => {
      const jan = Date.UTC(2020, 0, 15);
      writeTranscript("telegram:111", [
        msg({ content: "old", seq: 1, timestamp: jan }),
        msg({ content: "new", seq: 2 }),
      ]);
      const store = new SessionStore(TEST_DIR, 20, undefined, { rotateBytes: 1 });
      store.setSdkSessionId("telegram:111", "session-old");
      store.get("telegram:111");

      store.migrateSessionKey("telegram:111", "dm:alice");

      expect(existsSync(join(TEST_DIR, "_archive_dm_alice_2020-01.jsonl"))).toBe(true);
      const results = store.searchTranscript("dm:alice", { limit: 10 });
      expect(results.map((m) => m.content)).toEqual(["old", "new"]);
    });
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
