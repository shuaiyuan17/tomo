import { describe, expect, it } from "vitest";
import { activeSubsessions, canRetrySend, pendingFor, updatePending, isOpenSubsession, subsessionChatRows, subsessionState, subsessionStateLabel } from "../web/src/subsessions.js";
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
