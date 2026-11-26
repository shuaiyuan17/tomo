import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import type { WebRequest, WebSession } from "../../src/web/protocol.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Mark } from "./app-header.js";
import { ChatRow, ChatScroller, type ChatScrollerHandle } from "./chat-scroller.js";
import { awaitingOutput, chatRows, rowId } from "./chat-rows.js";
import { Composer, type ComposerHandle } from "./composer.js";
import { DayDivider, HistorySkeleton, LiveReply, parseHistory, PendingMessage, RecordedMessage, ThinkingDots, type RowActions, type SentAttachments } from "./conversation-rows.js";
import { blockKey, interleave, messageKey, pendingKey, type ToolBlock } from "./inline-tools.js";
import { trapTab } from "./layers.js";
import { dayDividers } from "./message-meta.js";
import { resumeDelay, useAppeared } from "./motion.js";
import { pendingUserMessages, recordedReplyIds } from "./pending.js";
import { collectReactions, type ShownReaction } from "./reactions.js";
import { ToolsUnreadableNote, TurnBlock } from "./tool-calls.js";
import { dragHasFiles, imageFiles } from "./uploads.js";
import type { useHistory } from "./use-history.js";
import { useSessionTools } from "./use-session-tools.js";
import type { useWeb } from "./use-web.js";
import { i18n, Trans } from "./i18n/index.js";

type Web = ReturnType<typeof useWeb>;
const NO_REACTIONS: readonly ShownReaction[] = [];
const notice = "rounded-xl border bg-muted/60 px-4 py-3 text-[13px] [&_code]:whitespace-nowrap";

/**
 * The selected conversation: its recorded history with the tool calls
 * between, this tab's pending messages, the reply streaming in, and the
 * composer. On Home it can open beside the room (`panel`): a pinned column
 * on wide screens, a modal layer on narrow ones.
 */
export function Conversation({ web, agent, session, sessionId, ownerConversation, history: loaded, hidden, inert, panel }: {
  web: Web; agent: string; session?: WebSession; sessionId: string;
  /** The owner's own conversation: their bubbles carry read receipts. */ ownerConversation: boolean;
  history: ReturnType<typeof useHistory>;
  hidden: boolean;
  /** Another modal layer (Tasks overlay, phone drawer) is over it. */ inert: boolean;
  panel?: { modal: boolean; onClose: () => void };
}) {
  const { history, status: historyStatus, reload, loadOlder } = loaded;
  const main = useRef<HTMLElement>(null);
  const scroller = useRef<ChatScrollerHandle>(null);
  const composer = useRef<ComposerHandle>(null);
  const group = session?.kind === "group";
  const writable = !!session?.writable;
  const live = web.connection === "live";
  const uploadsOn = web.bootstrap?.capabilities?.uploads !== false; // Off with saveInboundImages: no durable copy to keep with the message.
  const filesOn = web.bootstrap?.capabilities?.files === true; // Any other file: on with saveInboundFiles (filed by path, as iMessage's are).
  const canAttach = writable && live && (uploadsOn || filesOn);

  // Beside the room: Escape closes it. Narrow, it is modal like the Tasks overlay
  // (focus moves in and stays); wide, it is pinned and only takes the composer's focus on opening.
  const panelOpen = !!panel, panelModal = !!panel?.modal;
  const closePanel = useRef(panel?.onClose);
  closePanel.current = panel?.onClose;
  useEffect(() => {
    if (!panelOpen) return;
    // Narrow: the close button, so a phone's keyboard does not jump up over the room.
    if (panelModal) main.current?.querySelector<HTMLElement>("[data-chat-close]")?.focus();
    else if (!main.current?.contains(document.activeElement)) composer.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || inert) return;
      if (event.key === "Escape") {
        if (!panelModal && (event.target as Element | null)?.closest?.("[role=menu], [role=listbox], [role=dialog]")) return;
        event.preventDefault(); closePanel.current?.(); return;
      }
      if (panelModal && event.key === "Tab" && main.current) trapTab(main.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelOpen, panelModal, inert]);

  // Previews of what this tab sent, per request, for its pending bubble.
  const [sent, setSent] = useState<Record<string, SentAttachments>>({});
  const [confirmDismiss, setConfirmDismiss] = useState<string | null>(null);
  // A quoted message briefly highlights when its reply's quote is clicked.
  const [flashId, setFlashId] = useState<string>();
  const messages = useRef(history.messages);
  messages.current = history.messages;
  // One object for the rows' whole life: memoized rows never re-render for a new handler.
  const actions = useMemo<RowActions>(() => ({
    startReply: (message) => composer.current?.startReply(message),
    react: (quote, reaction) => composer.current?.react(quote, reaction),
    resend: (request) => composer.current?.resend(request),
    dismiss: (requestId) => composer.current?.dismiss(requestId),
    confirmDismiss: setConfirmDismiss,
    showMessage: (id) => {
      const message = messages.current.find((m) => m.id === id);
      if (message) scroller.current?.scrollToRow(rowId(message));
      setFlashId(id);
      setTimeout(() => setFlashId((current) => (current === id ? undefined : current)), 1_600);
    },
  }), []);

  /** Files dragged over the chat: "Drop to attach" (only files, only where sending is possible). */
  const [dragging, setDragging] = useState(false);
  const dragProps = {
    onDragEnter: (e: React.DragEvent) => { if (canAttach && dragHasFiles(e.dataTransfer.types)) { e.preventDefault(); setDragging(true); } },
    onDragOver: (e: React.DragEvent) => { if (canAttach && dragHasFiles(e.dataTransfer.types)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (e: React.DragEvent) => {
      if (!canAttach || !dragHasFiles(e.dataTransfer.types)) return;
      e.preventDefault(); setDragging(false);
      const images = imageFiles(e.dataTransfer.items);
      composer.current?.attach(filesOn ? Array.from(e.dataTransfer.files) : images.length ? images : Array.from(e.dataTransfer.files));
    },
  };

  const durable = useMemo(() => recordedReplyIds(history), [history]);
  useEffect(() => { web.discardRecordedBlocks(durable); }, [durable, web.discardRecordedBlocks]);
  const blocks = web.blocks.filter((b) => b.sessionId === sessionId && !durable.has(b.turnId ?? b.requestId));
  const pendingUsers = pendingUserMessages(web.requests, history, sessionId, new Set(Object.keys(sent)));
  const latest = web.requests.filter((r) => r.sessionId === sessionId).at(-1);
  const turnActive = latest?.state === "running" || latest?.state === "queued" || !!web.activity[sessionId];
  // Tool calls, inline: read from the session's transcript back to the oldest
  // loaded message (everything, once the whole history is loaded).
  const toolsSince = historyStatus === "ready" || historyStatus === "loading-older"
    ? (history.nextCursor ? history.messages[0]?.timestamp ?? 0 : 0) : null;
  const tools = useSessionTools(sessionId, toolsSince, web.revision, turnActive, web.onToolEvent);
  const toolsCutoff = history.nextCursor ? toolsSince ?? 0 : 0;
  const timeline = useMemo(() => interleave(history.messages, tools.items, toolsCutoff), [history.messages, tools.items, toolsCutoff]);
  const parsed = useMemo(() => parseHistory(history.messages), [history.messages]);
  const messageIndex = useMemo(() => new Map(history.messages.map((m, i) => [m.id, i])), [history.messages]);
  const requestById = useMemo(() => new Map(web.requests.map((r) => [r.requestId, r])), [web.requests]);
  // Who reacted to what: recorded tapbacks, this page's pending ones, and Tomo's (kept by the daemon).
  const reactions = useMemo(() => collectReactions(history.messages, pendingUserMessages(web.requests, history, sessionId), web.reactions, group),
    [history, web.requests, web.reactions, sessionId, group]);
  // Rows of the scroller (see chat-rows.ts); the running turn's calls and reply ride in the last one.
  const rows = chatRows(timeline.entries, pendingUsers, timeline.trailing.length > 0 || blocks.length > 0);
  // Until the running turn shows a step or a word, dots hold its place under the last message
  // (they ride in its row and never make one: an empty conversation keeps its greeting).
  const thinking = historyStatus !== "loading" && awaitingOutput(turnActive, timeline.trailing.length, blocks.length);
  // A day divider rides at the top of the row it introduces (rows only grow at their ends; see chat-rows.ts).
  // New rows and new reply blocks rise in as they arrive; what the conversation opened with (a load, a
  // reload, "Load earlier") never does. The entrance is the ROW's: a sent message keeps its row from
  // pending bubble to recorded message, so recording it mid-rise swaps the bubble inside, not the animation.
  const settled = historyStatus === "ready" || historyStatus === "loading-older";
  const scope = `${sessionId}:${history.revision ?? ""}`; // A rewritten history is a fresh transcript (as for the scroller below).
  const appearedRows = useAppeared(rows.map((row) => row.id), scope, settled);
  const appearedBlocks = useAppeared(blocks.map((block) => block.id), scope, settled);
  // A reply that was shown streaming in does not rise a second time when it is recorded: the recorded
  // message carries on the entrance its first block began (often still under way: a short reply is
  // recorded a moment after its block shows), or is simply there once that is over. One recorded
  // before any block of it was shown rises as any new message does.
  const streamed = useRef({ scope, shownAt: new Map<string, number>(), resumed: new Map<string, number | null>() });
  if (streamed.current.scope !== scope) streamed.current = { scope, shownAt: new Map(), resumed: new Map() };
  const liveKeys = blocks.map(blockKey).join("\n");
  useEffect(() => {
    const { shownAt } = streamed.current;
    for (const key of liveKeys ? liveKeys.split("\n") : []) if (!shownAt.has(key)) shownAt.set(key, performance.now());
  }, [liveKeys]);
  /** A row's entrance: undefined for none, else its animation-delay in ms (0, or negative to carry one on). */
  const entrance = (row: (typeof rows)[number]): number | undefined => {
    if (!appearedRows.has(row.id)) return undefined;
    const shownAt = row.kind === "message" && row.message.role === "assistant" ? streamed.current.shownAt.get(row.key) : undefined;
    if (shownAt === undefined) return 0;
    // Decided once, when the row first renders: the delay must not move while the animation runs.
    const { resumed } = streamed.current;
    if (!resumed.has(row.id)) resumed.set(row.id, resumeDelay(shownAt, performance.now()));
    return resumed.get(row.id) ?? undefined;
  };
  const dividers = dayDividers(rows.map((row) => row.kind === "message" ? { at: row.message.timestamp } : { at: row.kind === "pending" ? row.request.timestamp : undefined, late: true }));

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  // A turn's step rows (calls, its todo list, its sources) sit close together; the last one keeps the gap before the next message.
  const toolBlock = (block: ToolBlock, running: boolean) => <div key={block.key} data-slot="turn-block" className="mx-auto mb-4 max-w-[740px] has-[+[data-slot=turn-block]]:mb-0.5">
    <TurnBlock block={block} running={running} choices={openGroups} onChoice={(key, value) => setOpenGroups((old) => ({ ...old, [key]: value }))} /></div>;
  const rowProps = { agent, group, writable, live, sessionId, actions, receipts: ownerConversation };
  const pending = (request: WebRequest) => <PendingMessage key={request.requestId} request={request} sent={sent[request.requestId]} reactions={reactions.get(request.requestId) ?? NO_REACTIONS}
    confirming={confirmDismiss === request.requestId} {...rowProps} />;

  return <main ref={main} id="conversation" hidden={hidden} {...dragProps} tabIndex={-1} inert={inert}
    {...(panel ? { "aria-label": i18n.t("common:nav.conversation"), ...(panel.modal ? { role: "dialog", "aria-modal": true } : {}) } : {})}
    // Beside the room: a column on the right (the canvas re-fits to what is left, by its own ResizeObserver);
    // narrow, a sheet over the room from the right, and on a phone a drawer up from the bottom.
    className={panel
      ? "relative flex min-h-0 w-[400px] shrink-0 flex-col overscroll-contain border-l px-4 pt-2 pb-4 max-[1024px]:fixed max-[1024px]:top-(--app-header) max-[1024px]:right-0 max-[1024px]:bottom-0 max-[1024px]:z-30 max-[1024px]:w-[min(440px,92vw)] max-[1024px]:bg-background max-[1024px]:shadow-2xl motion-enter max-[600px]:top-auto max-[600px]:left-0 max-[600px]:h-[min(85dvh,calc(var(--app-height,100dvh)-3rem-env(safe-area-inset-top)-1rem))] max-[600px]:w-full max-[600px]:rounded-t-2xl max-[600px]:border-t max-[600px]:border-l-0 max-[600px]:px-3.5 max-[600px]:pb-[max(0.625rem,env(safe-area-inset-bottom))]"
      : "relative mx-auto flex min-w-0 max-w-[980px] flex-1 flex-col px-10 pt-4 pb-4 max-[1024px]:px-6 max-[800px]:px-5 max-[600px]:min-h-0 max-[600px]:w-full max-[600px]:px-3.5 max-[600px]:pt-2 max-[600px]:pb-[max(0.625rem,env(safe-area-inset-bottom))]"}>
    {panel && <div className="flex shrink-0 items-center justify-between pb-2">
      <h2 className="m-0 text-[13px] font-medium text-muted-foreground">{group ? session!.title : i18n.t("common:nav.conversation")}</h2>
      <Button variant="ghost" size="icon" data-chat-close aria-label={i18n.t("chat:panel.close")} title={i18n.t("chat:panel.closeTitle")} onClick={panel.onClose}
        className="size-8 rounded-lg text-muted-foreground hover:text-foreground"><X strokeWidth={1.75} /></Button></div>}
    {dragging && <div aria-hidden="true" className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/80 text-[15px] font-medium text-foreground motion-enter">
      <span className="flex items-center gap-2"><ImagePlus className="size-5" strokeWidth={1.75} />{i18n.t("chat:composer.drop")}</span></div>}
    {web.bootstrap?.setupRequired && <div className={cn(notice, "mx-auto mb-4 w-full max-w-[740px]")} role="alert"><Trans ns="chat" i18nKey="notice.setup" components={{ code: <code /> }} /></div>}
    {web.connection === "locked" && <div className={cn(notice, "mx-auto mb-4 w-full max-w-[740px]")} role="alert"><Trans ns="chat" i18nKey="notice.locked" components={{ code: <code /> }} /></div>}
    {/* A conversation (and a rewritten history) opens afresh: at its last turn. */}
    <ChatScroller key={scope} handle={scroller} busy={turnActive} lastRowId={rows.at(-1)?.id}
      keys={[...history.messages.map(messageKey), ...pendingUsers.map(pendingKey), ...blocks.map(blockKey)]} top={<>
      {history.nextCursor && <Button variant="outline" size="sm" className="mx-auto mb-6 flex rounded-full text-xs" onClick={() => void loadOlder()} disabled={historyStatus === "loading-older"}>{historyStatus === "loading-older" ? i18n.t("common:state.loading") : i18n.t("chat:history.earlier")}</Button>}
      {!tools.complete && <p className="mx-auto mb-4 max-w-[740px] text-center text-[11.5px] text-muted-foreground" role="note">{i18n.t("chat:history.olderTools")}</p>}
      {tools.unreadable && <ToolsUnreadableNote />}
      {historyStatus === "error" && <div className={cn(notice, "mx-auto mb-4 flex max-w-[740px] items-center gap-3")} role="alert">{i18n.t("chat:history.unavailable")} <Button variant="outline" size="sm" className="rounded-lg" onClick={reload}>{i18n.t("home:retry")}</Button></div>}
      {historyStatus === "loading" && sessionId && <HistorySkeleton label={i18n.t("chat:history.opening")} />}
      {historyStatus === "ready" && history.messages.length === 0 && blocks.length === 0 && pendingUsers.length === 0 && <div className="m-auto flex h-full min-h-56 max-w-md flex-col items-center justify-center pb-12 text-center"><Mark className="mb-4 size-16 stroke-[1.3]" /><h2 className="mt-2 mb-3 font-serif text-[28px] font-normal">{i18n.t("chat:empty.heading")}</h2><p className="m-0 max-w-80 text-sm text-muted-foreground">{group ? i18n.t("chat:empty.group") : i18n.t("chat:empty.body")}</p></div>}
      {/* The first shown row's day, outside the rows: on "Load earlier" only its text changes. */}
      {dividers.first && <DayDivider label={dividers.first} />}
      </>}>
      {rows.map((row, rowIndex) => { const delay = entrance(row); return <ChatRow key={row.id} row={row}>
        {row.kind === "message" && row.tools.map((block) => toolBlock(block, false))}
        {/* One element from pending bubble to recorded message: the entrance plays once, through the swap. */}
        {row.kind !== "live" && <div data-slot="message-entrance" className={delay === undefined ? undefined : "motion-enter"} style={delay ? { animationDelay: `${delay}ms` } : undefined}>
          {row.kind === "pending" ? pending(row.request) : (() => {
            const { message } = row;
            const index = messageIndex.get(message.id)!;
            const request = message.requestId ? requestById.get(message.requestId) : undefined;
            return <RecordedMessage message={message} parsed={parsed[index].parsed} quotedId={parsed[index].quotedId} request={request}
              reactions={reactions.get(message.id) ?? NO_REACTIONS} afterTapback={!!parsed[index - 1]?.parsed.tapback}
              flash={flashId === message.id}
              confirming={!!message.requestId && confirmDismiss === message.requestId} {...rowProps} />;
          })()}</div>}
        {rowIndex === rows.length - 1 && <>
          {timeline.trailing.map((block) => toolBlock(block, turnActive))}
          {blocks.map((block) => <LiveReply key={block.id} block={block} enter={appearedBlocks.has(block.id)} agent={agent} sessionId={sessionId} />)}
          {thinking && <ThinkingDots />}
        </>}
        {/* A change of day: at the END of the earlier row, so no row ever changes at its top. */}
        {dividers.after[rowIndex] && <DayDivider label={dividers.after[rowIndex]!} />}</ChatRow>; })}
    </ChatScroller>
    <Composer handle={composer} web={web} session={session} sessionId={sessionId} agent={agent} latest={latest} turnActive={turnActive}
      canAttach={canAttach} uploadsOn={uploadsOn} filesOn={filesOn} claim={(key) => scroller.current?.claim(key)} onAccepted={reload}
      onSent={(requestId, value) => setSent((old) => ({ ...old, [requestId]: value }))} onDismiss={() => setConfirmDismiss(null)} />
  </main>;
}
