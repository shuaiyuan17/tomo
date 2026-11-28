import { activeTotalMs, CHECKPOINT_MAX, currentStep, isTimestamp, joinedLine, needsOwner, OWNER_ACTION_MAX, PLAN_STEP_MAX, PROGRESS_TEXT_MAX, reportNumber, STEP_RESULT_MAX, TRANSITION_LOG_KEEP, UPDATES_KEEP, type SubsessionRecord } from "../agent/subsessions/types.js";
import type { SubsessionEvent } from "../agent/subsessions/state-machine.js";
import type { HomeSubsession } from "../home/status-reducer.js";
import type { WebSubsession, WebSubsessionDetail, WebSubsessionMilestone, WebSubsessionStatus, WebSubsessionUpdate } from "./protocol.js";

/**
 * The owner's sub-sessions as the web Tasks rail shows them (daemon side).
 * Pure: the caller reads the table and says which scope is the owner's, so
 * a task owned by any other session never reaches the browser.
 */

/** An ended task (finished, cancelled, failed) stays in the rail this long. It can still be opened by id until it is archived. */
export const SUBSESSION_ENDED_VISIBLE_MS = 72 * 60 * 60 * 1000;
/** Every open task is listed (their number is bounded by `subsessions.maxOpen`); ended ones fill up to this many rows. */
export const MAX_RAIL_SUBSESSIONS = 24;
const TITLE_LIMIT = 120;
export const BRIEF_LIMIT = 8_000;
export const REPORT_LIMIT = 20_000;
/** Earlier reports a detail carries at most (the newest), each clipped like the report. */
export const EARLIER_REPORTS_LIMIT = 2;
const QUOTE_LIMIT = 2_000;
/** Update entries a detail carries at most: every update the record keeps, plus a milestone for each status change it keeps. */
export const UPDATES_LIMIT = UPDATES_KEEP + TRANSITION_LOG_KEEP;
/**
 * Per conversation line. With the table's 40 lines, the quote, brief, checkpoint,
 * report and earlier reports (each cut to BRIEF_LIMIT), a detail is about 1.6 MB
 * fully escaped: under the 2 MiB IPC budget, which is shared with whatever else
 * is in flight, so keep any new field small.
 */
export const ENTRY_LIMIT = 4_000;

const OPEN = new Set<WebSubsessionStatus>(["queued", "active", "waiting"]);
const WRITABLE = new Set<WebSubsessionStatus>(["queued", "active", "waiting", "finished"]);

function clip(text: string, limit: number): { text: string; cut: boolean } {
  const points = Array.from(text);
  return points.length > limit ? { text: `${points.slice(0, limit).join("")}…`, cut: true } : { text, cut: false };
}

/** The browser's view of one record, or undefined when it is not one the owner may see (another scope, archived). */
/**
 * What the daemon knows of a task beyond its record. `background`:
 * SubsessionService.backgroundRunning (only a waiting(external) task carries
 * it). `model`: the model id its turns run on, resolved (the record's, else
 * the configured default).
 */
export interface SubsessionLive { background?: boolean; model?: string }

export function subsessionView(record: SubsessionRecord, scope: string, now: number, working: boolean, live: SubsessionLive = {}): WebSubsession | undefined {
  if (record.parentKey !== scope || record.status === "archived") return undefined;
  const status = record.status as WebSubsessionStatus;
  const step = currentStep(record);
  const action = needsOwner(record);
  return {
    id: record.id,
    title: clip(record.title, TITLE_LIMIT).text,
    status,
    ...(status === "waiting" && record.waitingOn ? { waitingOn: record.waitingOn } : {}),
    ...(action ? { ownerAction: clip(action, OWNER_ACTION_MAX).text, reportSeq: reportNumber(record) } : {}),
    ...(step ? { step: clip(step, PLAN_STEP_MAX).text } : {}),
    // Only an open task has a turn worth showing as running.
    working: working && OPEN.has(status),
    ...(live.background && status === "waiting" && record.waitingOn === "external" ? { background: true as const } : {}),
    ...(live.model ? { model: live.model } : {}),
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    activeMs: activeTotalMs(record, now),
    revision: record.conversationSeq,
    writable: WRITABLE.has(status),
  };
}

/**
 * The rail's list: the scope's tasks, open ones first (oldest first, as they
 * were started), then those that ended within SUBSESSION_ENDED_VISIBLE_MS,
 * newest first, while the list stays within MAX_RAIL_SUBSESSIONS. An open
 * task is never left out: one may be waiting for the owner. Nor is a
 * finished one whose report still needs the owner, however long ago it
 * finished: it is listed with the open ones, until they have done it.
 */
export function subsessionList(records: readonly SubsessionRecord[], scope: string, now: number, working: (key: string) => boolean, live: (record: SubsessionRecord) => SubsessionLive = () => ({})): WebSubsession[] {
  const views = records.flatMap((r) => { const v = subsessionView(r, scope, now, working(r.sessionKey), live(r)); return v ? [v] : []; });
  const kept = (v: WebSubsession) => OPEN.has(v.status) || v.ownerAction !== undefined;
  const open = views.filter(kept).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const ended = views.filter((v) => !kept(v) && now - (v.endedAt ?? v.lastActivityAt) < SUBSESSION_ENDED_VISIBLE_MS)
    .sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt));
  return [...open, ...ended.slice(0, Math.max(0, MAX_RAIL_SUBSESSIONS - open.length))];
}

/**
 * The tasks of the rail's list that sit at the home's visitor seats: those
 * at work right now. That is an active task, any task with a turn running,
 * and one waiting on something external whose own background work still
 * runs. Queued, waiting and ended tasks have nobody at a desk. Only the id,
 * the title and the start time go on: the brief never reaches the home.
 */
export function runningSubsessions(tasks: readonly WebSubsession[]): HomeSubsession[] {
  return tasks.filter((t) => t.status === "active" || t.working || t.background === true)
    .map((t) => ({ id: t.id, title: t.title, startedAt: t.createdAt }));
}

/** The status changes worth a line in the history: not the queued/active churn of every turn and check-back. */
const MILESTONES: Partial<Record<SubsessionEvent, WebSubsessionMilestone>> = {
  ask: "waitingOwner", stuck: "waitingOwner", self_restart: "waitingOwner",
  finish: "finished", reopen: "reopened",
};

/**
 * "Decisions and updates", newest first: the lines the task recorded with
 * task_update, with the milestones of its lifecycle among them. The first
 * start counts only while the log still has the spawn before it.
 */
export function subsessionUpdates(record: SubsessionRecord): WebSubsessionUpdate[] {
  const out: WebSubsessionUpdate[] = (record.updates ?? []).filter((u) => isTimestamp(u.at)).map((u) => ({ at: u.at, kind: "update" as const, text: clip(u.text, PROGRESS_TEXT_MAX).text, ...(u.kind === "plan" ? { plan: true as const } : {}) }));
  // A second task_ask while it is still waiting for the owner (from a
  // background report's turn) is not a new milestone.
  let waitingOwner = false;
  // The log is read as the table holds it: an entry not shaped like a transition is skipped, never thrown on.
  const log = (Array.isArray(record.transitions) ? record.transitions : []).filter((t) => !!t && typeof t === "object"
    && isTimestamp(t.at) && typeof t.event === "string" && typeof t.to === "string");
  log.forEach((t, i) => {
    const event = t.event as SubsessionEvent;
    const milestone = event === "start" ? (i > 0 && log[i - 1].from === null ? "started" : undefined)
      : t.to === "cancelled" || t.to === "failed" ? t.to : MILESTONES[event];
    // A cancel says why when the reason was the canceller's own words; the harness's fixed reasons are English, not shown.
    const reason = milestone === "cancelled" && t.said === true && typeof t.reason === "string" ? joinedLine(t.reason, PROGRESS_TEXT_MAX) : "";
    if (milestone && !(milestone === "waitingOwner" && waitingOwner)) out.push({ at: t.at, kind: "milestone", milestone, ...(reason ? { reason } : {}) });
    waitingOwner = milestone === "waitingOwner" || (waitingOwner && t.to === "waiting");
  });
  // Stable: at the same instant, a milestone reads as the later one (a finish lands after the task's last update).
  return out.map((e, i) => ({ e, i })).sort((a, b) => b.e.at - a.e.at || b.i - a.i).slice(0, UPDATES_LIMIT).map(({ e }) => e);
}

/** One task, opened: what the list shows plus its brief, the conversation and the report. */
export function subsessionDetail(record: SubsessionRecord, scope: string, now: number, working: boolean, live: SubsessionLive = {}): WebSubsessionDetail | undefined {
  const view = subsessionView(record, scope, now, working, live);
  if (!view) return undefined;
  const brief = clip(record.brief, BRIEF_LIMIT);
  const report = record.report !== undefined ? clip(record.report, REPORT_LIMIT) : undefined;
  const updates = subsessionUpdates(record);
  const doneSteps = (record.doneSteps ?? []).filter((d) => isTimestamp(d.at)).map((d) => ({ at: d.at, text: clip(d.text, PLAN_STEP_MAX).text, ...(d.result ? { result: clip(d.result, STEP_RESULT_MAX).text } : {}) }));
  const earlierReports = (Array.isArray(record.earlierReports) ? record.earlierReports : [])
    .filter((e) => !!e && typeof e.seq === "number" && typeof e.text === "string").slice(-EARLIER_REPORTS_LIMIT)
    .map((e) => { const c = clip(e.text, BRIEF_LIMIT); return { seq: e.seq, text: c.text, ...(c.cut ? { truncated: true as const } : {}) }; });
  // The steps ahead mean something only while the task can still take them.
  const plan = OPEN.has(view.status) && record.plan?.length ? record.plan.map((step) => ({ text: clip(step.text, PLAN_STEP_MAX).text, status: step.status })) : undefined;
  return {
    ...view,
    brief: brief.text,
    ...(brief.cut ? { briefTruncated: true } : {}),
    ...(record.quote?.length ? { quote: record.quote.map((line) => clip(line, QUOTE_LIMIT).text) } : {}),
    ...(record.waitingReason ? { waitingReason: clip(record.waitingReason, PROGRESS_TEXT_MAX).text } : {}),
    conversation: record.conversation.map((entry) => ({
      seq: entry.seq, at: entry.at, from: entry.from, kind: entry.kind, text: clip(entry.text, ENTRY_LIMIT).text,
      ...(entry.files ? { files: entry.files } : {}),
    })),
    ...(plan ? { plan } : {}),
    ...(doneSteps.length > 0 ? { doneSteps } : {}),
    ...(updates.length > 0 ? { updates } : {}),
    ...(typeof record.checkpoint === "string" && record.checkpoint.trim() ? { checkpoint: clip(record.checkpoint, CHECKPOINT_MAX).text } : {}),
    ...(earlierReports.length > 0 ? { earlierReports } : {}),
    ...(report ? { report: report.text, ...(report.cut ? { reportTruncated: true } : {}) } : {}),
  };
}
