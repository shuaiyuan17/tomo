import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent, type Ref } from "react";
import { ArrowUp, Plus, Reply, Sparkles, Square, X } from "lucide-react";
import type { WebReaction, WebRequest, WebSession } from "../../src/web/protocol.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, ApiError, dismissRequest, sendMessage, stopTurn } from "./api.js";
import { AttachmentTray } from "./attachment-tray.js";
import { createCompositionGuard } from "./compose-keys.js";
import { composerStatus, composerStatusIsProblem, requestLabels, requestStamp, useCompletedSettle, type ComposerNote } from "./composer-status.js";
import type { SentAttachments } from "./conversation-rows.js";
import { CredentialCard } from "./credential-card.js";
import { pendingKey } from "./inline-tools.js";
import { applyRestored, dismissAfterAcceptedSend, missingAttachments, resendAfterDraftChange, resendAfterSend, type Resend } from "./pending.js";
import { quoteFor } from "./reactions.js";
import { canSendWith, captureSend, imageFiles, pastedFiles } from "./uploads.js";
import { useAttachments } from "./use-attachments.js";
import type { useWeb } from "./use-web.js";

/**
 * The composer: the draft and its attachments, the reply being written, the
 * status line, and the send state machine (send, a resend of an interrupted
 * message, reactions, dismissals, a check after an uncertain answer, Stop).
 *
 * Its state is its own: typing, upload progress and the status line's clock
 * re-render the composer, not the page. The page reaches it through
 * `ComposerHandle` (a row's Reply / React / Resend / Dismiss, a drop on the chat).
 */
export interface ComposerHandle {
  startReply(message: { id: string; role: string; content: string }): void;
  /** A tapback on a message. `replaces`: an interrupted reaction this one resends. */
  react(quote: string, reaction: WebReaction, replaces?: string): void;
  /** Puts an interrupted request back in the composer to review and send again. */
  resend(request: WebRequest): void;
  /** Dismisses an interrupted request (a failure is said on the status line). */
  dismiss(requestId: string): void;
  attach(files: File[]): void;
  focus(options?: FocusOptions): void;
}

type Web = ReturnType<typeof useWeb>;

/** 503s that mean "not accepted, and why" — the draft stays, nothing ran. */
const REFUSAL_REASONS: Record<string, string> = {
  interrupted_backlog: "Not sent: messages interrupted by restarts are waiting for you above. Resend or dismiss them first; your draft is kept.",
  journal_unavailable: "Not sent: Tomo cannot read its record of browser messages, so it is not taking new ones. Check the daemon log; your draft is kept.",
  persist_failed: "Not sent: Tomo could not record the message safely. Your draft is kept; try again.",
};
const refusal = (err: unknown) => err instanceof ApiError && err.status === 503 ? REFUSAL_REASONS[err.code] : undefined;

/**
 * Why a send failed, for the status line. `definite`: the daemon said no
 * (nothing was accepted), so the request is not kept as uncertain; otherwise
 * it may have arrived and the owner checks before sending again.
 */
export function sendFailure(err: unknown, unknownLabel: string): { text: string; warn: boolean; definite: boolean } {
  const refused = refusal(err);
  if (refused) return { text: refused, warn: true, definite: true };
  if (err instanceof ApiError && [400, 401, 403, 409, 413, 415, 429].includes(err.status)) {
    const text = err.status === 413 ? "Message is too large. Shorten it and send again; your draft is kept."
      : err.status === 401 ? "Open the private link in web-access.log to reconnect. Your draft is kept."
      : err.code === "owner_dm_only" ? "Group conversations are read-only."
      : err.code === "upload_missing" ? "An attachment expired before it was sent. Remove it and attach it again; your draft is kept."
      : err.code === "uploads_disabled" ? "Attachments of that kind are off in config. Remove them to send; your draft is kept."
      : "Message was not accepted. Your draft is saved here; reconnect or check web settings.";
    return { text, warn: err.code !== "owner_dm_only", definite: true };
  }
  return { text: unknownLabel, warn: true, definite: false };
}

/** Why a reaction failed: never "your draft is kept" (a reaction has no draft). */
export function reactFailure(err: unknown): string {
  const refused = refusal(err);
  // Either case: the phrase can open a sentence ("Your draft is kept; try again.").
  return refused ? refused.replace(/([Yy])our draft is kept/, (_, y: string) => `${y === "Y" ? "The" : "the"} reaction was not sent`)
    : err instanceof ApiError ? "Reaction was not sent. Reconnect or try again."
    : "The reaction may not have been sent. Check the conversation before trying again.";
}

/** A resend that could not bring all of the original's attachments back (a failed read, a full tray). */
const missingNote = (missing: number) =>
  `${missing} attachment${missing === 1 ? "" : "s"} could not be restored. The interrupted message stays queued; attach ${missing === 1 ? "it" : "them"} again or dismiss it yourself.`;

const COMPOSER_MAX_HEIGHT = 240;
function fitComposer(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
}

const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif,.heic,.heif";

export function Composer({ handle, web, session, sessionId, agent, latest, turnActive, canAttach, uploadsOn, filesOn, claim, onAccepted, onSent, onDismiss }: {
  handle: Ref<ComposerHandle>;
  web: Web; session?: WebSession; sessionId: string; agent: string;
  /** The conversation's latest request, and whether a turn is running in it. */
  latest?: WebRequest; turnActive: boolean;
  canAttach: boolean; uploadsOn: boolean; filesOn: boolean;
  /** A send is going out: the chat takes the reader to its bubble. */ claim: (key: string) => void;
  /** A request was accepted: the history is read again. */ onAccepted: () => void;
  /** Previews of what a send carried, for its pending bubble. */ onSent: (requestId: string, sent: SentAttachments) => void;
  /** A dismissal starts (any confirmation on a bubble closes). */ onDismiss: () => void;
}) {
  const labels = requestLabels(agent);
  const live = web.connection === "live";
  const writable = !!session?.writable;
  const [draft, setDraft] = useState("");
  /** The message the next send replies to (its quote, as the agent will read it). */
  const [replyingTo, setReplyingTo] = useState<{ id: string; who: string; text: string } | null>(null);
  const attachments = useAttachments(web.bootstrap, web.refreshBootstrap, writable ? session!.id : undefined, { images: uploadsOn, files: filesOn });
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ime = useRef(createCompositionGuard());
  const [sending, setSending] = useState(false);
  // A send whose answer never came: kept (across a reload) until the owner checks it or keeps the draft.
  const [uncertain, setUncertain] = useState<string | null>(() => {
    try { return sessionStorage.getItem("tomo-pending-request"); } catch { return null; }
  });
  const remember = (id: string | null) => {
    setUncertain(id);
    try { if (id) sessionStorage.setItem("tomo-pending-request", id); else sessionStorage.removeItem("tomo-pending-request"); } catch { /* Optional recovery hint. */ }
  };
  // One-off notes for the status line, stamped with where the latest request
  // stood; composerStatus drops a note as soon as the request moves on.
  const [note, setNote] = useState<ComposerNote>({ text: "", at: "" });
  const stamp = useRef("");
  useEffect(() => { stamp.current = requestStamp(latest); });
  const setFeedback = (text: string, warn = false) => setNote({ text, at: stamp.current, warn });
  // Another conversation: the reply and a one-off note belonged to the last one.
  useEffect(() => { setReplyingTo(null); setNote({ text: "", at: "" }); }, [sessionId]);
  /** Interrupted request being resent from the composer (dismissed once the resend is accepted). */
  const [resending, setResending] = useState<Resend | null>(null);
  /** The current restore; bumped whenever the resend is replaced or ends, so a late result is dropped. */
  const restoreToken = useRef(0);
  const endResend = () => { restoreToken.current++; setResending(null); };
  /** A resend's images are still being read back into the tray. */
  const restoring = resending?.restoring === true;
  const [stopping, setStopping] = useState(false);
  useEffect(() => { if (!turnActive) setStopping(false); }, [turnActive]);

  // The composer grows with its text, up to a cap (then it scrolls). Text
  // changes and width changes (window, rail, rotation) both re-measure.
  useLayoutEffect(() => { fitComposer(input.current); }, [draft]);
  useEffect(() => {
    const element = input.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return; // our own height change
      width = element.clientWidth;
      fitComposer(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const canSend = writable && canSendWith(draft, attachments.items) && !sending && !restoring && !uncertain && live;

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend || !session || !web.bootstrap) return;
    const text = draft.trim();
    // Captured now: images added while this sends stay in the tray.
    const { keys: sentKeys, ids: images, files, refiled } = captureSend(attachments.items);
    // The resend this send is (captured now: the owner may start another while it is in flight).
    const sentAs = resending;
    const replyTo = replyingTo;
    const requestId = crypto.randomUUID();
    setSending(true); setFeedback("Sending…"); remember(requestId);
    // Sending is the reader's own move: it takes them to the end, wherever they were reading.
    // Claimed before the request goes out: the live stream can show its bubble before the POST returns.
    claim(pendingKey({ requestId }));
    try {
      const request = await sendMessage({ requestId, targetId: session.id, text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(refiled.length ? { refiled } : {}),
        ...(replyTo ? { reply: { text: replyTo.text } } : {}) }, web.bootstrap, web.refreshBootstrap);
      if (sentKeys.length) {
        const taken = attachments.take(sentKeys);
        const pictures = taken.filter((item) => item.kind !== "file"), others = taken.filter((item) => item.kind === "file");
        if (pictures.length || others.length) onSent(requestId, {
          ...(pictures.length ? { images: pictures.map((item) => item.preview) } : {}),
          ...(others.length ? { files: others.map((item) => ({ name: item.file.name, size: item.file.size })) } : {}) });
      }
      web.acceptRequest({ ...request, text, timestamp: Date.now() });
      // Accepted, and it really was that message (or the owner's edit of it):
      // only now does the interrupted one go.
      const replaced = dismissAfterAcceptedSend(sentAs, text, sentKeys);
      if (replaced) void dismiss(replaced, true);
      // Only the resend this was sent as ends; one the owner started while it was sending stays.
      setResending((old) => resendAfterSend(old, sentAs));
      setDraft((old) => old.trim() === text ? "" : old);
      setReplyingTo((old) => old === replyTo ? null : old);
      setFeedback(""); remember(null); onAccepted();
    } catch (err) {
      const failure = sendFailure(err, labels.unknown);
      if (failure.definite) remember(null);
      setFeedback(failure.text, failure.warn);
    } finally { setSending(false); }
  };

  const dismiss = async (requestId: string, quiet = false) => {
    if (!web.bootstrap) return;
    onDismiss();
    try { web.applyRequest(await dismissRequest(requestId, web.bootstrap, web.refreshBootstrap)); }
    catch { if (!quiet) setFeedback("Could not dismiss it yet. It is still kept; try again.", true); }
  };

  /**
   * A tapback on a message: its own request (no text), worded to the agent as
   * an iMessage tapback. It never touches the draft, and the reader stays
   * where they are.
   */
  const react = async (quote: string, reaction: WebReaction, replaces?: string) => {
    if (!writable || !session || !web.bootstrap || !live) return;
    const requestId = crypto.randomUUID();
    try {
      const request = await sendMessage({ requestId, targetId: session.id, text: "", reply: { text: quote, reaction } }, web.bootstrap, web.refreshBootstrap);
      web.acceptRequest({ ...request, text: "", timestamp: Date.now() });
      if (replaces) void dismiss(replaces, true);
      onAccepted();
    } catch (err) { setFeedback(reactFailure(err), true); }
  };

  const reattach = async (paths: string[], restored: { fileKeys: string[]; expected: number; token: number }) => {
    // Every read settles (allSettled-style: each one catches) before the tray or the resend changes.
    const files = await Promise.all(paths.map(async (path, i) => {
      try {
        const response = await fetch(`/api/v1/sessions/${sessionId}/media?path=${encodeURIComponent(path)}`, { credentials: "same-origin" });
        if (!response.ok) return null;
        const blob = await response.blob();
        return new File([blob], path.split("/").at(-1) || `image-${i + 1}`, { type: blob.type });
      } catch { return null; }
    }));
    // Another resend, a cancel or a send since: this result is stale — nothing goes in the tray, nothing changes.
    if (restoreToken.current !== restored.token) return;
    const found = files.filter((file): file is File => !!file);
    const keys = attachments.add(found);
    // Restored: only now may it be sent (and only now can it count as the resend).
    setResending((old) => applyRestored(old, restored.token, keys));
    // A failed read or a full tray: the original stays queued (missingAttachments), and the owner is told.
    const missing = missingAttachments({ requestId: "", original: "", imageKeys: keys, fileKeys: restored.fileKeys, expected: restored.expected });
    if (missing) setFeedback(missingNote(missing), true);
  };

  const resend = (request: WebRequest) => {
    // A tapback is sent again as it was: there is nothing to review.
    if (request.reply?.reaction) { void react(request.reply.text, request.reply.reaction, request.requestId); return; }
    // A new restore: any earlier one still reading is void, and what it put back in the tray goes (as its draft does).
    const token = ++restoreToken.current;
    // Its files come back as they are: already filed, the resend names them by path (nothing is uploaded again).
    // One atomic tray change: the previous resend's items out, this one's files in.
    const fileKeys = attachments.replaceAll([...(resending?.imageKeys ?? []), ...(resending?.fileKeys ?? [])], request.files ?? []);
    const restoringImages = !!request.images?.length;
    const expected = (request.images?.length ?? 0) + (request.files?.length ?? 0);
    setResending({ requestId: request.requestId, original: request.text ?? "", ...(fileKeys.length ? { fileKeys } : {}), ...(restoringImages ? { restoring: true } : {}), ...(expected ? { expected } : {}), token });
    setDraft(request.text ?? ""); input.current?.focus();
    setReplyingTo(request.reply ? { id: "", who: "an earlier message", text: request.reply.text } : null);
    // Its images come back too: read from where they were filed, attached (uploaded) again.
    // Until every one is back, Send stays off — a send now would leave them behind.
    if (restoringImages) void reattach(request.images!, { fileKeys, expected, token });
    setFeedback("Review the message, then send it again. The interrupted one is dismissed once this is accepted.");
  };

  const checkOutcome = async () => {
    if (!uncertain) return;
    try {
      const request = await api<WebRequest>(`/messages/${uncertain}`);
      // The answer goes into the request stream, so the status line shows it
      // live (and follows it to Completed) instead of a frozen copy.
      if (request.sessionId) { web.acceptRequest(request); setFeedback(""); }
      else setFeedback(labels[request.state], request.state !== "completed" && request.state !== "running" && request.state !== "queued");
      // Unknown stays unresolved; refused and interrupted were not answered, so the draft is kept.
      if (request.state !== "unknown") { remember(null); if (request.state !== "refused" && request.state !== "interrupted") setDraft(""); }
      onAccepted();
    } catch { setFeedback("Cannot check yet. Your draft is still here.", true); }
  };

  const stop = async () => {
    if (!web.bootstrap || stopping) return;
    setStopping(true); setFeedback("Stopping…");
    try {
      const { stopped } = await stopTurn(web.bootstrap, web.refreshBootstrap);
      if (!stopped) { setStopping(false); setFeedback("Nothing was running to stop."); }
    } catch { setStopping(false); setFeedback("Could not stop it. Try again.", true); }
  };

  useImperativeHandle(handle, () => ({
    startReply: (message) => {
      setReplyingTo({ id: message.id, who: message.role === "assistant" ? agent : "yourself", text: quoteFor(message) });
      input.current?.focus();
    },
    react: (quote, reaction, replaces) => void react(quote, reaction, replaces),
    resend,
    dismiss: (requestId) => void dismiss(requestId),
    attach: (files) => { attachments.add(files); input.current?.focus(); },
    focus: (options) => input.current?.focus(options),
  }));

  // Stop: offered in place of Send while a turn runs and there is nothing to send.
  const showStop = writable && turnActive && live && !canSendWith(draft, attachments.items) && !sending && !uncertain;
  // The SDK's predicted next message: offered only while the composer is empty and idle.
  const suggestion = writable && !turnActive && !draft && !attachments.items.length && !resending && !uncertain ? web.suggestions[sessionId] : undefined;
  return <div className="mx-auto w-full max-w-[740px]">
    <StatusLine activity={web.activity[sessionId]} note={note} latest={latest} agent={agent} turn={web.turns[sessionId]} turnActive={turnActive} />
    {suggestion && <button type="button" onClick={() => { setDraft(suggestion); input.current?.focus(); }} title="Use this as your message"
      className="motion-enter mb-2 flex max-w-full items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-left text-[12.5px] text-muted-foreground shadow-xs transition-colors hover:border-muted-foreground/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <Sparkles className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" /><span className="truncate">{suggestion}</span></button>}
    {resending && <div className="mb-2 flex items-center gap-2 tracking-[0.02em] text-[11px] text-muted-foreground">
      <Badge variant="outline" className="rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground">Resending an interrupted message</Badge>
      <span role="status" className={cn(missingAttachments(resending) > 0 && "text-destructive")}>{restoring ? "Restoring attachments…"
        : missingAttachments(resending) > 0 ? missingNote(missingAttachments(resending)) : "The original is dismissed once this one is accepted."}</span>
      <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-[11px]" onClick={endResend}>Not a resend</Button></div>}
    <AttachmentTray items={attachments.items} filesOn={filesOn} onRetry={attachments.retry} onRemove={attachments.remove} />
    {attachments.note && <p className="m-0 mb-2 text-[12px] text-muted-foreground" role="status">{attachments.note}</p>}
    {web.credentialRequest && <CredentialCard key={web.credentialRequest.id} request={web.credentialRequest} bootstrap={web.bootstrap} refresh={web.refreshBootstrap} />}
    {replyingTo && writable && <div className="motion-enter mb-2 flex items-center gap-2.5 rounded-2xl border bg-card/70 py-1.5 pr-1.5 pl-3" role="group" aria-label="Replying">
      <Reply className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <div className="min-w-0 flex-1 border-l-2 border-muted-foreground/40 pl-2.5">
        <span className="block text-[10.5px] font-medium tracking-[0.02em] text-muted-foreground">Replying to {replyingTo.who}</span>
        <span className="block truncate text-[12.5px] leading-snug text-foreground/80">{replyingTo.text || "an earlier message"}</span></div>
      <Button type="button" variant="ghost" size="icon" aria-label="Cancel reply" title="Cancel reply (Esc)" onClick={() => { setReplyingTo(null); input.current?.focus(); }}
        className="size-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground"><X className="size-3.5" strokeWidth={2} /></Button></div>}
    <form onSubmit={(e) => void send(e)} className="composer flex items-end gap-1 rounded-[20px] border bg-card p-2.5 shadow-xs transition-[border-color,box-shadow] focus-within:border-muted-foreground/50 focus-within:shadow-md">
      <input ref={fileInput} type="file" {...(filesOn ? {} : { accept: IMAGE_ACCEPT })} multiple hidden
        onChange={(e) => { attachments.add(Array.from(e.target.files ?? [])); e.target.value = ""; input.current?.focus(); }} />
      <Button type="button" variant="ghost" size="icon" aria-label={filesOn ? "Attach files" : "Attach images"}
        title={filesOn ? "Attach photos or files (or drop / paste them)" : uploadsOn ? "Attach images (or drop / paste them)" : "Uploads are off (saveInboundImages and saveInboundFiles are false in config)"} disabled={!canAttach}
        onClick={() => fileInput.current?.click()} className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-[20px]"><Plus strokeWidth={2} /></Button>
      <label className="sr-only" htmlFor="message">Message {agent}</label>
      <Textarea ref={input} id="message" placeholder={session?.kind === "group" ? "This group is read-only" : "What's on your mind?"} value={draft} maxLength={16_000} rows={1} disabled={!writable}
        className="max-h-60 min-h-10 flex-1 resize-none rounded-none border-0 bg-transparent! py-[7px] pr-3 pl-1.5 text-[15px] leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:ring-0 disabled:opacity-80 md:text-[15px]"
        onChange={(e) => { setDraft(e.target.value);
          // Cleared: the resend ends, and so does any restore it still had running.
          if (resending && !resendAfterDraftChange(resending, e.target.value)) endResend(); }} onPaste={(e) => {
          const files = filesOn ? pastedFiles(e.clipboardData?.items) : imageFiles(e.clipboardData?.items);
          if (!files.length || !canAttach) return;
          attachments.add(files);
          // A file on the clipboard is attached; text that came with it still pastes.
          if (!Array.from(e.clipboardData.types).includes("text/plain")) e.preventDefault();
        }} onCompositionStart={() => ime.current.start()} onCompositionEnd={() => ime.current.end()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && replyingTo && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); setReplyingTo(null); return; }
          if (ime.current.shouldSubmit({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
      {showStop ? <Button type="button" size="icon" aria-label={`Stop ${agent}`} title="Stop" aria-busy={stopping} disabled={stopping} onClick={() => void stop()}
        className="size-9 shrink-0 rounded-full bg-foreground text-background transition-[background-color,transform] hover:bg-foreground/85 active:scale-[0.94] disabled:opacity-60 [&_svg:not([class*='size-'])]:size-3.5">
        <Square fill="currentColor" strokeWidth={0} /></Button> :
      <Button type="submit" size="icon" aria-label="Send" aria-busy={sending}
        className="size-9 shrink-0 rounded-full transition-[background-color,transform] hover:bg-primary/85 active:scale-[0.94] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 [&_svg:not([class*='size-'])]:size-[18px]"
        title={restoring ? "Restoring attachments…" : undefined} disabled={!canSend}><ArrowUp strokeWidth={2.2} /></Button>}
    </form>
    {uncertain && !sending && <div className="mt-2 flex flex-wrap gap-2"><Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => void checkOutcome()}>Check message status</Button><Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => { remember(null); setFeedback("Draft kept. Review the conversation before sending it again."); }}>Keep draft for review</Button></div>}
  </div>;
}

/**
 * The status line above the composer. It counts a running tool's seconds
 * itself between the daemon's reports: the per-second tick re-renders this
 * line only.
 */
function StatusLine({ activity, note, latest, agent, turn, turnActive }: Omit<Parameters<typeof composerStatus>[0], "settled" | "now"> & { turnActive: boolean }) {
  const settle = useCompletedSettle(latest);
  const [now, setNow] = useState(() => Date.now());
  const ticking = turnActive && turn?.status.kind === "tool";
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  const input = { activity, note, latest, settled: settle.settled, agent, turn, now };
  return <div className="flex min-h-7 items-baseline gap-3 pb-2">
    <div className={cn("feedback min-w-0 flex-1 tracking-[0.02em] text-xs leading-normal text-muted-foreground tabular-nums transition-opacity duration-200 [overflow-wrap:anywhere]", settle.fading && "opacity-0", composerStatusIsProblem(input) && "text-destructive")} role="status" aria-live="polite">{composerStatus(input)}</div>
  </div>;
}
