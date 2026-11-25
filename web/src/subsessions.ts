import { useEffect, useState } from "react";
import type { WebSubsession, WebSubsessionDetail, WebSubsessionList } from "../../src/web/protocol.js";
import { api } from "./api.js";
import { i18n } from "./i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: tasks:subsession.state.*

/** Sub-sessions in the Tasks rail: render logic, kept pure so it is testable. */

const STATE_LABELS = {
  working: "tasks:subsession.state.working", active: "tasks:subsession.state.active", queued: "tasks:subsession.state.queued",
  waitingOwner: "tasks:subsession.state.waitingOwner", waiting: "tasks:subsession.state.waiting",
  finished: "tasks:subsession.state.finished", cancelled: "tasks:subsession.state.cancelled", failed: "tasks:subsession.state.failed",
} as const;

const WAITING = { owner: "waitingOwner", other: "waiting" } as const;
/** Which state a task is shown in: a running turn reads "Working", a task waiting on the owner says so. */
export function subsessionState(task: Pick<WebSubsession, "status" | "working" | "waitingOn">): keyof typeof STATE_LABELS {
  if (task.status === "active") return task.working ? "working" : "active";
  if (task.status === "waiting") return WAITING[task.waitingOn === "owner" ? "owner" : "other"];
  return task.status;
}
export function subsessionStateLabel(task: Pick<WebSubsession, "status" | "working" | "waitingOn">): string {
  return i18n.t(STATE_LABELS[subsessionState(task)]);
}

/** Open tasks are alive; ended ones are shown dimmed, as ended subagents are. */
export function isOpenSubsession(task: Pick<WebSubsession, "status">): boolean {
  return task.status === "queued" || task.status === "active" || task.status === "waiting";
}

/** Sub-sessions that count as activity on the Tasks button: those running now. */
export function activeSubsessions(tasks: readonly WebSubsession[]): number {
  return tasks.filter((task) => task.status === "active").length;
}

/** One message waiting for its POST: shown at the end of the chat until the task's conversation has it. */
export interface PendingSubsessionMessage { requestId: string; text: string; state: "sending" | "failed" | "sent"; error?: string;
  /** sent: the task's revision once it had it; the bubble goes when a read of the conversation is that new. */
  revision?: number }

/** A row of the chat, in order: the brief, then every line of the conversation, then the report. */
export type SubsessionChatRow =
  | { kind: "brief"; key: string; brief: string; quote?: string[]; truncated: boolean }
  | { kind: "entry"; key: string; from: "owner" | "task"; tag?: "ask" | "notify"; text: string; at: number; files?: number }
  | { kind: "report"; key: string; text: string; truncated: boolean }
  | { kind: "pending"; key: string; message: PendingSubsessionMessage };

export function subsessionChatRows(detail: WebSubsessionDetail, pending: readonly PendingSubsessionMessage[]): SubsessionChatRow[] {
  const rows: SubsessionChatRow[] = [{ kind: "brief", key: "brief", brief: detail.brief, ...(detail.quote?.length ? { quote: detail.quote } : {}), truncated: !!detail.briefTruncated }];
  for (const entry of detail.conversation) {
    const tag = entry.from === "task" && (entry.kind === "ask" || entry.kind === "notify") ? entry.kind : undefined;
    rows.push({ kind: "entry", key: `e${entry.seq}`, from: entry.from, ...(tag ? { tag } : {}), text: entry.text, at: entry.at, ...(entry.files ? { files: entry.files } : {}) });
  }
  if (detail.report) rows.push({ kind: "report", key: "report", text: detail.report, truncated: !!detail.reportTruncated });
  for (const message of pending) if (!(message.state === "sent" && message.revision !== undefined && detail.revision >= message.revision)) rows.push({ kind: "pending", key: `p${message.requestId}`, message });
  return rows;
}

/**
 * The owner's sub-sessions, re-read whenever `revision` moves (a `subsessions`
 * event, or a (re)connect). A failed read keeps the last list.
 */
export function useSubsessions(revision: number): WebSubsessionList {
  const [list, setList] = useState<WebSubsessionList>({ available: false, tasks: [] });
  useEffect(() => {
    // 0: before the first (re)connect, when there is no session cookie yet.
    if (revision === 0) return;
    const controller = new AbortController();
    void api<WebSubsessionList>("/subsessions", { signal: controller.signal }).then(setList, () => {});
    return () => controller.abort();
  }, [revision]);
  return list;
}
