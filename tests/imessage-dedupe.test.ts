import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageGuidDedupeStore } from "../src/channels/imessage-dedupe.js";

const tempDirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tomo-imessage-dedupe-"));
  tempDirs.push(dir);
  return join(dir, "seen-message-guids.json");
}

afterEach(() => {
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

  it("recovers from a corrupt persistence file", () => {
    const file = tempFile();
    writeFileSync(file, "not-json");
    const store = new MessageGuidDedupeStore(file);
    expect(store.checkAndRecord("guid-1", 1_000)).toBe(false);
  });
});
