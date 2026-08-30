import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SessionStore as SessionStoreImpl,
  SessionRegistryReadError,
} from "../src/sessions/store.js";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    try { chmodSync(REGISTRY, 0o644); } catch { /* may not exist */ }
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does not overwrite a corrupt registry when a mutator runs", () => {
    const store = seed();
    const good = readFileSync(REGISTRY, "utf-8");

    // The file goes bad underneath a running daemon (half-restored backup,
    // interrupted external writer, bit rot).
    const corrupt = good.slice(0, Math.floor(good.length / 2));
    writeFileSync(REGISTRY, corrupt);

    // Every mutator is loadRegistry() + saveRegistry(). None of them may
    // publish anything.
    expect(() => store.updateStats("telegram:1", STATS)).toThrow(SessionRegistryReadError);
    expect(() => store.touchSession("telegram:2")).toThrow(SessionRegistryReadError);
    expect(() => store.setChatTitle("telegram:2", "Chat")).toThrow(SessionRegistryReadError);
    expect(() => store.setSdkSessionId("telegram:9", "sdk-new")).toThrow(SessionRegistryReadError);
    expect(() => store.clearSdkSessionId("telegram:1")).toThrow(SessionRegistryReadError);

    expect(readFileSync(REGISTRY, "utf-8")).toBe(corrupt);
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
    expect(() => store.touchSession("telegram:1")).toThrow(SessionRegistryReadError);

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

    expect(() => store.touchSession("telegram:1")).toThrow(SessionRegistryReadError);

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
    expect(() => store.touchSession("telegram:1")).toThrow(SessionRegistryReadError);
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
    expect(() => store.touchSession("telegram:1")).toThrow(SessionRegistryReadError);

    // `tomo sessions clear` removing the file is a legitimate empty state.
    rmSync(REGISTRY);
    store.setSdkSessionId("telegram:5", "sdk-eee");
    expect(JSON.parse(readFileSync(REGISTRY, "utf-8")).sessions).toHaveLength(4);
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
