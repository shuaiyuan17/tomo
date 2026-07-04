import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { estimateTokens, resolveTimeRange } from "../src/lcm/stats.js";
import { getSdkSessionPath } from "../src/sessions/index.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

function mkEvent(type: "user" | "assistant", localDate: Date, text: string) {
  return {
    type,
    uuid: randomUUID(),
    timestamp: localDate.toISOString(),
    message: { role: type, content: [{ type: "text", text }] },
  };
}

describe("estimateTokens", () => {
  it("estimates pure ASCII at roughly four chars per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("estimates pure Chinese much higher than chars over four", () => {
    const text = "\u6c49".repeat(400);
    const tokens = estimateTokens(text);
    const oldEstimate = Math.ceil(text.length / 4);

    expect(tokens).toBeGreaterThanOrEqual(250);
    expect(tokens).toBeGreaterThan(oldEstimate * 3);
  });

  it("estimates mixed text between pure ASCII and pure Chinese", () => {
    const ascii = estimateTokens("a".repeat(400));
    const chinese = estimateTokens("\u6c49".repeat(400));
    const mixed = estimateTokens("a".repeat(200) + "\u6c49".repeat(200));

    expect(mixed).toBeGreaterThan(ascii);
    expect(mixed).toBeLessThan(chinese);
  });

  it("returns zero for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("resolveTimeRange", () => {
  let sessionId: string;
  let sdkSessionsDir: string;
  let path: string;

  beforeEach(() => {
    sessionId = `test-stats-${randomUUID()}`;
    sdkSessionsDir = join(tmpdir(), `tomo-test-stats-${randomUUID()}`);
    path = getSdkSessionPath(sessionId, sdkSessionsDir);
    mkdirSync(dirname(path), { recursive: true });
  });

  afterEach(() => {
    rmSync(sdkSessionsDir, { recursive: true, force: true });
  });

  function writeEvents(events: object[]) {
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  it("treats date-only boundaries as the full LOCAL day", () => {
    // Events straddle the local-day boundary. `new Date(y, m, d, h)` builds
    // local-time instants, so this test is timezone-independent: with the old
    // UTC parse of "YYYY-MM-DD", the range would shift by the UTC offset (and
    // the `to` boundary would sit at the START of the day, excluding it).
    const events = [
      mkEvent("user", new Date(2026, 3, 29, 23, 30), "prev day"),        // conv 0
      mkEvent("user", new Date(2026, 3, 30, 0, 30), "early target"),     // conv 1
      mkEvent("assistant", new Date(2026, 3, 30, 23, 30), "late target"),// conv 2
      mkEvent("user", new Date(2026, 4, 1, 0, 30), "next day"),          // conv 3
    ];
    writeEvents(events);

    const r = resolveTimeRange(sessionId, "2026-04-30", "2026-04-30", sdkSessionsDir);
    expect(r).toEqual({
      fromIdx: 1,
      toIdx: 2,
      firstUuid: events[1].uuid,
      lastUuid: events[2].uuid,
    });
  });

  it("still parses timezone-less datetimes as local time", () => {
    const events = [
      mkEvent("user", new Date(2026, 3, 30, 8, 0), "before"),   // conv 0
      mkEvent("user", new Date(2026, 3, 30, 10, 0), "inside"),  // conv 1
      mkEvent("user", new Date(2026, 3, 30, 12, 0), "after"),   // conv 2
    ];
    writeEvents(events);

    const r = resolveTimeRange(sessionId, "2026-04-30T09:00", "2026-04-30T11:00", sdkSessionsDir);
    expect(r).toEqual({
      fromIdx: 1,
      toIdx: 1,
      firstUuid: events[1].uuid,
      lastUuid: events[1].uuid,
    });
  });

  it("returns null for unparseable boundaries", () => {
    writeEvents([mkEvent("user", new Date(2026, 3, 30, 10, 0), "hi")]);
    expect(resolveTimeRange(sessionId, "not-a-date", "2026-04-30", sdkSessionsDir)).toBeNull();
  });

  it("returns null when no events fall inside the range", () => {
    writeEvents([mkEvent("user", new Date(2026, 3, 30, 10, 0), "hi")]);
    expect(resolveTimeRange(sessionId, "2026-05-02", "2026-05-03", sdkSessionsDir)).toBeNull();
  });
});
