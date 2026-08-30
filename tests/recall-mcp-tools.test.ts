import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/sessions/store.js";
import { RECALL_FOREIGN_AUDIENCE_REFUSAL, buildRecallTools, formatRecallResults } from "../src/mcp/recall-tools.js";
import type { SessionMessage } from "../src/sessions/types.js";

const TEST_DIR = join(tmpdir(), "tomo-test-recall-mcp");
const SESSION_KEY = "dm:alice";

interface ToolHandle {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function makeTool(store: SessionStore, sessionKey = SESSION_KEY): ToolHandle {
  const tools = buildRecallTools({
    search: (opts) => store.searchTranscript(sessionKey, opts),
  }) as unknown as ToolHandle[];
  const found = tools.find((t) => t.name === "recall_conversation");
  if (!found) throw new Error("recall_conversation tool not found");
  return found;
}

function seedMessage(store: SessionStore, overrides: Partial<SessionMessage> = {}): void {
  store.append(SESSION_KEY, {
    role: "user",
    content: "hello",
    channel: "telegram",
    timestamp: Date.now(),
    ...overrides,
  });
}

describe("recall_conversation MCP tool", () => {
  let store: SessionStore;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = new SessionStore(TEST_DIR, 20, join(TEST_DIR, "sdk-sessions"));
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("finds messages by case-insensitive substring", async () => {
    seedMessage(store, { content: "Let's try that new RAMEN place on 5th", senderName: "Alice", timestamp: 1000 });
    seedMessage(store, { role: "assistant", content: "Sounds good, booked for Friday", timestamp: 2000 });
    seedMessage(store, { content: "unrelated chatter", senderName: "Alice", timestamp: 3000 });

    const result = await makeTool(store).handler({ query: "ramen", limit: 20 }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("1 message(s)");
    expect(result.content[0].text).toContain("RAMEN place");
    expect(result.content[0].text).toContain("user (Alice)");
    expect(result.content[0].text).not.toContain("unrelated chatter");
  });

  it("filters by time range", async () => {
    const may1 = Date.parse("2026-05-01T12:00:00Z");
    const june1 = Date.parse("2026-06-01T12:00:00Z");
    seedMessage(store, { content: "may message", timestamp: may1 });
    seedMessage(store, { content: "june message", timestamp: june1 });

    const result = await makeTool(store).handler({
      after: "2026-05-15",
      limit: 20,
    }, {});

    expect(result.content[0].text).toContain("june message");
    expect(result.content[0].text).not.toContain("may message");
  });

  it("returns the most recent matches when over the limit, with a paging hint", async () => {
    for (let i = 1; i <= 5; i++) {
      seedMessage(store, { content: `note number ${i}`, timestamp: i * 1000 });
    }

    const result = await makeTool(store).handler({ query: "note", limit: 3 }, {});

    const text = result.content[0].text;
    expect(text).toContain("note number 3");
    expect(text).toContain("note number 5");
    expect(text).not.toContain("note number 2");
    expect(text).toContain("limit");
    expect(text).toContain("before");
  });

  it("truncates oversized message content in results", async () => {
    seedMessage(store, { content: `needle ${"x".repeat(2000)}`, timestamp: 1000 });

    const result = await makeTool(store).handler({ query: "needle", limit: 20 }, {});

    expect(result.content[0].text).toContain("[truncated]");
    expect(result.content[0].text.length).toBeLessThan(1000);
  });

  it("reports no matches without erroring", async () => {
    seedMessage(store, { content: "hello", timestamp: 1000 });

    const result = await makeTool(store).handler({ query: "zebra", limit: 20 }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No matching messages");
  });

  it("rejects malformed time bounds with a helpful error", async () => {
    const result = await makeTool(store).handler({ query: "x", after: "not-a-date", limit: 20 }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ISO 8601");
  });

  it("rejects an inverted time range", async () => {
    const result = await makeTool(store).handler({
      after: "2026-06-01",
      before: "2026-05-01",
      limit: 20,
    }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("later than");
  });

  it("skips transcript records without string content instead of throwing", async () => {
    seedMessage(store, { content: "good record", timestamp: 1000 });
    // Simulate a corrupt/legacy line written directly to the transcript file.
    appendFileSync(
      join(TEST_DIR, "dm_alice.jsonl"),
      JSON.stringify({ role: "user", channel: "telegram", timestamp: 2000 }) + "\n",
    );
    const freshStore = new SessionStore(TEST_DIR, 20, join(TEST_DIR, "sdk-sessions"));

    const result = await makeTool(freshStore).handler({ query: "good", limit: 20 }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("good record");
  });

  it("skips transcript records without string content when browsing without a query", async () => {
    seedMessage(store, { content: "good record", timestamp: 1000 });
    // Simulate a corrupt/legacy line written directly to the transcript file.
    appendFileSync(
      join(TEST_DIR, "dm_alice.jsonl"),
      JSON.stringify({ role: "user", channel: "telegram", timestamp: 2000 }) + "\n",
    );
    const freshStore = new SessionStore(TEST_DIR, 20, join(TEST_DIR, "sdk-sessions"));

    const result = await makeTool(freshStore).handler({ limit: 20 }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("good record");
  });
});

// The transcript bound to this tool is the session's own — which, while a
// group is summoned into a dm: session, is the OWNER's private DM history
// with a group steering the turn. `canSearch` is that gate.
describe("recall_conversation audience gate", () => {
  let store: SessionStore;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = new SessionStore(TEST_DIR, 20, join(TEST_DIR, "sdk-sessions"));
    seedMessage(store, { content: "the safe-deposit box code is 4417", timestamp: 1000 });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function gatedTool(canSearch: () => boolean): ToolHandle {
    let searched = 0;
    const tools = buildRecallTools({
      search: (opts) => { searched++; return store.searchTranscript(SESSION_KEY, opts); },
      canSearch,
    }) as unknown as ToolHandle[];
    const found = tools.find((t) => t.name === "recall_conversation");
    if (!found) throw new Error("recall_conversation tool not found");
    return Object.assign(found, { searchCount: () => searched }) as ToolHandle & { searchCount(): number };
  }

  it("refuses, and does not touch the transcript, when the turn is not this session's own", async () => {
    const tool = gatedTool(() => false) as ToolHandle & { searchCount(): number };

    const result = await tool.handler({ query: "safe-deposit", limit: 20 }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("recall is unavailable while a group is summoned into this session");
    expect(result.content[0].text).toContain(RECALL_FOREIGN_AUDIENCE_REFUSAL);
    // The refusal leaks nothing, not even a match count.
    expect(result.content[0].text).not.toContain("4417");
    expect(tool.searchCount()).toBe(0);
  });

  it("refuses before argument validation, so the refusal is the only outcome", async () => {
    // A malformed `after` would otherwise be reported first, telling a group
    // caller their query WOULD have run.
    const tool = gatedTool(() => false);
    const result = await tool.handler({ query: "safe-deposit", after: "not-a-date", limit: 20 }, {});

    expect(result.content[0].text).toContain("recall is unavailable");
    expect(result.content[0].text).not.toContain("Invalid after time");
  });

  it("is resolved per call, so the same tool works again once the summon ends", async () => {
    // One MCP server is built per live session and reused across turns.
    let own = false;
    const tool = gatedTool(() => own);

    expect((await tool.handler({ query: "safe-deposit", limit: 20 }, {})).isError).toBe(true);

    own = true;
    const allowed = await tool.handler({ query: "safe-deposit", limit: 20 }, {});
    expect(allowed.isError).toBeFalsy();
    expect(allowed.content[0].text).toContain("4417");
  });

  it("allows recall when no gate is supplied", async () => {
    const result = await makeTool(store).handler({ query: "safe-deposit", limit: 20 }, {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("4417");
  });
});

describe("formatRecallResults", () => {
  it("labels roles and includes seq numbers when present", () => {
    const text = formatRecallResults([
      { role: "user", content: "hi", channel: "telegram", timestamp: 1000, senderName: "Alice", seq: 7 },
      { role: "assistant", content: "hello", channel: "telegram", timestamp: 2000, seq: 8 },
    ], 20);

    expect(text).toContain("#7 user (Alice): hi");
    expect(text).toContain("#8 assistant: hello");
  });

  it("formats invalid timestamps as unknown-time", () => {
    const text = formatRecallResults([
      { role: "user", content: "hi", channel: "telegram", timestamp: NaN },
    ], 20);

    expect(text).toContain("[unknown-time]");
  });
});
