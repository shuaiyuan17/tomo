import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeContextStats, estimateTokens, resolveTimeRange } from "../src/lcm/stats.js";
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

describe("computeContextStats", () => {
  let sessionId: string;
  let sdkSessionsDir: string;
  let path: string;

  beforeEach(() => {
    sessionId = `test-ctxstats-${randomUUID()}`;
    sdkSessionsDir = join(tmpdir(), `tomo-test-ctxstats-${randomUUID()}`);
    path = getSdkSessionPath(sessionId, sdkSessionsDir);
    mkdirSync(dirname(path), { recursive: true });
  });

  afterEach(() => {
    rmSync(sdkSessionsDir, { recursive: true, force: true });
  });

  const write = (events: object[]) =>
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  it("counts a parallel-tool message once, not once per tool call", () => {
    // One assistant message that fires three tools at once — the shape of any
    // parallel Read/Grep fan-out. It is ONE message holding ~300 tokens of
    // tool input; counting it once per tool_use tripled it, and `tomo lcm
    // stats` then reported tool-heavy ranges as far bigger than they are.
    const ts = new Date(2026, 3, 30, 12, 0, 0).toISOString();
    const input = { pattern: "x".repeat(380) }; // ~100 tokens of JSON per call
    write([
      {
        type: "assistant",
        uuid: randomUUID(),
        timestamp: ts,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input },
            { type: "tool_use", id: "t2", name: "Grep", input },
            { type: "tool_use", id: "t3", name: "Read", input },
          ],
        },
      },
    ]);

    const stats = computeContextStats(sessionId, sdkSessionsDir)!;
    expect(stats).not.toBeNull();

    const oneMessage = estimateTokens(JSON.stringify(input)) * 3;
    expect(stats.totalMessages).toBe(1);
    expect(stats.totalTokens).toBe(oneMessage);
    expect(stats.sections).toHaveLength(1);
    expect(stats.sections[0].tokens).toBe(oneMessage);
    expect(stats.sections[0].messageCount).toBe(1);
    // The per-tool detail is still there — it just isn't a token multiplier.
    expect(stats.sections[0].toolCallCount).toBe(3);
    expect(stats.sections[0].toolsUsed.sort()).toEqual(["Grep:1", "Read:2"]);
  });

  it("counts a thinking-only assistant message instead of dropping it", () => {
    // Extended thinking with no text and no tool call: real tokens sitting in
    // the window that every section total used to omit.
    const ts = new Date(2026, 3, 30, 12, 0, 0).toISOString();
    const thinking = "reasoning ".repeat(100);
    write([
      {
        type: "assistant",
        uuid: randomUUID(),
        timestamp: ts,
        message: { role: "assistant", content: [{ type: "thinking", thinking }] },
      },
    ]);

    const stats = computeContextStats(sessionId, sdkSessionsDir)!;
    expect(stats.totalMessages).toBe(1);
    expect(stats.totalTokens).toBe(estimateTokens(thinking));
    expect(stats.sections[0].type).toBe("conversation");
  });
});
