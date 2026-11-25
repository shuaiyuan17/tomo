import { describe, expect, it } from "vitest";
import { activeSubsessions, canRetrySend, folded, updateText, pendingFor, updatePending, isOpenSubsession, subsessionChatRows, subsessionState, subsessionStateLabel, isWorkingState, subsessionsRefreshMs, SUBSESSIONS_BACKGROUND_REFRESH_MS, withListBackground } from "../web/src/subsessions.js";
import type { WebSubsession, WebSubsessionDetail } from "../src/web/protocol.js";

const task = (extra: Partial<WebSubsession> = {}): WebSubsession => ({ id: "s1", title: "T", status: "active", working: false,
  createdAt: 0, lastActivityAt: 0, activeMs: 0, revision: 0, writable: true, ...extra });
const detail = (extra: Partial<WebSubsessionDetail> = {}): WebSubsessionDetail => ({ ...task(), brief: "Do it.", conversation: [], ...extra });

describe("sub-sessions in the Tasks rail", () => {
  it("says what a task is doing: working only with a turn running, and when it waits on the owner", () => {
    expect(subsessionState(task({ working: true }))).toBe("working");
    expect(subsessionState(task())).toBe("active");
    expect(subsessionState(task({ status: "waiting", waitingOn: "owner" }))).toBe("waitingOwner");
    expect(subsessionState(task({ status: "waiting", waitingOn: "external" }))).toBe("waiting");
    expect(subsessionState(task({ status: "finished" }))).toBe("finished");
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
  });

  it("words an update: the task's own line, or the milestone's name", () => {
    expect(updateText({ at: 1, kind: "update", text: "Chose B" })).toBe("Chose B");
    expect(updateText({ at: 1, kind: "milestone", milestone: "waitingOwner" })).toBe("Waiting for you");
    expect(updateText({ at: 1, kind: "milestone", milestone: "started" })).toBe("Started");
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
});
