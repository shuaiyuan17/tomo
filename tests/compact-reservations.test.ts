import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  CompactReservations, backgroundLaunchGuardHooks, startsBackgroundTask,
  BACKGROUND_LAUNCH_SETTLE_MS, COMPACT_RESERVATION_REWRITE_TTL_MS, COMPACT_RESERVATION_RELOAD_TTL_MS,
} = await import("../src/agent/compact-reservations.js");

const IDLE = { activeBackgroundTasks: 0, awaitingTaskReport: false };

describe("CompactReservations", () => {
  let reloadPending: boolean;
  let r: InstanceType<typeof CompactReservations>;

  beforeEach(() => {
    vi.useFakeTimers();
    reloadPending = false;
    r = new CompactReservations(() => reloadPending);
  });
  afterEach(() => {
    r.dispose();
    vi.useRealTimers();
  });

  it("refuses with background tasks, and in the report window", () => {
    expect(r.reserve("k", "sid", { activeBackgroundTasks: 1, awaitingTaskReport: false }))
      .toMatchObject({ ok: false, reason: "background-tasks" });
    expect(r.reserve("k", "sid", { activeBackgroundTasks: 0, awaitingTaskReport: true }))
      .toMatchObject({ ok: false, reason: "awaiting-task-report" });
    expect(r.isPending("k")).toBe(false);
  });

  it("approval marks the session pending; while it stands every launch is denied (TOCTOU closed)", () => {
    const res = r.reserve("k", "sid", IDLE);
    expect(res.ok).toBe(true);
    expect(r.launchDenial("k")).toContain("pending");
    // Other sessions are unaffected.
    expect(r.launchDenial("other")).toBeNull();
    // A second compact of the same session is refused while one is pending.
    expect(r.reserve("k", "sid", IDLE)).toMatchObject({ ok: false, reason: "already-pending" });
  });

  it("a launch allowed moments ago blocks a reservation until it has had time to register", () => {
    expect(r.launchDenial("k")).toBeNull();
    expect(r.reserve("k", "sid", IDLE)).toMatchObject({ ok: false, reason: "recent-launch" });
    vi.advanceTimersByTime(BACKGROUND_LAUNCH_SETTLE_MS);
    expect(r.reserve("k", "sid", IDLE).ok).toBe(true);
  });

  it("finish with no reload pending (the rewrite failed) releases at once", () => {
    const res = r.reserve("k", "sid", IDLE);
    if (!res.ok) throw new Error("expected approval");
    r.finish("k", res.reservationId);
    expect(r.isPending("k")).toBe(false);
    expect(r.launchDenial("k")).toBeNull();
  });

  it("finish with a reload pending keeps the mark until the reload clears it", () => {
    const res = r.reserve("k", "sid", IDLE);
    if (!res.ok) throw new Error("expected approval");
    reloadPending = true;
    r.finish("k", res.reservationId);
    expect(r.isPending("k")).toBe(true);
    r.clear("k");
    expect(r.isPending("k")).toBe(false);
  });

  it("a rewrite that never reports back (crashed/hung client) expires", () => {
    expect(r.reserve("k", "sid", IDLE).ok).toBe(true);
    vi.advanceTimersByTime(COMPACT_RESERVATION_REWRITE_TTL_MS - 1);
    expect(r.isPending("k")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(r.isPending("k")).toBe(false);
  });

  it("a reload that never happens expires too", () => {
    const res = r.reserve("k", "sid", IDLE);
    if (!res.ok) throw new Error("expected approval");
    reloadPending = true;
    r.finish("k", res.reservationId);
    vi.advanceTimersByTime(COMPACT_RESERVATION_RELOAD_TTL_MS);
    expect(r.isPending("k")).toBe(false);
  });

  it("a stale finish or expiry does not release a newer reservation", () => {
    const first = r.reserve("k", "sid", IDLE);
    if (!first.ok) throw new Error("expected approval");
    r.clear("k");
    vi.advanceTimersByTime(BACKGROUND_LAUNCH_SETTLE_MS);
    const second = r.reserve("k", "sid", IDLE);
    expect(second.ok).toBe(true);
    r.finish("k", first.reservationId);
    expect(r.isPending("k")).toBe(true);
  });
});

describe("background launch guard hook", () => {
  it("knows which calls start a background task", () => {
    expect(startsBackgroundTask("Agent", { prompt: "x", run_in_background: true })).toBe(true);
    expect(startsBackgroundTask("Task", { prompt: "x", run_in_background: true })).toBe(true);
    expect(startsBackgroundTask("Bash", { command: "sleep 9", run_in_background: true })).toBe(true);
    expect(startsBackgroundTask("Monitor", {})).toBe(true);
    expect(startsBackgroundTask("Agent", { prompt: "x" })).toBe(false);
    expect(startsBackgroundTask("Bash", { command: "ls" })).toBe(false);
    expect(startsBackgroundTask("Read", null)).toBe(false);
  });

  it("denies a background launch with a readable reason while pending, lets everything else through", async () => {
    let reason: string | null = "a rollup is pending";
    const { PreToolUse } = backgroundLaunchGuardHooks("dm:owner", () => reason);
    expect(PreToolUse[0].onFailure).toBe("block");
    const hook = PreToolUse[0].hooks[0];
    expect(await hook({ tool_name: "Agent", tool_input: { prompt: "x", run_in_background: true } })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "a rollup is pending" },
    });
    expect(await hook({ tool_name: "Agent", tool_input: { prompt: "x" } })).toEqual({});
    reason = null;
    expect(await hook({ tool_name: "Agent", tool_input: { prompt: "x", run_in_background: true } })).toEqual({});
  });

  it("a foreground call does not start the settle window", async () => {
    const r = new CompactReservations(() => false);
    const hook = backgroundLaunchGuardHooks("k", () => r.launchDenial("k")).PreToolUse[0].hooks[0];
    await hook({ tool_name: "Bash", tool_input: { command: "ls" } });
    expect(r.reserve("k", "sid", IDLE).ok).toBe(true);
    r.dispose();
  });
});
