import { afterAll, describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { SessionMessage } from "../src/sessions/types.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSessionStore, writeTranscript as writeTranscriptIn } from "./helpers/session-store-fixtures.js";

const TEST_DIR = mkdtempSync(join(tmpdir(), "tomo-test-sessions-"));
const asidesIn = (dir: string): string[] => readdirSync(dir).filter((f) => f.startsWith("_pending_notes.json.corrupt-"));
const markerPath = (dir: string): string => join(dir, "_pending_notes.quarantined.json");

/** Make the store's move of the pending notes file fail (an immutable file, say). */
function failPendingNotesMove(store: unknown): () => void {
  const proto = Object.getPrototypeOf(store) as { moveWithoutClobber(from: string, to: string): string };
  const spy = vi.spyOn(proto, "moveWithoutClobber").mockImplementation(() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); });
  return () => spy.mockRestore();
}
// The root is unique to this run, so nothing else will clean it up.
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("SessionStore", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("appends messages and persists as JSONL", () => {
    const store = makeSessionStore(TEST_DIR);
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
    const store = makeSessionStore(TEST_DIR);

    expect(store.getSdkSessionId("key1")).toBeUndefined();

    store.setSdkSessionId("key1", "session-abc");
    expect(store.getSdkSessionId("key1")).toBe("session-abc");

    store.clearSdkSessionId("key1");
    expect(store.getSdkSessionId("key1")).toBeUndefined();
  });

  it("tracks unlinked sessions with expiry", () => {
    const store = makeSessionStore(TEST_DIR);
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

    const store = makeSessionStore(TEST_DIR, { sdkSessionsDir });

    expect(existsSync(sdkFile)).toBe(false);
    expect(store.listAllSessions()).toEqual([]);
  });

  it("lists only active sessions", () => {
    const store = makeSessionStore(TEST_DIR);
    store.setSdkSessionId("active", "session-1");
    store.setSdkSessionId("unlinked", "session-2");
    store.clearSdkSessionId("unlinked");

    const active = store.listSdkSessionIds();
    expect(active).toHaveLength(1);
    expect(active[0][0]).toBe("active");
  });

  it("persists registry across instances", () => {
    const store1 = makeSessionStore(TEST_DIR);
    store1.setSdkSessionId("key1", "session-xyz");

    const store2 = makeSessionStore(TEST_DIR);
    expect(store2.getSdkSessionId("key1")).toBe("session-xyz");
  });

  it("a pending notes file that will not parse is moved aside byte for byte, a fresh one started, and the marker names it", () => {
    const file = join(TEST_DIR, "_pending_notes.json");
    const corrupt = '{"version":1,"notes":{"dm:alice":["only copy of a replayed message"]'; // truncated
    writeFileSync(file, corrupt);
    const store = makeSessionStore(TEST_DIR);
    const told: string[] = [];
    store.onPendingNotesQuarantined = (aside) => told.push(aside);

    // Main read it as empty, and this write replaced every session's notes.
    store.setPendingNotes("telegram:-987", ["new"]);
    expect(store.getPendingNotes("telegram:-987")).toEqual(["new"]);
    const asides = asidesIn(TEST_DIR);
    expect(asides).toHaveLength(1);
    expect(readFileSync(join(TEST_DIR, asides[0]), "utf-8")).toBe(corrupt);
    expect(told).toEqual([join(TEST_DIR, asides[0])]);
    // A fresh process (a restart before the owner was told) still reads the marker.
    expect(makeSessionStore(TEST_DIR).quarantinedPendingNotes()).toEqual([join(TEST_DIR, asides[0])]);
    store.clearQuarantinedPendingNotes([join(TEST_DIR, asides[0])]);
    expect(existsSync(markerPath(TEST_DIR))).toBe(false);
    expect(store.quarantinedPendingNotes()).toBeUndefined();
  });

  it("a file that is not valid UTF-8, has a row of the wrong shape, is empty, or is a directory is moved aside too", () => {
    const file = join(TEST_DIR, "_pending_notes.json");
    const cases: Array<Buffer | "dir"> = [
      Buffer.concat([Buffer.from('{"version":1,"notes":{"dm:alice":["caf'), Buffer.from([0xff]), Buffer.from('"]}}')]),
      Buffer.from(JSON.stringify({ version: 1, notes: { "dm:alice": ["keep me"], "dm:bob": [42] } })),
      Buffer.from(""),
      "dir",
    ];
    for (const raw of cases) {
      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      if (raw === "dir") {
        mkdirSync(file);
        writeFileSync(join(file, "inside"), "kept");
      } else {
        writeFileSync(file, raw);
      }
      const store = makeSessionStore(TEST_DIR);
      expect(store.getPendingNotes("dm:alice")).toEqual([]);
      const asides = asidesIn(TEST_DIR);
      expect(asides).toHaveLength(1);
      if (raw === "dir") expect(readFileSync(join(TEST_DIR, asides[0], "inside"), "utf-8")).toBe("kept");
      else expect(readFileSync(join(TEST_DIR, asides[0])).equals(raw)).toBe(true);
    }
  });

  it("a file that cannot be moved aside throws, a write leaves it untouched, and no marker is left", () => {
    const file = join(TEST_DIR, "_pending_notes.json");
    writeFileSync(file, "{not json");
    const store = makeSessionStore(TEST_DIR);
    const restore = failPendingNotesMove(store);
    try {
      expect(() => store.getPendingNotes("dm:alice")).toThrow();
      expect(() => store.setPendingNotes("dm:alice", ["new"])).toThrow();
    } finally {
      restore();
    }
    expect(readFileSync(file, "utf-8")).toBe("{not json");
    expect(asidesIn(TEST_DIR)).toEqual([]);
    expect(store.quarantinedPendingNotes()).toBeUndefined();
  });

  it("a move that does not happen puts a marker that is already there back as it was", () => {
    const file = join(TEST_DIR, "_pending_notes.json");
    writeFileSync(file, "{not json");
    writeFileSync(markerPath(TEST_DIR), JSON.stringify({ asides: ["/x/_pending_notes.json.corrupt-1"] }));
    const store = makeSessionStore(TEST_DIR);
    const restore = failPendingNotesMove(store);
    try {
      expect(() => store.getPendingNotes("dm:alice")).toThrow();
    } finally {
      restore();
    }
    expect(store.quarantinedPendingNotes()).toEqual(["/x/_pending_notes.json.corrupt-1"]);
  });

  it("a read-only store throws for an unreadable pending notes file and leaves it as it is", () => {
    const file = join(TEST_DIR, "_pending_notes.json");
    writeFileSync(file, "{not json");
    const store = makeSessionStore(TEST_DIR, { readOnly: true });
    expect(() => store.getPendingNotes("dm:alice")).toThrow();
    expect(readFileSync(file, "utf-8")).toBe("{not json");
    expect(asidesIn(TEST_DIR)).toEqual([]);
  });

  it("persists pending notes across instances until cleared", () => {
    const store1 = makeSessionStore(TEST_DIR);
    store1.setPendingNotes("telegram:-987", ["first", "second"]);

    const store2 = makeSessionStore(TEST_DIR);
    expect(store2.getPendingNotes("telegram:-987")).toEqual(["first", "second"]);

    store2.setPendingNotes("telegram:-987", []);
    const store3 = makeSessionStore(TEST_DIR);
    expect(store3.getPendingNotes("telegram:-987")).toEqual([]);
  });

  it("list APIs see external registry changes from another store instance", () => {
    // Simulates the daemon's long-lived store vs a CLI process (`tomo
    // sessions clear`) rewriting the same registry file.
    const daemonStore = makeSessionStore(TEST_DIR);
    daemonStore.setSdkSessionId("telegram:1", "session-1");

    const cliStore = makeSessionStore(TEST_DIR);
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
    const store = makeSessionStore(TEST_DIR);
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
    const daemonStore = makeSessionStore(TEST_DIR);
    daemonStore.setSdkSessionId("telegram:1", "session-1");

    const cliStore = makeSessionStore(TEST_DIR);
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
    const store = makeSessionStore(TEST_DIR);
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

  it("usage from a ledger row that landed before the session's entry existed is held, then added with its first stats update", () => {
    const store = makeSessionStore(TEST_DIR);
    store.addOutsideUsage("telegram:1", { costUsd: 0.4, inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 1 });
    store.setSdkSessionId("telegram:1", "session-1");
    store.updateStats("telegram:1", { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsed: 10, contextMax: 100 });
    expect(store.getEntry("telegram:1")?.stats).toMatchObject({ totalCostUsd: 0.4, totalInputTokens: 3, totalOutputTokens: 2, totalQueries: 1 });
    // Applied once: a second update adds nothing more.
    store.updateStats("telegram:1", { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsed: 10, contextMax: 100 });
    expect(store.getEntry("telegram:1")?.stats.totalCostUsd).toBeCloseTo(0.4);
  });

  it("keeps the last real window when an estimated reading does not know one (contextMax 0)", () => {
    const store = makeSessionStore(TEST_DIR);
    store.setSdkSessionId("telegram:1", "session-1");
    const turn = { costUsd: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsed: 10, contextMax: 1_000_000 };
    store.updateStats("telegram:1", turn);
    store.updateStats("telegram:1", { ...turn, contextUsed: 15, contextMax: 0, contextEstimated: true });
    expect(store.getEntry("telegram:1")?.stats).toMatchObject({ contextMax: 1_000_000, contextUsed: 15, contextEstimated: true });
    store.updateStats("telegram:1", { ...turn, contextMax: 200_000 });
    expect(store.getEntry("telegram:1")?.stats.contextMax).toBe(200_000);
  });

  it("charges an outside call (forced-compaction summary) to the totals without touching the context reading or query count", () => {
    const store = makeSessionStore(TEST_DIR);
    store.setSdkSessionId("telegram:1", "session-1");
    store.updateStats("telegram:1", { costUsd: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsed: 900, contextMax: 1000 });
    store.addOutsideUsage("telegram:1", { costUsd: 0.5, inputTokens: 150_000, outputTokens: 900, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(store.getEntry("telegram:1")?.stats).toMatchObject({ totalCostUsd: 1.5, totalInputTokens: 150_010, totalQueries: 1, contextUsed: 900 });
    // On disk, not only in this instance's cache.
    expect(makeSessionStore(TEST_DIR).getEntry("telegram:1")?.stats).toMatchObject({ totalCostUsd: 1.5, totalInputTokens: 150_010 });
  });

  describe("usage baseline", () => {
    const turn = {
      costUsd: 0.1, inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      contextUsed: 10, contextMax: 100,
    };
    const baseline = (sdkSessionId: string, totalCostUsd: number) => ({
      sdkSessionId, totalCostUsd, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreated: 4 },
    });

    const zero = (sdkSessionId: string) => ({
      sdkSessionId, totalCostUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreated: 0 }, models: {},
    });

    it("a new SDK session's baseline is zero, and only setUsageBaseline (a landed ledger row) advances it", () => {
      const store = makeSessionStore(TEST_DIR);
      store.setSdkSessionId("telegram:1", "session-1");
      expect(store.getUsageBaseline("telegram:1")).toEqual(zero("session-1"));
      store.setUsageBaseline("telegram:1", baseline("session-1", 1.5));
      expect(makeSessionStore(TEST_DIR).getUsageBaseline("telegram:1")).toEqual(baseline("session-1", 1.5));
      // A snapshot for a different SDK session never lands on this one.
      store.setUsageBaseline("telegram:1", baseline("session-other", 9));
      expect(store.getUsageBaseline("telegram:1")).toEqual(baseline("session-1", 1.5));
    });

    it("a landed row's snapshot that arrives before its SDK session is linked becomes the link's baseline, not zero", () => {
      const store = makeSessionStore(TEST_DIR);
      // The first row of a brand-new session lands before turn completion links its id.
      store.setUsageBaseline("telegram:1", baseline("session-1", 0.75));
      expect(store.getUsageBaseline("telegram:1")).toBeUndefined();
      store.setSdkSessionId("telegram:1", "session-1");
      expect(makeSessionStore(TEST_DIR).getUsageBaseline("telegram:1")).toEqual(baseline("session-1", 0.75));
      // A pending snapshot for another SDK session is not borrowed.
      store.setUsageBaseline("telegram:2", baseline("session-x", 3));
      store.setSdkSessionId("telegram:2", "session-2");
      expect(store.getUsageBaseline("telegram:2")).toEqual(zero("session-2"));
    });

    it("persists the baseline next to the SDK session id and reads it back from disk", () => {
      const store = makeSessionStore(TEST_DIR);
      store.setSdkSessionId("telegram:1", "session-1");
      store.updateStats("telegram:1", { ...turn, usageBaseline: baseline("session-1", 275.47) });

      const fresh = makeSessionStore(TEST_DIR);
      expect(fresh.getUsageBaseline("telegram:1")).toEqual(baseline("session-1", 275.47));
      // No usageBaseline in the update: left untouched.
      fresh.updateStats("telegram:1", turn);
      expect(fresh.getUsageBaseline("telegram:1")?.totalCostUsd).toBe(275.47);
      // null: the totals reset, so the baseline is dropped.
      fresh.updateStats("telegram:1", { ...turn, usageBaseline: null });
      expect(fresh.getUsageBaseline("telegram:1")).toBeUndefined();
    });

    it("never stores a baseline measured on a different SDK session", () => {
      const store = makeSessionStore(TEST_DIR);
      store.setSdkSessionId("telegram:1", "session-1");
      store.updateStats("telegram:1", { ...turn, usageBaseline: baseline("session-other", 5) });
      expect(store.getUsageBaseline("telegram:1")).toBeUndefined();
    });

    it("drops the baseline when the SDK session is cleared (/new) or rotated", () => {
      const store = makeSessionStore(TEST_DIR);
      store.setSdkSessionId("telegram:1", "session-1");
      store.updateStats("telegram:1", { ...turn, usageBaseline: baseline("session-1", 275.47) });

      store.clearSdkSessionId("telegram:1");
      expect(store.getUsageBaseline("telegram:1")).toBeUndefined();
      expect(store.listAllSessions().some((e) => e.usageBaseline)).toBe(false);

      // A new SDK session starts at zero, never inheriting the old totals.
      store.setSdkSessionId("telegram:1", "session-2");
      expect(store.getUsageBaseline("telegram:1")).toEqual(zero("session-2"));
    });

    it("drops the baseline when the SDK session is retired", () => {
      const store = makeSessionStore(TEST_DIR);
      store.setSdkSessionId("telegram:1", "session-1");
      store.updateStats("telegram:1", { ...turn, usageBaseline: baseline("session-1", 275.47) });

      store.retireSdkSessionId("telegram:1");
      expect(store.getUsageBaseline("telegram:1")).toBeUndefined();
      expect(store.listAllSessions().some((e) => e.usageBaseline)).toBe(false);
      // A new SDK session starts at zero, never inheriting the old totals.
      store.setSdkSessionId("telegram:1", "session-2");
      expect(store.getUsageBaseline("telegram:1")).toEqual(zero("session-2"));
    });
  });

  it("retires a poisoned SDK session while preserving active metadata", () => {
    const store = makeSessionStore(TEST_DIR);
    store.setChatTitle("telegram:-987", "Ski Trip");
    store.addParticipant("telegram:-987", "Alice", "42");
    store.setSdkSessionId("telegram:-987", "session-poisoned");

    const retired = store.retireSdkSessionId("telegram:-987");

    expect(retired).toBe("session-poisoned");
    expect(store.getSdkSessionId("telegram:-987")).toBeUndefined();
    expect(store.listSdkSessionIds()).toEqual([]);

    const active = store.getEntry("telegram:-987");
    expect(active?.sdkSessionId).toBe("");
    expect(active?.chatTitle).toBe("Ski Trip");
    expect(active?.participants).toEqual(["Alice"]);
    expect(active?.participantIds).toEqual({ "42": ["Alice"] });

    const unlinked = store.listAllSessions().find((e) => e.sdkSessionId === "session-poisoned");
    expect(unlinked?.unlinkedAt).toBeTruthy();
    expect(unlinked?.expiresAt).toBeTruthy();
  });

  it("tracks display names per stable sender id", () => {
    const store = makeSessionStore(TEST_DIR);
    store.addParticipant("telegram:-987", "kw 🚀", "12345678");
    store.addParticipant("telegram:-987", "kw 🚀", "12345678"); // duplicate — no-op
    store.addParticipant("telegram:-987", "Kevin Wang", "12345678"); // profile rename
    store.addParticipant("telegram:-987", "No Id Person");

    const entry = store.getEntry("telegram:-987");
    expect(entry?.participants).toEqual(["kw 🚀", "Kevin Wang", "No Id Person"]);
    expect(entry?.participantIds).toEqual({ "12345678": ["kw 🚀", "Kevin Wang"] });
  });

  it("migrates pending notes with a unified session key", () => {
    const store = makeSessionStore(TEST_DIR);
    store.setSdkSessionId("telegram:111", "session-old");
    store.setPendingNotes("telegram:111", ["queued before migration"]);

    store.migrateSessionKey("telegram:111", "dm:alice");

    expect(store.getPendingNotes("telegram:111")).toEqual([]);
    expect(store.getPendingNotes("dm:alice")).toEqual(["queued before migration"]);
  });

  it("a re-key whose pending notes cannot be read or moved aside fails, so it is tried again", () => {
    const store = makeSessionStore(TEST_DIR);
    store.setSdkSessionId("telegram:111", "session-old");
    store.append("telegram:111", { role: "user", content: "before", timestamp: Date.now() });
    writeFileSync(join(TEST_DIR, "_pending_notes.json"), "{not json");
    const restore = failPendingNotesMove(store);
    try {
      expect(() => store.migrateSessionKey("telegram:111", "dm:alice")).toThrow();
    } finally {
      restore();
    }
    const fresh = makeSessionStore(TEST_DIR);
    expect(fresh.getEntry("telegram:111")?.sdkSessionId).toBe("session-old");
    expect(fresh.getEntry("dm:alice")).toBeUndefined();
    // Nothing moved: the old key's history is where it was.
    expect(fresh.loadTranscript("telegram:111").map((m) => m.content)).toEqual(["before"]);
  });

  it("remembers the raw key a unified session was migrated from, across chained migrations", () => {
    const store = makeSessionStore(TEST_DIR);
    store.setSdkSessionId("imessage:any;-;+15551234567", "session-old");

    store.migrateSessionKey("imessage:any;-;+15551234567", "dm:alice");
    expect(store.getEntry("dm:alice")?.migratedFrom).toBe("imessage:any;-;+15551234567");

    // A rename of the identity keeps the ORIGINAL raw key.
    store.migrateSessionKey("dm:alice", "dm:alicia");
    expect(store.getEntry("dm:alicia")?.migratedFrom).toBe("imessage:any;-;+15551234567");
  });

  it("keeps migratedFrom on the stub when a unified session is retired", () => {
    const store = makeSessionStore(TEST_DIR);
    store.setSdkSessionId("imessage:any;-;+15551234567", "session-old");
    store.migrateSessionKey("imessage:any;-;+15551234567", "dm:alice");

    store.retireSdkSessionId("dm:alice");

    // Active stub (no SDK session yet) still carries the provenance, so the
    // restore key survives the retired copy's 30-day expiry.
    expect(store.getEntry("dm:alice")?.sdkSessionId).toBe("");
    expect(store.getEntry("dm:alice")?.migratedFrom).toBe("imessage:any;-;+15551234567");
    expect(store.listAllSessions().filter((e) => e.channelKey === "dm:alice").every((e) => e.migratedFrom === "imessage:any;-;+15551234567")).toBe(true);
  });

  it("touches session lastActiveAt, on disk", () => {
    // Only Date is faked: the store's lock polling sleeps with Atomics.wait.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1) });
    try {
      const store = makeSessionStore(TEST_DIR);
      store.setSdkSessionId("key1", "session-abc");
      const before = store.listAllSessions()[0].lastActiveAt;

      vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 5));
      store.touchSession("key1");

      expect(before).toBe(Date.UTC(2026, 0, 1));
      expect(makeSessionStore(TEST_DIR).listAllSessions()[0].lastActiveAt).toBe(Date.UTC(2026, 0, 1, 0, 5));
    } finally {
      vi.useRealTimers();
    }
  });

  describe("transcript tail-loading and rotation", () => {
    const msg = (overrides: Partial<SessionMessage> = {}) => ({
      role: "user" as const,
      content: "hello",
      channel: "telegram",
      timestamp: Date.now(),
      ...overrides,
    });

    const writeTranscript = (key: string, messages: unknown[]) => writeTranscriptIn(TEST_DIR, key, messages);

    it("loads only the transcript tail into memory and keeps seq continuity", () => {
      writeTranscript("test", Array.from({ length: 30 }, (_, i) => msg({ content: `msg ${i + 1}`, seq: i + 1 })));

      const store = makeSessionStore(TEST_DIR, { tailMessages: 10 });
      const session = store.get("test");
      expect(session.messages).toHaveLength(10);
      expect(session.messages[0].content).toBe("msg 21");

      // seq continues from the true transcript tail, not from 0
      store.append("test", msg({ content: "new" }));
      expect(session.messages[session.messages.length - 1].seq).toBe(31);
    });

    it("bounds the in-memory cache as messages are appended", () => {
      const store = makeSessionStore(TEST_DIR, { tailMessages: 10 });
      for (let i = 0; i < 25; i++) {
        store.append("test", msg({ content: `msg ${i}` }));
      }
      const session = store.get("test");
      expect(session.messages.length).toBeLessThanOrEqual(20);
      // Everything is still on disk
      expect(store.searchTranscript("test", { limit: 100 })).toHaveLength(25);
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

      const store = makeSessionStore(TEST_DIR, { rotateBytes: 1 });
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

      const store = makeSessionStore(TEST_DIR, { rotateBytes: 1 });
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

      makeSessionStore(TEST_DIR, { rotateBytes: 1 }).get("test");

      // Simulate a crash between archive-append and active-file rewrite: the
      // active file still contains the already-archived messages.
      writeTranscript("test", [...oldMessages, current]);
      const store = makeSessionStore(TEST_DIR, { rotateBytes: 1 });
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
      const store = makeSessionStore(TEST_DIR, { rotateBytes: 1 });
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
      const store = makeSessionStore(TEST_DIR);
      store.setChatTitle("telegram:-987", "Ski Trip");
      store.addParticipant("telegram:-987", "Alice");
      store.addParticipant("telegram:-987", "Bob");

      const reloaded = makeSessionStore(TEST_DIR);
      const entry = reloaded.getEntry("telegram:-987");
      expect(entry?.chatTitle).toBe("Ski Trip");
      expect(entry?.participants).toEqual(["Alice", "Bob"]);
    });

    it("persists reply target before any SDK session exists", () => {
      const store = makeSessionStore(TEST_DIR);
      store.setReplyTarget("dm:alice", { channelName: "imessage", chatId: "+15551234567" });

      const reloaded = makeSessionStore(TEST_DIR);
      expect(reloaded.getReplyTarget("dm:alice")).toEqual({
        channelName: "imessage",
        chatId: "+15551234567",
      });
      expect(reloaded.listSdkSessionIds()).toEqual([]);
    });

    it("upgrades the stub in place when an SDK session is linked", () => {
      const store = makeSessionStore(TEST_DIR);
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
      const store = makeSessionStore(TEST_DIR);
      store.setChatTitle("telegram:-987", "Ski Trip");

      store.clearSdkSessionId("telegram:-987");

      // Gone entirely — not lingering as an unlinked entry
      expect(store.listAllSessions()).toHaveLength(0);
      const reloaded = makeSessionStore(TEST_DIR);
      expect(reloaded.getEntry("telegram:-987")).toBeUndefined();
    });

    it("excludes stubs from listSdkSessionIds but lists them as active entries", () => {
      const store = makeSessionStore(TEST_DIR);
      store.setChatTitle("telegram:-987", "Ski Trip");
      store.setSdkSessionId("dm:alice", "session-alice");

      expect(store.listSdkSessionIds()).toEqual([["dm:alice", "session-alice"]]);
      const activeKeys = store.listActiveEntries().map((e) => e.channelKey).sort();
      expect(activeKeys).toEqual(["dm:alice", "telegram:-987"]);
    });
  });
});
