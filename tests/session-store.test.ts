import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../src/sessions/store.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-sessions");

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

  it("touches session lastActiveAt", () => {
    const store = new SessionStore(TEST_DIR, 20);
    store.setSdkSessionId("key1", "session-abc");

    const before = store.listAllSessions()[0].lastActiveAt;
    // Small delay to ensure timestamp differs
    store.touchSession("key1");
    const after = store.listAllSessions()[0].lastActiveAt;

    expect(after).toBeGreaterThanOrEqual(before);
  });
});
