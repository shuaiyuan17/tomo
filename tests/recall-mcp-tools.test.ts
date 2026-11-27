import { afterAll, describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, transcriptFileStem } from "../src/sessions/store.js";
import {
  RECALL_FOREIGN_AUDIENCE_REFUSAL, buildRecallTools, formatRecallHits, formatRecallResults,
  type RecallSearchOutcome, type RecallToolDeps,
} from "../src/mcp/recall-tools.js";
import type { SessionMessage } from "../src/sessions/types.js";

const TEST_DIR = mkdtempSync(join(tmpdir(), "tomo-test-recall-mcp-"));
// The root is unique to this run, so nothing else will clean it up.
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
const SESSION_KEY = "dm:alice";
const DAY_MS = 24 * 60 * 60 * 1000;
/** "Now" for the tool, fixed so the default 365-day window does not move. */
const NOW = Date.parse("2026-09-01T00:00:00Z");
/** A recent moment well inside that window; seeded messages count up from it. */
const T0 = NOW - 30 * DAY_MS;

interface ToolHandle {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function makeTool(store: SessionStore, sessionKey = SESSION_KEY, extra: Partial<RecallToolDeps> = {}): ToolHandle {
  const tools = buildRecallTools({
    search: (opts) => store.searchTranscript(sessionKey, opts),
    recall: (opts) => store.recallTranscript(sessionKey, opts),
    now: () => NOW,
    ...extra,
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
    timestamp: T0,
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

  it("finds messages by a word, whatever its case", async () => {
    seedMessage(store, { content: "Let's try that new RAMEN place on 5th", senderName: "Alice", timestamp: T0 + 1000 });
    seedMessage(store, { role: "assistant", content: "Sounds good, booked for Friday", timestamp: T0 + 2000 });
    seedMessage(store, { content: "unrelated chatter", senderName: "Alice", timestamp: T0 + 3000 });

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

  it("keeps the most recent of equally scored matches when over the limit, and says how many there were", async () => {
    for (let i = 1; i <= 5; i++) {
      seedMessage(store, { content: `note number ${i}`, timestamp: T0 + i * 1000 });
    }

    const result = await makeTool(store).handler({ query: "note", limit: 3 }, {});

    const text = result.content[0].text;
    expect(text).toContain("note number 3");
    expect(text).toContain("note number 5");
    expect(text).not.toContain("note number 2");
    expect(text).toContain("the 3 best of 5 matches");
    expect(text).toContain("`limit`");
  });

  it("returns the most recent messages when browsing over the limit, with a paging hint", async () => {
    for (let i = 1; i <= 5; i++) {
      seedMessage(store, { content: `note number ${i}`, timestamp: T0 + i * 1000 });
    }

    const result = await makeTool(store).handler({ limit: 3 }, {});

    const text = result.content[0].text;
    expect(text).toContain("note number 3");
    expect(text).not.toContain("note number 2");
    expect(text).toContain("limit");
    expect(text).toContain("before");
  });

  it("truncates oversized message content in results", async () => {
    seedMessage(store, { content: `needle ${"x".repeat(2000)}`, timestamp: T0 + 1000 });

    const result = await makeTool(store).handler({ query: "needle", limit: 20 }, {});

    expect(result.content[0].text).toContain("[truncated]");
    expect(result.content[0].text.length).toBeLessThan(1000);
  });

  it("reports no matches without erroring", async () => {
    seedMessage(store, { content: "hello", timestamp: T0 + 1000 });

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

  it.each([
    ["searching", { query: "good", limit: 20 }],
    ["browsing without a query", { limit: 20 }],
  ])("skips transcript records without string content instead of throwing, when %s", async (_label, args) => {
    seedMessage(store, { content: "good record", timestamp: T0 + 1000 });
    // Simulate a corrupt/legacy line written directly to the transcript file.
    // The file name comes from the store's own mapping: a hand-built
    // "dm_alice.jsonl" only matched because dm:alice keeps its legacy stem.
    appendFileSync(
      join(TEST_DIR, `${transcriptFileStem(SESSION_KEY)}.jsonl`),
      JSON.stringify({ role: "user", channel: "telegram", timestamp: T0 + 2000 }) + "\n",
    );
    const freshStore = new SessionStore(TEST_DIR, 20, join(TEST_DIR, "sdk-sessions"));

    const result = await makeTool(freshStore).handler(args, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("good record");
  });
});

describe("recall_conversation scored search", () => {
  let store: SessionStore;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = new SessionStore(TEST_DIR, 20, join(TEST_DIR, "sdk-sessions"));
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const text = async (args: Record<string, unknown>, extra: Partial<RecallToolDeps> = {}): Promise<string> => {
    const result = await makeTool(store, SESSION_KEY, extra).handler({ limit: 20, ...args }, {});
    expect(result.isError).toBeFalsy();
    return result.content[0].text;
  };

  it("finds a message whose words are apart and in another order, which one substring could not", async () => {
    seedMessage(store, { content: "搬家公司说时间要改到下周三", timestamp: T0 + 1000 });
    seedMessage(store, { content: "The flight to Tokyo got cancelled", timestamp: T0 + 2000 });
    seedMessage(store, { content: "晚饭吃什么", timestamp: T0 + 3000 });

    const chinese = await text({ query: "搬家的时间" });
    expect(chinese).toContain("1 message(s)");
    expect(chinese).toContain("搬家公司说时间要改到下周三");

    const english = await text({ query: "cancelled Tokyo flight" });
    expect(english).toContain("1 message(s)");
    expect(english).toContain("got cancelled");
  });

  it("shows each match's score", async () => {
    seedMessage(store, { content: "dentist appointment moved to Tuesday", timestamp: T0 + 1000 });
    seedMessage(store, { content: "unrelated", timestamp: T0 + 2000 });

    expect(await text({ query: "appointment dentist" })).toMatch(/user \(score 1\.00\): dentist appointment moved/);
    expect(await text({ query: "dentist appointment" })).toMatch(/user \(score 1\.50\): dentist appointment moved/);
  });

  it("takes several phrasings in `queries`, and `query` alongside them", async () => {
    seedMessage(store, { content: "签了租约，下个月一号搬进去", timestamp: T0 + 1000 });
    seedMessage(store, { content: "the landlord wants a deposit", timestamp: T0 + 2000 });
    seedMessage(store, { content: "晚饭吃什么", timestamp: T0 + 3000 });

    expect(await text({ queries: ["apartment lease"] })).toContain("No matching messages");
    const both = await text({ queries: ["apartment lease", "租约"], query: "landlord" });
    expect(both).toContain("2 message(s)");
    expect(both).toContain("签了租约");
    expect(both).toContain("landlord wants");
  });

  it("refuses a query that is blank instead of browsing", async () => {
    seedMessage(store, { content: "anything", timestamp: T0 + 1000 });

    const result = await makeTool(store).handler({ query: "   ", limit: 20 }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("blank");
  });

  it("excerpts a long message around the match, not from its start", async () => {
    const content = `${"padding ".repeat(200)}the locker combination is 31-7-22 ${"padding ".repeat(200)}`;
    seedMessage(store, { content, timestamp: T0 + 1000 });
    seedMessage(store, { content: "unrelated", timestamp: T0 + 2000 });

    const result = await text({ query: "locker combination" });

    expect(result).toContain("the locker combination is 31-7-22");
    expect(result).toContain("… ");
    expect(result).toContain("[truncated]");
    expect(result.length).toBeLessThan(1000);
  });

  it("searches the last 365 days by default, and says so with and without results", async () => {
    seedMessage(store, { content: "the old ramen place closed", timestamp: NOW - 400 * DAY_MS });
    seedMessage(store, { content: "new ramen place opened", timestamp: NOW - 10 * DAY_MS });

    const hit = await text({ query: "ramen" });
    expect(hit).toContain("1 message(s)");
    expect(hit).toContain("new ramen place");
    expect(hit).not.toContain("old ramen place");
    expect(hit).toContain("Searched back to 2025-09-01 (the last 365 days; use after to go further).");

    const miss = await text({ query: "zeppelin" });
    expect(miss).toContain("No matching messages found (searched back to 2025-09-01 (the last 365 days; use after to go further)).");
  });

  it("goes further back with `after`, and then names that bound instead", async () => {
    seedMessage(store, { content: "the old ramen place closed", timestamp: NOW - 400 * DAY_MS });
    seedMessage(store, { content: "new ramen place opened", timestamp: NOW - 10 * DAY_MS });

    const result = await text({ query: "ramen", after: "2025-01-01" });

    expect(result).toContain("2 message(s)");
    expect(result).toContain("Searched back to 2025-01-01.");
    expect(result).not.toContain("365");
  });

  it("applies the default window when browsing too", async () => {
    seedMessage(store, { content: "ancient", timestamp: NOW - 400 * DAY_MS });
    seedMessage(store, { content: "recent", timestamp: NOW - 10 * DAY_MS });

    const result = await text({});

    expect(result).toContain("recent");
    expect(result).not.toContain("ancient");
    expect(result).toContain("only the last 365 days are shown (back to 2025-09-01)");
  });

  it("says so when `before` alone points past the default window, instead of reporting no matches", async () => {
    seedMessage(store, { content: "the old ramen place closed", timestamp: NOW - 400 * DAY_MS });
    const outcomes: RecallSearchOutcome[] = [];

    const result = await text({ query: "ramen", before: "2025-08-01" }, { onSearch: (o) => outcomes.push(o) });

    expect(result).toContain("`before` (2025-08-01) is more than 365 days ago");
    expect(result).toContain("Add `after`");
    // Nothing was searched, so nothing is counted as a search that found nothing.
    expect(outcomes).toEqual([]);
  });

  it("says where a search that ran out of budget stopped, and how to go on", async () => {
    const MINUTE_MS = 60 * 1000;
    for (let i = 1; i <= 200; i++) {
      seedMessage(store, { content: `ramen visit ${i}.`, timestamp: T0 + i * MINUTE_MS });
    }
    // The scan reads the clock once to start and then once every 64 records.
    // This one jumps past the budget on its third reading: the newest 64
    // records are scanned, and the scan is out of time before the 65th.
    let readings = 0;
    const result = await text({ query: "ramen", limit: 100 }, {
      recall: (opts) => store.recallTranscript(SESSION_KEY, {
        ...opts,
        budget: { now: () => (++readings >= 3 ? 1000 : 0) },
      }),
    });

    expect(result).toContain("64 message(s)");
    expect(result).toContain("ramen visit 200.");
    expect(result).toContain("ramen visit 137.");
    expect(result).not.toContain("ramen visit 136.");
    const stoppedAt = new Date(T0 + 137 * MINUTE_MS).toISOString();
    expect(result).toContain(`Searched back to ${stoppedAt} only.`);
    expect(result).toContain(`set \`before\` to that time to search what is older`);
    expect(result).not.toContain("365");
  });

  it("reports every scored search's outcome, and never a browse", async () => {
    seedMessage(store, { content: "ramen tonight", timestamp: T0 + 1000 });
    const outcomes: RecallSearchOutcome[] = [];
    const onSearch = (o: RecallSearchOutcome): void => { outcomes.push(o); };

    await text({ query: "ramen" }, { onSearch });
    await text({ query: "zeppelin" }, { onSearch });
    await text({}, { onSearch });

    expect(outcomes).toEqual([
      { matched: 1, stopped: false },
      { matched: 0, stopped: false },
    ]);
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
    seedMessage(store, { content: "the safe-deposit box code is 4417", timestamp: T0 + 1000 });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function gatedTool(canSearch: () => boolean): ToolHandle {
    let searched = 0;
    const tools = buildRecallTools({
      search: (opts) => { searched++; return store.searchTranscript(SESSION_KEY, opts); },
      recall: (opts) => { searched++; return store.recallTranscript(SESSION_KEY, opts); },
      now: () => NOW,
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
      { role: "user", content: "hi", channel: "telegram", timestamp: T0 + 1000, senderName: "Alice", seq: 7 },
      { role: "assistant", content: "hello", channel: "telegram", timestamp: T0 + 2000, seq: 8 },
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

  it("says the range held nothing when browsing finds no messages", () => {
    expect(formatRecallResults([], 20)).toBe("No messages in that time range.");
  });
});

describe("formatRecallHits", () => {
  const window = { fromTime: Date.parse("2026-01-01T00:00:00Z"), defaultWindow: false };

  it("says a search over files that are not in time order stopped early, without naming a date", () => {
    const text = formatRecallHits({ hits: [], matched: 0, scanned: 10, stopped: { reason: "bytes", reachedBackTo: null } }, window);

    expect(text).toContain("the search stopped before reading the whole time range");
    expect(text).toContain("`before` / `after`");
    expect(text).not.toContain("searched back to");
  });

  it("does not suggest a retry when the search ran out before getting past `before`", () => {
    // A retry with the same `before` would read the same newer records and
    // stop in the same place.
    const before = Date.parse("2026-06-01T00:00:00Z");
    const reachedBackTo = Date.parse("2026-07-10T00:00:00Z");
    const text = formatRecallHits({ hits: [], matched: 0, scanned: 500, stopped: { reason: "bytes", reachedBackTo } }, window, before);

    expect(text).toContain("got back to 2026-07-10T00:00:00.000Z only, without getting past `before`");
    expect(text).toContain("cannot be reached by this search");
    expect(text).not.toContain("set `before` to that time");
  });

  it("suggests continuing from where it stopped when that is below `before`", () => {
    const before = Date.parse("2026-08-01T00:00:00Z");
    const reachedBackTo = Date.parse("2026-07-10T00:00:00Z");
    const text = formatRecallHits({ hits: [], matched: 0, scanned: 500, stopped: { reason: "time", reachedBackTo } }, window, before);

    expect(text).toContain("set `before` to that time to search what is older");
  });
});
