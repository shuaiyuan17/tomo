import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { COMPOSER_FIELD, COMPOSER_FORM, COMPOSER_SEND } from "./composer-frame.js";
import { ArrowLeft, ArrowUp, Check, ChevronDown, Circle, CircleDot, Paperclip } from "lucide-react";
import type { WebSubsession, WebSubsessionDetail, WebSubsessionDoneStep, WebSubsessionPlanStep, WebSubsessionUpdate } from "../../src/web/protocol.js";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api, ApiError } from "./api.js";
import { Text } from "./markdown.js";
import { ModelBadge } from "./model-badge.js";
import { useAgentName } from "./agent-name.js";
import { RAIL_SCROLL, useScrollbarInPadding } from "./rail-scroll.js";
import { differentDay, messageDateTime, messageTime } from "./message-meta.js";
import { createCompositionGuard } from "./compose-keys.js";
import { canRetrySend, folded, planStepLook, showableTime, updateText, SUBSESSIONS_RETRY_MS, subsessionChatRows, updatePending, usePending, subsessionState, subsessionStateLabel, isWorkingState, asksOwner, ownerAsk, withListBackground, hasProgress, leadsWithChat, progressSummary, type PendingSubsessionMessage, type ProgressSummary, type SubsessionChatRow } from "./subsessions.js";
import { i18n, useTranslation } from "./i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: tasks:subsession.error.*
// i18n-dynamic: tasks:subsession.markDone.error.*

/** How the view sends the owner's words: resolves when the task has them, rejects with the refusal. */
export type SubsessionSend = (id: string, requestId: string, text: string) => Promise<WebSubsession>;
/** How the view marks a finished task's report done (by the report number it showed): resolves with the task, rejects with the refusal. */
export type SubsessionDone = (id: string, report: number) => Promise<WebSubsession>;

const ERRORS = {
  subsession_ended: "tasks:subsession.error.ended", subsession_inbox_full: "tasks:subsession.error.full",
  subsession_not_found: "tasks:subsession.error.gone", subsessions_unavailable: "tasks:subsession.error.unavailable",
  network: "tasks:subsession.error.network",
} as const;
/** Which message a failed send shows, by the refusal's code; anything unknown counts as the network. */
const errorKey = (error: unknown): keyof typeof ERRORS =>
  error instanceof ApiError && error.code in ERRORS ? error.code as keyof typeof ERRORS : "network";

const DONE_ERRORS = {
  subsession_nothing_to_do: "tasks:subsession.markDone.error.nothing", subsession_newer_report: "tasks:subsession.markDone.error.newer",
  subsession_not_found: "tasks:subsession.markDone.error.gone", subsessions_unavailable: "tasks:subsession.markDone.error.unavailable",
  network: "tasks:subsession.markDone.error.network",
} as const;
const doneErrorKey = (error: unknown): keyof typeof DONE_ERRORS =>
  error instanceof ApiError && error.code in DONE_ERRORS ? error.code as keyof typeof DONE_ERRORS : "network";

type Status = "loading" | "ready" | "gone" | "error";

/**
 * One sub-session, opened in the Tasks rail: its brief, what the owner and the
 * task have said to each other, the report, and a box to write to it (the same
 * as `/s <id> …` in the DM). Re-read whenever the rail's list moves (`revision`),
 * so it follows the task live.
 *
 * Until anything has been said, the view leads with what the task is doing
 * (its plan, decisions and updates) under the brief, at full size. Once there
 * is a message or a report, that folds into one line under the brief, above the chat (the step
 * it is on), which opens it again.
 */
export function SubsessionView({ summary, revision, onBack, send, done }: { summary: WebSubsession; revision: number; onBack: () => void; send?: SubsessionSend; done?: SubsessionDone }) {
  const { t } = useTranslation("tasks");
  const [detail, setDetail] = useState<WebSubsessionDetail>();
  const [status, setStatus] = useState<Status>("loading");
  const pending = usePending(summary.id);
  const setPending = (update: (old: PendingSubsessionMessage[]) => PendingSubsessionMessage[]) => updatePending(summary.id, update);
  const [reload, setReload] = useState(0);
  const id = summary.id;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void api<WebSubsessionDetail>(`/subsessions/${encodeURIComponent(id)}`, { signal: controller.signal }).then((value) => { setDetail(value); setStatus("ready"); },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // Only a 404 means the task is gone; anything else (the table unreadable for a moment, the network) is read again.
        if (error instanceof ApiError && error.status === 404) { setStatus("gone"); return; }
        setStatus("error");
        timer = setTimeout(() => setReload((n) => n + 1), SUBSESSIONS_RETRY_MS);
      });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, revision, reload]);
  // The task as Done returned it, while the list still shows the ask it cleared: the list can lag (coalesced),
  // or no longer carry the task at all (an old one leaves it once it no longer needs the owner), and the rail
  // then keeps the summary it was opened with. A list showing anything else (a newer report) wins.
  const [marked, setMarked] = useState<{ task: WebSubsession; report: number }>();
  const current = marked && summary.ownerAction !== undefined && summary.reportSeq === marked.report ? marked.task : summary;
  // What the list says now wins over the last detail read (it is the newer of the two).
  // `background` is dropped, not set false, when it ends: take it from the list alone.
  const shown = withListBackground(detail, current);
  const state = subsessionState(shown);
  // Not before the conversation has been read: a message must have somewhere to show.
  const writable = !!send && shown.writable && status !== "gone" && !!detail;
  const running = isWorkingState(state);
  /** Opened by the owner from the folded line; folded by default once the chat leads. */
  const [progressOpen, setProgressOpen] = useState(false);

  const deliver = (message: PendingSubsessionMessage) => {
    if (!send) return;
    setPending((old) => [...old.filter((m) => m.requestId !== message.requestId), { ...message, state: "sending", error: undefined }]);
    void send(id, message.requestId, message.text).then((task) => {
      // Kept (as sent) until a read of the conversation has it, so it never blinks out in between.
      setPending((old) => old.map((m) => m.requestId === message.requestId ? { ...m, state: "sent", revision: task.revision } : m));
      setReload((n) => n + 1);
    }, (error: unknown) => {
      setPending((old) => old.map((m) => m.requestId === message.requestId ? { ...m, state: "failed", error: errorKey(error) } : m));
    });
  };
  const rows = subsessionChatRows(detail, pending);
  const chatFirst = leadsWithChat(rows);
  const progress = detail && hasProgress(detail) ? detail : undefined;
  const foldLine = progress && chatFirst ? progressSummary(progress, running) : undefined;
  // Sent ones the conversation now has are done with.
  useEffect(() => {
    if (detail) updatePending(id, (old) => old.some((m) => m.state === "sent" && m.revision !== undefined && detail.revision >= m.revision)
      ? old.filter((m) => !(m.state === "sent" && m.revision !== undefined && detail.revision >= m.revision)) : old);
  }, [detail, id]);
  return <section className="motion-from-right flex min-h-0 flex-1 flex-col" aria-labelledby="subsession-heading" data-subsession={id}>
    <div className="mb-2 flex items-start gap-1.5 pr-2.5">
      <Button variant="ghost" size="sm" onClick={onBack} aria-label={t("back")}
        className="h-8 shrink-0 gap-1 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground">
        <ArrowLeft className="size-4" strokeWidth={1.75} />{t("heading")}</Button>
    </div>
    <div className="mb-2.5 px-2.5">
      <h2 id="subsession-heading" className="m-0 text-[15px] leading-snug font-semibold [overflow-wrap:anywhere]"><IdPill id={id} className="mr-1.5 align-[1.5px]" />{shown.title}<ModelBadge model={shown.model} className="align-[1.5px]" /></h2>
      <p className="m-0 mt-0.5 tracking-[0.02em] text-[10px] text-muted-foreground [overflow-wrap:anywhere]" data-testid="subsession-state">
        {isWorkingState(state) ? <span className="shimmer">{subsessionStateLabel(shown)}</span> : <span className={cn(asksOwner(state) && "font-medium text-foreground/80")}>{subsessionStateLabel(shown)}</span>}
        {asksOwner(state) && ownerAsk(shown) ? <> · {ownerAsk(shown)}</> : null}</p>
      {done && state === "needsYou" && shown.reportSeq !== undefined
        ? <MarkDone key={shown.reportSeq} id={id} report={shown.reportSeq} done={done} onDone={(task, report) => { setMarked({ task, report }); setReload((n) => n + 1); }} /> : null}
    </div>
    <Chat rows={rows} status={detail ? "ready" : status} id={id} onRetry={deliver} follow={chatFirst}
      fold={progress && foldLine ? <ProgressFold summary={foldLine} open={progressOpen} onOpenChange={setProgressOpen}>
        <Doing plan={progress.plan} done={progress.doneSteps} running={running} />
        <Updates updates={progress.updates} />
        <Checkpoint text={progress.checkpoint} />
      </ProgressFold> : undefined}
      overview={progress && !chatFirst ? <div data-testid="subsession-overview" className="flex flex-col gap-4 px-0.5 pt-1">
        <Doing plan={progress.plan} done={progress.doneSteps} running={running} roomy />
        <Updates updates={progress.updates} roomy />
        <Checkpoint text={progress.checkpoint} />
      </div> : undefined} />
    {status === "gone" && detail && <p role="status" className="m-0 mx-2.5 mb-2 text-[11.5px] text-muted-foreground">{t("subsession.gone")}</p>}
    {send && <SubsessionComposer id={id} writable={writable} ended={!shown.writable} onSend={(text) => deliver({ requestId: crypto.randomUUID(), text, state: "sending" })} />}
  </section>;
}

/** Done steps shown before "show earlier", and updates before "show all": folded under the brief, and with the view to themselves (`roomy`). */
const DONE_SHOWN = 3;
const UPDATES_SHOWN = 3;
const DONE_SHOWN_ROOMY = 6;
const UPDATES_SHOWN_ROOMY = 8;
const sectionHeading = "m-0 mb-1 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase";
const foldButton = "rounded px-0 text-[11px] text-muted-foreground transition-colors hover:text-foreground";

/** Older than today: the date says when, as the time alone would not. */
function When({ at }: { at: number }) {
  if (!showableTime(at)) return null;
  return <time dateTime={new Date(at).toISOString()} title={messageDateTime(at)} className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
    {differentDay(at, Date.now()) ? messageDateTime(at) : messageTime(at)}</time>;
}

/**
 * "What it's doing": a checklist. The steps it finished (each with its
 * result, the newest few unless asked for more), then the one it is on and
 * those still ahead.
 */
function Doing({ plan, done, running, roomy }: { plan?: WebSubsessionPlanStep[]; done?: WebSubsessionDoneStep[]; running: boolean; roomy?: boolean }) {
  const { t } = useTranslation("tasks");
  const agent = useAgentName();
  const [open, setOpen] = useState(false);
  if (!plan?.length && !done?.length) return null;
  const keep = roomy ? DONE_SHOWN_ROOMY : DONE_SHOWN;
  const finished = folded(done ?? [], keep, open, "end");
  return <section aria-label={t("subsession.doing.heading", { agent })} data-testid="subsession-doing">
    <p className={sectionHeading}>{t("subsession.doing.heading", { agent })}</p>
    {finished.hidden > 0 || open && (done?.length ?? 0) > keep ? <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn(foldButton, "mb-1")}>
      {open ? t("subsession.doing.fewer") : t("subsession.doing.earlier", { count: finished.hidden })}</button> : null}
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {finished.shown.map((step, i) => <li key={`d${i}`} data-step="done" className="flex items-start gap-1.5 text-[12px] leading-snug">
        <Check aria-hidden="true" className="mt-[2px] size-3 shrink-0 text-foreground/70" />
        <span className="sr-only">{t("subsession.doing.done")}: </span>
        <span className="min-w-0 flex-1 text-foreground/80 [overflow-wrap:anywhere]">{step.text}{step.result ? <span className="text-muted-foreground"> · {step.result}</span> : null}</span>
        <When at={step.at} />
      </li>)}
      {(plan ?? []).map((step, i) => { const look = planStepLook(step.status, running); return <li key={`p${i}`} data-step={step.status} data-look={look} className="flex items-start gap-1.5 text-[12px] leading-snug">
        {look === "pending" ? <Circle aria-hidden="true" className="mt-[2px] size-3 shrink-0 text-muted-foreground/60" />
          : <CircleDot aria-hidden="true" className={cn("mt-[2px] size-3 shrink-0", look === "running" ? "text-primary" : "text-muted-foreground")} />}
        <span className="sr-only">{look === "pending" ? t("subsession.doing.pending") : t("subsession.doing.inProgress")}: </span>
        <span className={cn("min-w-0 [overflow-wrap:anywhere]", look === "pending" ? "text-muted-foreground" : look === "running" ? "font-medium text-foreground/90" : "font-medium text-foreground/70")}>
          {look === "running" ? <span className="shimmer">{step.text}</span> : step.text}</span>
      </li>; })}
    </ol>
  </section>;
}

/** "Decisions and updates", newest first: what the task decided or what changed, with its milestones among them. */
function Updates({ updates, roomy }: { updates?: WebSubsessionUpdate[]; roomy?: boolean }) {
  const { t } = useTranslation("tasks");
  const [open, setOpen] = useState(false);
  const lines = (updates ?? []).flatMap((entry) => { const text = updateText(entry); return text ? [{ entry, text }] : []; });
  if (lines.length === 0) return null;
  const keep = roomy ? UPDATES_SHOWN_ROOMY : UPDATES_SHOWN;
  const view = folded(lines, keep, open, "start");
  return <section aria-label={t("subsession.updates.heading")} data-testid="subsession-updates">
    <p className={sectionHeading}>{t("subsession.updates.heading")}</p>
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {view.shown.map(({ entry, text }, i) => <li key={i} data-kind={entry.kind} className="flex items-start gap-1.5 text-[12px] leading-snug">
        <span aria-hidden="true" className={cn("mx-[4px] mt-[6px] size-1 shrink-0 rounded-full", entry.kind === "milestone" ? "bg-muted-foreground/50" : "bg-primary/70")} />
        <span className={cn("min-w-0 flex-1 [overflow-wrap:anywhere]", entry.kind === "milestone" ? "text-muted-foreground" : "text-foreground/85")}>{text}</span>
        <When at={entry.at} />
      </li>)}
    </ol>
    {view.hidden > 0 || open && lines.length > keep ? <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn(foldButton, "mt-1")}>
      {open ? t("subsession.updates.fewer") : t("subsession.updates.more", { count: lines.length })}</button> : null}
  </section>;
}

/** What the task saved with task_checkpoint (its side effects so far, what it ruled out): three lines, the rest on Show more. */
function Checkpoint({ text }: { text?: string }) {
  const { t } = useTranslation("tasks");
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return <section aria-label={t("subsession.checkpoint.heading")} data-testid="subsession-checkpoint">
    <div className="flex items-center justify-between gap-2">
      <p className={sectionHeading}>{t("subsession.checkpoint.heading")}</p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="rounded px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">{open ? t("brief.less") : t("brief.more")}</button>
    </div>
    <div className={cn("text-[12px] leading-snug text-foreground/85", open ? "max-h-[40vh] overflow-y-auto pr-1" : "line-clamp-3")}>
      <Text breaks>{text}</Text></div>
  </section>;
}

/**
 * What the task is doing, folded into one line under the brief once there is
 * something to read there: the step it is on (or its latest update) and how
 * far through its plan it is. Opens in place to the full checklist and the
 * decisions and updates.
 */
export function ProgressFold({ summary, open, onOpenChange, children }: { summary: ProgressSummary; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const { t } = useTranslation("tasks");
  const agent = useAgentName();
  const count = summary.total !== undefined ? t("subsession.progress.count", { done: summary.done, total: summary.total }) : undefined;
  return <Collapsible open={open} onOpenChange={onOpenChange} data-testid="subsession-progress"
    className="overflow-hidden rounded-lg border bg-card/70">
    <CollapsibleTrigger title={open ? t("subsession.progress.hide", { agent }) : t("subsession.progress.show", { agent })}
      className="group flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:outline-offset-0">
      <SummaryMark look={summary.look} />
      <span className="sr-only">{t("subsession.progress.label", { agent })}</span>
      <span data-testid="subsession-progress-summary" className={cn("min-w-0 flex-1 truncate text-[12px] leading-snug",
        summary.look === "running" || summary.look === "paused" ? "font-medium text-foreground/85" : "text-foreground/75")}>
        {summary.text}</span>
      {summary.total !== undefined && <span title={count} className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
        <span aria-hidden="true">{summary.done}/{summary.total}</span><span className="sr-only">{count}</span></span>}
      <ChevronDown aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground", open && "rotate-180")} />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div className="flex max-h-[min(42vh,340px)] flex-col gap-3 overflow-y-auto border-t px-2.5 pt-2 pb-2.5 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]">{children}</div>
    </CollapsibleContent>
  </Collapsible>;
}

/** The folded line's mark, drawn as the checklist draws the same kind of line. */
function SummaryMark({ look }: { look: ProgressSummary["look"] }) {
  const cls = "size-3 shrink-0";
  if (look === "done") return <Check aria-hidden="true" className={cn(cls, "text-foreground/70")} />;
  if (look === "pending") return <Circle aria-hidden="true" className={cn(cls, "text-muted-foreground/60")} />;
  if (look === "update") return <span aria-hidden="true" className="mx-[4px] size-1 shrink-0 rounded-full bg-primary/70" />;
  return <CircleDot aria-hidden="true" className={cn(cls, look === "running" ? "text-primary" : "text-muted-foreground")} />;
}

/** The task's short id, set apart from the title the way the rail sets apart a model. */
export function IdPill({ id, className }: { id: string; className?: string }) {
  return <span data-subsession-id className={cn("inline-block rounded-[5px] border px-1 font-mono text-[10px] leading-[15px] font-normal tracking-normal text-muted-foreground", className)}>{id}</span>;
}

/**
 * The brief and the conversation. `overview`: what the task is doing, shown at
 * full size after the brief while nothing has been said. `fold`: the same,
 * folded into one line, between the brief and the conversation once something
 * has been said. `follow`: keep to the
 * end as lines arrive (the chat leads); otherwise it opens at the top.
 */
export function Chat({ rows, status, id, onRetry, overview, fold, follow }: { rows: SubsessionChatRow[]; status: Status; id: string; onRetry: (message: PendingSubsessionMessage) => void; overview?: ReactNode; fold?: ReactNode; follow: boolean }) {
  const { t } = useTranslation("tasks");
  const scroll = useRef<HTMLDivElement | null>(null);
  const gutter = useScrollbarInPadding<HTMLDivElement>();
  const scrollRef = useCallback((el: HTMLDivElement | null) => { scroll.current = el; gutter(el); }, [gutter]);
  const pinned = useRef(true);
  const last = rows.at(-1)?.key;
  // Follows the end while the reader is there; reading further up stays put.
  const followed = useRef(follow);
  useLayoutEffect(() => {
    const el = scroll.current;
    // The chat has just taken the lead: go to its end, wherever the overview was scrolled to.
    if (follow && !followed.current) pinned.current = true;
    followed.current = follow;
    if (el && follow && pinned.current) el.scrollTop = el.scrollHeight;
  }, [last, rows.length, follow]);
  return <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}
    className={cn("min-h-0 flex-1 overflow-y-auto px-2.5 pb-2", RAIL_SCROLL)} data-testid="subsession-scroll" tabIndex={0} aria-label={t("subsession.conversation", { id })}>
    {status !== "ready" && <p className="m-0 px-1.5 text-[13px] text-muted-foreground" role="status">{status === "loading" ? t("note.loading") : status === "gone" ? t("subsession.gone") : t("note.error")}</p>}
    {(status === "ready" || rows.length > 0) && <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((row) => <Fragment key={row.key}><li className="min-w-0">{rowView(row, id, onRetry)}</li>
          {row.kind === "brief" && fold ? <li className="min-w-0">{fold}</li> : null}</Fragment>)}
      </ol>}
    {overview && status === "ready" && <div className="motion-enter mt-4 min-w-0">{overview}</div>}
  </div>;
}

function rowView(row: SubsessionChatRow, id: string, onRetry: (message: PendingSubsessionMessage) => void) {
  if (row.kind === "brief") return <Brief brief={row.brief} quote={row.quote} truncated={row.truncated} />;
  if (row.kind === "report") return <Report text={row.text} truncated={row.truncated} seq={row.seq} />;
  if (row.kind === "pending") return <PendingBubble message={row.message} onRetry={() => onRetry(row.message)} />;
  return row.from === "owner" ? <OwnerBubble text={row.text} at={row.at} files={row.files} /> : <TaskMessage id={id} text={row.text} at={row.at} tag={row.tag} />;
}

const meta = "mb-1 flex items-baseline gap-1.5 tracking-[0.02em] text-[10.5px] text-muted-foreground";
const bubble = "markdown ml-auto w-fit max-w-[92%] rounded-2xl rounded-tr-md bg-secondary px-3 py-2 text-[13px]! leading-relaxed!";
const Time = ({ at }: { at: number }) => !showableTime(at) ? null : <time dateTime={new Date(at).toISOString()} title={messageDateTime(at)} className="tabular-nums">{messageTime(at)}</time>;

function OwnerBubble({ text, at, files }: { text: string; at: number; files?: number }) {
  const { t } = useTranslation("tasks");
  return <div data-from="owner" className="flex flex-col items-end">
    <div className={meta}><span className="font-medium text-foreground/80">{t("subsession.you")}</span><Time at={at} /></div>
    <div className={bubble}><Text breaks>{text}</Text></div>
    {files ? <p className="m-0 mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground"><Paperclip className="size-3" aria-hidden="true" />{t("subsession.files", { count: files })}</p> : null}
  </div>;
}

function TaskMessage({ id, text, at, tag }: { id: string; text: string; at: number; tag?: "ask" | "notify" }) {
  const { t } = useTranslation("tasks");
  return <div data-from="task">
    <div className={meta}><span className="font-medium text-foreground/80">{id}</span>{tag === "ask" ? <span className="rounded-[5px] bg-primary/10 px-1 text-primary">{t("subsession.tag.ask")}</span>
      : tag === "notify" ? <span>{t("subsession.tag.notify")}</span> : null}<Time at={at} /></div>
    <div className="markdown text-[13px]! leading-relaxed!"><Text>{text}</Text></div>
  </div>;
}

function PendingBubble({ message, onRetry }: { message: PendingSubsessionMessage; onRetry: () => void }) {
  const { t } = useTranslation("tasks");
  const failed = message.state === "failed";
  // An ended or missing task is final. Anything else may pass (the table or the task's inbox recovers, the network may
  // not have delivered it): it is sent again with the same id, which the task drops if it already has it.
  const retry = failed && canRetrySend(message.error);
  return <div data-from="owner" data-pending={message.state} className="flex flex-col items-end">
    <div className={cn(bubble, "opacity-70")}><Text breaks>{message.text}</Text></div>
    <p role="status" className="m-0 mt-1 text-right text-[10.5px] text-muted-foreground">
      {message.state === "sent" ? t("subsession.sent") : failed ? <>{i18n.t(ERRORS[(message.error ?? "network") as keyof typeof ERRORS])}{retry && <> · <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-foreground">{t("subsession.retry")}</button></>}</> : t("subsession.sending")}</p>
  </div>;
}

function Brief({ brief, quote, truncated }: { brief: string; quote?: string[]; truncated: boolean }) {
  const { t } = useTranslation("tasks");
  const [open, setOpen] = useState(false);
  return <section aria-label={t("brief.heading")} className="rounded-lg border bg-card/70 px-2.5 py-2">
    <div className="mb-1 flex items-center justify-between gap-2">
      <p className="m-0 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{t("brief.heading")}</p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="rounded px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">{open ? t("brief.less") : t("brief.more")}</button>
    </div>
    <div className={cn("text-[12.5px] leading-relaxed", open ? "max-h-[40vh] overflow-y-auto pr-1" : "line-clamp-3")}>
      {quote && <blockquote className="m-0 mb-2 border-l-2 pl-2 text-muted-foreground"><Text breaks>{quote.join("\n")}</Text></blockquote>}
      <div className="markdown text-[12.5px]! leading-relaxed!"><Text>{truncated ? t("brief.truncated", { text: brief }) : brief}</Text></div></div>
  </section>;
}

/** The report, or (`seq`) an earlier one a later report replaced before it was read. */
function Report({ text, truncated, seq }: { text: string; truncated: boolean; seq?: number }) {
  const { t } = useTranslation("tasks");
  const heading = seq === undefined ? t("subsession.report") : t("subsession.earlierReport", { seq });
  return <section aria-label={heading} className="rounded-lg border bg-card/70 px-2.5 py-2">
    <p className="m-0 mb-1 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{heading}</p>
    <div className="markdown text-[12.5px]! leading-relaxed!"><Text>{truncated ? t("brief.truncated", { text }) : text}</Text></div>
  </section>;
}

/** A small composer, the DM's in miniature: Enter sends (IME-safe), Shift+Enter breaks the line. */
function SubsessionComposer({ id, writable, ended, onSend }: { id: string; writable: boolean; ended: boolean; onSend: (text: string) => void }) {
  const { t } = useTranslation("tasks");
  const [draft, setDraft] = useState("");
  const ime = useRef(createCompositionGuard());
  const input = useRef<HTMLTextAreaElement>(null);
  const canSend = writable && draft.trim().length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
    input.current?.focus();
  };
  return <div className="px-2.5 pt-1">
    {ended && <p role="status" className="m-0 mb-1.5 text-[11px] text-muted-foreground">{t("subsession.ended")}</p>}
    <form onSubmit={submit} className={COMPOSER_FORM}>
      <label className="sr-only" htmlFor={`subsession-message-${id}`}>{t("subsession.label", { id })}</label>
      <Textarea ref={input} id={`subsession-message-${id}`} data-testid="subsession-input" value={draft} maxLength={16_000} rows={1} disabled={!writable}
        placeholder={t("subsession.placeholder", { id })}
        className={cn(COMPOSER_FIELD, "max-h-40 pr-2 py-[7px] text-[13.5px] leading-[22px] disabled:opacity-70 md:text-[13.5px]")}
        onChange={(e) => setDraft(e.target.value)} onCompositionStart={() => ime.current.start()} onCompositionEnd={() => ime.current.end()}
        onKeyDown={(e) => { if (ime.current.shouldSubmit({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
      <Button type="submit" size="icon" aria-label={t("subsession.send", { id })} disabled={!canSend}
        className={cn(COMPOSER_SEND, "[&_svg:not([class*='size-'])]:size-4")}><ArrowUp strokeWidth={2.2} /></Button>
    </form>
  </div>;
}

/**
 * "Done" on a task whose report asks the owner to do something: the same as
 * `/s <id> done <report>`. It names the report it was shown with, so a newer
 * report's ask is never cleared by it. Keyed by that report, so a new one starts fresh.
 */
function MarkDone({ id, report, done, onDone }: { id: string; report: number; done: SubsessionDone; onDone: (task: WebSubsession, report: number) => void }) {
  const { t } = useTranslation("tasks");
  const [state, setState] = useState<{ marking: boolean; error?: keyof typeof DONE_ERRORS }>({ marking: false });
  const mark = () => {
    setState({ marking: true });
    void done(id, report).then((task) => { setState({ marking: false }); onDone(task, report); },
      (error: unknown) => setState({ marking: false, error: doneErrorKey(error) }));
  };
  return <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
    <Button type="button" variant="outline" size="sm" onClick={mark} disabled={state.marking} title={t("subsession.markDone.title")}
      className="h-7 gap-1 rounded-lg px-2 text-[12px]"><Check className="size-3.5" aria-hidden="true" />
      {state.marking ? t("subsession.markDone.marking") : t("subsession.markDone.label")}</Button>
    {state.error ? <span role="status" className="text-[11px] text-muted-foreground">{i18n.t(DONE_ERRORS[state.error])}</span> : null}
  </div>;
}
