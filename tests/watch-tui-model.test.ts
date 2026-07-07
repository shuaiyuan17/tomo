import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applySnapshot,
  initialState,
  pushNotice,
  FEED_LIMIT,
  type WatchState,
} from "../src/watch/tui/model.js";
import type { WatchEvent, WatchSnapshot } from "../src/watch/protocol.js";

function fold(events: WatchEvent[], backfill = false): WatchState {
  let s = initialState();
  for (const e of events) s = applyEvent(s, e, backfill);
  return s;
}

function snapshotWith(overrides: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return {
    protocolVersion: 1,
    pid: 1,
    startedAt: Date.now(),
    version: "0.0.0",
    model: "claude-test",
    channels: ["telegram"],
    sessions: [],
    cron: [],
    nextHeartbeatAt: null,
    costTodayUsd: 1.5,
    costWeekUsd: 9,
    turnsToday: 12,
    recent: [],
    lastIssue: null,
    ...overrides,
  };
}

describe("watch TUI model", () => {
  it("maps user and assistant transcripts to feed items", () => {
    const s = fold([
      { type: "transcript", ts: 1, sessionKey: "dm:shuai", role: "user", channel: "telegram", sender: "Shuai", text: "hey" },
      { type: "transcript", ts: 2, sessionKey: "dm:shuai", role: "assistant", channel: "telegram", text: "hi there" },
    ]);
    expect(s.feed).toHaveLength(2);
    expect(s.feed[0]).toMatchObject({ kind: "user", text: "hey", isGroup: false });
    expect(s.feed[1]).toMatchObject({ kind: "assistant", text: "hi there" });
  });

  it("renders silent assistant replies as a quiet notice", () => {
    const s = fold([
      { type: "transcript", ts: 1, sessionKey: "dm:shuai", role: "assistant", channel: "telegram", text: "NO_REPLY" },
    ]);
    expect(s.feed[0].kind).toBe("notice");
  });

  it("flags group sessions (telegram negative ids and imessage GUIDs)", () => {
    const s = fold([
      { type: "transcript", ts: 1, sessionKey: "telegram:-100123", role: "user", channel: "telegram", text: "yo" },
      { type: "transcript", ts: 2, sessionKey: "imessage:chat;+;guid", role: "user", channel: "imessage", text: "yo" },
      { type: "transcript", ts: 3, sessionKey: "telegram:555", role: "user", channel: "telegram", text: "yo" },
    ]);
    expect(s.feed.map((i) => i.isGroup)).toEqual([true, true, false]);
  });

  it("tracks in-flight turns and attaches stats that arrive before turn.end (runtime order)", () => {
    let s = fold([{ type: "turn.start", ts: 1, sessionKey: "dm:shuai", source: "user" }]);
    expect(s.inFlight["dm:shuai"]).toMatchObject({ sessionKey: "dm:shuai", source: "user" });

    s = applyEvent(s, { type: "tool.start", ts: 2, sessionKey: "dm:shuai", tool: "Read", detail: "Read /tmp/x" });
    expect(s.inFlight["dm:shuai"]?.activity).toBe("Read /tmp/x");

    // Runtime order: stats are recorded when the SDK query resolves, BEFORE
    // the turn (delivery included) ends.
    s = applyEvent(s, { type: "turn.stats", ts: 3, sessionKey: "dm:shuai", costUsd: 0.04, contextUsed: 41_000, contextMax: 100_000 });
    expect(s.contextUsed).toBe(41_000);
    expect(s.costTodayUsd).toBeCloseTo(0.04);

    s = applyEvent(s, { type: "turn.end", ts: 4, sessionKey: "dm:shuai", source: "user", ok: true, durationMs: 8200 });
    expect(s.inFlight["dm:shuai"]).toBeUndefined();
    expect(s.turnsToday).toBe(1);
    const turnItem = s.feed.find((i) => i.kind === "turn");
    expect(turnItem?.status).toBe("ok");
    expect(turnItem?.meta).toContain("8.2s");
    expect(turnItem?.meta).toContain("$0.0400");
    expect(turnItem?.meta).toContain("ctx 41%");
    expect(s.pendingStats["dm:shuai"]).toBeUndefined();
  });

  it("still annotates an existing turn row when stats arrive after turn.end", () => {
    const s = fold([
      { type: "turn.end", ts: 1, sessionKey: "dm:shuai", source: "user", ok: true, durationMs: 1000 },
      { type: "turn.stats", ts: 2, sessionKey: "dm:shuai", costUsd: 0.02, contextUsed: 10, contextMax: 100 },
    ]);
    expect(s.feed.find((i) => i.kind === "turn")?.meta).toContain("$0.0200");
  });

  it("never annotates an older turn row while the current turn is in flight", () => {
    const s = fold([
      // Turn A fails without ever emitting stats — its row stays unannotated.
      { type: "turn.start", ts: 1, sessionKey: "dm:shuai", source: "user" },
      { type: "turn.end", ts: 2, sessionKey: "dm:shuai", source: "user", ok: false, durationMs: 500 },
      // Turn B: stats fire mid-flight (normal runtime order), then it ends.
      { type: "turn.start", ts: 3, sessionKey: "dm:shuai", source: "user" },
      { type: "turn.stats", ts: 4, sessionKey: "dm:shuai", costUsd: 0.42, contextUsed: 42, contextMax: 100 },
      { type: "turn.end", ts: 5, sessionKey: "dm:shuai", source: "user", ok: true, durationMs: 1000 },
    ]);
    const rows = s.feed.filter((i) => i.kind === "turn");
    expect(rows).toHaveLength(2);
    // Turn A's failed row must NOT carry turn B's stats…
    expect(rows[0].status).toBe("error");
    expect(rows[0].meta).not.toContain("$");
    // …turn B's row must.
    expect(rows[1].status).toBe("ok");
    expect(rows[1].meta).toContain("$0.4200");
  });

  it("does not leak a previous turn's stashed stats into the next turn", () => {
    const s = fold([
      // Turn 1: stats recorded, but the turn dies before turn.end fires.
      { type: "turn.start", ts: 1, sessionKey: "dm:shuai", source: "user" },
      { type: "turn.stats", ts: 2, sessionKey: "dm:shuai", costUsd: 0.9, contextUsed: 1, contextMax: 100 },
      // Turn 2 starts fresh and ends without stats.
      { type: "turn.start", ts: 3, sessionKey: "dm:shuai", source: "cron" },
      { type: "turn.end", ts: 4, sessionKey: "dm:shuai", source: "cron", ok: false, durationMs: 100 },
    ]);
    expect(s.feed.find((i) => i.kind === "turn")?.meta).not.toContain("$0.9");
  });

  it("tracks concurrent in-flight turns on different sessions independently", () => {
    let s = fold([
      { type: "turn.start", ts: 1, sessionKey: "dm:shuai", source: "user" },
      { type: "turn.start", ts: 2, sessionKey: "telegram:-100123", source: "cron" },
    ]);
    expect(Object.keys(s.inFlight)).toHaveLength(2);

    // Activity updates land on the right session's indicator.
    s = applyEvent(s, { type: "tool.start", ts: 3, sessionKey: "telegram:-100123", tool: "Bash", detail: "Bash: ls" });
    expect(s.inFlight["telegram:-100123"]?.activity).toBe("Bash: ls");
    expect(s.inFlight["dm:shuai"]?.activity).toBeUndefined();

    // One session's turn.end must not clear the other's indicator.
    s = applyEvent(s, { type: "turn.end", ts: 4, sessionKey: "telegram:-100123", source: "cron", ok: true, durationMs: 500 });
    expect(s.inFlight["telegram:-100123"]).toBeUndefined();
    expect(s.inFlight["dm:shuai"]).toMatchObject({ source: "user" });
  });

  it("resolves tool items on tool.end with duration", () => {
    const s = fold([
      { type: "tool.start", ts: 1, sessionKey: "dm:shuai", tool: "Bash", detail: "Bash: ls" },
      { type: "tool.end", ts: 2, sessionKey: "dm:shuai", tool: "Bash", ok: false, durationMs: 900 },
    ]);
    expect(s.feed[0]).toMatchObject({ kind: "tool", status: "error", meta: "900ms" });
  });

  it("resolves cron items on cron.done", () => {
    const s = fold([
      { type: "cron.fired", ts: 1, jobId: "j1", name: "morning-brief" },
      { type: "cron.done", ts: 2, jobId: "j1", name: "morning-brief", ok: true },
    ]);
    expect(s.feed[0]).toMatchObject({ kind: "cron", status: "ok" });
  });

  it("does not double-count vitals when folding snapshot backfill", () => {
    const events: WatchEvent[] = [
      { type: "turn.end", ts: 1, sessionKey: "dm:shuai", source: "user", ok: true, durationMs: 100 },
      { type: "turn.stats", ts: 2, sessionKey: "dm:shuai", costUsd: 0.5, contextUsed: 10, contextMax: 100 },
    ];
    const s = applySnapshot(initialState(), snapshotWith({ recent: events }));
    // Snapshot totals stand; backfilled events must not add to them.
    expect(s.costTodayUsd).toBeCloseTo(1.5);
    expect(s.turnsToday).toBe(12);
    // But context (a point-in-time gauge) does update from backfill.
    expect(s.contextUsed).toBe(10);
    // And the feed still gets the items.
    expect(s.feed.some((i) => i.kind === "turn")).toBe(true);
  });

  it("prefers the dm session for the context gauge", () => {
    const s = applySnapshot(initialState(), snapshotWith({
      sessions: [
        { key: "telegram:-1", lastActiveAt: 99, contextUsed: 5, contextMax: 10, totalCostUsd: 0, totalQueries: 0 },
        { key: "dm:shuai", lastActiveAt: 1, contextUsed: 42, contextMax: 100, totalCostUsd: 0, totalQueries: 0 },
      ],
    }));
    expect(s.contextUsed).toBe(42);
  });

  it("clears a stale in-flight turn left dangling at the ring edge", () => {
    const s = applySnapshot(initialState(), snapshotWith({
      recent: [
        { type: "turn.start", ts: Date.now() - 60 * 60_000, sessionKey: "dm:shuai", source: "cron" },
        { type: "turn.start", ts: Date.now() - 10_000, sessionKey: "telegram:-1", source: "user" },
      ],
    }));
    expect(s.inFlight["dm:shuai"]).toBeUndefined();
    expect(s.inFlight["telegram:-1"]).toBeDefined();
  });

  it("caps the feed length", () => {
    let s = initialState();
    for (let i = 0; i < FEED_LIMIT + 50; i++) {
      s = applyEvent(s, { type: "heartbeat", ts: i });
    }
    expect(s.feed.length).toBe(FEED_LIMIT);
  });

  it("tracks last issue from events", () => {
    const s = fold([{ type: "issue", ts: 1, level: "error", msg: "boom" }]);
    expect(s.lastIssue).toMatchObject({ msg: "boom" });
    expect(s.feed[0]).toMatchObject({ kind: "issue", status: "error" });
  });

  it("pushNotice adds a local notice item", () => {
    const s = pushNotice(initialState(), "send failed");
    expect(s.feed[0]).toMatchObject({ kind: "notice", text: "send failed" });
  });
});
