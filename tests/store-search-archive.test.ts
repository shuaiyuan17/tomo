import { afterAll, beforeEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/sessions/store.js";

const ROOT = mkdtempSync(join(tmpdir(), "tomo-test-search-archive-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const SDK_ID = "11111111-2222-3333-4444-555555555555";
let dir: string;
let store: SessionStore;

function writeArchive(lines: string[]): void {
  writeFileSync(join(dir, `_archive_${SDK_ID}.jsonl`), lines.join("\n") + "\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(ROOT, "case-"));
  mkdirSync(join(dir, "sdk-sessions"), { recursive: true });
  store = new SessionStore(dir, 20, join(dir, "sdk-sessions"));
});

describe("SessionStore.searchArchive", () => {
  it("returns nothing when there is no archive", () => {
    expect(store.searchArchive(SDK_ID, {})).toEqual([]);
  });

  it("reads string content", () => {
    writeArchive([
      JSON.stringify({ type: "user", timestamp: "2026-01-02T03:04:05.000Z", message: { role: "user", content: "  plain words  " } }),
    ]);
    expect(store.searchArchive(SDK_ID, {})).toEqual([
      { role: "user", content: "plain words", channel: "archive", timestamp: Date.parse("2026-01-02T03:04:05.000Z") },
    ]);
  });

  it("joins text blocks with a space and ignores other blocks", () => {
    writeArchive([
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "first" },
            { type: "tool_use", name: "Bash", input: {} },
            { type: "text", text: "second" },
          ],
        },
      }),
    ]);
    const [hit] = store.searchArchive(SDK_ID, {});
    expect(hit.role).toBe("assistant");
    expect(hit.content).toBe("first second");
    expect(hit.timestamp).toBe(0);
  });

  it("skips malformed lines and non-conversation events", () => {
    writeArchive([
      "{not json",
      "null",
      "42",
      JSON.stringify({ type: "system", message: { role: "user", content: "system noise" } }),
      JSON.stringify({ type: "user" }),
      JSON.stringify({ type: "user", message: { role: "user", content: 7 } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "out" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "survivor" } }),
    ]);
    expect(store.searchArchive(SDK_ID, {}).map((m) => m.content)).toEqual(["survivor"]);
  });

  it("filters by query (case-insensitive) and respects limit", () => {
    writeArchive([
      JSON.stringify({ type: "user", message: { role: "user", content: "Coffee one" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "tea" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "coffee two" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "COFFEE three" } }),
    ]);
    expect(store.searchArchive(SDK_ID, { query: "coffee", limit: 2 }).map((m) => m.content)).toEqual(["Coffee one", "coffee two"]);
  });
});
