import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageGuidDedupeStore } from "../src/channels/imessage-dedupe.js";
import { log } from "../src/logger.js";

const tempDirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tomo-imessage-dedupe-"));
  tempDirs.push(dir);
  return join(dir, "seen-message-guids.json");
}

const persistedGuids = (file: string): string[] =>
  (JSON.parse(readFileSync(file, "utf-8")) as { entries: Array<{ guid: string }> }).entries.map((e) => e.guid);

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MessageGuidDedupeStore", () => {
  it("dedupes a GUID across store instances", () => {
    const file = tempFile();
    const first = new MessageGuidDedupeStore(file);
    expect(first.checkAndRecord("guid-1", 1_000_000)).toBe(false);
    expect(first.checkAndRecord("guid-1", 1_000_001)).toBe(true);

    const afterRestart = new MessageGuidDedupeStore(file);
    expect(afterRestart.checkAndRecord("guid-1", 1_000_002)).toBe(true);
  });

  it("accepts a GUID again after its TTL expires", () => {
    const store = new MessageGuidDedupeStore(null, { ttlMs: 100 });
    expect(store.checkAndRecord("guid-1", 1_000)).toBe(false);
    expect(store.checkAndRecord("guid-1", 1_100)).toBe(true);
    expect(store.checkAndRecord("guid-1", 1_101)).toBe(false);
  });

  it("evicts the oldest GUID when the hard cap is reached", () => {
    const store = new MessageGuidDedupeStore(null, { maxEntries: 2 });
    expect(store.checkAndRecord("guid-1", 1)).toBe(false);
    expect(store.checkAndRecord("guid-2", 2)).toBe(false);
    expect(store.checkAndRecord("guid-3", 3)).toBe(false);
    expect(store.checkAndRecord("guid-1", 4)).toBe(false);
    expect(store.checkAndRecord("guid-3", 5)).toBe(true);
  });

  it("recovers from a corrupt persistence file, and the next record persists over it", () => {
    const file = tempFile();
    writeFileSync(file, "not-json");
    const store = new MessageGuidDedupeStore(file);
    expect(store.checkAndRecord("guid-1", 1_000)).toBe(false);
    expect(persistedGuids(file)).toEqual(["guid-1"]);
    expect(new MessageGuidDedupeStore(file).has("guid-1", 1_001)).toBe(true);
  });

  // The imsg channel's at-least-once path: `has()` before dispatch, `record()`
  // only after the hand-off succeeded (checkAndRecord is for reactions only).
  describe("has / record", () => {
    it("has() only looks: a GUID it was asked about is still unseen", () => {
      const file = tempFile();
      const store = new MessageGuidDedupeStore(file);
      expect(store.has("guid-1", 1_000)).toBe(false);
      expect(store.has("guid-1", 1_001)).toBe(false);
      expect(store.checkAndRecord("guid-1", 1_002)).toBe(false);
    });

    it("record() is idempotent and persists, keeping the first sighting", () => {
      const file = tempFile();
      const store = new MessageGuidDedupeStore(file, { ttlMs: 100 });
      store.record("guid-1", 1_000);
      store.record("guid-1", 1_050); // a second record does not refresh the TTL
      expect(store.has("guid-1", 1_100)).toBe(true);
      expect(store.has("guid-1", 1_101)).toBe(false);
      expect(persistedGuids(file)).toEqual(["guid-1"]);
    });

    it("has() prunes entries past their TTL", () => {
      const file = tempFile();
      const store = new MessageGuidDedupeStore(file, { ttlMs: 100 });
      store.record("guid-1", 1_000);
      expect(store.has("guid-1", 1_100)).toBe(true);
      expect(store.has("guid-1", 1_101)).toBe(false);
      // Pruned for good, not just hidden: a later lookup inside the old window
      // does not bring it back.
      expect(store.has("guid-1", 1_050)).toBe(false);
    });

    it("keeps working in memory when it cannot persist, and warns once", () => {
      // A regular file where the parent directory should be: mkdir fails with
      // ENOTDIR for root too, unlike a chmod.
      const blocker = tempFile();
      writeFileSync(blocker, "");
      const warn = vi.spyOn(log, "warn");
      const store = new MessageGuidDedupeStore(join(blocker, "seen.json"));

      expect(() => store.record("guid-1", 1_000)).not.toThrow();
      expect(() => store.record("guid-2", 1_001)).not.toThrow();
      expect(store.has("guid-1", 1_002)).toBe(true);
      expect(store.checkAndRecord("guid-2", 1_003)).toBe(true);
      expect(warn.mock.calls.filter(([, msg]) => typeof msg === "string" && msg.includes("Could not persist"))).toHaveLength(1);
    });
  });
});
