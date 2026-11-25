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

/**
 * Messages on their way, per task, kept for the page's lifetime rather than in
 * the chat view: going back to the list or closing the rail must not lose a
 * failed or unconfirmed message (and its request id, which a retry reuses).
 */
const pendingStore = new Map<string, PendingSubsessionMessage[]>();
const pendingListeners = new Set<() => void>();
export function pendingFor(id: string): PendingSubsessionMessage[] { return pendingStore.get(id) ?? []; }
export function updatePending(id: string, update: (old: PendingSubsessionMessage[]) => PendingSubsessionMessage[]): void {
  const next = update(pendingFor(id));
  if (next.length) pendingStore.set(id, next); else pendingStore.delete(id);
  for (const listener of pendingListeners) listener();
}
/** One task's messages on their way, re-rendered when they change. */
export function usePending(id: string): PendingSubsessionMessage[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    pendingListeners.add(listener);
    return () => { pendingListeners.delete(listener); };
  }, []);
  return pendingFor(id);
}

/**
 * May a failed send be tried again? Not to a task that ended or is gone; any
 * other failure may pass (the table or the task's inbox recovers, or the
 * network never delivered it). A retry reuses the request id, which the task
 * drops if it already has it.
 */
export function canRetrySend(error: string | undefined): boolean {
  return error !== "subsession_ended" && error !== "subsession_not_found";
}

/** A row of the chat, in order: the brief, then every line of the conversation, then the report. */
export type SubsessionChatRow =
  | { kind: "brief"; key: string; brief: string; quote?: string[]; truncated: boolean }
  | { kind: "entry"; key: string; from: "owner" | "task"; tag?: "ask" | "notify"; text: string; at: number; files?: number }
  | { kind: "report"; key: string; text: string; truncated: boolean }
  | { kind: "pending"; key: string; message: PendingSubsessionMessage };

export function subsessionChatRows(detail: WebSubsessionDetail | undefined, pending: readonly PendingSubsessionMessage[]): SubsessionChatRow[] {
  // Not read yet (or the read failed): what is on its way still shows, with its state and retry.
  if (!detail) return pending.filter((m) => m.state !== "sent").map((message) => ({ kind: "pending", key: `p${message.requestId}`, message }));
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
/** A failed read of the list is tried again this long after. */
export const SUBSESSIONS_RETRY_MS = 5_000;
export function useSubsessions(revision: number): WebSubsessionList {
  const [list, setList] = useState<WebSubsessionList>({ available: false, tasks: [] });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    // 0: before the first (re)connect, when there is no session cookie yet.
    if (revision === 0) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A failed read keeps the last list and is tried again, so a blip never leaves the rail stale.
    const again = () => { if (!controller.signal.aborted) timer = setTimeout(() => setRetry((n) => n + 1), SUBSESSIONS_RETRY_MS); };
    void api<WebSubsessionList>("/subsessions", { signal: controller.signal }).then((next) => {
      // The table could not be read (or recovery is not done): keep what was shown, and look again.
      if (!next.available) { setList((old) => old.available ? old : next); again(); return; }
      setList(next);
    }, again);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision, retry]);
  return list;
}
