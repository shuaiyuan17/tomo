import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRightIcon, BracesIcon, CheckIcon, FileIcon } from "lucide-react";
import type { ToolActivity, WebSubsession } from "../../src/web/protocol.js";
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
import { i18n, Trans, useTranslation } from "./i18n/index.js";

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
} as const;
const stateOf = (row: ToolRow, running: boolean): CardState => row.result?.isError ? "error" : row.result ? "done" : running ? "running" : "unknown";

/** A card's head sentence: a catalog key with `<id>` (a task id pill) and `<b>` (a name) in it. */
function Head({ k, values }: { k: string; values?: Record<string, string> }) {
  const { t } = useTranslation("activity");
  return <Trans t={t} ns="activity" i18nKey={k as never} values={values}
    components={{ id: <IdPill id={values?.id ?? ""} className="mx-0.5 align-[1px]" />, b: <b className="font-medium text-foreground" /> }} />;
}
/** The same sentence as plain text, for the card's accessible name. */
const plain = (k: string, values?: Record<string, string>) => (i18n.t as unknown as (key: string, v?: object) => string)(`activity:${k}`, values).replace(/<\/?\w+>/g, "");

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
  const label = plain(head.k, head.values);
  return <section role="group" aria-label={label} data-activity-card={row.activity?.kind} data-state={state}
    className={cn("group/card w-[min(560px,100%)] overflow-hidden rounded-lg border bg-card font-sans", state === "error" && "border-destructive/35",
      state === "running" && "motion-enter")}>
    <div className={cn("px-3.5", compact ? "py-2" : "pt-2.5 pb-3")}>
      <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
        <span aria-hidden="true" className={cn("grid size-4 shrink-0 place-items-center [&_svg]:size-3.5", state === "error" && "text-destructive")}><Icon /></span>
        <span className={cn("min-w-0 flex-1 truncate", state === "error" && "text-destructive", state === "running" && "shimmer")}><Head {...head} /></span>
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
    {state !== "error" && activity.withOwner && <p className="m-0 mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
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

interface CardProps { row: ToolRow; state: CardState; raw: { rawOpen: boolean; onRawOpen: (open: boolean) => void } }

/** A card for `rows` (one call, or a run of the same kind), or null when they are not a card's (the caller shows lines). */
export function ActivityCard({ rows, running, rawOpen, onRawOpen }: { rows: readonly ToolRow[]; running: boolean; rawOpen: boolean; onRawOpen: (open: boolean) => void }) {
  const row = rows[0];
  const activity = knownActivity(row);
  if (!activity) return null;
  const props = { state: stateOf(row, running), raw: { rawOpen, onRawOpen } };
  switch (activity.kind) {
    case "task_spawn": return <SpawnCard row={{ ...row, activity }} {...props} />;
    case "task_message": return <NoteCard row={{ ...row, activity }} {...props} />;
    case "task_cancel": return <CancelCard row={{ ...row, activity }} {...props} />;
    case "send_message": return <SendCard row={{ ...row, activity }} {...props} />;
    default: return null;
  }
}
