import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, transcriptFileStem } from "../src/sessions/store.js";
import { readHistoryPage } from "../src/sessions/history-reader.js";
import { WebData } from "../src/web/data.js";
import { webSessionId } from "../src/web/owner.js";

let root: string;
let dirs: { sessionsDir: string; sdkSessionsDir: string };
let store: SessionStore;
const key = "dm:owner";
const timestamp = Date.UTC(2026, 8, 1);
const identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" as const }];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-web-history-"));
  dirs = { sessionsDir: join(root, "sessions"), sdkSessionsDir: join(root, "sdk") };
  store = new SessionStore(dirs.sessionsDir, 20, dirs.sdkSessionsDir);
  store.setSdkSessionId(key, "test-sdk-session");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function state() {
  return Object.fromEntries(readdirSync(dirs.sessionsDir).map((name) => [name, {
    bytes: readFileSync(join(dirs.sessionsDir, name), "utf8"), mtime: statSync(join(dirs.sessionsDir, name)).mtimeMs,
  }]));
}
function row(content: string, time = timestamp, seq = 1) {
  return JSON.stringify({ role: "user", channel: "telegram", content, timestamp: time, seq }) + "\n";
}

describe("store-owned web history reads", () => {
  it("paginates archives and sidecars with overlapping seqs, preserving tied record order without writes", async () => {
    const stem = transcriptFileStem(key);
    writeFileSync(join(dirs.sessionsDir, `${stem}.jsonl`), Array.from({ length: 120 }, (_, i) => row(`active ${i}`, timestamp + i, i + 1)).join(""));
    writeFileSync(join(dirs.sessionsDir, `${stem}.legacy-20260901-000000.jsonl`), row("sidecar", timestamp + 50, 1));
    writeFileSync(join(dirs.sessionsDir, `_archive_${stem}_2026-08.legacy-20260901-000000.jsonl`), row("archive sidecar", timestamp - 1, 1));
    const before = state();
    const newest = await readHistoryPage(dirs, key);
    expect(newest.messages).toHaveLength(100);
    expect(newest.messages.at(-1)?.content).toBe("active 119");
    expect(newest.messages.filter((m) => m.timestamp === timestamp + 50).map((m) => m.content)).toEqual(["sidecar", "active 50"]);
    const older = await readHistoryPage(dirs, key, newest.nextCursor!);
    expect(older.messages).toHaveLength(22); expect(older.messages[0].content).toBe("archive sidecar");
    expect(older.nextCursor).toBeNull();
    expect(new Set([...older.messages, ...newest.messages].map((m) => m.id)).size).toBe(122);
    expect(state()).toEqual(before);
  });
  it("reads full messages beyond watch clipping and fresh context metadata", async () => {
    const content = "detail ".repeat(1000);
    store.append(key, { role: "assistant", content, timestamp, channel: "web" });
    const data = new WebData({ ...dirs, identities });
    expect((await data.history(webSessionId(key))).messages[0].content).toBe(content);
    store.updateStats(key, { costUsd: 0, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsed: 12, contextMax: 100, contextEstimated: true });
    expect(data.catalog().sessions[0].stats).toEqual({ contextUsed: 12, contextMax: 100, contextEstimated: true });
    store.updateStats(key, { costUsd: 0, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsed: 20, contextMax: 100 });
    expect(data.catalog().sessions[0].stats).toEqual({ contextUsed: 20, contextMax: 100, contextEstimated: false });
  });
  it("fails closed for unreadable registries, unknown sessions, invalid cursors and symlinks", async () => {
    const data = new WebData({ ...dirs, identities });
    await expect(data.history(webSessionId("dm:peer"))).rejects.toMatchObject({ status: 404 });
    await expect(readHistoryPage(dirs, key, "not-a-cursor")).rejects.toThrow();
    writeFileSync(join(root, "outside.jsonl"), row("outside"));
    symlinkSync(join(root, "outside.jsonl"), join(dirs.sessionsDir, `${transcriptFileStem(key)}.jsonl`));
    await expect(readHistoryPage(dirs, key)).rejects.toThrow();
    writeFileSync(join(dirs.sessionsDir, "_sessions.json"), "broken");
    expect(() => data.catalog()).toThrow();
    await expect(data.history(webSessionId(key))).rejects.toThrow();
  });
  it("does not create or migrate files during a read-only catalog/history request", async () => {
    const empty = { sessionsDir: join(root, "new"), sdkSessionsDir: dirs.sdkSessionsDir };
    expect(new WebData({ ...empty, identities }).catalog().ownerId).toBe(webSessionId(key));
    expect(readdirSync(root)).not.toContain("new");
    const before = state();
    SessionStore.readSnapshot(dirs.sessionsDir, dirs.sdkSessionsDir);
    await readHistoryPage(dirs, key);
    expect(state()).toEqual(before);
  });
  it("retains a stable owner selection across legacy-to-DM migration", async () => {
    const legacy = "telegram:test-owner";
    const other = { sessionsDir: join(root, "legacy"), sdkSessionsDir: dirs.sdkSessionsDir };
    const legacyStore = new SessionStore(other.sessionsDir, 20, other.sdkSessionsDir);
    legacyStore.setSdkSessionId(legacy, "test-legacy-sdk-session"); legacyStore.append(legacy, { role: "user", content: "Legacy text", timestamp, channel: "telegram" });
    const data = new WebData({ ...other, identities });
    expect(data.catalog().ownerId).toBe(webSessionId(key));
    expect((await data.history(webSessionId(key))).messages[0].content).toBe("Legacy text");
    legacyStore.migrateSessionKey(legacy, key);
    expect(data.catalog().ownerId).toBe(webSessionId(key));
    expect((await data.history(webSessionId(key))).messages[0].content).toBe("Legacy text");
  });
});
