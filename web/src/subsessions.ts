import { useEffect, useState } from "react";
import type { WebSubsession, WebSubsessionDetail, WebSubsessionList, WebSubsessionMilestone, WebSubsessionUpdate } from "../../src/web/protocol.js";
import { api } from "./api.js";
import { i18n } from "./i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: tasks:subsession.state.*
// i18n-dynamic: tasks:subsession.updates.milestone.*

/** Sub-sessions in the Tasks rail: render logic, kept pure so it is testable. */

const STATE_LABELS = {
  working: "tasks:subsession.state.working", background: "tasks:subsession.state.background", active: "tasks:subsession.state.active", queued: "tasks:subsession.state.queued",
  waitingOwner: "tasks:subsession.state.waitingOwner", needsYou: "tasks:subsession.state.needsYou", waiting: "tasks:subsession.state.waiting",
  finished: "tasks:subsession.state.finished", cancelled: "tasks:subsession.state.cancelled", failed: "tasks:subsession.state.failed",
} as const;

const MILESTONE_LABELS = {
  started: "tasks:subsession.updates.milestone.started", waitingOwner: "tasks:subsession.updates.milestone.waitingOwner",
  finished: "tasks:subsession.updates.milestone.finished", reopened: "tasks:subsession.updates.milestone.reopened",
  cancelled: "tasks:subsession.updates.milestone.cancelled", failed: "tasks:subsession.updates.milestone.failed",
} as const satisfies Record<WebSubsessionMilestone, string>;

/** An update's words: the line the task recorded, or the milestone's name (an unknown one shows nothing). */
export function updateText(entry: WebSubsessionUpdate): string {
  if (entry.kind !== "milestone") return entry.plan ? i18n.t("tasks:subsession.updates.planChanged", { reason: entry.text }) : entry.text;
  // A daemon newer than this page may send a milestone it does not know.
  if (!Object.hasOwn(MILESTONE_LABELS, entry.milestone)) return "";
  const label = i18n.t(MILESTONE_LABELS[entry.milestone]);
  return entry.reason ? i18n.t("tasks:subsession.updates.withReason", { label, reason: entry.reason }) : label;
}

const WAITING = { owner: "waitingOwner", other: "waiting" } as const;
const NEEDS_YOU = { needsYou: "needsYou" } as const;
/**
 * Which state a task is shown in: a running turn reads "Working", a task
 * waiting on the owner says so, one waiting on something external while its
 * own background work still runs reads as working in the background, and a
 * finished one whose report asks something of the owner reads "Needs you".
 */
type ShownTask = Pick<WebSubsession, "status" | "working" | "waitingOn" | "background" | "ownerAction">;
export function subsessionState(task: ShownTask): keyof typeof STATE_LABELS {
  if (task.status === "finished" && task.ownerAction) return NEEDS_YOU.needsYou;
  if (task.status === "active") return task.working ? "working" : "active";
  if (task.status === "waiting" && task.waitingOn === "external" && task.background) return "background";
  if (task.status === "waiting") return WAITING[task.waitingOn === "owner" ? "owner" : "other"];
  return task.status;
}
/** Shown with the working shimmer: a turn running now, or its background work. */
export function isWorkingState(state: ReturnType<typeof subsessionState>): boolean {
  return state === "working" || state === "background";
}
/** Shown emphasised, with what it asks: the task is waiting on the owner, or its report needs them. */
export function asksOwner(state: ReturnType<typeof subsessionState>): boolean {
  return state === "waitingOwner" || state === "needsYou";
}
/** What a task that asks the owner something says it needs: its question, or what its report asks them to do. */
export function ownerAsk(task: Pick<WebSubsession, "status" | "ownerAction"> & { waitingReason?: string }): string | undefined {
  return task.status === "finished" ? task.ownerAction : task.status === "waiting" ? task.waitingReason : undefined;
}
/**
 * How a plan step is drawn: the step in progress moves (shimmer, accent)
 * only while the task is actually working; waiting for the owner or on
 * something external, it is held still ("paused").
 */
export function planStepLook(status: "pending" | "in_progress", running: boolean): "running" | "paused" | "pending" {
  if (status !== "in_progress") return "pending";
  return running ? "running" : "paused";
}

/** A time a Date can show (a stored 1e20 is not one: it would throw in toISOString). */
export function showableTime(at: number): boolean {
  return Number.isFinite(new Date(at).getTime());
}

export function subsessionStateLabel(task: ShownTask): string {
  return i18n.t(STATE_LABELS[subsessionState(task)]);
}

/**
 * An opened task as shown: what the list says now wins over the last detail
 * read (it is the newer of the two). `background` and `ownerAction` are left
 * out of a view, not set empty, once they no longer hold, so they come from
 * the list alone.
 */
export function withListBackground<D extends Partial<WebSubsession>>(detail: D | undefined, summary: WebSubsession): Omit<D, "background" | "ownerAction" | "reportSeq"> & WebSubsession {
  const rest: Partial<WebSubsession> = { ...(detail ?? {}) };
  delete rest.background;
  delete rest.ownerAction;
  delete rest.reportSeq;
  return { ...rest, ...summary } as Omit<D, "background" | "ownerAction" | "reportSeq"> & WebSubsession;
}

/**
 * While a task waits on something external, the list is read again this
 * often: its background work starting or ending (or a report window lapsing)
 * changes no task record, so no `subsessions` event says so.
 */
export const SUBSESSIONS_BACKGROUND_REFRESH_MS = 15_000;
export function subsessionsRefreshMs(list: WebSubsessionList): number | undefined {
  return list.available && list.tasks.some((task) => task.status === "waiting" && task.waitingOn === "external") ? SUBSESSIONS_BACKGROUND_REFRESH_MS : undefined;
}

/**
 * How much of a list shows before "show more": the newest `keep` (from the
 * end for the done steps, oldest first; from the start for updates, newest
 * first). `hidden`: how many the fold keeps back.
 */
export function folded<T>(items: readonly T[], keep: number, open: boolean, from: "start" | "end"): { shown: readonly T[]; hidden: number } {
  if (open || items.length <= keep) return { shown: items, hidden: 0 };
  return { shown: from === "end" ? items.slice(-keep) : items.slice(0, keep), hidden: items.length - keep };
}

/** Open tasks are alive, and so is a finished one that still needs the owner; ended ones are shown dimmed, as ended subagents are. */
export function isOpenSubsession(task: Pick<WebSubsession, "status" | "ownerAction">): boolean {
  return task.status === "queued" || task.status === "active" || task.status === "waiting" || (task.status === "finished" && !!task.ownerAction);
}

/** Sub-sessions that count as activity on the Tasks button: those running now, in a turn or in the background. */
export function activeSubsessions(tasks: readonly WebSubsession[]): number {
  return tasks.filter((task) => task.status === "active" || (task.status === "waiting" && task.background === true)).length;
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

/** Plan, done steps, a line of "Decisions and updates" or a checkpoint: something to show of what the task is doing. */
export function hasProgress(detail: Pick<WebSubsessionDetail, "plan" | "doneSteps" | "updates" | "checkpoint">): boolean {
  return !!detail.plan?.length || !!detail.doneSteps?.length || !!detail.updates?.some((u) => updateText(u)) || !!detail.checkpoint;
}

/**
 * An opened task leads with what it is doing until something has been said:
 * a line of the conversation (the owner's or the task's), the report, or a
 * message of the owner's on its way. From then on it leads with the chat, and
 * what it is doing folds into one line above it.
 */
export function leadsWithChat(rows: readonly SubsessionChatRow[]): boolean {
  return rows.some((row) => row.kind !== "brief");
}

/**
 * The folded line: the step it is on, else the next one, else its latest
 * decision or update (a line of its own before a milestone), else the last
 * step it finished. `done` / `total`: steps ticked off and all steps, while
 * it has a plan.
 */
export interface ProgressSummary { text: string; look: "running" | "paused" | "pending" | "update" | "done"; done: number; total?: number }
export function progressSummary(detail: Pick<WebSubsessionDetail, "plan" | "doneSteps" | "updates" | "checkpoint">, running: boolean): ProgressSummary | undefined {
  const done = detail.doneSteps?.length ?? 0;
  const plan = detail.plan ?? [];
  const total = plan.length ? { total: done + plan.length } : {};
  const now = plan.find((step) => step.status === "in_progress");
  if (now) return { text: now.text, look: planStepLook("in_progress", running), done, ...total };
  if (plan.length) return { text: i18n.t("tasks:subsession.progress.next", { step: plan[0].text }), look: "pending", done, ...total };
  const lines = (detail.updates ?? []).filter((u) => updateText(u));
  const own = lines.find((u) => u.kind === "update");
  if (own) return { text: updateText(own), look: "update", done };
  const last = detail.doneSteps?.at(-1);
  if (last) return { text: last.text, look: "done", done };
  if (lines[0]) return { text: updateText(lines[0]), look: "update", done };
  // Only a checkpoint: the folded line names it, so it can still be opened.
  return detail.checkpoint ? { text: i18n.t("tasks:subsession.checkpoint.heading"), look: "update", done } : undefined;
}

/** A row of the chat, in order: the brief, then every line of the conversation, then the report. */
export type SubsessionChatRow =
  | { kind: "brief"; key: string; brief: string; quote?: string[]; truncated: boolean }
  | { kind: "entry"; key: string; from: "owner" | "task"; tag?: "ask" | "notify"; text: string; at: number; files?: number }
  /** `seq`: an earlier report, replaced by a later one before it was read. */
  | { kind: "report"; key: string; text: string; truncated: boolean; seq?: number }
  | { kind: "pending"; key: string; message: PendingSubsessionMessage };

export function subsessionChatRows(detail: WebSubsessionDetail | undefined, pending: readonly PendingSubsessionMessage[]): SubsessionChatRow[] {
  // Not read yet (or the read failed): what is on its way still shows, with its state and retry.
  if (!detail) return pending.filter((m) => m.state !== "sent").map((message) => ({ kind: "pending", key: `p${message.requestId}`, message }));
  const rows: SubsessionChatRow[] = [{ kind: "brief", key: "brief", brief: detail.brief, ...(detail.quote?.length ? { quote: detail.quote } : {}), truncated: !!detail.briefTruncated }];
  for (const entry of detail.conversation) {
    const tag = entry.from === "task" && (entry.kind === "ask" || entry.kind === "notify") ? entry.kind : undefined;
    rows.push({ kind: "entry", key: `e${entry.seq}`, from: entry.from, ...(tag ? { tag } : {}), text: entry.text, at: entry.at, ...(entry.files ? { files: entry.files } : {}) });
  }
  for (const earlier of detail.earlierReports ?? []) rows.push({ kind: "report", key: `report${earlier.seq}`, text: earlier.text, truncated: !!earlier.truncated, seq: earlier.seq });
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
      const refresh = subsessionsRefreshMs(next);
      if (refresh !== undefined && !controller.signal.aborted) timer = setTimeout(() => setRetry((n) => n + 1), refresh);
    }, again);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision, retry]);
  return list;
}
