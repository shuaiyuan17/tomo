import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowUp, Paperclip } from "lucide-react";
import type { WebSubsession, WebSubsessionDetail } from "../../src/web/protocol.js";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "./api.js";
import { Text } from "./markdown.js";
import { messageDateTime, messageTime } from "./message-meta.js";
import { createCompositionGuard } from "./compose-keys.js";
import { canRetrySend, isOpenSubsession, SUBSESSIONS_RETRY_MS, subsessionChatRows, updatePending, usePending, subsessionState, subsessionStateLabel, isWorkingState, type PendingSubsessionMessage, type SubsessionChatRow } from "./subsessions.js";
import { i18n, useTranslation } from "./i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: tasks:subsession.error.*

/** How the view sends the owner's words: resolves when the task has them, rejects with the refusal. */
export type SubsessionSend = (id: string, requestId: string, text: string) => Promise<WebSubsession>;

const ERRORS = {
  subsession_ended: "tasks:subsession.error.ended", subsession_inbox_full: "tasks:subsession.error.full",
  subsession_not_found: "tasks:subsession.error.gone", subsessions_unavailable: "tasks:subsession.error.unavailable",
  network: "tasks:subsession.error.network",
} as const;
/** Which message a failed send shows, by the refusal's code; anything unknown counts as the network. */
const errorKey = (error: unknown): keyof typeof ERRORS =>
  error instanceof ApiError && error.code in ERRORS ? error.code as keyof typeof ERRORS : "network";

type Status = "loading" | "ready" | "gone" | "error";

/**
 * One sub-session, opened in the Tasks rail: its brief, what the owner and the
 * task have said to each other, the report, and a box to write to it (the same
 * as `/s <id> …` in the DM). Re-read whenever the rail's list moves (`revision`),
 * so it follows the task live.
 */
export function SubsessionView({ summary, revision, onBack, send }: { summary: WebSubsession; revision: number; onBack: () => void; send?: SubsessionSend }) {
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
  // What the list says now wins over the last detail read (it is the newer of the two).
  const shown = { ...(detail ?? {}), ...summary };
  const state = subsessionState(shown);
  // Not before the conversation has been read: a message must have somewhere to show.
  const writable = !!send && shown.writable && status !== "gone" && !!detail;

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
  // Sent ones the conversation now has are done with.
  useEffect(() => {
    if (detail) setPending((old) => old.some((m) => m.state === "sent" && m.revision !== undefined && detail.revision >= m.revision)
      ? old.filter((m) => !(m.state === "sent" && m.revision !== undefined && detail.revision >= m.revision)) : old);
  }, [detail]);
  return <section className="motion-from-right flex min-h-0 flex-1 flex-col" aria-labelledby="subsession-heading" data-subsession={id}>
    <div className="mb-2 flex items-start gap-1.5 pr-2.5">
      <Button variant="ghost" size="sm" onClick={onBack} aria-label={t("back")}
        className="h-8 shrink-0 gap-1 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground">
        <ArrowLeft className="size-4" strokeWidth={1.75} />{t("heading")}</Button>
    </div>
    <div className="mb-2.5 px-2.5">
      <h2 id="subsession-heading" className="m-0 text-[15px] leading-snug font-semibold [overflow-wrap:anywhere]"><IdPill id={id} className="mr-1.5 align-[1.5px]" />{shown.title}</h2>
      <p className="m-0 mt-0.5 tracking-[0.02em] text-[10px] text-muted-foreground [overflow-wrap:anywhere]" data-testid="subsession-state">
        {isWorkingState(state) ? <span className="shimmer">{subsessionStateLabel(shown)}</span> : <span className={cn(state === "waitingOwner" && "font-medium text-foreground/80")}>{subsessionStateLabel(shown)}</span>}
        {shown.waitingReason && state === "waitingOwner" ? <> · {shown.waitingReason}</> : null}</p>
      {shown.progress && isOpenSubsession(shown) && <p className="m-0 mt-1.5 text-[12px] leading-snug text-muted-foreground [overflow-wrap:anywhere]"><span className="font-medium text-foreground/80">{t("now")}</span> {shown.progress}</p>}
    </div>
    <Chat rows={rows} status={detail ? "ready" : status} id={id} onRetry={deliver} />
    {status === "gone" && detail && <p role="status" className="m-0 mx-2.5 mb-2 text-[11.5px] text-muted-foreground">{t("subsession.gone")}</p>}
    {send && <SubsessionComposer id={id} writable={writable} ended={!shown.writable} onSend={(text) => deliver({ requestId: crypto.randomUUID(), text, state: "sending" })} />}
  </section>;
}

/** The task's short id, set apart from the title the way the rail sets apart a model. */
export function IdPill({ id, className }: { id: string; className?: string }) {
  return <span data-subsession-id className={cn("inline-block rounded-[5px] border px-1 font-mono text-[10px] leading-[15px] font-normal tracking-normal text-muted-foreground", className)}>{id}</span>;
}

function Chat({ rows, status, id, onRetry }: { rows: SubsessionChatRow[]; status: Status; id: string; onRetry: (message: PendingSubsessionMessage) => void }) {
  const { t } = useTranslation("tasks");
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = rows.at(-1)?.key;
  // Follows the end while the reader is there; reading further up stays put.
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [last, rows.length]);
  return <div ref={scroll} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}
    className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]" tabIndex={0} aria-label={t("subsession.conversation", { id })}>
    {status !== "ready" && <p className="m-0 px-1.5 text-[13px] text-muted-foreground" role="status">{status === "loading" ? t("note.loading") : status === "gone" ? t("subsession.gone") : t("note.error")}</p>}
    {(status === "ready" || rows.length > 0) && <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((row) => <li key={row.key} className="min-w-0">{rowView(row, id, onRetry)}</li>)}
        {status === "ready" && rows.length === 1 && <li className="px-0.5 text-[11.5px] text-muted-foreground">{t("subsession.nothingYet", { id })}</li>}
      </ol>}
  </div>;
}

function rowView(row: SubsessionChatRow, id: string, onRetry: (message: PendingSubsessionMessage) => void) {
  if (row.kind === "brief") return <Brief brief={row.brief} quote={row.quote} truncated={row.truncated} />;
  if (row.kind === "report") return <Report text={row.text} truncated={row.truncated} />;
  if (row.kind === "pending") return <PendingBubble message={row.message} onRetry={() => onRetry(row.message)} />;
  return row.from === "owner" ? <OwnerBubble text={row.text} at={row.at} files={row.files} /> : <TaskMessage id={id} text={row.text} at={row.at} tag={row.tag} />;
}

const meta = "mb-1 flex items-baseline gap-1.5 tracking-[0.02em] text-[10.5px] text-muted-foreground";
const bubble = "markdown ml-auto w-fit max-w-[92%] rounded-2xl rounded-tr-md bg-secondary px-3 py-2 text-[13px]! leading-relaxed!";
const Time = ({ at }: { at: number }) => <time dateTime={new Date(at).toISOString()} title={messageDateTime(at)} className="tabular-nums">{messageTime(at)}</time>;

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

function Report({ text, truncated }: { text: string; truncated: boolean }) {
  const { t } = useTranslation("tasks");
  return <section aria-label={t("subsession.report")} className="rounded-lg border bg-card/70 px-2.5 py-2">
    <p className="m-0 mb-1 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{t("subsession.report")}</p>
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
    <form onSubmit={submit} className="flex items-end gap-1 rounded-[16px] border bg-card p-1.5 shadow-xs transition-[border-color,box-shadow] focus-within:border-muted-foreground/50 focus-within:shadow-md">
      <label className="sr-only" htmlFor={`subsession-message-${id}`}>{t("subsession.label", { id })}</label>
      <Textarea ref={input} id={`subsession-message-${id}`} data-testid="subsession-input" value={draft} maxLength={16_000} rows={1} disabled={!writable}
        placeholder={t("subsession.placeholder", { id })}
        className="max-h-40 min-h-8 flex-1 resize-none rounded-none border-0 bg-transparent! py-[5px] pr-2 pl-1.5 text-[13.5px] leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:ring-0 disabled:opacity-70 md:text-[13.5px]"
        onChange={(e) => setDraft(e.target.value)} onCompositionStart={() => ime.current.start()} onCompositionEnd={() => ime.current.end()}
        onKeyDown={(e) => { if (ime.current.shouldSubmit({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
      <Button type="submit" size="icon" aria-label={t("subsession.send", { id })} disabled={!canSend}
        className="size-8 shrink-0 rounded-full transition-[background-color,transform] hover:bg-primary/85 active:scale-[0.94] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 [&_svg:not([class*='size-'])]:size-4"><ArrowUp strokeWidth={2.2} /></Button>
    </form>
  </div>;
}
