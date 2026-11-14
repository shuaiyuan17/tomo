import { describe, it, expect } from "vitest";
import { audienceOf, audienceSwitchNote, isOwnAudienceTurn, MIXED_AUDIENCE_KEY } from "../src/agent/audience.js";

const label = (a: string) => (a === "dm" ? "the private DM" : `the group ${a}`);

describe("audienceOf", () => {
  it("maps private messages to dm", () => {
    expect(audienceOf("telegram", { chatId: "111" })).toBe("dm");
    expect(audienceOf("telegram", { chatId: "111", isGroup: false })).toBe("dm");
  });

  it("maps group messages to their raw session key", () => {
    expect(audienceOf("telegram", { chatId: "-987", isGroup: true })).toBe("telegram:-987");
  });
});

describe("audienceSwitchNote", () => {
  it("is silent for the first message (no previous audience)", () => {
    expect(audienceSwitchNote(undefined, ["dm"], label)).toBe("");
    expect(audienceSwitchNote(undefined, ["telegram:-987"], label)).toBe("");
  });

  it("is silent when the audience is unchanged", () => {
    expect(audienceSwitchNote("dm", ["dm"], label)).toBe("");
    expect(audienceSwitchNote("telegram:-987", ["telegram:-987"], label)).toBe("");
  });

  it("notes a switch from DM to a group as an audience tomo-event", () => {
    const note = audienceSwitchNote("dm", ["telegram:-987"], label);
    expect(note).toMatch(/^<tomo-event type="audience" name="switch" ts="[^"]+">/);
    expect(note).toContain("Audience switched");
    expect(note).toContain("the private DM");
    expect(note).toContain("the group telegram:-987");
    expect(note.trimEnd()).toMatch(/<\/tomo-event>$/);
  });

  it("notes a switch from a group back to the DM", () => {
    const note = audienceSwitchNote("telegram:-987", ["dm"], label);
    expect(note).toContain("Audience switched");
    expect(note).toContain("this one is from the private DM");
  });

  it("notes a switch between two summoned groups", () => {
    const note = audienceSwitchNote("telegram:-987", ["telegram:-555"], label);
    expect(note).toContain("the group telegram:-987");
    expect(note).toContain("the group telegram:-555");
  });

  it("flags mixed-audience batches even without a prior audience", () => {
    const note = audienceSwitchNote(undefined, ["dm", "telegram:-987", "dm"], label);
    expect(note).toMatch(/^<tomo-event type="audience" name="check" ts="[^"]+">/);
    expect(note).toContain("Audience check");
    expect(note).toContain("the private DM");
    expect(note).toContain("the group telegram:-987");
  });

  it("handles empty input", () => {
    expect(audienceSwitchNote("dm", [], label)).toBe("");
  });
});

// The predicate that gates this session's PRIVATE surfaces — the private
// people subtree and the session transcript — for the turn in flight.
describe("isOwnAudienceTurn", () => {
  const DM = "dm:alice";
  const GROUP = "telegram:-1001234567";
  const OTHER_GROUP = "telegram:-1009999999";

  it("is true for a group session's own turn", () => {
    expect(isOwnAudienceTurn(GROUP, [GROUP])).toBe(true);
    // A group session's audience bookkeeping is DM-session-shaped; the key
    // already names the audience, so the turn is always its own.
    expect(isOwnAudienceTurn(GROUP, undefined)).toBe(true);
  });

  it("is true for the owner's own DM turn", () => {
    expect(isOwnAudienceTurn(DM, ["dm"])).toBe(true);
    expect(isOwnAudienceTurn(DM, ["dm", "dm"])).toBe(true);
  });

  it("is true for a background turn with no recorded audience", () => {
    // Cron, LCM, continuity — the owner's own, nobody else is steering.
    expect(isOwnAudienceTurn(DM, undefined)).toBe(true);
    expect(isOwnAudienceTurn(DM, [])).toBe(true);
  });

  it("is false for a summoned group's turn on the owner's DM session", () => {
    expect(isOwnAudienceTurn(DM, [GROUP])).toBe(false);
    expect(isOwnAudienceTurn(DM, [GROUP, GROUP])).toBe(false);
  });

  it("fails closed for a batch spanning several audiences", () => {
    expect(isOwnAudienceTurn(DM, ["dm", GROUP])).toBe(false);
    expect(isOwnAudienceTurn(DM, [GROUP, OTHER_GROUP])).toBe(false);
  });
});

describe("BackgroundAudienceLedger", () => {
  const GROUP = "telegram:-100270";
  const OTHER = "telegram:-100999";

  it("records a task's origin from the turn running when it appeared", async () => {
    const { BackgroundAudienceLedger } = await import("../src/agent/audience.js");
    const l = new BackgroundAudienceLedger();
    l.setLiveTasks([{ task_id: "a" }], () => [GROUP]);
    l.setLiveTasks([{ task_id: "a" }, { task_id: "b" }], () => ["dm"]);
    expect(l.originOf("a")).toEqual([GROUP]);
    expect(l.originOf("b")).toEqual(["dm"]);
    expect(l.liveOrigins().sort()).toEqual([GROUP, "dm"].sort());
  });

  it("is the owner's for a task started with nothing registered (a harness turn)", async () => {
    const { BackgroundAudienceLedger } = await import("../src/agent/audience.js");
    const l = new BackgroundAudienceLedger();
    l.setLiveTasks([{ task_id: "c" }], () => undefined);
    expect(l.originOf("c")).toEqual(["dm"]);
  });

  it("gives a subagent-launched task its parent's origin, not the current turn's", async () => {
    const { BackgroundAudienceLedger } = await import("../src/agent/audience.js");
    const l = new BackgroundAudienceLedger();
    l.setLiveTasks([{ task_id: "p" }], () => [GROUP]);
    l.setLiveTasks([{ task_id: "p" }, { task_id: "child", parent_task_id: "p" }], () => ["dm"]);
    expect(l.originOf("child")).toEqual([GROUP]);
  });

  it("attributes report turns in order, one task's report each", async () => {
    const { BackgroundAudienceLedger } = await import("../src/agent/audience.js");
    const l = new BackgroundAudienceLedger();
    l.setLiveTasks([{ task_id: "g" }], () => [GROUP]);
    l.setLiveTasks([{ task_id: "g" }, { task_id: "o" }], () => ["dm"]);
    l.taskFinished("g");
    l.setLiveTasks([{ task_id: "o" }], () => undefined);
    expect(l.claimReportTurn()).toEqual([GROUP]);
    l.endReportTurn();
    l.taskFinished("o");
    l.setLiveTasks([], () => undefined);
    expect(l.claimReportTurn()).toEqual(["dm"]);
  });

  it("unions reports that arrive together, so disagreement fails closed", async () => {
    const { BackgroundAudienceLedger, scopedCallerKeyFor } = await import("../src/agent/audience.js");
    const l = new BackgroundAudienceLedger();
    l.setLiveTasks([{ task_id: "g" }], () => [GROUP]);
    l.setLiveTasks([{ task_id: "g" }, { task_id: "h" }], () => [OTHER]);
    l.taskFinished("g");
    l.taskFinished("h");
    expect(scopedCallerKeyFor("dm:shuai", l.claimReportTurn())).toBe(MIXED_AUDIENCE_KEY);
  });

  it("does not queue a task's report twice (notification, then leaving the set)", async () => {
    const { BackgroundAudienceLedger } = await import("../src/agent/audience.js");
    const l = new BackgroundAudienceLedger();
    l.setLiveTasks([{ task_id: "g" }], () => [GROUP]);
    l.taskFinished("g");
    expect(l.claimReportTurn()).toEqual([GROUP]);
    l.endReportTurn();
    l.setLiveTasks([], () => undefined);
    // Nothing left to attribute the next one to.
    expect(l.claimReportTurn()).toEqual([MIXED_AUDIENCE_KEY]);
  });

  it("fails an unattributable report turn closed, with no timeout to release it", async () => {
    const { BackgroundAudienceLedger } = await import("../src/agent/audience.js");
    const l = new BackgroundAudienceLedger();
    expect(l.claimReportTurn()).toEqual([MIXED_AUDIENCE_KEY]);
    expect(l.reportTurnAudience()).toEqual([MIXED_AUDIENCE_KEY]);
    l.endReportTurn();
    expect(l.reportTurnAudience()).toBeNull();
  });

  it("falls back to the live tasks' origins when no report is queued", async () => {
    const { BackgroundAudienceLedger } = await import("../src/agent/audience.js");
    const l = new BackgroundAudienceLedger();
    l.setLiveTasks([{ task_id: "m" }], () => ["dm"]);
    expect(l.claimReportTurn()).toEqual(["dm"]);
  });

  it("a task started inside a report turn inherits that turn's audience", async () => {
    const { BackgroundAudienceLedger } = await import("../src/agent/audience.js");
    const l = new BackgroundAudienceLedger();
    l.setLiveTasks([{ task_id: "g" }], () => [GROUP]);
    l.taskFinished("g");
    l.setLiveTasks([], () => undefined);
    l.claimReportTurn();
    l.setLiveTasks([{ task_id: "g2" }], () => undefined);
    expect(l.originOf("g2")).toEqual([GROUP]);
  });
});
