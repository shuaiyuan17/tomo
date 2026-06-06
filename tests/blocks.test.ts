import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// blocks.ts reads config.lcm.dailyFreshTail at call time. Stub the config
// module so tests don't need a populated ~/.tomo/config.json or channel env
// vars (CI has neither, so the real buildConfig() throws at import).
vi.mock("../src/config.js", () => ({
  config: { lcm: { dailyFreshTail: 32, globalFreshTail: false } },
}));

import { resolveBlockRange, findDuePromotions, isWarmTailCandidate, globalFreshTailStartIdx } from "../src/lcm/blocks.js";
import { config as mockedConfig } from "../src/config.js";
import { getSdkSessionPath } from "../src/sessions/index.js";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Build a fake user/assistant event with a local-tz timestamp for a given day.
function mkEvent(day: string, hour: number, role: "user" | "assistant", extra: Record<string, any> = {}) {
  // Local midnight → hour. Use explicit Date construction so the resulting
  // ISO timestamp, when read back and converted to local tz, maps to `day`.
  const [y, m, d] = day.split("-").map(Number);
  const ts = new Date(y, m - 1, d, hour, 0, 0).toISOString();
  return {
    type: role,
    uuid: randomUUID(),
    timestamp: ts,
    ...extra,
  };
}

// Build a candidate (real conversational) event with text content.
function mkTextEvent(day: string, hour: number, role: "user" | "assistant", text: string, extra: Record<string, any> = {}) {
  const [y, m, d] = day.split("-").map(Number);
  const ts = new Date(y, m - 1, d, hour, 0, 0).toISOString();
  return {
    type: role,
    uuid: randomUUID(),
    timestamp: ts,
    message: { role, content: text },
    ...extra,
  };
}

function writeArchive(sessionId: string, events: any[]): string {
  const path = getSdkSessionPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

function todayTag(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("resolveBlockRange — daily fresh-tail behavior", () => {
  let sessionId: string;
  let archivePath: string;

  beforeEach(() => {
    sessionId = `test-blocks-${randomUUID()}`;
  });

  afterEach(() => {
    if (archivePath && existsSync(archivePath)) unlinkSync(archivePath);
  });

  it("compacts a past day with fewer than DAILY_FRESH_TAIL raw events", () => {
    // Past day: 10 events. Pre-fix, this returned null ("No events found").
    // Post-fix, fresh-tail guard skipped for past days → compacts all 10.
    const pastDay = "2026-04-15";
    const events: any[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(mkEvent(pastDay, 9, i % 2 === 0 ? "user" : "assistant"));
    }
    archivePath = writeArchive(sessionId, events);

    const result = resolveBlockRange(sessionId, "daily", pastDay);
    expect(result).not.toBeNull();
    expect(result!.blockTag).toBe(`daily ${pastDay}`);
    expect(result!.description).toContain("10 events");
    // No "kept raw" suffix for past-day rollups.
    expect(result!.description).not.toContain("kept raw");
  });

  it("still preserves fresh tail for today's rollup with >32 raw events", () => {
    const today = todayTag();
    const events: any[] = [];
    for (let i = 0; i < 50; i++) {
      events.push(mkEvent(today, 9, i % 2 === 0 ? "user" : "assistant"));
    }
    archivePath = writeArchive(sessionId, events);

    const result = resolveBlockRange(sessionId, "daily", today);
    expect(result).not.toBeNull();
    // 50 - 32 = 18 events compacted, 32 kept raw.
    expect(result!.description).toContain("18 events");
    expect(result!.description).toContain("32 most-recent events kept raw");
  });

  it("returns null for today with ≤32 raw events and no existing block", () => {
    const today = todayTag();
    const events: any[] = [];
    for (let i = 0; i < 15; i++) {
      events.push(mkEvent(today, 9, i % 2 === 0 ? "user" : "assistant"));
    }
    archivePath = writeArchive(sessionId, events);

    const result = resolveBlockRange(sessionId, "daily", today);
    expect(result).toBeNull();
  });

  it("compacts all events for a past day that has 32 raw events (boundary)", () => {
    // Exactly DAILY_FRESH_TAIL. Pre-fix: ≤32 → null. Post-fix: past day ignores guard.
    const pastDay = "2026-04-11";
    const events: any[] = [];
    for (let i = 0; i < 32; i++) {
      events.push(mkEvent(pastDay, 9, i % 2 === 0 ? "user" : "assistant"));
    }
    archivePath = writeArchive(sessionId, events);

    const result = resolveBlockRange(sessionId, "daily", pastDay);
    expect(result).not.toBeNull();
    expect(result!.description).toContain("32 events");
    expect(result!.description).not.toContain("kept raw");
  });

  it("compacts all events for a past day with more than 32 raw events", () => {
    // Past day >32 should NOT keep a fresh tail either — past days are cold,
    // there's no short-term context worth preserving outside the block.
    const pastDay = "2026-04-14";
    const events: any[] = [];
    for (let i = 0; i < 50; i++) {
      events.push(mkEvent(pastDay, 9, i % 2 === 0 ? "user" : "assistant"));
    }
    archivePath = writeArchive(sessionId, events);

    const result = resolveBlockRange(sessionId, "daily", pastDay);
    expect(result).not.toBeNull();
    expect(result!.description).toContain("50 events");
    expect(result!.description).not.toContain("kept raw");
  });
});

describe("findDuePromotions — past-day nudging", () => {
  let sessionId: string;
  let archivePath: string;

  beforeEach(() => {
    sessionId = `test-blocks-due-${randomUUID()}`;
  });

  afterEach(() => {
    if (archivePath && existsSync(archivePath)) unlinkSync(archivePath);
  });

  it("flags past days with small raw-event counts (end-to-end nudge → compact)", () => {
    // End-to-end: this is what the rollup runner uses to surface past-day
    // rollups to Claw. Must be independent of DAILY_FRESH_TAIL — otherwise
    // past days with ≤32 events would be invisible to the nudge loop.
    const pastDay = "2026-04-15";
    const events: any[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(mkEvent(pastDay, 9, i % 2 === 0 ? "user" : "assistant"));
    }
    archivePath = writeArchive(sessionId, events);

    const due = findDuePromotions(sessionId);
    const dailyDue = due.find((d) => d.level === "daily" && d.period === pastDay);
    expect(dailyDue).toBeDefined();
    expect(dailyDue!.childCount).toBe(10);
  });

  it("flags a past day with a daily block AND leftover raw events", () => {
    // Scenario observed in the wild: a `daily <day>` block was written early
    // in the day (e.g. by a mid-morning compact) but more raw events accumulated
    // after and never got absorbed. findDuePromotions must flag this for the
    // nudge loop so the agent re-runs `tomo lcm daily --date <day>` and
    // rebuild semantics sweep up the leftovers.
    const pastDay = "2026-04-22";
    const events: any[] = [];
    // Existing daily block
    events.push({
      type: "user",
      uuid: randomUUID(),
      timestamp: new Date(2026, 3, 22, 1, 0, 0).toISOString(),
      isCompactSummary: true,
      blockTag: `daily ${pastDay}`,
      message: { role: "user", content: "[daily 2026-04-22 — 50 events summarized]\n\nearly 4/22 rollup" },
    });
    // Leftover raw events for the same day
    for (let i = 0; i < 20; i++) {
      events.push(mkEvent(pastDay, 14, i % 2 === 0 ? "user" : "assistant"));
    }
    archivePath = writeArchive(sessionId, events);

    const due = findDuePromotions(sessionId);
    const dailyDue = due.find((d) => d.level === "daily" && d.period === pastDay);
    expect(dailyDue).toBeDefined();
    expect(dailyDue!.childCount).toBe(20);
  });

  it("does NOT flag a past day with a block and only a few (<8) leftover raw events", () => {
    // Don't spam nudges for trivial residual events (attachments, a stray
    // heartbeat). The floor kicks in when both a block exists AND leftover
    // is below FLOOR_WITH_BLOCK = 8.
    const pastDay = "2026-04-19";
    const events: any[] = [];
    events.push({
      type: "user",
      uuid: randomUUID(),
      timestamp: new Date(2026, 3, 19, 1, 0, 0).toISOString(),
      isCompactSummary: true,
      blockTag: `daily ${pastDay}`,
      message: { role: "user", content: "[daily 2026-04-19 — 100 events summarized]\n\n..." },
    });
    for (let i = 0; i < 3; i++) {
      events.push(mkEvent(pastDay, 23, i % 2 === 0 ? "user" : "assistant"));
    }
    archivePath = writeArchive(sessionId, events);

    const due = findDuePromotions(sessionId);
    const dailyDue = due.find((d) => d.level === "daily" && d.period === pastDay);
    expect(dailyDue).toBeUndefined();
  });
});

describe("isWarmTailCandidate — classifier", () => {
  const stamp = "[imessage · Fri 06/05 22:18 PDT]";
  it("counts a real user message", () => {
    expect(isWarmTailCandidate({ type: "user", message: { role: "user", content: `${stamp} 🧱做好了` } } as any)).toBe(true);
  });
  it("counts a coalesced real-message turn", () => {
    expect(isWarmTailCandidate({ type: "user", message: { role: "user", content: `${stamp} [User sent 2 messages in quick succession] hi` } } as any)).toBe(true);
  });
  it("rejects a cron turn (System: after the stamp)", () => {
    expect(isWarmTailCandidate({ type: "user", message: { role: "user", content: `${stamp} System: Scheduled task "daily-backup" triggered.` } } as any)).toBe(false);
  });
  it("rejects a continuity heartbeat (raw System:)", () => {
    expect(isWarmTailCandidate({ type: "user", message: { role: "user", content: "System: It is Fri, Jun 5, 22:22 PDT. Weather outside ..." } } as any)).toBe(false);
  });
  it("rejects a cron turn with a pending note prepended (multi-bracket strip)", () => {
    const content = `[System: You proactively sent the following message …]\n\n${stamp} System: Scheduled task "daily-backup" triggered.`;
    expect(isWarmTailCandidate({ type: "user", message: { role: "user", content } } as any)).toBe(false);
  });
  it("still counts a real message with a pending note prepended", () => {
    const content = `[System: You proactively sent the following message …]\n\n${stamp} hey what's up`;
    expect(isWarmTailCandidate({ type: "user", message: { role: "user", content } } as any)).toBe(true);
  });
  it("rejects a tool_result-only user turn (no text)", () => {
    expect(isWarmTailCandidate({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "..." }] } } as any)).toBe(false);
  });
  it("counts an assistant text reply", () => {
    expect(isWarmTailCandidate({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "好的 🦀" }] } } as any)).toBe(true);
  });
  it("rejects a tool_use-only assistant turn (no text)", () => {
    expect(isWarmTailCandidate({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } } as any)).toBe(false);
  });
  it("rejects compact summaries and non-conv events", () => {
    expect(isWarmTailCandidate({ type: "user", isCompactSummary: true, message: { role: "user", content: "[daily ...]" } } as any)).toBe(false);
    expect(isWarmTailCandidate({ type: "system" } as any)).toBe(false);
  });
});

describe("globalFreshTailStartIdx", () => {
  it("returns events.length when no candidates", () => {
    const evs = [{ type: "system" }, { type: "user", message: { role: "user", content: [{ type: "tool_result" }] } }] as any[];
    expect(globalFreshTailStartIdx(evs, 4)).toBe(evs.length);
  });
  it("returns the oldest candidate index when candidates <= N", () => {
    const evs = [
      { type: "user", message: { role: "user", content: "[imessage · x] a" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
    ] as any[];
    expect(globalFreshTailStartIdx(evs, 4)).toBe(0);
  });
  it("returns the Nth-newest candidate index, counting only candidates", () => {
    // candidates at idx 0,2,3 (idx1 is a tool_result = non-candidate)
    const evs = [
      { type: "user", message: { role: "user", content: "[imessage · x] a" } },       // 0 cand
      { type: "user", message: { role: "user", content: [{ type: "tool_result" }] } }, // 1 non-cand
      { type: "user", message: { role: "user", content: "[imessage · x] b" } },       // 2 cand
      { type: "user", message: { role: "user", content: "[imessage · x] c" } },       // 3 cand
    ] as any[];
    // N=2 → 2nd-newest candidate is idx 2
    expect(globalFreshTailStartIdx(evs, 2)).toBe(2);
  });
});

describe("resolveBlockRange + findDuePromotions — GLOBAL fresh tail", () => {
  let sessionId: string;
  let archivePath: string;

  beforeEach(() => {
    sessionId = `test-blocks-global-${randomUUID()}`;
    (mockedConfig as any).lcm.globalFreshTail = true;
    (mockedConfig as any).lcm.dailyFreshTail = 4; // small N for readable tests
  });

  afterEach(() => {
    (mockedConfig as any).lcm.globalFreshTail = false;
    (mockedConfig as any).lcm.dailyFreshTail = 32;
    if (archivePath && existsSync(archivePath)) unlinkSync(archivePath);
  });

  it("keeps the newest N conversational turns warm across a PAST day", () => {
    // 10 candidate events on a past day, N=4 → compact 6, keep newest 4 raw.
    // (Today-only behavior would compact all 10 for a past day.)
    const pastDay = "2026-04-15";
    const events: any[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(mkTextEvent(pastDay, 9, i % 2 === 0 ? "user" : "assistant", `[imessage · x] msg ${i}`));
    }
    archivePath = writeArchive(sessionId, events);

    const result = resolveBlockRange(sessionId, "daily", pastDay);
    expect(result).not.toBeNull();
    expect(result!.description).toContain("6 events");
    expect(result!.description).toContain("4 most-recent events kept raw");
  });

  it("returns null for a past day entirely within the global warm window", () => {
    // Only 3 candidates total, N=4 → all warm → nothing to promote yet.
    const pastDay = "2026-04-16";
    const events: any[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(mkTextEvent(pastDay, 9, i % 2 === 0 ? "user" : "assistant", `[imessage · x] m ${i}`));
    }
    archivePath = writeArchive(sessionId, events);

    expect(resolveBlockRange(sessionId, "daily", pastDay)).toBeNull();
  });

  it("findDuePromotions does NOT nudge while a past day's raw is inside the warm window", () => {
    // 3 candidates total (≤ N=4) → all warm → no nudge (would be a re-nudge loop).
    const pastDay = "2026-04-16";
    const events: any[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(mkTextEvent(pastDay, 9, i % 2 === 0 ? "user" : "assistant", `[imessage · x] m ${i}`));
    }
    archivePath = writeArchive(sessionId, events);

    const due = findDuePromotions(sessionId);
    expect(due.find((d) => d.level === "daily" && d.period === pastDay)).toBeUndefined();
  });

  it("findDuePromotions DOES nudge once newer turns push the past day out of the window (GC trigger)", () => {
    // Past day has 6 candidates; a later day adds 4 more (= N). The past day's
    // events now fall outside the newest-4 window → should be flagged for rollup.
    const pastDay = "2026-04-16";
    const laterDay = "2026-04-18";
    const events: any[] = [];
    for (let i = 0; i < 6; i++) {
      events.push(mkTextEvent(pastDay, 9, i % 2 === 0 ? "user" : "assistant", `[imessage · x] old ${i}`));
    }
    for (let i = 0; i < 4; i++) {
      events.push(mkTextEvent(laterDay, 9, i % 2 === 0 ? "user" : "assistant", `[imessage · x] new ${i}`));
    }
    archivePath = writeArchive(sessionId, events);

    const due = findDuePromotions(sessionId);
    const dailyDue = due.find((d) => d.level === "daily" && d.period === pastDay);
    expect(dailyDue).toBeDefined();
    // All 6 of the past day's raw are outside the newest-4 window.
    expect(dailyDue!.childCount).toBe(6);
  });

  it("does NOT promote a PARTIAL daily block to its week (day still has warm raw)", () => {
    // A past-week day has a daily block AND warm raw still present → the block is
    // partial → the weekly rollup must NOT be considered due (else it'd summarize
    // an incomplete day and never re-run after the daily block rebuilds).
    const day = "2026-04-08"; // ISO week 2026-W15, well in the past
    const events: any[] = [];
    events.push({
      type: "user",
      uuid: randomUUID(),
      timestamp: new Date(2026, 3, 8, 1, 0, 0).toISOString(),
      isCompactSummary: true,
      blockTag: `daily ${day}`,
      message: { role: "user", content: `[daily ${day} — 40 events summarized]\n\nearly part` },
    });
    // 2 warm raw candidates (≤ N=4) → daily not due, but day is "not fully promoted"
    for (let i = 0; i < 2; i++) {
      events.push(mkTextEvent(day, 14, i % 2 === 0 ? "user" : "assistant", `[imessage · x] warm ${i}`));
    }
    archivePath = writeArchive(sessionId, events);

    const due = findDuePromotions(sessionId);
    expect(due.find((d) => d.level === "weekly")).toBeUndefined();
  });

  it("DOES promote a complete daily block to its week (no remaining raw)", () => {
    // Same week, but the day is fully promoted (block only, no raw) → weekly due.
    const day = "2026-04-08";
    const events: any[] = [{
      type: "user",
      uuid: randomUUID(),
      timestamp: new Date(2026, 3, 8, 1, 0, 0).toISOString(),
      isCompactSummary: true,
      blockTag: `daily ${day}`,
      message: { role: "user", content: `[daily ${day} — 40 events summarized]\n\nfull day` },
    }];
    archivePath = writeArchive(sessionId, events);

    const due = findDuePromotions(sessionId);
    expect(due.find((d) => d.level === "weekly" && d.period === "2026-W15")).toBeDefined();
  });
});
