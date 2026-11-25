import { memo, type ReactNode } from "react";
import type { HistoryMessage, WebReaction, WebRequest, WebSnapshot } from "../../src/web/protocol.js";
import { CopyAction, MessageActions, ReactAction, ReactionPills, ReplyAction, TapbackLine } from "@/components/ai/message-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Text } from "./markdown.js";
import { FileCard, MessageBody, ReplyQuote } from "./message-body.js";
import { channelLabel, messageDateTime, messageTime } from "./message-meta.js";
import { awaitingOwner, historyBadge, pendingLabel, readReceipt, type ReadReceipt } from "./pending.js";
import { parseTapback, quoteFor, reactionKind, type ShownReaction } from "./reactions.js";
import { ReadReceiptMark } from "./read-receipt.js";
import { findQuoted, messageText, parseReply, type ReplyContext } from "./reply.js";
import { parseSendMarker, sendMarkerLabel, type SendMarker } from "./send-marker.js";
import { formatSize } from "./uploads.js";
import { i18n, useTranslation } from "./i18n/index.js";

/**
 * The chat's rows: recorded messages, this tab's pending ones, and the reply
 * streaming in. A recorded message is memoized on props that are its own
 * (its message object, request, reactions, flags), so a streamed block, a
 * tool event or another request's change re-renders only the rows it touches.
 */

/** What the rows can ask of the page. One stable object: rows never re-render because a handler changed. */
export interface RowActions {
  startReply(message: { id: string; role: string; content: string }): void;
  react(quote: string, reaction: WebReaction): void;
  resend(request: WebRequest): void;
  dismiss(requestId: string): void;
  /** Asks to confirm a dismiss (null: back to the plain buttons). */
  confirmDismiss(requestId: string | null): void;
  /** Scrolls to a quoted message and briefly highlights it. */
  showMessage(id: string): void;
}

/** A message's send marker, reply quote, body and tapback, as written. */
export interface ParsedMessage { sent?: SendMarker; reply?: ReplyContext; body: string; tapback?: ReturnType<typeof parseTapback> }
const parsedCache = new WeakMap<HistoryMessage, ParsedMessage>();
function parseMessage(message: HistoryMessage): ParsedMessage {
  let parsed = parsedCache.get(message);
  if (!parsed) {
    const { sent, body: content } = parseSendMarker(message.role, message.content);
    const { reply, body } = parseReply(content);
    // A tapback (the owner's, from any channel) shows as one quiet line, not a bubble.
    const tapback = message.role === "user" ? parseTapback(message.content) : undefined;
    parsed = { sent, reply, body, tapback };
    parsedCache.set(message, parsed);
  }
  return parsed;
}

/**
 * Each message parsed (cached per message object, which the history keeps
 * while it is unchanged) and the id of the message it quotes (findQuoted
 * scans the messages before it). Indexed like `messages`.
 */
export function parseHistory(messages: readonly HistoryMessage[]): Array<{ parsed: ParsedMessage; quotedId?: string }> {
  const list = messages as HistoryMessage[];
  return list.map((message, index) => {
    const parsed = parseMessage(message);
    const target = parsed.tapback ? parsed.tapback.reply : parsed.reply;
    return { parsed, quotedId: target && findQuoted(list, index, target)?.id };
  });
}

/** A centred day label at the top of the first row of a day ("Yesterday", "Sat, Nov 8"). */
export function DayDivider({ label }: { label: string }) {
  return <div role="separator" aria-label={label} className="mx-auto mb-6 flex max-w-[740px] items-center gap-3 text-[11px] font-medium tracking-[0.02em] text-muted-foreground">
    <span aria-hidden="true" className="h-px flex-1 bg-border" /><span aria-hidden="true">{label}</span><span aria-hidden="true" className="h-px flex-1 bg-border" /></div>;
}

const metaBadge = "self-center rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground";
const smallButton = "h-7 rounded-lg text-xs";

/** Resend / Dismiss for an interrupted request awaiting the owner, on its bubble (history or pending). */
function InterruptedActions({ request, agent, writable, confirming, actions }: { request?: WebRequest; agent: string; writable: boolean; confirming: boolean; actions: RowActions }) {
  if (!request) return null;
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <span>{i18n.t("chat:interrupted.note", { agent })}</span>
    <Button variant="outline" size="sm" className={smallButton} onClick={() => actions.resend(request)} disabled={!writable}>{i18n.t("chat:interrupted.resend")}</Button>
    {confirming
      ? <><Button variant="outline" size="sm" className={smallButton} onClick={() => actions.dismiss(request.requestId)}>{i18n.t("chat:interrupted.dismissConfirm")}</Button>
        <Button variant="ghost" size="sm" className={smallButton} onClick={() => actions.confirmDismiss(null)}>{i18n.t("chat:interrupted.keep")}</Button></>
      : <Button variant="ghost" size="sm" className={smallButton} onClick={() => actions.confirmDismiss(request.requestId)}>{i18n.t("chat:interrupted.dismiss")}</Button>}
  </div>;
}

/**
 * The owner's own bubble: as wide as its content (up to 85% of the column),
 * left-aligned with its header, and — in the owner conversation — the read
 * receipt under its right edge.
 */
function OwnBubble({ receipts, receipt, agent, children }: { receipts: boolean; receipt?: ReadReceipt; agent: string; children?: ReactNode }) {
  return <div className="own-bubble group relative flex w-fit min-w-0 max-w-[85%] flex-col">{children}
    {receipts && <ReadReceiptMark receipt={receipt} agent={agent} />}</div>;
}

const userBubble = "min-w-0 rounded-2xl rounded-tl-md bg-secondary px-5 py-3.5 max-[600px]:px-4 max-[600px]:py-3";

export interface RecordedMessageProps {
  message: HistoryMessage; parsed: ParsedMessage; quotedId?: string;
  /** The web request this message was sent as (its state badges the bubble). */
  request?: WebRequest;
  /** Shown reactions; compared by content, not identity. */
  reactions: readonly ShownReaction[];
  /** The message before it is a tapback (Tomo's silence after one is the expected answer). */
  afterTapback: boolean;
  /** Rises in (it arrived while the page was open, not sent from here). */ enter: boolean;
  /** Highlighted: its quote was just clicked. */ flash: boolean;
  /** Its interrupted request's Dismiss is being confirmed. */ confirming: boolean;
  /** The owner conversation: the owner's bubbles carry a read receipt. */ receipts: boolean;
  agent: string; group: boolean; writable: boolean; live: boolean; sessionId: string; actions: RowActions;
}

/** A recorded message: a tapback line, "No reply", or a message with its header, actions and reactions. */
export const RecordedMessage = memo(function RecordedMessage(props: RecordedMessageProps) {
  const { message, parsed, quotedId, request, reactions, afterTapback, enter, flash, confirming, receipts, agent, group, writable, live, sessionId, actions } = props;
  // Memoized: subscribe, so a language switch re-renders the row.
  useTranslation();
  const { sent, reply, body, tapback } = parsed;
  const interrupted = request && awaitingOwner(request) ? request : undefined;
  const onQuote = quotedId ? () => actions.showMessage(quotedId) : undefined;
  const articleClass = (gap: string) => cn(`message ${message.role} group/message mx-auto ${gap} max-w-[740px] rounded-2xl transition-[background-color,box-shadow] duration-700`,
    enter && "motion-enter", flash && "bg-primary/10 shadow-[0_0_0_8px_color-mix(in_srgb,var(--primary)_10%,transparent)]");
  const when = <><time dateTime={new Date(message.timestamp).toISOString()} title={messageDateTime(message.timestamp)} className="tabular-nums">{messageTime(message.timestamp)}</time><span>{channelLabel(message.channel)}</span></>;
  const interruptedActions = <InterruptedActions request={interrupted} agent={agent} writable={writable} confirming={confirming} actions={actions} />;
  if (tapback) return <article id={`msg-${message.id}`} className={articleClass("mb-5")}>
    <TapbackLine who={group ? i18n.t("chat:reaction.who.participant") : i18n.t("chat:reaction.who.you")} reaction={tapback.reaction} quote={tapback.reply?.excerpt}
      meta={<span className="flex shrink-0 items-baseline gap-3 text-[11px] tracking-[0.02em]">{when}</span>} onQuote={onQuote} />
    {interruptedActions}</article>;
  const silent = message.role === "assistant" && body.trim() === "NO_REPLY";
  // Tomo's silence after a tapback is the expected answer to one: nothing to show.
  if (silent && afterTapback) return null;
  const user = message.role === "user";
  const mine = reactions.find((r) => r.from !== "agent")?.reaction.kind;
  const actionable = !silent && message.role !== "tool_summary";
  // The request alone decides the badge and receipt (helpers take the request list).
  const own = request ? [request] : [];
  const badge = user ? historyBadge(message.requestId, own) : undefined;
  const content = <div className={cn("markdown", user && userBubble, message.role === "assistant" && "reading")}>
    {silent
      // A turn that ended without a reply (silent by choice, or stopped): said plainly, not as the agent's words.
      ? <p className="m-0 font-sans text-[12.5px] text-muted-foreground">{i18n.t("chat:message.noReply")}</p>
      : <MessageBody body={body} reply={reply} sessionId={sessionId} onQuote={onQuote} thinking={message.role === "assistant" ? "joined" : undefined} />}</div>;
  return <article id={`msg-${message.id}`} className={articleClass("mb-7")}>
    <div className="mb-2 flex items-baseline gap-3 tracking-[0.02em] text-[11px] text-muted-foreground"><span className="font-sans text-[13px] font-semibold text-foreground">{message.role === "assistant" ? agent : user ? (group ? i18n.t("chat:message.participant") : i18n.t("chat:reaction.who.you")) : i18n.t("chat:message.system")}</span>{when}
      {sent && <Badge variant="outline" className={metaBadge}>{sendMarkerLabel(sent)}</Badge>}
      {badge && <Badge variant="outline" className={metaBadge}>{badge}</Badge>}
      {actionable && <MessageActions aria-label={i18n.t("chat:message.actions")} className="-my-1.5 ml-auto self-center">
        {writable && live && <>
          <ReplyAction onReply={() => actions.startReply(message)} />
          <ReactAction current={mine} onReact={(kind) => actions.react(quoteFor(message), kind)} /></>}
        <CopyAction text={messageText(message.role, message.content)} /></MessageActions>}</div>
    {user ? <OwnBubble receipts={receipts} receipt={readReceipt(message.requestId, own)} agent={agent}>{content}</OwnBubble> : content}
    <ReactionPills reactions={reactions} agent={agent} className={user ? "relative z-[1] -mt-2.5 ml-3" : "mt-1"} />
    {user && interruptedActions}</article>;
}, (before, after) => {
  for (const key of Object.keys(after) as Array<keyof RecordedMessageProps>) {
    if (key === "reactions") { if (!sameReactions(before.reactions, after.reactions)) return false; }
    else if (before[key] !== after[key]) return false;
  }
  return true;
});

function sameReactions(a: readonly ShownReaction[], b: readonly ShownReaction[]): boolean {
  return a === b || (a.length === b.length && a.every((r, i) => r.from === b[i].from && r.pending === b[i].pending && r.reaction.emoji === b[i].reaction.emoji && r.reaction.kind === b[i].reaction.kind));
}

/** Previews this tab kept of what it sent with a request (its pending bubble shows them until the transcript has the message). */
export interface SentAttachments { images?: string[]; files?: Array<{ name: string; size: number }> }

/** A message this tab sent that the transcript does not show yet: a tapback line, or a bubble with its attachments. */
export function PendingMessage({ request, sent, reactions, receipts, confirming, agent, writable, sessionId, actions }: {
  request: WebRequest; sent?: SentAttachments; reactions: readonly ShownReaction[]; receipts: boolean; confirming: boolean;
  agent: string; writable: boolean; sessionId: string; actions: RowActions;
}) {
  const interruptedActions = <InterruptedActions request={awaitingOwner(request) ? request : undefined} agent={agent} writable={writable} confirming={confirming} actions={actions} />;
  const quote = request.reply?.text.replace(/\s+/g, " ").trim() || null;
  if (request.reply?.reaction) return <article className="message user tapback motion-enter mx-auto mb-5 max-w-[740px]" data-request-id={request.requestId}>
    <TapbackLine who={i18n.t("chat:reaction.who.you")} reaction={reactionKind(request.reply.reaction)} quote={quote}
      meta={<Badge variant="outline" className={cn(metaBadge, "shrink-0")}>{pendingLabel(request)}</Badge>} />
    {interruptedActions}</article>;
  const files = sent?.files ?? (request.files ?? []).map((file): { name: string; size?: number } => ({ name: file.name, size: file.size }));
  return <article className="message user motion-enter mx-auto mb-7 max-w-[740px]" data-request-id={request.requestId}>
    <div className="mb-2 flex items-baseline gap-3 tracking-[0.02em] text-[11px] text-muted-foreground"><span className="font-sans text-[13px] font-semibold text-foreground">{i18n.t("chat:reaction.who.you")}</span><span>{channelLabel("web")}</span>
      <Badge variant="outline" className={metaBadge}>{pendingLabel(request)}</Badge></div>
    {/* Another tab's send (or a reload): the images by where they were filed. */}
    {!sent?.images && request.images?.length ? <div className="mb-2 opacity-80"><MessageBody sessionId={sessionId}
      body={`[Sent ${request.images.length === 1 ? "an image" : `${request.images.length} images`}, saved to: ${request.images.join(", ")}]`} /></div> : null}
    {sent?.images && <div className="mb-2 flex flex-wrap gap-2 opacity-80">{sent.images.map((src, i) =>
      <img key={i} src={src} alt={i18n.t("chat:image.alt")} className="block max-h-[280px] max-w-[280px] rounded-xl border object-contain" />)}</div>}
    {files.length > 0 && <div className="mb-2 flex flex-wrap gap-2 opacity-80">
      {files.map((file, i) => <FileCard key={i} name={file.name} size={file.size === undefined ? undefined : formatSize(file.size)} />)}</div>}
    <OwnBubble receipts={receipts} receipt={readReceipt(request.requestId, [request])} agent={agent}>{request.text ? <div className={cn("markdown opacity-80", userBubble)}>
      {request.reply && <ReplyQuote reply={{ verb: "replying", excerpt: quote, truncated: false }} />}
      <Text breaks>{request.text}</Text></div> : null}</OwnBubble>
    <ReactionPills reactions={reactions} agent={agent} className="relative z-[1] -mt-2.5 ml-3" />
    {interruptedActions}</article>;
}

/** A block of the reply streaming in, until the transcript records the turn. */
export const LiveReply = memo(function LiveReply({ block, agent, sessionId }: { block: WebSnapshot["blocks"][number]; agent: string; sessionId: string }) {
  const { t } = useTranslation("chat");
  return <article className="message assistant motion-enter mx-auto mb-7 max-w-[740px]">
    <div className="mb-2 flex items-baseline gap-3 tracking-[0.02em] text-[11px] text-muted-foreground"><span className="font-sans text-[13px] font-semibold text-foreground">{agent}</span><span>{t("message.inProgress")}</span></div>
    <div className="markdown reading"><MessageBody body={[block.text, ...(block.images ?? []).map((id) => `MEDIA:web:${id}`),
      ...(block.files ?? []).map((file) => `MEDIA:web:file:${file.id}:${file.size}:${file.name}`)].filter(Boolean).join("\n")} sessionId={sessionId} thinking="block" /></div></article>;
});
