import { BanIcon, CalendarClockIcon, CircleCheckIcon, CornerDownRightIcon, HistoryIcon, HouseIcon, KeyRoundIcon, LayersIcon, ListChecksIcon,
  ListIcon, PawPrintIcon, SendIcon, ShieldQuestionIcon, SmilePlusIcon, UserRoundIcon, type LucideIcon } from "lucide-react";
import type { ToolActivity } from "../../src/web/protocol.js";
import type { ToolRow } from "./subagent.js";
import { i18n } from "./i18n/index.js";

/**
 * Tomo's own tools (tomo-internal) as the chat shows them: a sentence with
 * an icon and, after it, what came of the call ("Checked on s12 · active",
 * "Listed to-dos · 12 open"), in place of `mcp__tomo-internal__…: {json}`.
 * Everything here reads the `activity` / `outcome` the server parsed
 * (src/web/activity.ts); a row without them, or of a kind this page does not
 * know (a daemon newer than the page), keeps its plain line.
 */

export const INTERNAL_PREFIX = "mcp__tomo-internal__";

/**
 * The row's activity, when it is one this page knows, and its result (if it
 * has one) was read: a call that finished with an outcome the server could
 * not read (a new wording) makes no claim about what happened, so it keeps
 * the plain line. A running call and a failed one are sentences.
 */
export function knownActivity(row: Pick<ToolRow, "activity" | "result">): ToolActivity | undefined {
  const activity = row.activity;
  if (row.result && !row.result.isError && !row.result.outcome) return undefined;
  return activity && typeof activity === "object" && typeof activity.kind === "string" && activity.kind in KINDS ? activity : undefined;
}

/** What a call did, for the fold's summary ("fed the pet, checked a task"). */
export type ActivityKind = "task" | "taskCheck" | "message" | "reaction" | "todo" | "schedule" | "ask" | "recall" | "pet" | "home" | "rollup" | "people" | "lookup";

/** Per tool: its icon and what it counts as in a fold. */
const KINDS: Record<ToolActivity["kind"], { icon: LucideIcon; kind: ActivityKind }> = {
  task_spawn: { icon: ListChecksIcon, kind: "task" }, task_message: { icon: CornerDownRightIcon, kind: "task" },
  task_cancel: { icon: BanIcon, kind: "task" }, task_done: { icon: ListChecksIcon, kind: "task" }, task_status: { icon: ListChecksIcon, kind: "taskCheck" },
  send_message: { icon: SendIcon, kind: "message" }, edit_message: { icon: SendIcon, kind: "message" }, unsend_message: { icon: SendIcon, kind: "message" },
  rename_group_chat: { icon: SendIcon, kind: "message" }, react_to_message: { icon: SmilePlusIcon, kind: "reaction" },
  list_sessions: { icon: ListIcon, kind: "lookup" }, list_people: { icon: UserRoundIcon, kind: "lookup" },
  todo_add: { icon: CircleCheckIcon, kind: "todo" }, todo_resolve: { icon: CircleCheckIcon, kind: "todo" }, todo_list: { icon: CircleCheckIcon, kind: "lookup" },
  schedule_create: { icon: CalendarClockIcon, kind: "schedule" }, schedule_remove: { icon: CalendarClockIcon, kind: "schedule" },
  schedule_enable: { icon: CalendarClockIcon, kind: "schedule" }, schedule_list: { icon: CalendarClockIcon, kind: "lookup" },
  request_permission: { icon: ShieldQuestionIcon, kind: "ask" }, request_credential: { icon: KeyRoundIcon, kind: "ask" },
  pet_status: { icon: PawPrintIcon, kind: "pet" }, pet_feed: { icon: PawPrintIcon, kind: "pet" }, pet_play: { icon: PawPrintIcon, kind: "pet" },
  pet_sleep: { icon: PawPrintIcon, kind: "pet" }, pet_hatch: { icon: PawPrintIcon, kind: "pet" },
  home_check: { icon: HouseIcon, kind: "home" }, recall_conversation: { icon: HistoryIcon, kind: "recall" },
  lcm_rollup: { icon: LayersIcon, kind: "rollup" }, upsert_person: { icon: UserRoundIcon, kind: "people" },
};

/** Tools shown as a card in the chat (activity-card.tsx); every other internal tool is a line. */
const CARD_KINDS = new Set<ToolActivity["kind"]>(["task_spawn", "task_message", "task_cancel", "send_message"]);
/** A row shown as a card: one of those tools, with an activity this page knows (and a result it could read, when it has one). */
export function isCardRow(row: Pick<ToolRow, "activity" | "result">): boolean {
  const activity = knownActivity(row);
  return !!activity && CARD_KINDS.has(activity.kind);
}

export function activityIcon(row: Pick<ToolRow, "activity" | "result">): LucideIcon | undefined {
  const activity = knownActivity(row);
  return activity ? KINDS[activity.kind].icon : undefined;
}
export function activityKind(row: Pick<ToolRow, "activity" | "result">): ActivityKind | undefined {
  const activity = knownActivity(row);
  return activity ? KINDS[activity.kind].kind : undefined;
}

/** Keys this file picks at runtime, from literal maps and conditionals (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: activity:line.*
// i18n-dynamic: activity:detail.*
// i18n-dynamic: activity:kind.*
/** A key of this namespace. Every one is written out whole below (tests/i18n-catalogs.test.ts finds them); `t` is untyped only so they can sit in lookup maps. */
type Key = `activity:${"line" | "detail" | "kind"}.${string}`;
const translate = (key: Key, values?: Record<string, unknown>): string => (i18n.t as unknown as (key: string, values?: Record<string, unknown>) => string)(key, values);

export function activityKindText(kind: ActivityKind, count: number): string {
  const t = (key: Key) => translate(key, { count });
  switch (kind) {
    case "task": return t("activity:kind.task");
    case "taskCheck": return t("activity:kind.taskCheck");
    case "message": return t("activity:kind.message");
    case "reaction": return t("activity:kind.reaction");
    case "todo": return t("activity:kind.todo");
    case "schedule": return t("activity:kind.schedule");
    case "ask": return t("activity:kind.ask");
    case "recall": return t("activity:kind.recall");
    case "pet": return t("activity:kind.pet");
    case "home": return t("activity:kind.home");
    case "rollup": return t("activity:kind.rollup");
    case "people": return t("activity:kind.people");
    case "lookup": return t("activity:kind.lookup");
  }
}

const REACTIONS: Record<string, string> = { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" };
/** The owner's own conversation is "you"; another one by its key until cards look names up. */
const isOwnerTarget = (target: string) => /^dm:/.test(target);

/**
 * A call's sentence and what came of it. `detail` is shown muted after the
 * title; `held`: it returned normally but nothing happened.
 */
export function activityLine(row: Pick<ToolRow, "activity" | "result">): { title: string; detail?: string; held?: boolean } | undefined {
  const activity = knownActivity(row);
  if (!activity) return undefined;
  const t = (key: Key, values: Record<string, unknown> = {}) => translate(key, values);
  const outcome = row.result && !row.result.isError ? row.result.outcome : undefined;
  const held = !!outcome?.noop;
  const count = (key: Key) => outcome?.count !== undefined ? t(key, { count: outcome.count }) : undefined;
  // Nothing happened: the tool's own sentence says why (English, as a failure's reason is).
  const say = (title: string, detail?: string) => ({ title, ...(held ? { detail: outcome!.noop, held } : detail ? { detail } : {}) });
  switch (activity.kind) {
    case "task_spawn": return say(outcome?.id ? t("activity:line.taskSpawnId", { id: outcome.id, title: activity.title }) : t("activity:line.taskSpawn", { title: activity.title }));
    case "task_message": return say(outcome?.delivery === "held" ? t("activity:line.taskMessageHeld", { id: activity.id }) : t("activity:line.taskMessage", { id: activity.id }));
    case "task_cancel": return say(t("activity:line.taskCancel", { id: activity.id }));
    case "task_done": return say(t("activity:line.taskDone", { id: activity.id }));
    case "task_status": return activity.id ? say(t("activity:line.taskStatusOne", { id: activity.id }), outcome?.status)
      : say(t("activity:line.taskStatusAll"), count("activity:detail.tasks"));
    case "send_message": {
      const you = isOwnerTarget(activity.target);
      const name = { name: activity.target };
      return say(activity.mode === "delegate" ? (you ? t("activity:line.delegateYou") : t("activity:line.delegateTo", name))
        : you ? t("activity:line.sendYou") : t("activity:line.sendTo", name));
    }
    case "react_to_message": return say(activity.remove ? t("activity:line.unreact") : t("activity:line.react", { emoji: REACTIONS[activity.reaction] ?? activity.reaction }));
    case "edit_message": return say(t("activity:line.edit"));
    case "unsend_message": return say(t("activity:line.unsend"));
    case "rename_group_chat": return say(t("activity:line.rename", { title: activity.title }));
    case "list_sessions": return say(t("activity:line.listSessions"));
    case "todo_add": return say(outcome?.id ? t("activity:line.todoAddId", { id: outcome.id, title: activity.title }) : t("activity:line.todoAdd", { title: activity.title }));
    case "todo_resolve": {
      const id = { id: activity.id };
      return say(activity.action === "done" ? t("activity:line.todoDone", id) : activity.action === "drop" ? t("activity:line.todoDrop", id)
        : activity.action === "snooze" ? t("activity:line.todoSnooze", id) : t("activity:line.todoHandoff", id));
    }
    case "todo_list": return say(t("activity:line.todoList"), count("activity:detail.todos"));
    case "schedule_create": return say(t("activity:line.scheduleCreate", { name: activity.name }), activity.schedule);
    case "schedule_remove": return say(t("activity:line.scheduleRemove", { id: activity.id }));
    case "schedule_enable": return say(t(activity.enabled ? "activity:line.scheduleResume" : "activity:line.schedulePause", { id: activity.id }));
    case "schedule_list": return say(t("activity:line.scheduleList"), count("activity:detail.jobs"));
    case "request_permission": return say(t(activity.access === "write" ? "activity:line.permissionWrite" : "activity:line.permissionRead", { path: activity.path }));
    case "request_credential": return say(t("activity:line.credential", { name: activity.name }));
    case "pet_status": return say(t("activity:line.petStatus"), outcome?.status);
    case "pet_feed": return say(t(activity.treat ? "activity:line.petTreat" : "activity:line.petFeed"), outcome?.status);
    case "pet_play": return say(t("activity:line.petPlay"), outcome?.status);
    case "pet_sleep": return say(t(activity.action === "wake" ? "activity:line.petWake" : "activity:line.petSleep"), outcome?.status);
    case "pet_hatch": return say(t("activity:line.petHatch", { name: activity.name }));
    case "home_check": return say(t("activity:line.homeCheck"),
      outcome?.count === 0 ? t("activity:detail.noProblems") : count("activity:detail.problems"));
    case "recall_conversation": return say(!activity.query ? t("activity:line.recallBrowse")
      : activity.more ? t("activity:line.recallMore", { query: activity.query, count: activity.more }) : t("activity:line.recall", { query: activity.query }),
    count("activity:detail.messages"));
    case "lcm_rollup": {
      const what = t({ daily: "activity:line.rollupDaily", weekly: "activity:line.rollupWeekly", monthly: "activity:line.rollupMonthly", yearly: "activity:line.rollupYearly" }[activity.level] as Key);
      return say(activity.period ? t("activity:line.rollupPeriod", { what, period: activity.period }) : what, held ? undefined : count("activity:detail.events"));
    }
    case "upsert_person": return say(t(outcome?.status === "created" ? "activity:line.personCreated" : "activity:line.personUpdated", { name: activity.name }));
    case "list_people": return say(t("activity:line.listPeople"), count("activity:detail.people"));
  }
}
