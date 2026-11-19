import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  CompactReservations, backgroundLaunchGuardHooks, startsBackgroundTask,
  BACKGROUND_LAUNCH_SETTLE_MS, COMPACT_RESERVATION_REWRITE_SAFETY_MS,
} = await import("../src/agent/compact-reservations.js");

const IDLE = { activeBackgroundTasks: 0, awaitingTaskReport: false, backgroundingInFlight: 0 };

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
    expect(r.reserve("k", "sid", { ...IDLE, activeBackgroundTasks: 1 }))
      .toMatchObject({ ok: false, reason: "background-tasks" });
    expect(r.reserve("k", "sid", { ...IDLE, awaitingTaskReport: true }))
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

  it("refuses while a task is being moved to the background", () => {
    expect(r.reserve("k", "sid", { ...IDLE, backgroundingInFlight: 1 })).toMatchObject({ ok: false, reason: "backgrounding" });
  });

  it("finish with the trigger on disk holds the mark for as long as the trigger exists — no timeout", () => {
    const res = r.reserve("k", "sid", IDLE);
    if (!res.ok) throw new Error("expected approval");
    reloadPending = true;
    r.finish("k", res.reservationId);
    // An idle session can go a long time without the turn that reloads it.
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    expect(r.isPending("k")).toBe(true);
    expect(r.launchDenial("k")).not.toBeNull();
    // The turn-end path consumes the trigger and holds the mark through the close.
    r.holdForReload("k");
    reloadPending = false;
    expect(r.isPending("k")).toBe(true);
    r.clear("k");
    expect(r.isPending("k")).toBe(false);
  });

  it("an awaiting-reload mark ends when its trigger is gone (consumed, or the key moved to another session)", () => {
    const res = r.reserve("k", "sid", IDLE);
    if (!res.ok) throw new Error("expected approval");
    reloadPending = true;
    r.finish("k", res.reservationId);
    reloadPending = false;
    expect(r.isPending("k")).toBe(false);
  });

  it("a rewriter that never reports back keeps the mark until the long safety timeout", () => {
    expect(r.reserve("k", "sid", IDLE).ok).toBe(true);
    vi.advanceTimersByTime(COMPACT_RESERVATION_REWRITE_SAFETY_MS - 1);
    expect(r.isPending("k")).toBe(true);
    vi.advanceTimersByTime(1);
    // No trigger appeared: the rewrite never happened, release.
    expect(r.isPending("k")).toBe(false);
  });

  it("the safety timeout never releases a mark whose trigger is on disk", () => {
    expect(r.reserve("k", "sid", IDLE).ok).toBe(true);
    reloadPending = true; // the crashed CLI got as far as the rename
    vi.advanceTimersByTime(COMPACT_RESERVATION_REWRITE_SAFETY_MS);
    expect(r.isPending("k")).toBe(true);
  });

  it("holdForReload protects a reload even when the rewrite bypassed the gate", () => {
    r.holdForReload("k");
    expect(r.launchDenial("k")).not.toBeNull();
    r.clear("k");
    expect(r.launchDenial("k")).toBeNull();
  });

  it("a stale finish does not release a newer reservation", () => {
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
