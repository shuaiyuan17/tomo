import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRightIcon, BracesIcon, FilePlusIcon, FileXIcon, FolderInputIcon, NotebookPenIcon, PencilLineIcon, TextCursorInputIcon, CheckIcon, CircleCheckIcon, CircleHelpIcon, ClockIcon, FileIcon, PlusIcon, Trash2Icon, UserRoundIcon } from "lucide-react";
import type { ToolActivity, ToolOutcome, WebSubsession } from "../../src/web/protocol.js";
import { cn } from "@/lib/utils";
import { ToolSection } from "@/components/ai/tool";
import { CopyButton } from "./code-block.js";
import { IdPill } from "./subsession-view.js";
import { ModelBadge } from "./model-badge.js";
import { RunningMark } from "./running-mark.js";
import { activityIcon, knownActivity } from "./activity.js";
import { useActivityEnv, useSubsessionById } from "./activity-env.js";
import { asksOwner, isOpenSubsession, isWorkingState, subsessionState, subsessionStateLabel } from "./subsessions.js";
import { callDuration, elapsedSince, type ToolRow } from "./subagent.js";
import { useNow } from "./use-now.js";
import { formatLocale, i18n, Trans, useTranslation } from "./i18n/index.js";
import { cronJobHash, memoryFileHash } from "./study-data.js";
import { formatList } from "./i18n/format.js";

/** Keys this file picks at runtime (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: activity:card.*

/**
 * One of Tomo's own tool calls that left something behind (a task started, a
 * note passed, a message sent) as a card in the chat rather than a line:
 * docs/web-ui.md, "Activity cards". One component for every kind: a head
 * (icon, a sentence, time, the raw-data button), a body, an optional footer,
 * and the raw-data panel. Running, it shimmers; failed, it is outlined in the
 * destructive colour and says why; done without effect, it says so in warn.
 */

/** `unknown`: no result, and the turn is over (interrupted, or the result is not in what was loaded): no claim either way. */
type CardState = "running" | "done" | "error" | "unknown";

/** Each card's head sentence, by state (catalog keys in activity:card). */
const HEADS = {
  spawn: { running: "card.spawning", unknown: "card.spawning", error: "card.spawnFailed", done: "card.spawn" },
  note: { running: "card.noting", unknown: "card.noting", error: "card.noteFailed", done: "card.note", held: "card.noteHeld" },
  cancel: { running: "card.cancelling", unknown: "card.cancelling", error: "card.cancelFailed", done: "card.cancel" },
  send: { running: "card.sendingTo", unknown: "card.sendingTo", error: "card.sendFailed", done: "card.sentTo" },
  sendYou: { running: "card.sendingYou", unknown: "card.sendingYou", error: "card.sendFailed", done: "card.sentYou" },
  delegate: { running: "card.delegating", unknown: "card.delegating", error: "card.sendFailed", done: "card.delegate" },
  delegateYou: { running: "card.delegating", unknown: "card.delegating", error: "card.sendFailed", done: "card.delegateYou" },
  todoAdd: { running: "card.todoAdding", unknown: "card.todoAdding", error: "card.todoAddFailed", done: "card.todoAdd" },
  todoResolve: { running: "card.todoResolving", unknown: "card.todoResolving", error: "card.todoResolveFailed", done: "card.todoDone" },
  todos: { running: "card.todosWorking", unknown: "card.todosWorking", error: "card.todosFailed", done: "card.todos" },
  scheduleOnce: { running: "card.scheduling", unknown: "card.scheduling", error: "card.scheduleFailed", done: "card.scheduledOnce" },
  scheduleRecurring: { running: "card.scheduling", unknown: "card.scheduling", error: "card.scheduleFailed", done: "card.scheduledRecurring" },
  permission: { running: "card.permissionAsking", unknown: "card.permissionAsking", error: "card.permissionFailed", done: "card.permission" },
  credential: { running: "card.credentialAsking", unknown: "card.credentialAsking", error: "card.credentialFailed", done: "card.credential" },
} as const;
/** A to-do resolved, by action: its head, the icon of its line, and what it counts as in a merged card's head. */
const RESOLVED = {
  done: { head: "card.todoDone", icon: CircleCheckIcon, part: "closed" }, drop: { head: "card.todoDrop", icon: Trash2Icon, part: "dropped" },
  snooze: { head: "card.todoSnooze", icon: ClockIcon, part: "snoozed" }, handoff: { head: "card.todoHandoff", icon: UserRoundIcon, part: "handed" },
} as const;
const PARTS = { added: "card.todoParts.added", closed: "card.todoParts.closed", dropped: "card.todoParts.dropped", snoozed: "card.todoParts.snoozed",
  handed: "card.todoParts.handed", failed: "card.todoParts.failed", unknown: "card.todoParts.unknown" } as const;
const LINE_STATE = { done: "card.lineState.done", error: "card.lineState.error", running: "card.lineState.running", unknown: "card.lineState.unknown" } as const;
/** Said before a to-do line to a screen reader: what was done to it (the icon and strike-through say it on screen). */
const LINE_ACTION = { add: "card.lineAction.add", done: "card.lineAction.done", drop: "card.lineAction.drop", snooze: "card.lineAction.snooze",
  handoff: "card.lineAction.handoff" } as const;
const WAITING = { me: "card.todoWaiting.me", owner: "card.todoWaiting.owner", external: "card.todoWaiting.external" } as const;
const ACCESS = { read: "card.access.read", write: "card.access.write" } as const;
/** A card of several calls: running while any runs, failed when all failed, unknown when none finished, else done. */
function stateOfAll(rows: readonly ToolRow[], running: boolean): CardState {
  const states = rows.map((row) => stateOf(row, running));
  if (states.includes("running")) return "running";
  if (states.every((state) => state === "error")) return "error";
  return states.includes("done") ? "done" : states.includes("unknown") ? "unknown" : "error";
}
const stateOf = (row: ToolRow, running: boolean): CardState => row.result?.isError ? "error" : row.result ? "done" : running ? "running" : "unknown";

/** A card's head sentence: a catalog key with `<id>` (a task id pill) and `<b>` (a name) in it. */
function Head({ k, values }: { k: string; values?: Record<string, string> }) {
  const { t } = useTranslation("activity");
  return <Trans t={t} ns="activity" i18nKey={k as never} values={values}
    components={{ id: <IdPill id={values?.id ?? ""} className="mx-0.5 align-[1px]" />, b: <b className="font-medium text-foreground" /> }} />;
}

/** Text the agent wrote (a note, a message), set off on a tinted block, clamped to `lines` with "Show all". */
function Quote({ text, lines, plain: bare, truncated }: { text: string; lines: 2 | 3 | 6; plain?: boolean; truncated?: boolean }) {
  const { t } = useTranslation("activity");
  const [open, setOpen] = useState(false);
  // A first guess from the text; once laid out, whether the clamp actually cut it (wrapping on a narrow screen, CJK).
  const [long, setLong] = useState(() => text.split("\n").length > lines || text.length > lines * 80);
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);
  return <div className={bare ? "mt-1" : "mt-2"}>
    <p ref={ref} data-slot="activity-quote" className={cn("m-0 whitespace-pre-wrap [overflow-wrap:anywhere]",
      bare ? "text-[12.5px] leading-relaxed text-muted-foreground" : "rounded-[10px] bg-foreground/[0.05] px-3 py-2 text-[13px] leading-relaxed text-foreground",
      !open && (lines === 2 ? "line-clamp-2" : lines === 3 ? "line-clamp-3" : "line-clamp-6"))}>{text}</p>
    {long && <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
      className="mt-1 rounded px-1 text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{open ? t("card.showLess") : t("card.showAll")}</button>}
    {truncated && (open || !long) && <p className="m-0 mt-1 text-[11.5px] text-muted-foreground">{t("card.longer")}</p>}
  </div>;
}

/** One call in the raw-data panel: its full name, id and time, then INPUT / OUTPUT as the server sent them. */
function RawCall({ row }: { row: ToolRow }) {
  const { t } = useTranslation(["activity", "chat"]);
  const idRef = useRef<HTMLSpanElement>(null);
  // Without the clipboard (not a secure context, or denied): the JSON in a selected box, to copy by hand.
  const [manual, setManual] = useState(false);
  const manualBox = useRef<HTMLTextAreaElement>(null);
  // Focused and selected once, when it appears: not again on every re-render (a running card's clock).
  useEffect(() => { if (manual) { manualBox.current?.focus(); manualBox.current?.select(); } }, [manual]);
  const json = JSON.stringify({ name: row.name, id: row.toolUseId, input: row.input, output: row.result?.output, isError: row.result?.isError ?? false }, null, 2);
  const took = callDuration(row);
  return <div className="space-y-2.5">
    <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
      <span className="min-w-0 truncate">{row.name}</span><span aria-hidden="true">·</span>
      <span ref={idRef} title={row.toolUseId} className="min-w-0 max-w-[14ch] truncate">{row.toolUseId}</span>
      {took && <span className="shrink-0">· {took}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1"><CopyButton value={row.toolUseId} fallback={idRef} label={t("card.copyId", { id: row.toolUseId })} />
        <CopyButton value={json} fallback={() => setManual(true)} label={t("card.copyJson")} /></span>
    </div>
    {manual && <textarea readOnly value={json} rows={6} aria-label={t("card.copyJson")} ref={manualBox}
      className="block w-full resize-y rounded-md border bg-background p-2 font-mono text-[11px] text-foreground" />}
    {row.input && <ToolSection label={t("chat:trace.input")} text={row.input} truncated={row.inputTruncated} />}
    {row.result && <ToolSection label={row.result.isError ? t("chat:trace.error") : t("chat:trace.output")} text={row.result.output} truncated={row.result.truncated} error={row.result.isError} />}
  </div>;
}

/** The raw-data panel: every call of the card, and what this data is. */
function RawPanel({ rows }: { rows: readonly ToolRow[] }) {
  const { t } = useTranslation("activity");
  return <div data-slot="activity-raw" className="motion-enter space-y-3 border-t bg-foreground/[0.02] px-3.5 py-3">
    {rows.map((row) => <RawCall key={row.id} row={row} />)}
    <p className="m-0 font-mono text-[10.5px] text-muted-foreground">{t("card.rawNote")}</p>
  </div>;
}

/**
 * The shell every card shares. `head`: the sentence (key and values);
 * `rawOpen` / `onRawOpen`: the raw panel, open state kept by the chat (by call
 * id) so paging and live updates do not close it.
 */
function Card({ rows, state, head, children, footer, rawOpen, onRawOpen, compact }: {
  rows: readonly ToolRow[]; state: CardState; head: { k: string; values?: Record<string, string> }; children?: ReactNode; footer?: ReactNode;
  rawOpen: boolean; onRawOpen: (open: boolean) => void; compact?: boolean;
}) {
  const { t } = useTranslation(["activity", "chat"]);
  const row = rows[0];
  const Icon = state === "running" ? RunningMark : activityIcon(row) ?? BracesIcon;
  const now = useNow(state === "running");
  const time = state === "running" ? elapsedSince(row.ts, now) : callDuration(row);
  const headId = useId();
  return <section role="group" aria-labelledby={headId} data-activity-card={row.activity?.kind} data-state={state}
    className={cn("group/card w-[min(560px,100%)] overflow-hidden rounded-lg border bg-card font-sans", state === "error" && "border-destructive/35",
      state === "running" && "motion-enter")}>
    <div className={cn("px-3.5", compact ? "py-2" : "pt-2.5 pb-3")}>
      <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
        <span aria-hidden="true" className={cn("grid size-4 shrink-0 place-items-center [&_svg]:size-3.5", state === "error" && "text-destructive")}><Icon /></span>
        <span id={headId} className={cn("min-w-0 flex-1 truncate", state === "error" && "text-destructive", state === "running" && "shimmer")}><Head {...head} /></span>
        {state === "running" && <span className="sr-only">{t("chat:trace.running")}</span>}
        {state === "error" && <span className="sr-only">{t("chat:trace.failed")}</span>}
        {time && <span className="shrink-0 tabular-nums">{time}</span>}
        <button type="button" aria-label={t("card.raw")} title={rawOpen ? t("card.rawHide") : t("card.raw")} aria-expanded={rawOpen} onClick={() => onRawOpen(!rawOpen)}
          className={cn("-my-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-55 transition-opacity hover:bg-foreground/[0.06] hover:text-foreground hover:opacity-100",
            "group-hover/card:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:size-9 pointer-coarse:-my-2.5 pointer-coarse:opacity-100",
            rawOpen && "bg-foreground/[0.06] opacity-100")}>
          <BracesIcon className="size-3.5" aria-hidden="true" /></button>
      </div>
      {children}
      {state === "unknown" && <p className="m-0 mt-2 text-[12px] text-muted-foreground">{t("card.unknown")}</p>}
    </div>
    {footer && state === "done" && <div className="flex min-w-0 items-center gap-2 border-t px-3.5 py-2 text-[12px] text-muted-foreground">{footer}</div>}
    {rawOpen && <RawPanel rows={rows} />}
  </section>;
}

/** A failure's reason (the tool's own words), in the destructive colour. */
function Reason({ row }: { row: ToolRow }) {
  return row.result?.reason ? <p className="m-0 mt-1.5 text-[12.5px] text-destructive [overflow-wrap:anywhere]">{row.result.reason}</p> : null;
}
/** A sentence in the warn colour: the call returned, but did not do what it says on the head. */
function Warn({ children }: { children: ReactNode }) {
  return <p className="m-0 mt-2 text-[12.5px] text-warn [overflow-wrap:anywhere]">{children}</p>;
}

/** The footer of a task's card: what it is doing NOW (not when it was started), and the way to it. */
function TaskFooter({ task }: { task: WebSubsession | null | undefined }) {
  const { t } = useTranslation("activity");
  const { openTask } = useActivityEnv();
  if (task === undefined) return null;
  if (task === null) return <span>{t("card.taskGone")}</span>;
  const state = subsessionState(task);
  const say = subsessionStateLabel(task);
  const extra = state === "needsYou" ? task.ownerAction : isOpenSubsession(task) ? task.step : undefined;
  return <>
    <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", isWorkingState(state) ? "bg-primary" : asksOwner(state) ? "bg-warn" : "bg-muted-foreground/50")} />
    <span className="min-w-0 flex-1 truncate">
      {isWorkingState(state) ? <span className="shimmer">{say}</span> : <span className={cn(asksOwner(state) && "font-medium text-foreground/80")}>{say}</span>}
      {extra && <> · {extra}</>}
    </span>
    {openTask && <button type="button" onClick={() => openTask(task.id)}
      className="-my-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-primary hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:py-2">
      {t("card.openTask")}<ArrowRightIcon className="size-3.5" aria-hidden="true" /></button>}
  </>;
}

function SpawnCard({ row, state, raw }: CardProps & { row: ToolRow & { activity: Extract<ToolActivity, { kind: "task_spawn" }> } }) {
  const activity = row.activity;
  const id = row.result?.outcome?.id;
  const task = useSubsessionById(id);
  const head = { k: HEADS.spawn[state] };
  return <Card rows={[row]} state={state} head={head} {...raw} footer={id ? <TaskFooter task={task} /> : undefined}>
    <p className="m-0 mt-1.5 text-[13.5px] leading-snug font-medium text-foreground [overflow-wrap:anywhere]">
      {id && <IdPill id={id} className="mr-1.5 align-[1px]" />}{activity.title}<ModelBadge model={task?.model ?? activity.model} className="ml-1.5" /></p>
    {state === "error" ? <Reason row={row} /> : <Quote text={activity.brief} lines={2} plain truncated={activity.briefTruncated} />}
  </Card>;
}

function NoteCard({ row, state, raw }: CardProps & { row: ToolRow & { activity: Extract<ToolActivity, { kind: "task_message" }> } }) {
  const { t } = useTranslation("activity");
  const activity = row.activity;
  const outcome = row.result?.outcome;
  const held = outcome?.delivery === "held";
  const values = { id: activity.id };
  const head = { k: held && state === "done" ? HEADS.note.held : HEADS.note[state], values };
  return <Card rows={[row]} state={state} head={head} {...raw}>
    {state === "error" ? <Reason row={row} /> : <Quote text={activity.text} lines={3} truncated={activity.textTruncated} />}
    {state === "done" && activity.withOwner && <p className="m-0 mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <CheckIcon className="size-3.5" aria-hidden="true" />{t("card.withOwner")}</p>}
    {held && outcome.noop && <Warn>{outcome.noop}</Warn>}
    {outcome?.delivery === "queued" && <p className="m-0 mt-2 text-[12px] text-muted-foreground">{t("card.noteQueued")}</p>}
    {outcome?.delivery === "released" && <p className="m-0 mt-2 text-[12px] text-muted-foreground">{t("card.noteReleased")}</p>}
  </Card>;
}

function CancelCard({ row, state, raw }: CardProps & { row: ToolRow & { activity: Extract<ToolActivity, { kind: "task_cancel" | "task_done" }> } }) {
  const { t } = useTranslation("activity");
  const activity = row.activity;
  const task = useSubsessionById(activity.id);
  const head = { k: HEADS.cancel[state], values: { id: activity.id } };
  return <Card rows={[row]} state={state} head={head} {...raw}>
    <p className="m-0 mt-1.5 text-[13.5px] leading-snug font-medium text-foreground [overflow-wrap:anywhere]">
      <IdPill id={activity.id} className="mr-1.5 align-[1px]" />{task?.title}</p>
    {state === "error" ? <Reason row={row} /> : activity.reason && <p className="m-0 mt-1 text-[12.5px] text-muted-foreground">{t("card.reason", { reason: activity.reason })}</p>}
    {row.result?.outcome?.noop && <Warn>{row.result.outcome.noop}</Warn>}
  </Card>;
}

const CHANNELS = ["telegram", "imessage", "web"] as const;
function SendCard({ row, state, raw }: CardProps & { row: ToolRow & { activity: Extract<ToolActivity, { kind: "send_message" }> } }) {
  const { t } = useTranslation("activity");
  const env = useActivityEnv();
  const activity = row.activity;
  const session = activity.targetId ? env.sessions.find((s) => s.id === activity.targetId) : undefined;
  const name = session?.title || activity.target;
  const prefix = activity.target.split(":")[0];
  const channel = !activity.toOwner && (CHANNELS as readonly string[]).includes(prefix) ? t(`card.via.${prefix as (typeof CHANNELS)[number]}`) : undefined;
  const values = { name };
  // A direct message to the conversation on screen is its next bubble: the card only says so (unless the tool noted something went wrong).
  const here = activity.mode === "direct" && state === "done" && !row.result?.outcome?.note && (activity.toOwner ? !!env.ownerConversation : !!activity.targetId && activity.targetId === env.sessionId);
  if (here) return <Card rows={[row]} state={state} head={{ k: "card.sentHere" }} {...raw} compact />;
  const delegate = activity.mode === "delegate";
  const k = (delegate ? (activity.toOwner ? HEADS.delegateYou : HEADS.delegate) : activity.toOwner ? HEADS.sendYou : HEADS.send)[state];
  return <Card rows={[row]} state={state} head={{ k, values }} {...raw}>
    {channel && <span className="sr-only"> · {channel}</span>}
    {channel && <p aria-hidden="true" className="m-0 -mt-0.5 pl-6 text-[11.5px] text-muted-foreground">{channel}</p>}
    {state === "error" ? <Reason row={row} /> : <>
      {activity.text && <Quote text={activity.text} lines={6} truncated={activity.textTruncated} />}
      {delegate && <p className="m-0 mt-1.5 text-[12px] text-muted-foreground">{t("card.delegateNote")}</p>}
      {(activity.media?.length || activity.stickers || activity.replyTo || activity.effect) && <div className="mt-2 flex flex-wrap gap-1.5">
        {activity.media?.map((file, i) => <Chip key={`m${i}`}><FileIcon className="size-3" aria-hidden="true" />{file}</Chip>)}
        {activity.stickers ? <Chip>{t("card.stickers", { count: activity.stickers })}</Chip> : null}
        {activity.replyTo && <Chip>{t("card.replyTo", { text: activity.replyTo })}</Chip>}
        {activity.effect && <Chip>{t("card.effect", { effect: activity.effect })}</Chip>}
      </div>}
      {row.result?.outcome?.note && <Warn>{row.result.outcome.note}</Warn>}
    </>}
  </Card>;
}
const Chip = ({ children }: { children: ReactNode }) => <span className="inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground">{children}</span>;

type TodoRow = ToolRow & { activity: Extract<ToolActivity, { kind: "todo_add" | "todo_resolve" }> };
/** One to-do call as a line of the card: what it did to which to-do, and the small print under it. */
function TodoLine({ row, state, alone }: { row: TodoRow; state: CardState; alone: boolean }) {
  const { t } = useTranslation("activity");
  const activity = row.activity;
  const outcome: ToolOutcome = row.result?.outcome ?? {};
  const add = activity.kind === "todo_add";
  const resolved = activity.kind === "todo_resolve" ? RESOLVED[activity.action] : undefined;
  const Icon = state === "running" ? RunningMark : state === "unknown" ? CircleHelpIcon : add ? PlusIcon : resolved!.icon;
  const id = outcome.id ?? (activity.kind === "todo_resolve" ? activity.id : undefined);
  // A resolve's title is the tool's printed words verbatim (title, and its next step after " · next: " when that differs):
  // English like every tool's own text here, and never re-split, since a title can hold the same marker.
  const title = add ? activity.title : outcome.title;
  const struck = state === "done" && (activity.kind === "todo_resolve" && (activity.action === "done" || activity.action === "drop"));
  const date = outcome.review ?? (add ? activity.reviewIn : undefined);
  const small: string[] = [];
  if (state === "done" || state === "running" || state === "unknown") {
    if (add) {
      small.push(t("card.todoNext", { next: activity.next }), t(WAITING[activity.waitingOn]));
      if (date) small.push(outcome.due ? t("card.todoDue", { date }) : t("card.todoReview", { date }));
    } else if (activity.kind === "todo_resolve") {
      if (activity.action === "done" && activity.evidence) small.push(activity.evidence);
      if (activity.action === "drop" && activity.reason) small.push(activity.reason);
      if (activity.action === "snooze") {
        const until = outcome.review ?? activity.until;
        if (until) small.push(t("card.todoUntil", { date: until }));
        if (outcome.snoozes && outcome.maxSnoozes) small.push(t("card.todoSnoozes", { count: outcome.snoozes, max: outcome.maxSnoozes }));
        if (activity.reason) small.push(activity.reason);
      }
      if (activity.action === "handoff" && activity.next) small.push(t("card.todoNext", { next: activity.next }));
    }
  }
  return <li data-todo-line={add ? "add" : activity.kind === "todo_resolve" ? activity.action : undefined} data-state={state} className="flex min-w-0 gap-2 py-0.5">
    <span aria-hidden="true" className={cn("mt-[3px] grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5", state === "error" ? "text-destructive" : "text-muted-foreground")}><Icon /></span>
    <div className="min-w-0 flex-1">
      <p className={cn("m-0 text-[13px] leading-snug [overflow-wrap:anywhere]", state === "error" ? "text-destructive" : "text-foreground", state === "running" && "shimmer")}>
        <span className="sr-only">{t("card.lineSr", { action: t(LINE_ACTION[add ? "add" : activity.kind === "todo_resolve" ? activity.action : "add"]), state: t(LINE_STATE[state]) })} </span>
        {id && <IdPill id={id} className="mr-1.5 align-[1px]" />}
        <span className={cn(struck && "line-through decoration-muted-foreground/50")}>{title}</span></p>
      {state === "error" && row.result?.reason && <p className="m-0 mt-0.5 text-[12px] text-destructive [overflow-wrap:anywhere]">
        {t(add ? "card.todoNotAdded" : "card.todoNotUpdated", { reason: row.result.reason })}</p>}
      {small.length > 0 && <p className="m-0 mt-0.5 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">{small.join(" · ")}</p>}
      {state === "unknown" && !alone && <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">{t("card.unknown")}</p>}
    </div>
  </li>;
}

/** Lines a to-do card shows before "N more". */
const TODO_LINES = 3;
/** to-do calls in a row: one card, a line each (the first three, then "N more"). */
function TodoCard({ rows, running, raw }: { rows: TodoRow[]; running: boolean; raw: CardProps["raw"] }) {
  const { t } = useTranslation("activity");
  const [all, setAll] = useState(false);
  const states = rows.map((row) => stateOf(row, running));
  const state = stateOfAll(rows, running);
  let head: { k: string; values?: Record<string, string> };
  if (rows.length === 1) {
    const activity = rows[0].activity;
    head = activity.kind === "todo_add" ? { k: HEADS.todoAdd[state] }
      : { k: state === "done" ? RESOLVED[activity.action].head : HEADS.todoResolve[state], values: { id: activity.id } };
  } else if (state === "done") {
    const counts: Partial<Record<keyof typeof PARTS, number>> = {};
    rows.forEach((row, i) => {
      const part = states[i] === "error" ? "failed" : states[i] === "unknown" ? "unknown" : states[i] !== "done" ? undefined
        : row.activity.kind === "todo_add" ? "added" : RESOLVED[row.activity.action].part;
      if (part) counts[part] = (counts[part] ?? 0) + 1;
    });
    const parts = (Object.keys(PARTS) as (keyof typeof PARTS)[]).flatMap((part) => counts[part] ? [t(PARTS[part], { count: counts[part] })] : []);
    head = { k: HEADS.todos.done, values: { parts: formatList(parts) } };
  } else head = { k: HEADS.todos[state] };
  const shown = all ? rows : rows.slice(0, TODO_LINES);
  return <Card rows={rows} state={state} head={head} {...raw}>
    <ul className="m-0 mt-1.5 list-none space-y-1 p-0">{shown.map((row) => <TodoLine key={row.id} row={row} state={stateOf(row, running)} alone={rows.length === 1} />)}</ul>
    {rows.length > TODO_LINES && <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all}
      className="mt-1 rounded px-1 text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      {all ? t("card.showLess") : t("card.moreLines", { count: rows.length - TODO_LINES })}</button>}
  </Card>;
}

const MINUTE_MS = 60_000;
/** An interval in the largest whole unit: "every 2 hours", "every day", "every 90 minutes", "every 30 seconds". */
function every(ms: number): string {
  if (ms % (1440 * MINUTE_MS) === 0) return i18n.t("activity:card.everyDays", { count: ms / (1440 * MINUTE_MS) });
  if (ms % (60 * MINUTE_MS) === 0) return i18n.t("activity:card.everyHours", { count: ms / (60 * MINUTE_MS) });
  if (ms % MINUTE_MS === 0) return i18n.t("activity:card.everyMinutes", { count: ms / MINUTE_MS });
  return i18n.t("activity:card.everySeconds", { count: Math.max(1, Math.round(ms / 1000)) });
}
/** A time the page names in the reader's own zone and language: "Nov 15, 8:30 AM". */
const when = (at: number) => new Intl.DateTimeFormat(formatLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);

function ScheduleCard({ row, state, raw }: CardProps & { row: ToolRow & { activity: Extract<ToolActivity, { kind: "schedule_create" }> } }) {
  const { t } = useTranslation("activity");
  const env = useActivityEnv();
  const activity = row.activity;
  const outcome = row.result?.outcome;
  // Once: a date (even kept after it ran), or any job deleted after its first run (`once: true`, also with a cron or an interval).
  const once = outcome ? !!outcome.firesOnce || outcome.lifecycle === "once" : !!activity.once;
  const head = { k: (once ? HEADS.scheduleOnce : HEADS.scheduleRecurring)[state], values: { name: activity.name } };
  const target = activity.session ? env.sessions.find((s) => s.id === activity.sessionId)?.title || activity.session : undefined;
  const badge = once ? (outcome?.nextRunAt ? when(outcome.nextRunAt) : undefined)
    : outcome?.everyMs ? every(outcome.everyMs) : outcome?.cron ? `${outcome.cron}${outcome.tz ? ` (${outcome.tz})` : ""}` : activity.schedule;
  const mono = !once && !outcome?.everyMs;
  const footer = outcome?.id ? <>
    <span className="font-mono text-[11.5px]">{outcome.id}</span>
    {target && <Chip>{t("card.toSession", { name: target })}</Chip>}
    {!once && outcome.nextRunAt && <span className="min-w-0 truncate">{t("card.nextRun", { when: when(outcome.nextRunAt) })}</span>}
    <a href={cronJobHash(outcome.id)} className="-my-1 ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-primary hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:py-2">
      {t("card.openCron")}<ArrowRightIcon className="size-3.5" aria-hidden="true" /></a>
  </> : undefined;
  return <Card rows={[row]} state={state} head={head} {...raw} footer={footer}>
    <p className="m-0 mt-1.5 text-[13.5px] leading-snug font-medium text-foreground [overflow-wrap:anywhere]">{activity.name}
      {badge && state !== "error" && <span className={cn("ml-1.5 inline-block rounded-md border px-1.5 align-[1px] text-[11px] font-normal text-muted-foreground", mono && "font-mono")}>{badge}</span>}</p>
    {state === "error" ? <Reason row={row} /> : <Quote text={activity.message} lines={2} plain truncated={activity.messageTruncated} />}
  </Card>;
}

function PermissionCard({ row, state, raw }: CardProps & { row: ToolRow & { activity: Extract<ToolActivity, { kind: "request_permission" }> } }) {
  const { t } = useTranslation("activity");
  const activity = row.activity;
  const status = row.result?.outcome?.status;
  const footer = status === "pending" ? <span>{t("card.permissionPending")}</span> : status === "already_allowed" ? <span>{t("card.permissionAllowed")}</span> : undefined;
  return <Card rows={[row]} state={state} head={{ k: HEADS.permission[state] }} {...raw} footer={footer}>
    <p className="m-0 mt-1.5 flex min-w-0 items-center gap-1.5 text-[13px] text-foreground">
      <span className="shrink-0 rounded-md border px-1.5 text-[11px] text-muted-foreground">{t(ACCESS[activity.access])}</span>
      <span className="min-w-0 truncate font-mono text-[12.5px]" title={activity.path}>{activity.path}</span></p>
    {state === "error" ? <Reason row={row} /> : <Quote text={`“${activity.reason}”`} lines={3} plain />}
  </Card>;
}

function CredentialCard({ row, state, raw }: CardProps & { row: ToolRow & { activity: Extract<ToolActivity, { kind: "request_credential" }> } }) {
  const { t } = useTranslation("activity");
  const activity = row.activity;
  const channel = row.result?.outcome?.channel;
  const named = channel && (CHANNELS as readonly string[]).includes(channel) ? t(`card.via.${channel as (typeof CHANNELS)[number]}`) : channel;
  const footer = state === "done" ? <span>{named ? `${t("card.askedOn", { channel: named })} · ` : ""}{t("card.credentialNote")}</span> : undefined;
  return <Card rows={[row]} state={state} head={{ k: HEADS.credential[state] }} {...raw} footer={footer}>
    <p className="m-0 mt-1.5 font-mono text-[13px] text-foreground [overflow-wrap:anywhere]">{activity.name}</p>
    {state === "error" ? <Reason row={row} /> : <Quote text={activity.purpose} lines={2} plain />}
  </Card>;
}

type MemoryKind = "memory_write" | "memory_str_replace" | "memory_append" | "memory_move" | "memory_delete";
type MemoryRow = ToolRow & { activity: Extract<ToolActivity, { kind: MemoryKind }> };
/** What a memory write did, for its line: the action's word and icon, and its card's head when it is alone. */
const MEMORY_ACTIONS = {
  create: { icon: FilePlusIcon, head: "card.memoryCreated" }, write: { icon: NotebookPenIcon, head: "card.memoryRewrote" },
  edit: { icon: PencilLineIcon, head: "card.memoryEdited" }, append: { icon: TextCursorInputIcon, head: "card.memoryAppended" },
  move: { icon: FolderInputIcon, head: "card.memoryMoved" }, delete: { icon: FileXIcon, head: "card.memoryDeleted" },
} as const;
const MEMORY_HEADS = { working: "card.memoryWorking", failed: "card.memoryFailed", noneWent: "card.memoryNoneWent", counted: "card.memoryHead" } as const;
function memoryAction(activity: MemoryRow["activity"]) {
  const word: keyof typeof MEMORY_ACTIONS = activity.kind === "memory_write" ? (activity.created ? "create" : "write") : activity.kind === "memory_str_replace" ? "edit"
    : activity.kind === "memory_append" ? "append" : activity.kind === "memory_move" ? "move" : "delete";
  return { word, ...MEMORY_ACTIONS[word] };
}
const MEMORY_WORDS = { create: "card.memoryAction.create", write: "card.memoryAction.write", edit: "card.memoryAction.edit", append: "card.memoryAction.append",
  move: "card.memoryAction.move", delete: "card.memoryAction.delete" } as const;

/** A memory path: monospace, relative to memory/, a link to it in the Study's Memory tab (not under private/, which the Study does not open). */
function MemoryPath({ path, gone }: { path: string; gone?: boolean }) {
  const { t } = useTranslation("activity");
  const text = <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{path}</span>;
  if (gone) return text;
  const hash = memoryFileHash(path);
  return hash === "#study/memory" ? text
    : <a href={hash} title={t("card.memoryOpen", { path })} className="text-foreground underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground/60">{text}</a>;
}

function MemoryLine({ row, state }: { row: MemoryRow; state: CardState }) {
  const { t } = useTranslation("activity");
  const activity = row.activity;
  const action = memoryAction(activity);
  const Icon = state === "running" ? RunningMark : state === "unknown" ? CircleHelpIcon : action.icon;
  const note = row.result?.outcome?.note;
  let small: ReactNode = null;
  // What it changed, only once it did: running, refused or without a result, the line claims nothing.
  if (state === "done") {
    switch (activity.kind) {
      case "memory_write": small = activity.created ? t("card.memoryNew") : t("card.memoryReplaced"); break;
      case "memory_str_replace": small = <><span className="line-through decoration-muted-foreground/50">“{activity.old}”</span> → “{activity.new}”</>; break;
      // Not "new file": `create` only allows creating one; the result does not say whether it did.
      case "memory_append": small = t("card.memoryAdded", { count: activity.lines }); break;
      case "memory_delete": small = t("card.memoryKept"); break;
      default: break;
    }
  }
  return <li data-memory-line={action.word} data-state={state} className="flex min-w-0 gap-2 py-0.5">
    <span aria-hidden="true" className={cn("mt-[3px] grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5", state === "error" ? "text-destructive" : "text-muted-foreground")}><Icon /></span>
    <div className="min-w-0 flex-1">
      <p className={cn("m-0 text-[13px] leading-snug", state === "error" ? "text-destructive" : "text-foreground", state === "running" && "shimmer")}>
        <span className="mr-1.5 text-[12px] text-muted-foreground">{t(MEMORY_WORDS[action.word])}</span>
        <span className="sr-only">({t(LINE_STATE[state])}) </span>
        {activity.kind === "memory_move" ? <><MemoryPath path={activity.from} gone /> → <MemoryPath path={activity.to} gone={state !== "done" || !!activity.pathAltered} /></>
          : <MemoryPath path={activity.path} gone={activity.kind === "memory_delete" || state !== "done" || !!activity.pathAltered} />}</p>
      {state === "error" && row.result?.reason && <p className="m-0 mt-0.5 text-[12px] text-destructive [overflow-wrap:anywhere]">{row.result.reason}</p>}
      {small && <p className="m-0 mt-0.5 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">{small}</p>}
      {state === "done" && note && <p className="m-0 mt-0.5 text-[12px] text-warn [overflow-wrap:anywhere]">{note}</p>}
      {state === "unknown" && <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">{t("card.unknown")}</p>}
    </div>
  </li>;
}

/** Memory writes in a row: one card, a line each (the first three, then "N more"); a refused one is a red line in it. */
function MemoryCard({ rows, running, raw }: { rows: MemoryRow[]; running: boolean; raw: CardProps["raw"] }) {
  const { t } = useTranslation("activity");
  const [all, setAll] = useState(false);
  const states = rows.map((row) => stateOf(row, running));
  const state = stateOfAll(rows, running);
  const failed = states.filter((s) => s === "error").length;
  const done = states.filter((s) => s === "done").length;
  let head: { k: string; values?: Record<string, string> };
  if (state === "running" || state === "unknown") head = { k: MEMORY_HEADS.working };
  else if (state === "error") head = { k: rows.length === 1 ? MEMORY_HEADS.failed : MEMORY_HEADS.noneWent };
  else if (rows.length === 1) head = { k: memoryAction(rows[0].activity).head };
  else {
    const changes = t("card.memoryChanges", { count: done });
    head = { k: MEMORY_HEADS.counted, values: { text: failed ? `${changes} · ${t("card.memoryFailedCount", { count: failed })}` : changes } };
  }
  const shown = all ? rows : rows.slice(0, TODO_LINES);
  return <Card rows={rows} state={state} head={head} {...raw}>
    <ul className="m-0 mt-1.5 list-none space-y-1 p-0">{shown.map((row) => <MemoryLine key={row.id} row={row} state={stateOf(row, running)} />)}</ul>
    {rows.length > TODO_LINES && <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all}
      className="mt-1 rounded px-1 text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      {all ? t("card.showLess") : t("card.moreLines", { count: rows.length - TODO_LINES })}</button>}
  </Card>;
}

interface CardProps { row: ToolRow; state: CardState; raw: { rawOpen: boolean; onRawOpen: (open: boolean) => void } }

/** A card for `rows` (one call, or a run of the same kind), or null when they are not a card's (the caller shows lines). */
export function ActivityCard({ rows, running, rawOpen, onRawOpen }: { rows: readonly ToolRow[]; running: boolean; rawOpen: boolean; onRawOpen: (open: boolean) => void }) {
  const row = rows[0];
  const activity = knownActivity(row);
  if (!activity) return null;
  const props = { state: stateOf(row, running), raw: { rawOpen, onRawOpen } };
  switch (activity.kind) {
    case "todo_add": case "todo_resolve": {
      const todos = rows.flatMap((r) => { const a = knownActivity(r); return a && (a.kind === "todo_add" || a.kind === "todo_resolve") ? [{ ...r, activity: a }] : []; });
      return <TodoCard rows={todos} running={running} raw={props.raw} />;
    }
    case "memory_write": case "memory_str_replace": case "memory_append": case "memory_move": case "memory_delete": {
      const writes = rows.flatMap((r) => { const a = knownActivity(r); return a && (a.kind === "memory_write" || a.kind === "memory_str_replace" || a.kind === "memory_append"
        || a.kind === "memory_move" || a.kind === "memory_delete") ? [{ ...r, activity: a }] : []; });
      return <MemoryCard rows={writes} running={running} raw={props.raw} />;
    }
    case "schedule_create": return <ScheduleCard row={{ ...row, activity }} {...props} />;
    case "request_permission": return <PermissionCard row={{ ...row, activity }} {...props} />;
    case "request_credential": return <CredentialCard row={{ ...row, activity }} {...props} />;
    case "task_spawn": return <SpawnCard row={{ ...row, activity }} {...props} />;
    case "task_message": return <NoteCard row={{ ...row, activity }} {...props} />;
    case "task_cancel": return <CancelCard row={{ ...row, activity }} {...props} />;
    case "send_message": return <SendCard row={{ ...row, activity }} {...props} />;
    default: return null;
  }
}
