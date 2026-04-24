import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveBlockRange, findDuePromotions } from "../src/lcm/blocks.js";
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
