import { beforeEach, describe, expect, it, vi } from "vitest";

const { cfg } = vi.hoisted(() => ({ cfg: { lcm: { forceCompactAtPct: 95 }, locale: undefined as string | undefined } }));
vi.mock("../src/config.js", () => ({ config: cfg }));
vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { ForceCompactor, FORCE_COMPACT_MAX_PER_HOUR, sessionNote } = await import("../src/agent/force-compactor.js");
import type { ForceCompactorDeps } from "../src/agent/force-compactor.js";
import type { ForceCompactReport } from "../src/lcm/force-compact.js";
import type { RunningTaskRecord } from "../src/agent/running-agents-ledger.js";

const reading = (used: number, max = 1000, estimated = false, inputTokens = 500) => ({
  costUsd: 0, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  contextUsed: used, contextMax: max, ...(estimated ? { contextEstimated: true } : {}),
});

const okReport = (over: Partial<ForceCompactReport> = {}): ForceCompactReport => ({
  beforeTokens: 960, afterTokens: 400, contextMax: 1000, pruned: { entries: 3, chars: 9000 },
  summarized: [{ from: "2026-11-22 09:00", to: "2026-11-22 18:00", events: 40, blockTag: "daily 2026-11-22" }],
  archived: [], usageCapped: 1, reachedSafe: true, ok: true, errors: [], ...over,
});

const agent: RunningTaskRecord = { sessionKey: "telegram:-100", taskId: "a1", kind: "agent", taskType: "local_agent", subagentType: "general-purpose", description: "research", startedAt: 1, lastActivityAt: 2 };

function makeDeps(over: Partial<ForceCompactorDeps> = {}) {
  const events: string[] = [];
  const release = vi.fn(() => { events.push("release"); });
  const deps = {
    hold: vi.fn((key: string) => { events.push("hold"); return { key, release }; }),
    quiesce: vi.fn(async (_h: unknown, beforeClose: () => boolean) => { events.push("quiesce"); return beforeClose() ? "sdk-1" : null; }),
    markInterrupted: vi.fn(() => { events.push("mark"); return [agent]; }),
    sessionClosed: vi.fn(),
    compact: vi.fn(async () => { events.push("compact"); return okReport(); }),
    queueNote: vi.fn((_k: string, _n: string) => { events.push("note"); return true; }),
    notifyOwner: vi.fn(async () => { events.push("owner"); return true; }),
    groupTitle: vi.fn(() => "Family"),
    reportInterrupted: vi.fn(() => { events.push("interrupted-note"); }),
    ...over,
  };
  return { deps, events, release };
}

beforeEach(() => { cfg.lcm.forceCompactAtPct = 95; });

describe("ForceCompactor triggers", () => {
  it("starts at the threshold, not below it, and never on an estimated reading", async () => {
    const { deps } = makeDeps();
    const fc = new ForceCompactor(deps);
    expect(fc.maybeStart("dm:owner", reading(949), "threshold")).toBe(false);
    expect(fc.maybeStart("dm:owner", reading(990, 1000, true), "threshold")).toBe(false);
    expect(deps.hold).not.toHaveBeenCalled();
    expect(fc.maybeStart("dm:owner", reading(950), "threshold")).toBe(true);
    await fc.running("dm:owner");
    expect(deps.compact).toHaveBeenCalledWith(expect.objectContaining({ key: "dm:owner", sdkSessionId: "sdk-1", contextUsed: 950, contextMax: 1000 }));
  });

  it("starts on \"Prompt is too long\" at any reading, with the window seen earlier", async () => {
    const { deps } = makeDeps();
    const fc = new ForceCompactor(deps);
    fc.maybeStart("dm:owner", reading(100, 200_000), "threshold");
    expect(fc.maybeStart("dm:owner", null, "prompt-too-long")).toBe(true);
    await fc.running("dm:owner");
    expect(deps.compact).toHaveBeenCalledWith(expect.objectContaining({ contextMax: 200_000 }));
  });

  it("does not calibrate on a reading from a turn the CLI refused locally (no tokens: the stale anchor itself)", async () => {
    const { deps } = makeDeps();
    const fc = new ForceCompactor(deps);
    expect(fc.maybeStart("dm:owner", reading(995, 1000, false, 0), "threshold")).toBe(true);
    await fc.running("dm:owner");
    expect(deps.compact).toHaveBeenCalledWith(expect.objectContaining({ key: "dm:owner", sdkSessionId: "sdk-1", contextUsed: undefined, contextMax: 1000 }));
  });

  it.each([0, 100])("is off at forceCompactAtPct=%s, for both triggers", (pct) => {
    cfg.lcm.forceCompactAtPct = pct;
    const { deps } = makeDeps();
    const fc = new ForceCompactor(deps);
    expect(fc.maybeStart("dm:owner", reading(999), "threshold")).toBe(false);
    expect(fc.maybeStart("dm:owner", reading(999), "prompt-too-long")).toBe(false);
    expect(deps.hold).not.toHaveBeenCalled();
  });

  it("runs one compaction per key at a time, and none when the hold is refused", async () => {
    let finish!: () => void;
    const { deps } = makeDeps({ compact: vi.fn(() => new Promise<ForceCompactReport>((r) => { finish = () => r(okReport()); })) });
    const fc = new ForceCompactor(deps);
    expect(fc.maybeStart("dm:owner", reading(990), "threshold")).toBe(true);
    expect(fc.maybeStart("dm:owner", reading(990), "prompt-too-long")).toBe(true);
    expect(deps.hold).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(deps.compact).toHaveBeenCalled());
    finish();
    await fc.running("dm:owner");

    const refused = makeDeps({ hold: vi.fn(() => null) });
    const fc2 = new ForceCompactor(refused.deps);
    expect(fc2.maybeStart("dm:owner", reading(990), "threshold")).toBe(false);
    expect(refused.deps.quiesce).not.toHaveBeenCalled();
  });

  it(`gives up after ${FORCE_COMPACT_MAX_PER_HOUR} runs in an hour and tells the owner once`, async () => {
    let now = 0;
    const { deps } = makeDeps({ now: () => now } as Partial<ForceCompactorDeps>);
    const fc = new ForceCompactor(deps);
    for (let i = 0; i < FORCE_COMPACT_MAX_PER_HOUR; i++) {
      expect(fc.maybeStart("dm:owner", reading(990), "threshold")).toBe(true);
      await fc.running("dm:owner");
      now += 60_000;
    }
    deps.notifyOwner.mockClear();
    expect(fc.maybeStart("dm:owner", reading(990), "threshold")).toBe(false);
    expect(fc.maybeStart("dm:owner", reading(990), "threshold")).toBe(false);
    expect(deps.notifyOwner.mock.calls.filter((c) => /3 times/.test(String(c[0])))).toHaveLength(1);
    now += 61 * 60_000;
    expect(fc.maybeStart("dm:owner", reading(990), "threshold")).toBe(true);
  });
});

describe("ForceCompactor run", () => {
  it("records the background work, then closes, compacts, notes the session inside the hold, and tells the owner once", async () => {
    const { deps, events } = makeDeps();
    const fc = new ForceCompactor(deps);
    fc.maybeStart("telegram:-100", reading(970), "threshold");
    await fc.running("telegram:-100");
    expect(events).toEqual(["hold", "quiesce", "mark", "compact", "note", "interrupted-note", "release"]);
    // The result is told only once the next turn shows it reached the API.
    fc.maybeStart("telegram:-100", reading(300), "threshold");
    expect(events.at(-1)).toBe("owner");
    expect(deps.reportInterrupted).toHaveBeenCalledWith("telegram:-100", [agent]);
    const note = deps.queueNote.mock.calls[0][1];
    expect(note).toContain('<tomo-event type="force-compacted"');
    expect(note).toContain("summarized 2026-11-22 09:00 → 2026-11-22 18:00");
    expect(note).toContain("1 background task(s)");
    // A group: its title, never its content, in the owner's DM.
    const owner = String(deps.notifyOwner.mock.calls[0][0]);
    expect(owner).toContain("“Family”");
    expect(owner).toContain("97%");
    expect(owner).toContain("40%");
    expect(owner).not.toContain("2026-11-22");
    expect(owner).toMatch(/1 background task was stopped/);
  });

  it("aborts without closing or compacting when the interrupted work cannot be recorded", async () => {
    const { deps, release } = makeDeps({ markInterrupted: vi.fn(() => null) });
    const fc = new ForceCompactor(deps);
    fc.maybeStart("dm:owner", reading(990), "threshold");
    await fc.running("dm:owner");
    expect(deps.compact).not.toHaveBeenCalled();
    expect(deps.queueNote).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(String(deps.notifyOwner.mock.calls[0][0])).toMatch(/could not compact/);
  });

  it("releases the hold and reports a failure when the compaction throws", async () => {
    const { deps, release } = makeDeps({ compact: vi.fn(async () => { throw new Error("disk full"); }) });
    const fc = new ForceCompactor(deps);
    fc.maybeStart("dm:owner", reading(990), "threshold");
    await fc.running("dm:owner");
    expect(release).toHaveBeenCalledTimes(1);
    expect(String(deps.notifyOwner.mock.calls[0][0])).toMatch(/could not compact/);
    expect(fc.running("dm:owner")).toBeUndefined();
  });

  it("reports a run that did not complete as a failure — and what it did change, if anything", async () => {
    const none = makeDeps({ compact: vi.fn(async () => okReport({ ok: false, pruned: null, summarized: [], usageCapped: 0, errors: ["archive rewrite: refused"] })) });
    const fc = new ForceCompactor(none.deps);
    fc.maybeStart("dm:owner", reading(990), "threshold");
    await fc.running("dm:owner");
    expect(none.deps.queueNote).not.toHaveBeenCalled();
    expect(String(none.deps.notifyOwner.mock.calls[0][0])).toMatch(/could not compact it itself.*Nothing was changed/);

    const part = makeDeps({ compact: vi.fn(async () => okReport({ ok: false, usageCapped: 0, errors: ["archive rewrite: refused"] })) });
    const fc2 = new ForceCompactor(part.deps);
    fc2.maybeStart("dm:owner", reading(990), "threshold");
    await fc2.running("dm:owner");
    expect(part.deps.queueNote.mock.calls[0][1]).toContain("could not finish");
    expect(String(part.deps.notifyOwner.mock.calls[0][0])).toMatch(/compacted part of it.*could not finish/);
  });

  it("recovers a refusal right after a restart with the window the registry recorded", async () => {
    const { deps } = makeDeps({ persistedWindow: () => 1_000_000 });
    const fc = new ForceCompactor(deps);
    expect(fc.maybeStart("dm:owner", null, "prompt-too-long")).toBe(true);
    await fc.running("dm:owner");
    expect(deps.compact).toHaveBeenCalledWith(expect.objectContaining({ contextMax: 1_000_000 }));
    const none = makeDeps();
    expect(new ForceCompactor(none.deps).maybeStart("dm:owner", null, "prompt-too-long")).toBe(false);
  });

  it("stop() aborts a running compaction, waits for it, and starts no new one", async () => {
    let seen: AbortSignal | undefined;
    const { deps } = makeDeps({
      compact: vi.fn(({ signal }) => { seen = signal; return new Promise<ForceCompactReport>((r) => signal.addEventListener("abort", () => r(okReport({ ok: false, errors: ["aborted (shutdown)"] })))); }),
    });
    const fc = new ForceCompactor(deps);
    fc.maybeStart("dm:owner", reading(990), "threshold");
    await vi.waitFor(() => expect(deps.compact).toHaveBeenCalled());
    await fc.stop();
    expect(seen?.aborted).toBe(true);
    expect(fc.running("dm:owner")).toBeUndefined();
    expect(fc.maybeStart("telegram:-1", reading(990), "threshold")).toBe(false);
  });

  it("judges the result by the next turn: recovered when it reached the API, still-over when refused again", async () => {
    const { log } = await import("../src/logger.js");
    const a = makeDeps();
    const fc = new ForceCompactor(a.deps);
    fc.maybeStart("dm:owner", reading(990), "threshold");
    await fc.running("dm:owner");
    expect(a.deps.notifyOwner).not.toHaveBeenCalled();
    // A locally refused turn: no tokens, then the prompt-too-long call.
    // Another kind of failed turn judges nothing.
    fc.maybeStart("dm:owner", reading(300), "turn-failed");
    expect(a.deps.notifyOwner).not.toHaveBeenCalled();
    fc.maybeStart("dm:owner", reading(990, 1000, false, 0), "prompt-too-long");
    await vi.waitFor(() => expect(a.deps.notifyOwner).toHaveBeenCalledTimes(1));
    expect(String(a.deps.notifyOwner.mock.calls[0][0])).toMatch(/still refused/);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ result: "still-over" }), "Forced compaction result");

    const b = makeDeps();
    const fc2 = new ForceCompactor(b.deps);
    fc2.maybeStart("dm:owner", reading(990), "threshold");
    await fc2.running("dm:owner");
    fc2.maybeStart("dm:owner", reading(300), "threshold");
    expect(String(b.deps.notifyOwner.mock.calls[0][0])).toMatch(/now about 40%/);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ result: "recovered" }), "Forced compaction result");
    fc2.maybeStart("dm:owner", reading(300), "threshold");
    expect(b.deps.notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("keeps the ledger cut-off until a CLI that outlived the close has exited", async () => {
    let exit!: () => void;
    const untilExit = new Promise<void>((r) => { exit = r; });
    const { deps } = makeDeps({ quiesce: vi.fn(async (h: { untilExit?: Promise<void> }, beforeClose: () => boolean) => { beforeClose(); h.untilExit = untilExit; return null; }) as never });
    const fc = new ForceCompactor(deps);
    fc.maybeStart("dm:owner", reading(990), "threshold");
    await fc.running("dm:owner");
    expect(deps.sessionClosed).not.toHaveBeenCalled();
    exit();
    await vi.waitFor(() => expect(deps.sessionClosed).toHaveBeenCalledWith("dm:owner"));
  });

  it("tells the session about an archive fallback and a still-high result", () => {
    const note = sessionNote({ reason: "prompt-too-long", beforePct: 99 }, okReport({
      summarized: [], archived: [{ from: "a", to: "b", events: 5, blockTag: "daily x" }], afterTokens: 800, reachedSafe: false,
    }), []);
    expect(note).toContain("Prompt is too long");
    expect(note).toContain("archived a → b (5 events) without a summary");
    expect(note).toContain("still high");
  });
});
