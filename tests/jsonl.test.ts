import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { iterateJsonlBackwardsSync, readJsonlTailSync, readFirstJsonlRecordSync } from "../src/jsonl.js";

const TEST_DIR = join(tmpdir(), "tomo-test-jsonl");

describe("jsonl backward reading", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function writeRecords(name: string, records: unknown[]): string {
    const file = join(TEST_DIR, name);
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return file;
  }

  it("iterates records newest-first across chunk boundaries", () => {
    const records = Array.from({ length: 500 }, (_, i) => ({ i, pad: "x".repeat(50) }));
    const file = writeRecords("many.jsonl", records);

    // Tiny chunk size forces lines to straddle read boundaries.
    const seen = [...iterateJsonlBackwardsSync<{ i: number }>(file, 64)].map((r) => r.i);
    expect(seen).toEqual(records.map((r) => r.i).reverse());
  });

  it("preserves multi-byte UTF-8 characters that straddle chunk boundaries", () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ i, text: "日本語テキスト🎌".repeat(3) }));
    const file = writeRecords("utf8.jsonl", records);

    // A chunk size not aligned to the multi-byte sequences guarantees splits
    // inside characters.
    for (const record of iterateJsonlBackwardsSync<{ text: string }>(file, 37)) {
      expect(record.text).toBe("日本語テキスト🎌".repeat(3));
    }
    expect([...iterateJsonlBackwardsSync(file, 37)]).toHaveLength(50);
  });

  it("skips malformed lines and handles a line larger than the chunk size", () => {
    const big = { i: 1, pad: "y".repeat(5000) };
    const file = join(TEST_DIR, "mixed.jsonl");
    writeFileSync(file, [
      JSON.stringify({ i: 0 }),
      "{not json",
      JSON.stringify(big),
      "",
      JSON.stringify({ i: 2 }),
    ].join("\n") + "\n");

    const seen = [...iterateJsonlBackwardsSync<{ i: number }>(file, 64)].map((r) => r.i);
    expect(seen).toEqual([2, 1, 0]);
  });

  it("yields nothing for a missing or empty file", () => {
    expect([...iterateJsonlBackwardsSync(join(TEST_DIR, "nope.jsonl"))]).toEqual([]);
    const empty = join(TEST_DIR, "empty.jsonl");
    writeFileSync(empty, "");
    expect([...iterateJsonlBackwardsSync(empty)]).toEqual([]);
  });

  it("readJsonlTailSync returns the last N records in file order", () => {
    const file = writeRecords("tail.jsonl", Array.from({ length: 20 }, (_, i) => ({ i })));

    const tail = readJsonlTailSync<{ i: number }>(file, 5);
    expect(tail.map((r) => r.i)).toEqual([15, 16, 17, 18, 19]);

    // Shorter file than N → everything
    expect(readJsonlTailSync<{ i: number }>(file, 100)).toHaveLength(20);
  });

  it("readFirstJsonlRecordSync returns the first parseable record", () => {
    const file = join(TEST_DIR, "first.jsonl");
    writeFileSync(file, ["garbage line", JSON.stringify({ i: 7 }), JSON.stringify({ i: 8 })].join("\n") + "\n");

    expect(readFirstJsonlRecordSync<{ i: number }>(file)?.i).toBe(7);
    expect(readFirstJsonlRecordSync(join(TEST_DIR, "nope.jsonl"))).toBeUndefined();
  });
});
