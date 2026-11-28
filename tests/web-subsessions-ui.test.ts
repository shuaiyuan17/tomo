import { describe, expect, it } from "vitest";
import { activeSubsessions, canRetrySend, folded, hasProgress, leadsWithChat, progressSummary, planStepLook, showableTime, updateText, pendingFor, updatePending, isOpenSubsession, subsessionChatRows, subsessionState, subsessionStateLabel, isWorkingState, subsessionsRefreshMs, SUBSESSIONS_BACKGROUND_REFRESH_MS, msToNextLocalDay, startOfLocalDay, todaysSubsessions, withListBackground } from "../web/src/subsessions.js";
import type { WebSubsession, WebSubsessionDetail } from "../src/web/protocol.js";

const task = (extra: Partial<WebSubsession> = {}): WebSubsession => ({ id: "s1", title: "T", status: "active", working: false,
  createdAt: 0, lastActivityAt: 0, activeMs: 0, revision: 0, writable: true, ...extra });
const detail = (extra: Partial<WebSubsessionDetail> = {}): WebSubsessionDetail => ({ ...task(), brief: "Do it.", conversation: [], ...extra });

describe("sub-sessions in the Tasks rail", () => {
  it("moves the step in progress only while the task is working, and holds it still while it waits", () => {
    expect(planStepLook("in_progress", true)).toBe("running");
    expect(planStepLook("in_progress", false)).toBe("paused");
    expect(planStepLook("pending", true)).toBe("pending");
    const waiting = (waitingOn: "owner" | "external") => isWorkingState(subsessionState({ status: "waiting", waitingOn, working: false }));
    expect(planStepLook("in_progress", waiting("owner"))).toBe("paused");
    expect(planStepLook("in_progress", waiting("external"))).toBe("paused");
    expect(planStepLook("in_progress", isWorkingState(subsessionState({ status: "active", working: true })))).toBe("running");
    // Waiting on something external while its own background work runs: that work is running, so it moves, as the header does.
    expect(planStepLook("in_progress", isWorkingState(subsessionState({ status: "waiting", waitingOn: "external", working: false, background: true })))).toBe("running");
    // Active between turns: no turn runs, so it holds still.
    expect(planStepLook("in_progress", isWorkingState(subsessionState({ status: "active", working: false })))).toBe("paused");
  });

  it("shows a time only when a Date can hold it", () => {
    expect(showableTime(Date.UTC(2026, 10, 25))).toBe(true);
    expect(showableTime(1e20)).toBe(false);
    expect(showableTime(Number.NaN)).toBe(false);
  });

  it("says what a task is doing: working only with a turn running, and when it waits on the owner", () => {
    expect(subsessionState(task({ working: true }))).toBe("working");
    expect(subsessionState(task())).toBe("active");
    expect(subsessionState(task({ status: "waiting", waitingOn: "owner" }))).toBe("waitingOwner");
    expect(subsessionState(task({ status: "waiting", waitingOn: "external" }))).toBe("waiting");
    expect(subsessionState(task({ status: "finished" }))).toBe("finished");
    expect(subsessionState(task({ status: "finished", ownerAction: "Merge PR #3" }))).toBe("needsYou");
    expect(subsessionStateLabel(task({ status: "finished", ownerAction: "Merge PR #3" }))).toBe("Needs you");
    expect(isOpenSubsession(task({ status: "finished", ownerAction: "Merge PR #3" }))).toBe(true);
    expect(isOpenSubsession(task({ status: "finished" }))).toBe(false);
    expect(subsessionStateLabel(task({ status: "waiting", waitingOn: "owner" }))).toBe("Waiting for you");
    expect(subsessionStateLabel(task({ working: true }))).toBe("Working");
  });

  it("shows a task whose background work still runs as working, not waiting", () => {
    const bg = task({ status: "waiting", waitingOn: "external", background: true });
    expect(subsessionState(bg)).toBe("background");
    expect(isWorkingState(subsessionState(bg))).toBe(true);
    expect(subsessionStateLabel(bg)).toBe("Working (background)");
    expect(isWorkingState(subsessionState(task({ status: "waiting", waitingOn: "external" })))).toBe(false);
    // Waiting on the owner is never hidden behind background work.
    expect(subsessionState(task({ status: "waiting", waitingOn: "owner", background: true }))).toBe("waitingOwner");
    expect(activeSubsessions([bg, task({ id: "s2", status: "waiting", waitingOn: "external" })])).toBe(1);
  });

  it("re-reads the list while a task waits on something external, since its background work changes no record", () => {
    const bg = task({ status: "waiting", waitingOn: "external", background: true });
    expect(subsessionsRefreshMs({ available: true, tasks: [task(), bg] })).toBe(SUBSESSIONS_BACKGROUND_REFRESH_MS);
    // Waiting on something external without it: background work may start (a report turn), so it is read again too.
    expect(subsessionsRefreshMs({ available: true, tasks: [task(), task({ id: "s2", status: "waiting", waitingOn: "external" })] })).toBe(SUBSESSIONS_BACKGROUND_REFRESH_MS);
    expect(subsessionsRefreshMs({ available: true, tasks: [task(), task({ id: "s2", status: "waiting", waitingOn: "owner" }), task({ id: "s3", status: "finished" })] })).toBeUndefined();
    expect(subsessionsRefreshMs({ available: false, tasks: [] })).toBeUndefined();
  });

  it("takes background from the list alone when an opened task is shown", () => {
    const summary = task({ status: "waiting", waitingOn: "external" });
    const shown = withListBackground(detail({ status: "waiting", waitingOn: "external", background: true }), summary);
    expect(shown).not.toHaveProperty("background");
    expect(subsessionState(shown)).toBe("waiting");
    expect(withListBackground(detail(), { ...summary, background: true }).background).toBe(true);
    expect(withListBackground(undefined, summary)).toEqual(summary);
    // Marked done: the list no longer says Needs you, and an older detail read does not bring it back.
    const done = withListBackground(detail({ status: "finished", ownerAction: "Merge PR #3", reportSeq: 2 }), task({ status: "finished" }));
    expect(done).not.toHaveProperty("ownerAction");
    expect(done).not.toHaveProperty("reportSeq");
    expect(subsessionState(done)).toBe("finished");
  });

  it("words an update: the task's own line, or the milestone's name", () => {
    expect(updateText({ at: 1, kind: "update", text: "Chose B" })).toBe("Chose B");
    expect(updateText({ at: 1, kind: "update", text: "C was not needed", plan: true })).toBe("Plan changed: C was not needed");
    expect(updateText({ at: 1, kind: "milestone", milestone: "waitingOwner" })).toBe("Waiting for you");
    expect(updateText({ at: 1, kind: "milestone", milestone: "started" })).toBe("Started");
    expect(updateText({ at: 1, kind: "milestone", milestone: "cancelled", reason: "not needed" })).toBe("Cancelled: not needed");
    // A milestone this page does not know (a newer daemon) shows nothing rather than a raw key.
    expect(updateText({ at: 1, kind: "milestone", milestone: "teleported" as never })).toBe("");
  });

  it("folds a long list to its newest few until asked", () => {
    const items = [1, 2, 3, 4, 5];
    expect(folded(items, 3, false, "end")).toEqual({ shown: [3, 4, 5], hidden: 2 });
    expect(folded(items, 3, false, "start")).toEqual({ shown: [1, 2, 3], hidden: 2 });
    expect(folded(items, 3, true, "end")).toEqual({ shown: items, hidden: 0 });
    expect(folded([1, 2], 3, false, "end")).toEqual({ shown: [1, 2], hidden: 0 });
  });

  it("counts only running tasks on the Tasks button", () => {
    expect(activeSubsessions([task(), task({ id: "s2", status: "waiting" }), task({ id: "s3", status: "finished" }), task({ id: "s4", status: "queued" })])).toBe(1);
    expect(isOpenSubsession(task({ status: "queued" }))).toBe(true);
    expect(isOpenSubsession(task({ status: "cancelled" }))).toBe(false);
  });

  it("lays out the chat: brief, the conversation in order, the report, then messages still on their way", () => {
    const rows = subsessionChatRows(detail({ quote: ["owner words"], report: "All done.", conversation: [
      { seq: 1, at: 1, from: "task", kind: "notify", text: "Started." },
      { seq: 2, at: 2, from: "owner", kind: "message", text: "Use B.", files: 1 },
      { seq: 3, at: 3, from: "task", kind: "ask", text: "Ship?" },
      { seq: 4, at: 4, from: "task", kind: "reply", text: "Done with B." },
    ] }), [{ requestId: "r1", text: "thanks", state: "sending" }]);
    expect(rows.map((r) => r.kind === "entry" ? `${r.from}:${r.tag ?? "-"}` : r.kind)).toEqual(["brief", "task:notify", "owner:-", "task:ask", "task:-", "report", "pending"]);
    expect(rows[0]).toMatchObject({ quote: ["owner words"], brief: "Do it." });
    expect(rows[2]).toMatchObject({ files: 1 });
    // Earlier reports, replaced before they were read, come before the report.
    const withEarlier = subsessionChatRows(detail({ report: "Third.", earlierReports: [{ seq: 2, text: "Second." }] }), []);
    expect(withEarlier.map((r) => r.kind === "report" ? `report:${r.seq ?? "-"}` : r.kind)).toEqual(["brief", "report:2", "report:-"]);
  });

  it("leads with what the task is doing until something is said, then with the chat", () => {
    expect(leadsWithChat(subsessionChatRows(detail(), []))).toBe(false);
    // Any line of the conversation, either way, the report, or the owner's message on its way: the chat leads.
    expect(leadsWithChat(subsessionChatRows(detail({ conversation: [{ seq: 1, at: 1, from: "owner", kind: "message", text: "hi" }] }), []))).toBe(true);
    expect(leadsWithChat(subsessionChatRows(detail({ conversation: [{ seq: 1, at: 1, from: "task", kind: "notify", text: "Started." }] }), []))).toBe(true);
    expect(leadsWithChat(subsessionChatRows(detail({ report: "Done." }), []))).toBe(true);
    expect(leadsWithChat(subsessionChatRows(detail(), [{ requestId: "r1", text: "go", state: "sending" }]))).toBe(true);
    // A sent message the conversation already has adds nothing of its own.
    expect(leadsWithChat(subsessionChatRows(detail({ revision: 3 }), [{ requestId: "r1", text: "go", state: "sent", revision: 3 }]))).toBe(false);
  });

  it("has something to show of what the task is doing only with a plan, a done step or a line it can word", () => {
    expect(hasProgress({})).toBe(false);
    expect(hasProgress({ plan: [{ text: "A", status: "pending" }] })).toBe(true);
    expect(hasProgress({ doneSteps: [{ at: 1, text: "A" }] })).toBe(true);
    expect(hasProgress({ updates: [{ at: 1, kind: "milestone", milestone: "started" }] })).toBe(true);
    expect(hasProgress({ updates: [{ at: 1, kind: "milestone", milestone: "teleported" as never }] })).toBe(false);
    expect(hasProgress({ checkpoint: "Pushed branch x" })).toBe(true);
  });

  it("folds what it is doing into one line: the step it is on, else the next, else its latest own update, else its last done step", () => {
    const doneSteps = [{ at: 1, text: "Read the code" }, { at: 2, text: "Wrote the fix" }];
    const updates = [{ at: 5, kind: "milestone" as const, milestone: "finished" as const }, { at: 4, kind: "update" as const, text: "Chose B" }];
    expect(progressSummary({ doneSteps, plan: [{ text: "Test it", status: "in_progress" }, { text: "Ship", status: "pending" }] }, true))
      .toEqual({ text: "Test it", look: "running", done: 2, total: 4 });
    expect(progressSummary({ plan: [{ text: "Test it", status: "in_progress" }] }, false)).toMatchObject({ look: "paused", done: 0, total: 1 });
    expect(progressSummary({ doneSteps, plan: [{ text: "Ship", status: "pending" }] }, true)).toEqual({ text: "Next: Ship", look: "pending", done: 2, total: 3 });
    // No plan left (an ended task): its own latest line before a milestone, with no count.
    expect(progressSummary({ doneSteps, updates }, false)).toEqual({ text: "Chose B", look: "update", done: 2 });
    expect(progressSummary({ doneSteps, updates: [updates[0]] }, false)).toEqual({ text: "Wrote the fix", look: "done", done: 2 });
    expect(progressSummary({ updates: [updates[0]] }, false)).toEqual({ text: "Finished", look: "update", done: 0 });
    expect(progressSummary({}, false)).toBeUndefined();
    expect(progressSummary({ checkpoint: "Pushed branch x" }, false)).toEqual({ text: "Checkpoint", look: "update", done: 0 });
  });

  it("keeps a sent message until a read of the conversation has it, so it never blinks out", () => {
    const sent = { requestId: "r1", text: "go", state: "sent" as const, revision: 3 };
    expect(subsessionChatRows(detail({ revision: 2 }), [sent]).at(-1)).toMatchObject({ kind: "pending" });
    expect(subsessionChatRows(detail({ revision: 3 }), [sent]).some((r) => r.kind === "pending")).toBe(false);
    const failed = { requestId: "r2", text: "go", state: "failed" as const, error: "network" };
    expect(subsessionChatRows(detail({ revision: 9 }), [failed]).at(-1)).toMatchObject({ kind: "pending", message: { state: "failed" } });
  });

  it("keeps messages on their way outside the chat view, so leaving the chat loses none", () => {
    updatePending("s7", (old) => [...old, { requestId: "r1", text: "go", state: "failed", error: "network" }]);
    // A later view of the same task finds it, with the request id a retry reuses.
    expect(pendingFor("s7")).toEqual([{ requestId: "r1", text: "go", state: "failed", error: "network" }]);
    expect(pendingFor("s8")).toEqual([]);
    updatePending("s7", () => []);
    expect(pendingFor("s7")).toEqual([]);
  });

  it("shows what is on its way even before (or without) a read of the conversation", () => {
    const rows = subsessionChatRows(undefined, [{ requestId: "r1", text: "go", state: "failed", error: "network" }, { requestId: "r2", text: "x", state: "sent", revision: 1 }]);
    expect(rows.map((r) => r.key)).toEqual(["pr1"]);
  });

  it("offers a retry for any failed send except to a task that ended or is gone", () => {
    for (const error of ["network", "subsessions_unavailable", "subsession_inbox_full", undefined]) expect(canRetrySend(error)).toBe(true);
    for (const error of ["subsession_ended", "subsession_not_found"]) expect(canRetrySend(error)).toBe(false);
  });
  describe("only today's ended sub-sessions are listed until the earlier ones are asked for", () => {
    // Times are built on the machine's own clock, as the browser reads them: the test holds in any time zone.
    const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
    const now = at(27, 15);
    const ids = (list: readonly WebSubsession[]) => list.map((t) => t.id);
    const ended = (id: string, status: "finished" | "cancelled" | "failed", when: number, extra: Partial<WebSubsession> = {}) =>
      task({ id, status, writable: false, createdAt: when - 60_000, lastActivityAt: when, endedAt: when, ...extra });

    it("lists what ended today, whatever its state, and holds back what ended before today", () => {
      const list = [ended("s1", "finished", at(27, 9)), ended("s2", "cancelled", at(27, 0)), ended("s3", "failed", at(27, 14)),
        ended("s4", "finished", at(26, 23, 59)), ended("s5", "cancelled", at(26, 10)), ended("s6", "failed", at(25, 10))];
      const view = todaysSubsessions(list, now);
      expect(ids(view.shown)).toEqual(["s1", "s2", "s3"]);
      expect(ids(view.earlier)).toEqual(["s4", "s5", "s6"]);
    });

    it("never holds back a task that is still open, or a finished one that needs the owner, however old", () => {
      const old = at(25, 10);
      const list = [task({ id: "s1", status: "active", working: true, createdAt: old, lastActivityAt: old }),
        task({ id: "s2", status: "queued", createdAt: old, lastActivityAt: old }),
        task({ id: "s3", status: "waiting", waitingOn: "owner", createdAt: old, lastActivityAt: old }),
        task({ id: "s4", status: "waiting", waitingOn: "external", createdAt: old, lastActivityAt: old }),
        ended("s5", "finished", old, { ownerAction: "Merge PR #3", reportSeq: 1 }),
        ended("s6", "finished", old)];
      const view = todaysSubsessions(list, now);
      expect(ids(view.shown)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
      expect(ids(view.earlier)).toEqual(["s6"]);
    });

    it("loses none: opened, the earlier ones follow today's, each part in the order given", () => {
      const list = [task({ id: "s1", createdAt: at(25, 10), lastActivityAt: at(25, 10) }), ended("s2", "cancelled", at(26, 10)), ended("s3", "finished", at(27, 9)), ended("s4", "failed", at(25, 10))];
      const view = todaysSubsessions(list, now);
      expect(ids(view.shown)).toEqual(["s1", "s3"]);
      expect(ids(view.earlier)).toEqual(["s2", "s4"]);
      expect([...view.shown, ...view.earlier].map((t) => t.id).sort()).toEqual(ids(list));
    });

    it("counts a task by when it last did anything: one that ended yesterday and was written to today is today's", () => {
      expect(todaysSubsessions([ended("s1", "finished", at(26, 10), { lastActivityAt: at(27, 8) })], now).earlier).toHaveLength(0);
      // The end is the later of the two.
      expect(todaysSubsessions([ended("s1", "finished", at(27, 8), { lastActivityAt: at(26, 10) })], now).earlier).toHaveLength(0);
    });

    it("takes the day from the viewer's own midnight, and does not take an unreadable or a slightly ahead time for an old one", () => {
      expect(startOfLocalDay(now)).toBe(at(27, 0));
      // Just after midnight, what ended a minute before it is yesterday's.
      expect(todaysSubsessions([ended("s1", "finished", at(26, 23, 59))], at(27, 0, 1)).earlier).toHaveLength(1);
      expect(todaysSubsessions([ended("s1", "finished", at(26, 23, 59))], at(26, 23, 59)).earlier).toHaveLength(0);
      // The daemon's clock a little ahead of the browser's, across midnight.
      expect(todaysSubsessions([ended("s1", "finished", at(28, 0, 1))], at(27, 23, 59)).earlier).toHaveLength(0);
      expect(todaysSubsessions([ended("s1", "finished", Number.NaN)], now).earlier).toHaveLength(0);
    });

    it("sets its timer for the viewer's next midnight, and never for no time at all", () => {
      expect(msToNextLocalDay(at(27, 0), at(27, 23, 59))).toBe(60_000);
      expect(msToNextLocalDay(at(27, 0), at(27, 0))).toBe(at(28, 0) - at(27, 0));
      // The clock already past it (the day has not been moved on yet): soon, not at once in a loop.
      expect(msToNextLocalDay(at(27, 0), at(28, 0, 5))).toBe(250);
    });

    it("has nothing to offer when there is nothing earlier", () => {
      expect(todaysSubsessions([], now)).toEqual({ shown: [], earlier: [] });
    });
  });
});
