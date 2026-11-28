import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildRecallTools,
  formatRecallAcross,
  groupLabels,
  recallAcross,
  type RecallScopeAllDeps,
  type RecallScoredOpts,
} from "../src/mcp/recall-tools.js";
import { SessionStore, type TranscriptRecall } from "../src/sessions/store.js";
import type { SessionMessage } from "../src/sessions/types.js";

// ===== recall_conversation scope "all": one budget, several transcripts =====

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-01T00:00:00Z");

function msg(content: string, timestamp: number, senderName?: string): SessionMessage {
  return { role: "user", content, channel: "telegram", timestamp, ...(senderName ? { senderName } : {}) } as SessionMessage;
}

function recallOf(hits: Array<{ content: string; at: number; score: number }>, extra: Partial<TranscriptRecall> = {}): TranscriptRecall {
  return {
    hits: hits.map((h) => ({ msg: msg(h.content, h.at), score: h.score, matchIndex: 0 })),
    matched: hits.length,
    scanned: hits.length,
    ...extra,
  };
}

/** A fake clock, and transcripts whose search costs `cost` ms each, capped at the budget they are given. */
function fakeSources(spec: Array<{ key: string; title?: string; bytes: number; cost: number; recall?: TranscriptRecall }>, own: { bytes: number; cost: number; recall?: TranscriptRecall }) {
  let now = 0;
  const calls: Array<{ key: string; maxMs: number; maxBytes: number; startedAt: number }> = [];
  const run = (key: string, cost: number, recall: TranscriptRecall | undefined, opts: RecallScoredOpts): TranscriptRecall => {
    const maxMs = opts.budget!.maxMs;
    calls.push({ key, maxMs, maxBytes: opts.budget!.maxBytes, startedAt: now });
    const spent = Math.min(cost, maxMs);
    now += spent;
    const base = recall ?? recallOf([]);
    return cost > maxMs ? { ...base, stopped: { reason: "time", reachedBackTo: T0 } } : base;
  };
  const deps: RecallScopeAllDeps = {
    allowed: () => true,
    groups: () => spec.map(({ key, title, bytes }) => ({ key, bytes, ...(title ? { title } : {}) })),
    ownBytes: () => own.bytes,
    recallGroup: (key, opts) => {
      const s = spec.find((x) => x.key === key)!;
      return run(key, s.cost, s.recall, opts);
    },
    clock: () => now,
    budget: { maxMs: 300, maxBytes: 1000 },
  };
  const ownRun = (opts: RecallScoredOpts) => run("own", own.cost, own.recall, opts);
  return { deps, ownRun, calls };
}

const OPTS: RecallScoredOpts = { queries: ["x"], limit: 20 };

describe("sharing one budget", () => {
  it("goes smallest transcript first, each taking an equal part of what is left", () => {
    const { deps, ownRun, calls } = fakeSources(
      [
        { key: "g:big", bytes: 500, cost: 1000 },
        { key: "g:small", bytes: 10, cost: 10 },
      ],
      { bytes: 300, cost: 1000 },
    );
    recallAcross(ownRun, deps, OPTS);
    expect(calls.map((c) => c.key)).toEqual(["g:small", "own", "g:big"]);
    // small: 300/3 = 100 offered, uses 10. own: 290/2 = 145. big: the rest, 145.
    expect(calls.map((c) => c.maxMs)).toEqual([100, 145, 145]);
    // The whole search stays inside the one budget.
    expect(calls.reduce((sum, c) => sum + Math.min(c.maxMs, 1000), 0) - 90).toBeLessThanOrEqual(300);
  });

  it("hands what small transcripts leave to the large one after them", () => {
    const { deps, ownRun, calls } = fakeSources(
      [
        { key: "g:a", bytes: 1, cost: 1 },
        { key: "g:b", bytes: 2, cost: 1 },
      ],
      { bytes: 900, cost: 1000 },
    );
    recallAcross(ownRun, deps, OPTS);
    expect(calls.at(-1)).toMatchObject({ key: "own", maxMs: 298 });
  });

  it("shares the byte backstop the same way", () => {
    const { deps, ownRun, calls } = fakeSources(
      [{ key: "g:a", bytes: 100, cost: 1 }],
      { bytes: 5000, cost: 1 },
    );
    recallAcross(ownRun, deps, OPTS);
    // 1000 bytes: g:a is offered 500 and can use 100 at most; own gets 900.
    expect(calls.map((c) => [c.key, c.maxBytes])).toEqual([["g:a", 500], ["own", 900]]);
  });

  it("does not search a conversation once the budget is spent, and says so", () => {
    const { deps, ownRun, calls } = fakeSources([{ key: "g:late", bytes: 10, cost: 1 }], { bytes: 1, cost: 1 });
    let t = 0;
    deps.clock = () => (t += 200);
    const across = recallAcross(ownRun, deps, OPTS);
    expect(calls.map((c) => c.key)).toEqual(["own"]);
    expect(across.sources[1].recall).toBeUndefined();
    const text = formatRecallAcross(across, { fromTime: T0 - DAY, defaultWindow: false });
    expect(text).toContain(`- group g:late: not searched; the search's time ran out before it got there.`);
  });

  it("says where each conversation that ran out of time stopped", () => {
    const { deps, ownRun } = fakeSources(
      [{ key: "g:big", title: "Hiking", bytes: 500, cost: 1000 }],
      { bytes: 1, cost: 1 },
    );
    const across = recallAcross(ownRun, deps, OPTS);
    const text = formatRecallAcross(across, { fromTime: T0 - 30 * DAY, defaultWindow: false });
    expect(text).toContain(`- group "Hiking": searched back to ${new Date(T0).toISOString()} only.`);
    expect(text).toContain(`- this conversation: searched back to ${new Date(T0 - 30 * DAY).toISOString().slice(0, 10)}.`);
  });
});

describe("merging and marking where each hit came from", () => {
  it("keeps the best `limit` over all conversations, oldest first, each group hit marked", () => {
    const { deps, ownRun } = fakeSources(
      [{ key: "g:1", title: "Book club", bytes: 1, cost: 1, recall: recallOf([{ content: "group-best", at: T0 + 2 * DAY, score: 0.9 }, { content: "group-worst", at: T0 + 3 * DAY, score: 0.5 }]) }],
      { bytes: 2, cost: 1, recall: recallOf([{ content: "own-good", at: T0 + DAY, score: 0.8 }]) },
    );
    const across = recallAcross(ownRun, deps, { ...OPTS, limit: 2 });
    expect(across.hits.map((h) => [h.msg.content, h.label])).toEqual([["own-good", null], ["group-best", 'group "Book club"']]);
    expect(across.matched).toBe(3);
    const text = formatRecallAcross(across, { fromTime: T0 - DAY, defaultWindow: true });
    expect(text).toMatch(/^\[group "Book club"\] \[2026-11-03T00:00:00.000Z\] user \(score 0\.90\): group-best$/m);
    expect(text).toMatch(/^\[2026-11-02T00:00:00.000Z\] user \(score 0\.80\): own-good$/m);
    expect(text).toContain("the 2 best of 3 matches");
    expect(text).toContain("Without `after`, only the last 365 days are searched");
  });

  it("labels groups by title, adds the key when titles collide, and the key alone when there is none", () => {
    const labels = groupLabels([
      { key: "telegram:-1", title: "Family", bytes: 0 },
      { key: "telegram:-2", title: "family", bytes: 0 },
      { key: "telegram:-3", bytes: 0 },
      { key: "telegram:-4", title: 'Ev"il\n] [group "x"', bytes: 0 },
    ]);
    expect(labels.get("telegram:-1")).toBe('group "Family" (telegram:-1)');
    expect(labels.get("telegram:-2")).toBe('group "family" (telegram:-2)');
    expect(labels.get("telegram:-3")).toBe("group telegram:-3");
    // Nothing in a title can close the quotes or start a new line.
    expect(labels.get("telegram:-4")).toBe('group "Ev il ] [group x"');
  });
});

describe("the tool's scope argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "tomo-test-recall-scope-all-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir, join(dir, "sdk"), { dbPath: join(dir, "tomo.db") });
  const OWN = "dm:owner";
  const GROUP_A = "telegram:-100";
  const GROUP_B = "telegram:-200";
  const now = Date.now();
  store.append(OWN, msg("owner mentions the walnut harvest", now - 3 * DAY));
  store.append(GROUP_A, msg("Alice: walnut harvest on Sunday", now - 2 * DAY, "Alice"));
  store.append(GROUP_B, msg("Bob: walnut harvest is cancelled", now - DAY, "Bob"));

  function tool(scopeAll?: Partial<RecallScopeAllDeps>, searches?: { n: number }) {
    const [t] = buildRecallTools({
      search: (opts) => store.searchTranscript(OWN, opts),
      recall: (opts) => store.recallTranscript(OWN, opts),
      onSearch: () => { if (searches) searches.n++; },
      ...(scopeAll ? {
        scopeAll: {
          allowed: () => true,
          groups: () => [GROUP_A, GROUP_B].map((key, i) => ({ key, title: ["Orchard", "Neighbours"][i], bytes: store.transcriptBytes(key) })),
          ownBytes: () => store.transcriptBytes(OWN),
          recallGroup: (key, opts) => store.recallTranscript(key, opts),
          ...scopeAll,
        },
      } : {}),
    }) as unknown as Array<{ handler: (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>;
    return t;
  }

  it("reads every group's transcript, and marks each hit with its group", async () => {
    const searches = { n: 0 };
    const result = await tool({}, searches).handler({ query: "walnut harvest", scope: "all", limit: 20 }, {});
    const text = result.content[0].text;
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/^\[group "Orchard"\] .*Alice: walnut harvest on Sunday$/m);
    expect(text).toMatch(/^\[group "Neighbours"\] .*Bob: walnut harvest is cancelled$/m);
    expect(text).toMatch(/^\[[^\]]+\] #1 user .*owner mentions the walnut harvest$/m);
    expect(text).toContain("3 message(s), oldest first.");
    // Counted once, as one search.
    expect(searches.n).toBe(1);
  });

  it("is this conversation only by default", async () => {
    const result = await tool({}).handler({ query: "walnut harvest", limit: 20 }, {});
    expect(result.content[0].text).toContain("1 message(s)");
    expect(result.content[0].text).not.toContain("[group");
  });

  it("refuses all on a session that was not given it, without searching", async () => {
    const searches = { n: 0 };
    const result = await tool(undefined, searches).handler({ query: "walnut harvest", scope: "all", limit: 20 }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('scope "all" is only available in your private conversation with the owner');
    expect(searches.n).toBe(0);
  });

  it("refuses all when the turn may not have it, before reading anything", async () => {
    let read = 0;
    const result = await tool({ allowed: () => false, groups: () => { read++; return []; } }).handler({ query: "walnut", scope: "all", limit: 20 }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('scope "all" is unavailable on this turn');
    expect(read).toBe(0);
  });

  it("refuses all without a query: browsing covers this conversation only", async () => {
    const result = await tool({}).handler({ scope: "all", limit: 20 }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("needs `query` or `queries`");
  });
});
