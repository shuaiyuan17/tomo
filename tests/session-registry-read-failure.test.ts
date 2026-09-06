import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SessionStore as SessionStoreImpl,
  SessionRegistryReadError,
} from "../src/sessions/store.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SessionStore as RawSessionStore } from "../src/sessions/store.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-registry-read-failure");
const REGISTRY = join(TEST_DIR, "_sessions.json");

class SessionStore extends SessionStoreImpl {
  constructor(dir: string, historyLimit = 20, sdkSessionsDir = join(dir, "sdk-sessions")) {
    super(dir, historyLimit, sdkSessionsDir);
  }
}

const STATS = {
  costUsd: 0.01,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  contextUsed: 10,
  contextMax: 100,
};

/** A store with three linked sessions on disk, as a long-running daemon has. */
function seed(): SessionStore {
  const store = new SessionStore(TEST_DIR);
  store.setSdkSessionId("telegram:1", "sdk-aaa");
  store.setSdkSessionId("telegram:2", "sdk-bbb");
  store.setSdkSessionId("imessage:3", "sdk-ccc");
  return store;
}

describe("session registry read failure", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try { chmodSync(TEST_DIR, 0o755); } catch { /* may not exist */ }
    try { chmodSync(REGISTRY, 0o644); } catch { /* may not exist */ }
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does not overwrite a corrupt registry when any mutator runs", () => {
    const store = seed();
    const good = readFileSync(REGISTRY, "utf-8");

    // The file goes bad underneath a running daemon (half-restored backup,
    // interrupted external writer, bit rot).
    const corrupt = good.slice(0, Math.floor(good.length / 2));
    writeFileSync(REGISTRY, corrupt);

    // Bookkeeping mutators skip silently; link-changing mutators refuse
    // loudly. Neither may publish anything.
    store.updateStats("telegram:1", STATS);
    store.touchSession("telegram:2");
    store.setChatTitle("telegram:2", "Chat");
    store.addParticipant("telegram:2", "Ada");
    store.setReplyTarget("telegram:2", { channelName: "telegram", chatId: "2" });

    expect(() => store.setSdkSessionId("telegram:9", "sdk-new")).toThrow(SessionRegistryReadError);
    expect(() => store.clearSdkSessionId("telegram:1")).toThrow(SessionRegistryReadError);
    expect(() => store.retireSdkSessionId("telegram:1")).toThrow(SessionRegistryReadError);
    expect(() => store.migrateSessionKey("telegram:1", "identity:me")).toThrow(SessionRegistryReadError);

    expect(readFileSync(REGISTRY, "utf-8")).toBe(corrupt);
  });

  it("never throws from a bookkeeping mutator, whatever the failure", () => {
    // These sit on the inbound path (addParticipant runs before the message is
    // appended, and the rejection is swallowed upstream) and on the
    // turn-completion path (updateStats runs after the model already
    // answered). A throw drops a message or fails a successful turn.
    const store = seed();
    writeFileSync(REGISTRY, "{ not json");

    expect(() => store.updateStats("telegram:1", STATS)).not.toThrow();
    expect(() => store.touchSession("telegram:1")).not.toThrow();
    expect(() => store.setChatTitle("telegram:1", "Title")).not.toThrow();
    expect(() => store.addParticipant("telegram:1", "Ada", "u1")).not.toThrow();
    expect(() => store.setReplyTarget("telegram:1", { channelName: "telegram", chatId: "1" })).not.toThrow();
    // ...including for a key that has no entry yet, where the bookkeeping
    // path would otherwise create a stub it cannot persist.
    expect(() => store.setChatTitle("telegram:new", "Fresh")).not.toThrow();
    expect(() => store.addParticipant("telegram:new", "Bob")).not.toThrow();
  });

  it("leaves no un-persisted mutation behind in memory", () => {
    const store = seed();
    writeFileSync(REGISTRY, "{ not json");

    // A refused link change must not have already applied itself: the probe
    // is that the link still resolves the way it did before the refusal.
    expect(() => store.clearSdkSessionId("telegram:1")).toThrow(SessionRegistryReadError);
    expect(store.getSdkSessionId("telegram:1")).toBe("sdk-aaa");

    expect(() => store.retireSdkSessionId("telegram:2")).toThrow(SessionRegistryReadError);
    expect(store.getSdkSessionId("telegram:2")).toBe("sdk-bbb");

    expect(() => store.setSdkSessionId("telegram:1", "sdk-other")).toThrow(SessionRegistryReadError);
    expect(store.getSdkSessionId("telegram:1")).toBe("sdk-aaa");

    // A skipped bookkeeping write must not leave a stub entry either.
    store.setChatTitle("telegram:new", "Fresh");
    store.addParticipant("telegram:new", "Bob");
    expect(store.listActiveEntries()).toHaveLength(3);
    expect(store.listActiveEntries().map((e) => e.channelKey)).not.toContain("telegram:new");
  });

  it("resumes bookkeeping writes once the file is readable again", () => {
    const store = seed();
    const good = readFileSync(REGISTRY, "utf-8");

    writeFileSync(REGISTRY, "{ not json");
    store.setChatTitle("telegram:1", "Skipped");
    expect(readFileSync(REGISTRY, "utf-8")).toBe("{ not json");

    writeFileSync(REGISTRY, good);
    store.setChatTitle("telegram:1", "Applied");
    const onDisk = JSON.parse(readFileSync(REGISTRY, "utf-8"));
    expect(onDisk.sessions.find((e: { channelKey: string }) => e.channelKey === "telegram:1").chatTitle)
      .toBe("Applied");
  });

  it("keeps the last known-good state in memory instead of reading as empty", () => {
    const store = seed();
    writeFileSync(REGISTRY, "{ not json");

    // Reads still answer from the last good load — the alternative is telling
    // the caller there is no SDK session, which cold-starts a new one and
    // orphans the old JSONL.
    expect(store.getSdkSessionId("telegram:1")).toBe("sdk-aaa");
    expect(store.listActiveEntries()).toHaveLength(3);
  });

  it("loads correctly once the file is readable again, and resumes persisting", () => {
    const store = seed();
    const good = readFileSync(REGISTRY, "utf-8");

    writeFileSync(REGISTRY, "}}}}");
    expect(() => store.setSdkSessionId("telegram:9", "sdk-x")).toThrow(SessionRegistryReadError);

    // The transient condition clears.
    writeFileSync(REGISTRY, good);

    expect(store.getSdkSessionId("telegram:1")).toBe("sdk-aaa");
    expect(store.getSdkSessionId("telegram:2")).toBe("sdk-bbb");
    expect(store.getSdkSessionId("imessage:3")).toBe("sdk-ccc");

    // And a mutation now persists again.
    store.setSdkSessionId("telegram:4", "sdk-ddd");
    const onDisk = JSON.parse(readFileSync(REGISTRY, "utf-8"));
    expect(onDisk.sessions.map((e: { sdkSessionId: string }) => e.sdkSessionId).sort())
      .toEqual(["sdk-aaa", "sdk-bbb", "sdk-ccc", "sdk-ddd"]);

    // A fresh process sees the same thing.
    expect(new SessionStore(TEST_DIR).getSdkSessionId("telegram:2")).toBe("sdk-bbb");
  });

  it("refuses to persist when the registry is unreadable rather than unparseable", () => {
    const store = seed();
    if (process.getuid?.() === 0) return; // root reads everything

    // An external writer updates the registry (so the stat cache misses and we
    // must actually read it) and the read then fails — the EACCES/EMFILE/EIO
    // case, where the bytes on disk are perfectly good and simply out of reach.
    const updated = readFileSync(REGISTRY, "utf-8").replace("sdk-aaa", "sdk-aaa-v2");
    writeFileSync(REGISTRY, updated);
    chmodSync(REGISTRY, 0o000);

    expect(() => store.setSdkSessionId("telegram:9", "sdk-x")).toThrow(SessionRegistryReadError);

    chmodSync(REGISTRY, 0o644);
    expect(readFileSync(REGISTRY, "utf-8")).toBe(updated);
    // ...and the external writer's version is what we pick up once it is
    // readable again, not the stale copy we were holding.
    expect(store.getSdkSessionId("telegram:1")).toBe("sdk-aaa-v2");
  });

  it("treats a valid-JSON registry with no session array as a failure, not as empty", () => {
    const store = seed();
    const corrupt = '{"version":1,"sessions":"oops"}';
    writeFileSync(REGISTRY, corrupt);
    expect(() => store.setSdkSessionId("telegram:9", "sdk-x")).toThrow(SessionRegistryReadError);
    expect(readFileSync(REGISTRY, "utf-8")).toBe(corrupt);
  });

  it("still treats an absent registry as legitimately empty", () => {
    const store = new SessionStore(TEST_DIR);
    expect(store.listActiveEntries()).toEqual([]);
    store.setSdkSessionId("telegram:1", "sdk-aaa");
    expect(JSON.parse(readFileSync(REGISTRY, "utf-8")).sessions).toHaveLength(1);
  });

  it("recovers when the registry is deleted while unreadable", () => {
    const store = seed();
    writeFileSync(REGISTRY, "nope");
    expect(() => store.setSdkSessionId("telegram:9", "sdk-x")).toThrow(SessionRegistryReadError);

    // `tomo sessions clear` removing the file is a legitimate empty state.
    rmSync(REGISTRY);
    store.setSdkSessionId("telegram:5", "sdk-eee");
    expect(JSON.parse(readFileSync(REGISTRY, "utf-8")).sessions).toHaveLength(4);
  });

  it("treats a 0-byte registry as empty when nothing is held, and refuses when something is", () => {
    // JSON.parse("") throws, so without special handling a truncated file is a
    // permanent refusal with no way back.

    // Nothing held (an interrupted first write on a fresh install): empty and
    // writable, so it self-heals.
    writeFileSync(REGISTRY, "");
    const fresh = new SessionStore(TEST_DIR);
    expect(fresh.listActiveEntries()).toEqual([]);
    fresh.setSdkSessionId("telegram:1", "sdk-aaa");
    expect(JSON.parse(readFileSync(REGISTRY, "utf-8")).sessions).toHaveLength(1);

    // Sessions held (something truncated a real registry): refuse.
    const store = seed();
    writeFileSync(REGISTRY, "");
    expect(() => store.setSdkSessionId("telegram:9", "sdk-new")).toThrow(SessionRegistryReadError);
    expect(readFileSync(REGISTRY, "utf-8")).toBe("");
    expect(store.getSdkSessionId("telegram:1")).toBe("sdk-aaa");

    // Documented recovery: delete the file, which reads as ENOENT = empty.
    rmSync(REGISTRY);
    store.setSdkSessionId("telegram:9", "sdk-new");
    expect(JSON.parse(readFileSync(REGISTRY, "utf-8")).sessions.length).toBeGreaterThan(0);
  });

  it("never deletes an SDK session file from a registry it could not read", () => {
    const store = seed();
    const sdkDir = join(TEST_DIR, "sdk-sessions");
    mkdirSync(sdkDir, { recursive: true });
    const sdkFile = join(sdkDir, "sdk-aaa.jsonl");
    writeFileSync(sdkFile, "{}\n");

    // Expire the entry on disk, then make the file unreadable, then start a
    // process — cleanupExpired runs from the constructor and unlinks JSONLs.
    const parsed = JSON.parse(readFileSync(REGISTRY, "utf-8"));
    for (const e of parsed.sessions) { e.unlinkedAt = 1; e.expiresAt = 1; }
    writeFileSync(REGISTRY, JSON.stringify(parsed));
    const expired = readFileSync(REGISTRY, "utf-8");
    writeFileSync(REGISTRY, "{ not json");

    new SessionStore(TEST_DIR);
    expect(existsSync(sdkFile)).toBe(true);
    expect(readFileSync(REGISTRY, "utf-8")).toBe("{ not json");

    // Control: with the same registry readable, it does get cleaned up.
    writeFileSync(REGISTRY, expired);
    new SessionStore(TEST_DIR);
    expect(existsSync(sdkFile)).toBe(false);
    void store;
  });

  it.skipIf(process.getuid?.() === 0)("never throws from a bookkeeping mutator when the SAVE fails, and publishes once it can", () => {
    // Not a read failure: the file is fine, the directory refuses new files
    // (writeJsonAtomicSync writes a temp file beside it). updateStats runs
    // after the model has answered; a throw here fails a good turn.
    const store = seed();
    chmodSync(TEST_DIR, 0o500);
    try {
      expect(() => store.updateStats("telegram:1", STATS)).not.toThrow();
      expect(() => store.updateStats("telegram:1", STATS)).not.toThrow();
      expect(() => store.touchSession("telegram:2")).not.toThrow();
      expect(() => store.addParticipant("telegram:1", "Ann")).not.toThrow();
      // The change is held in memory…
      expect(store.getEntry("telegram:1")?.stats?.totalQueries).toBe(2);
    } finally {
      chmodSync(TEST_DIR, 0o755);
    }
    // …and published by the next save that succeeds.
    store.touchSession("telegram:1");
    const onDisk = JSON.parse(readFileSync(REGISTRY, "utf-8")) as { sessions: Array<{ channelKey: string; stats: { totalQueries: number } }> };
    expect(onDisk.sessions.find((e) => e.channelKey === "telegram:1")?.stats.totalQueries).toBe(2);
  });

  it("constructs without throwing when the registry is unreadable at startup", () => {
    seed();
    writeFileSync(REGISTRY, "{{{");
    // A read error at boot must not take the daemon down...
    const store = new SessionStore(TEST_DIR);
    // ...but nothing may be written from the empty state it starts with.
    expect(() => store.setSdkSessionId("telegram:1", "sdk-zzz")).toThrow(SessionRegistryReadError);
    expect(readFileSync(REGISTRY, "utf-8")).toBe("{{{");
  });
});

// ---------------------------------------------------------------------------
// The OTHER direction: the registry reads fine and cannot be WRITTEN. This one
// runs from the constructor, where a throw is not a failed housekeeping pass —
// it is a daemon that does not start.
// ---------------------------------------------------------------------------

describe("expired-session cleanup at construction", () => {
  const SDK_DIR = join(TEST_DIR, "sdk");

  beforeEach(() => {
    mkdirSync(SDK_DIR, { recursive: true });
  });

  afterEach(() => {
    try { chmodSync(TEST_DIR, 0o755); } catch { /* may not exist */ }
  });

  it("does not stop the daemon starting when the cleanup cannot be persisted", () => {
    const past = Date.now() - 60_000;
    writeFileSync(join(SDK_DIR, "sdk-old.jsonl"), "{}\n");
    writeFileSync(REGISTRY, JSON.stringify({
      version: 1,
      sessions: [{
        sdkSessionId: "sdk-old",
        channelKey: "telegram:1",
        createdAt: past - 1_000,
        lastActiveAt: past - 1_000,
        unlinkedAt: past - 1_000,
        expiresAt: past,
        stats: {
          totalQueries: 0,
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          contextUsed: 0,
          contextMax: 0,
        },
      }],
    }));
    const before = readFileSync(REGISTRY, "utf-8");

    // ENOSPC / EACCES / a read-only volume, whichever way it arrives: the
    // atomic write cannot create its temp file next to the registry.
    chmodSync(TEST_DIR, 0o555);

    let store: RawSessionStore | undefined;
    expect(() => { store = new RawSessionStore(TEST_DIR, 20, SDK_DIR); }).not.toThrow();

    // It really did get as far as the unlink — this is the point the header
    // on cleanupExpired is written about.
    expect(existsSync(join(SDK_DIR, "sdk-old.jsonl"))).toBe(false);
    // The failed write changed nothing on disk, and the store is usable.
    expect(readFileSync(REGISTRY, "utf-8")).toBe(before);
    expect(store?.getSdkSessionId("telegram:1")).toBeUndefined();
  });
});
