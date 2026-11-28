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
  const run = (key: string, cost: number, recall: TranscriptRecall | undefined, opts: RecallScoredOpts, bytes: number): TranscriptRecall => {
    const maxMs = opts.budget!.maxMs;
    calls.push({ key, maxMs, maxBytes: opts.budget!.maxBytes, startedAt: now });
    const spent = Math.min(cost, maxMs);
    now += spent;
    const base = { ...(recall ?? recallOf([])), bytesRead: Math.min(bytes, opts.budget!.maxBytes) };
    return cost > maxMs ? { ...base, stopped: { reason: "time", reachedBackTo: T0 } } : base;
  };
  const deps: RecallScopeAllDeps = {
    allowed: () => true,
    groups: () => spec.map(({ key, title }) => ({ key, ...(title ? { title } : {}) })),
    recallGroup: (key, opts) => {
      const s = spec.find((x) => x.key === key)!;
      return run(key, s.cost, s.recall, opts, s.bytes);
    },
    clock: () => now,
    budget: { maxMs: 300, maxBytes: 1000 },
  };
  const ownRun = (opts: RecallScoredOpts) => run("own", own.cost, own.recall, opts, own.bytes);
  return { deps, ownRun, calls };
}

const OPTS: RecallScoredOpts = { queries: ["x"], limit: 20 };

describe("sharing one budget", () => {
  it("searches the groups first and this conversation last, each taking an equal part of what is left", () => {
    const { deps, ownRun, calls } = fakeSources(
      [
        { key: "g:big", bytes: 500, cost: 1000 },
        { key: "g:small", bytes: 10, cost: 10 },
      ],
      { bytes: 300, cost: 1000 },
    );
    const across = recallAcross(ownRun, deps, OPTS);
    expect(calls.map((c) => c.key)).toEqual(["g:big", "g:small", "own"]);
    // big: 300/3 = 100, all used. small: 200/2 = 100, uses 10. own: the 190 left.
    expect(calls.map((c) => c.maxMs)).toEqual([100, 100, 190]);
    // The whole search stays inside the one budget.
    expect(calls.reduce((sum, c) => sum + c.maxMs, 0) - 90).toBe(300);
    // Shown this conversation first, whatever the search order was.
    expect(across.sources.map((s) => s.label)).toEqual([null, "group g:big", "group g:small"]);
  });

  it("hands what small transcripts leave to this conversation", () => {
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

  it("shares the byte backstop the same way, charging what each scan says it read", () => {
    const { deps, ownRun, calls } = fakeSources(
      [{ key: "g:a", bytes: 100, cost: 1 }],
      { bytes: 5000, cost: 1 },
    );
    recallAcross(ownRun, deps, OPTS);
    // 1000 bytes: g:a is offered 500 and reads 100; own gets 900.
    expect(calls.map((c) => [c.key, c.maxBytes])).toEqual([["g:a", 500], ["own", 900]]);
  });

  it("charges a scan that does not say what it read its whole share", () => {
    const { deps, ownRun, calls } = fakeSources([{ key: "g:a", bytes: 100, cost: 1 }], { bytes: 5000, cost: 1 });
    const silent = deps.recallGroup;
    deps.recallGroup = (key, opts) => {
      const result = silent(key, opts);
      delete result.bytesRead;
      return result;
    };
    recallAcross(ownRun, deps, OPTS);
    expect(calls.map((c) => [c.key, c.maxBytes])).toEqual([["g:a", 500], ["own", 500]]);
  });

  it("charges finding the groups to the same budget", () => {
    const { deps, ownRun, calls } = fakeSources([{ key: "g:a", bytes: 1, cost: 1 }], { bytes: 2, cost: 1000 });
    let now = 0;
    deps.clock = () => now;
    const groups = deps.groups;
    deps.groups = () => { now += 250; return groups(); };
    recallAcross(ownRun, deps, OPTS);
    // 50 ms left for two conversations.
    expect(calls[0].maxMs).toBe(25);
  });

  it("does not claim nothing is there when part of the history was not searched", () => {
    const { deps, ownRun } = fakeSources([{ key: "g:big", bytes: 500, cost: 1000 }], { bytes: 1, cost: 1 });
    const cut = formatRecallAcross(recallAcross(ownRun, deps, OPTS), { fromTime: T0 - DAY, defaultWindow: false });
    expect(cut).toMatch(/^No matching messages found in the parts of this conversation and the group chats that were searched/);
    const whole = fakeSources([{ key: "g:small", bytes: 5, cost: 1 }], { bytes: 1, cost: 1 });
    const done = formatRecallAcross(recallAcross(whole.ownRun, whole.deps, OPTS), { fromTime: T0 - DAY, defaultWindow: false });
    expect(done).toMatch(/^No matching messages found in this conversation or the 1 group chat\(s\)\./);
  });

  it("does not search a conversation once the time is spent, and says so", () => {
    const { deps, ownRun, calls } = fakeSources([{ key: "g:first", bytes: 10, cost: 1 }], { bytes: 1, cost: 1 });
    let t = 0;
    deps.clock = () => (t += 200);
    const across = recallAcross(ownRun, deps, OPTS);
    expect(calls.map((c) => c.key)).toEqual(["g:first"]);
    expect(across.sources[0]).toEqual({ label: null, skipped: "time" });
    const text = formatRecallAcross(across, { fromTime: T0 - DAY, defaultWindow: false });
    expect(text).toContain(`- this conversation: not searched; the search's time ran out before it got there.`);
  });

  it("says it was the read limit, not the time, when that is what ran out", () => {
    const { deps, ownRun, calls } = fakeSources([{ key: "g:first", bytes: 10, cost: 1 }], { bytes: 1, cost: 1 });
    const read = deps.recallGroup;
    // A scan that overshot its share by a whole chunk.
    deps.recallGroup = (key, opts) => ({ ...read(key, opts), bytesRead: 2000 });
    const across = recallAcross(ownRun, deps, OPTS);
    expect(calls.map((c) => c.key)).toEqual(["g:first"]);
    const text = formatRecallAcross(across, { fromTime: T0 - DAY, defaultWindow: false });
    expect(text).toContain(`- this conversation: not searched; the search's read limit was used up before it got there.`);
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
      { key: "telegram:-1", title: "Family" },
      { key: "telegram:-2", title: "family" },
      { key: "telegram:-3" },
      { key: "telegram:-4", title: 'Ev"il\n] [group "x"' },
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
          groups: () => [GROUP_A, GROUP_B].map((key, i) => ({ key, title: ["Orchard", "Neighbours"][i] })),
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

  it("gets the bytes each scan read from the store", () => {
    const r = store.recallTranscript(GROUP_A, { queries: ["walnut"] });
    expect(r.bytesRead).toBeGreaterThan(0);
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
