import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, dismissRequest, sendMessage, stopTurn } from "./api.js";
import { useWeb } from "./use-web.js";
import { createCompositionGuard } from "./compose-keys.js";
import { Text } from "./markdown.js";
import { MessageBody } from "./message-body.js";
import { findQuoted, parseReply } from "./reply.js";
import { TasksPanel } from "./tasks-panel.js";
import { PlanUsage } from "./plan-usage.js";
import { CompactButton } from "./compact-button.js";
import { ScheduledSection } from "./scheduled-section.js";
import { useAppeared, useMountedFor } from "./motion.js";
import { runningCount } from "./tasks.js";
import { ArrowUp, ImagePlus, Sparkles, Square, RotateCw, X, BookOpen, ChevronsUpDown, ListChecks, MessageCircle, Monitor, Moon, PanelLeft, Sun, SunMoon } from "lucide-react";
import { Study } from "./study.js";
import { focusFromHash, STUDY_LABELS, viewFromHash, type StudyPage } from "./study-data.js";
import { ScreenWindow } from "./screen.js";
import { awaitingOwner, dismissAfterAcceptedSend, historyBadge, pendingLabel, pendingUserMessages, recordedReplyIds, resendAfterDraftChange, type Resend } from "./pending.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { HistoryPage, WebRequest } from "../../src/web/protocol.js";
import "./styles.css";
import { composerStatus, requestLabels, requestStamp, useCompletedSettle, type ComposerNote } from "./composer-status.js";
import { useRailWidth } from "./rail-width.js";
import { AgentNameContext, agentNameOf } from "./agent-name.js";
import { blockKey, interleave, messageKey, pendingKey, type ToolBlock } from "./inline-tools.js";
import { useSessionTools } from "./use-session-tools.js";
import { ChatRow, ChatScroller, type ChatScrollerHandle } from "./chat-scroller.js";
import { chatRows, rowId } from "./chat-rows.js";
import { ToolsUnreadableNote, TurnBlock } from "./tool-calls.js";
import { useAttachments } from "./use-attachments.js";
import { attachmentLabel, canSendWith, captureSend, dragHasFiles, imageFiles } from "./uploads.js";

type Theme = "system" | "light" | "dark";
/** 503s that mean "not accepted, and why" — the draft stays, nothing ran. */
const refusalReasons: Record<string, string> = {
  interrupted_backlog: "Not sent: messages interrupted by restarts are waiting for you above. Resend or dismiss them first; your draft is kept.",
  journal_unavailable: "Not sent: Tomo cannot read its record of browser messages, so it is not taking new ones. Check the daemon log; your draft is kept.",
  persist_failed: "Not sent: Tomo could not record the message safely. Your draft is kept; try again.",
};


const OVERLAY_QUERY = "(max-width: 800px)";
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
/** Keeps Tab / Shift+Tab inside `container`. */
function trapTab(container: HTMLElement, event: KeyboardEvent) {
  const items = [...container.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.hasAttribute("disabled"));
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  const inside = container.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
}
const COMPOSER_MAX_HEIGHT = 240;
function fitComposer(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
}
function storedTasksOpen(): boolean {
  try { return localStorage.getItem("tomo-tasks-open") === "1"; } catch { return false; }
}
const THEMES = [["system", "System theme", SunMoon], ["light", "Light theme", Sun], ["dark", "Dark theme", Moon]] as const;
function storedTheme(): Theme {
  try { const theme = localStorage.getItem("tomo-theme"); return theme === "light" || theme === "dark" ? theme : "system"; }
  catch { return "system"; }
}
function Mark({ className }: { className?: string }) {
  return <svg className={cn("size-10 shrink-0 fill-none stroke-primary stroke-2 [stroke-linecap:round]", className)} viewBox="0 0 40 40" aria-hidden="true"><path d="M 32 14 C 36 20, 32 32, 20 32 C 8 32, 5 22, 10 14 C 14 7, 26 6, 30 12" /></svg>;
}

function useStudyRoute(): [StudyPage | null, (page: StudyPage | null) => void, string | null] {
  const [page, setPage] = useState(() => viewFromHash(window.location.hash));
  const [focus, setFocus] = useState(() => focusFromHash(window.location.hash));
  useEffect(() => {
    const update = () => { setPage(viewFromHash(window.location.hash)); setFocus(focusFromHash(window.location.hash)); };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return [page, (next) => { window.location.hash = next ? `study/${next}` : ""; if (!next) history.replaceState(null, "", window.location.pathname + window.location.search); setPage(next); setFocus(null); }, focus];
}

export function App() {
  const web = useWeb();
  const agent = agentNameOf(web.bootstrap?.agentName);
  const labels = requestLabels(agent);
  const [study, setStudy, studyFocus] = useStudyRoute();
  const [screenOpen, setScreenOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const selectedId = selected || web.bootstrap?.ownerId || web.bootstrap?.sessions[0]?.id || "";
  const session = web.bootstrap?.sessions.find((s) => s.id === selectedId);
  // The screen is the owner's: offered only with the owner conversation selected.
  const screenAllowed = !!web.bootstrap?.capabilities?.screen && session?.kind !== "group";
  const screen = screenOpen && screenAllowed;
  const screenButton = useRef<HTMLButtonElement>(null);
  const closeScreen = () => { setScreenOpen(false); screenButton.current?.focus(); };
  const [history, setHistory] = useState<HistoryPage>({ messages: [], nextCursor: null });
  const [historyStatus, setHistoryStatus] = useState("loading");
  const [reload, setReload] = useState(0);
  const historySession = useRef("");
  const scroller = useRef<ChatScrollerHandle>(null);
  const [draft, setDraft] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  /** Previews of images this tab sent, per request, for its pending bubble. */
  const [sentImages, setSentImages] = useState<Record<string, string[]>>({});
  const attachments = useAttachments(web.bootstrap, web.refreshBootstrap, session?.writable ? session.id : undefined);
  // Off with saveInboundImages: there would be no durable copy to keep with the message.
  const uploadsOn = web.bootstrap?.capabilities?.uploads !== false;
  const canAttach = !!session?.writable && web.connection === "live" && uploadsOn;
  /** Files dragged over the chat: "Drop to attach" (only files, only where sending is possible). */
  const dragProps = {
    onDragEnter: (e: React.DragEvent) => { if (canAttach && dragHasFiles(e.dataTransfer.types)) { e.preventDefault(); setDragging(true); } },
    onDragOver: (e: React.DragEvent) => { if (canAttach && dragHasFiles(e.dataTransfer.types)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (e: React.DragEvent) => {
      if (!canAttach || !dragHasFiles(e.dataTransfer.types)) return;
      e.preventDefault(); setDragging(false);
      attachments.add(imageFiles(e.dataTransfer.items).length ? imageFiles(e.dataTransfer.items) : Array.from(e.dataTransfer.files));
      input.current?.focus();
    },
  };
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState<string | null>(() => {
    try { return sessionStorage.getItem("tomo-pending-request"); } catch { return null; }
  });
  // One-off notes for the status line, stamped with where the latest request
  // stood; composerStatus drops a note as soon as the request moves on.
  const [note, setNote] = useState<ComposerNote>({ text: "", at: "" });
  const stamp = useRef("");
  const setFeedback = (text: string) => setNote({ text, at: stamp.current });
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [tasksOpen, setTasksOpen] = useState(storedTasksOpen);
  useEffect(() => {
    try { localStorage.setItem("tomo-tasks-open", tasksOpen ? "1" : "0"); } catch { /* Storage can be unavailable. */ }
  }, [tasksOpen]);
  const running = runningCount(web.tasks);
  const tasksButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // A quoted message briefly highlights when its reply's quote is clicked.
  const [flashId, setFlashId] = useState<string>();
  const showMessage = (id: string) => {
    const message = history.messages.find((m) => m.id === id);
    if (message) scroller.current?.scrollToRow(rowId(message));
    setFlashId(id);
    setTimeout(() => setFlashId((current) => (current === id ? undefined : current)), 1_600);
  };
  const ime = useRef(createCompositionGuard());
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
  const rail = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const overlay = useMediaQuery(OVERLAY_QUERY);
  const phone = useMediaQuery("(max-width: 600px)");
  // Drag-to-resize for the Tasks rail; wide screens only (the narrow overlay keeps its width).
  const railSize = useRailWidth({ enabled: !overlay, sidebar: () => sidebar.current?.offsetWidth ?? 272 });
  // The rail stays mounted through its closing transition (see motion.ts).
  const railMotion = useMountedFor(tasksOpen);
  const tasksModal = tasksOpen && overlay && railMotion.mounted;
  const closeTasks = () => { setTasksOpen(false); tasksButton.current?.focus(); };
  // Phone width: the sidebar (navigation, conversation picker, context,
  // plan usage, theme) is a drawer behind a button at the top left, so the
  // chat has the whole screen. It is a modal layer like the Tasks overlay;
  // only one of the two is open at a time.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = phone && menuOpen;
  const drawerMotion = useMountedFor(drawer);
  const closeMenu = (refocus = true) => { setMenuOpen(false); if (refocus) menuButton.current?.focus(); };
  const modal = tasksModal || drawer;
  useEffect(() => {
    if (!drawer) return;
    sidebar.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeMenu(); return; }
      if (event.key === "Tab" && sidebar.current) trapTab(sidebar.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);
  // On narrow screens the rail is a modal layer: focus moves into it, stays
  // there (the content under it is inert), and Escape anywhere closes it,
  // returning focus to the topbar button. A pinned desktop rail is not modal.
  useEffect(() => {
    if (!tasksModal) return;
    rail.current?.querySelector<HTMLElement>("[data-tasks-close]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeTasks(); return; }
      if (event.key === "Tab" && rail.current) trapTab(rail.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tasksModal]);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && systemDark));
    try { localStorage.setItem("tomo-theme", theme); } catch { /* Storage can be unavailable. */ }
  }, [theme, systemDark]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    if (historySession.current !== selectedId) {
      historySession.current = selectedId;
      setHistory({ messages: [], nextCursor: null }); setHistoryStatus("loading");
    }
    void api<HistoryPage>(`/sessions/${selectedId}/messages`, { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setHistory((old) => {
        if (old.revision !== value.revision) return value;
        const fresh = new Set(value.messages.map((m) => m.id));
        return { revision: value.revision, messages: [...old.messages.filter((m) => !fresh.has(m.id)), ...value.messages],
          nextCursor: old.messages.length > 100 ? old.nextCursor : value.nextCursor };
      });
      setHistoryStatus("ready");
    }).catch(() => { if (!controller.signal.aborted) setHistoryStatus("error"); });
    return () => controller.abort();
  }, [selectedId, web.revision, reload]);


  useEffect(() => {
    web.discardRecordedBlocks(recordedReplyIds(history));
  }, [history, web.discardRecordedBlocks]);

  const remember = (id: string | null) => {
    setUncertain(id);
    try { if (id) sessionStorage.setItem("tomo-pending-request", id); else sessionStorage.removeItem("tomo-pending-request"); } catch { /* Optional recovery hint. */ }
  };
  // New messages rise in as they arrive (not on load). Web-sent ones were
  // already shown as a pending bubble / streamed block, so they don't again.
  const appeared = useAppeared(history.messages.map((m) => m.id), selectedId, historyStatus === "ready");
  const webRequestIds = new Set(web.requests.map((r) => r.requestId));
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!session?.writable || !canSendWith(draft, attachments.items) || sending || uncertain || !web.bootstrap || web.connection !== "live") return;
    const text = draft.trim();
    // Captured now: images added while this sends stay in the tray.
    const { keys: sentKeys, ids: images } = captureSend(attachments.items);
    const requestId = crypto.randomUUID();
    setSending(true); setFeedback("Sending…"); remember(requestId);
    // Sending is the reader's own move: it takes them to the end, wherever they were reading.
    // Claimed before the request goes out: the live stream can show its bubble before the POST returns.
    scroller.current?.claim(pendingKey({ requestId }));
    try {
      const request = await sendMessage({ requestId, targetId: session.id, text, ...(images.length ? { images } : {}) }, web.bootstrap, web.refreshBootstrap);
      if (images.length) { const taken = attachments.take(sentKeys); setSentImages((old) => ({ ...old, [requestId]: taken.map((item) => item.preview) })); }
      web.acceptRequest({ ...request, text, timestamp: Date.now() });
      // Accepted, and it really was that message (or the owner's edit of it):
      // only now does the interrupted one go.
      const replaced = dismissAfterAcceptedSend(resending, text, sentKeys);
      if (replaced) void dismiss(replaced, true);
      setResending(null);
      setDraft((old) => old.trim() === text ? "" : old);
      setFeedback(""); remember(null); setReload((r) => r + 1);
    } catch (err) {
      // Definite refusals the daemon names (nothing was accepted), not network uncertainty.
      const refusal = err instanceof ApiError && err.status === 503 ? refusalReasons[err.code] : undefined;
      if (refusal) { remember(null); setFeedback(refusal); }
      else if (err instanceof ApiError && [400, 401, 403, 409, 413, 415, 429].includes(err.status)) {
        remember(null);
        setFeedback(err.status === 413 ? "Message is too large. Shorten it and send again; your draft is kept."
          : err.status === 401 ? "Open the private link in web-access.log to reconnect. Your draft is kept."
          : err.code === "owner_dm_only" ? "Group conversations are read-only."
          : err.code === "upload_missing" ? "An attached image expired before it was sent. Remove it and attach it again; your draft is kept." : "Message was not accepted. Your draft is saved here; reconnect or check web settings.");
      } else setFeedback(labels.unknown);
    } finally { setSending(false); }
  };
  const reattach = async (paths: string[]) => {
    const files = await Promise.all(paths.map(async (path, i) => {
      try {
        const response = await fetch(`/api/v1/sessions/${selectedId}/media?path=${encodeURIComponent(path)}`, { credentials: "same-origin" });
        if (!response.ok) return null;
        const blob = await response.blob();
        return new File([blob], path.split("/").at(-1) || `image-${i + 1}`, { type: blob.type });
      } catch { return null; }
    }));
    const found = files.filter((file): file is File => !!file);
    const keys = attachments.add(found);
    setResending((old) => old && { ...old, imageKeys: keys });
    if (found.length < paths.length) setFeedback("Some of its images could not be read back; attach them again before sending.");
  };
  /** Interrupted request being resent from the composer (dismissed once the resend is accepted). */
  const [resending, setResending] = useState<Resend | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState<string | null>(null);
  const dismiss = async (requestId: string, quiet = false) => {
    if (!web.bootstrap) return;
    setConfirmDismiss(null);
    try { web.applyRequest(await dismissRequest(requestId, web.bootstrap, web.refreshBootstrap)); }
    catch { if (!quiet) setFeedback("Could not dismiss it yet. It is still kept; try again."); }
  };
  const resend = (request: WebRequest) => {
    setResending({ requestId: request.requestId, original: request.text ?? "" });
    setDraft(request.text ?? ""); input.current?.focus();
    // Its images come back too: read from where they were filed, attached (uploaded) again.
    if (request.images?.length) void reattach(request.images);
    setFeedback("Review the message, then send it again. The interrupted one is dismissed once this is accepted.");
  };
  /** Resend / Dismiss for an interrupted request awaiting the owner, on its bubble (history or pending). */
  const interruptedActions = (request: WebRequest | undefined) => request && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <span>Not answered. {agent} may have started on it — check before resending.</span>
    <Button variant="outline" size="sm" className="h-7 rounded-lg text-xs" onClick={() => resend(request)} disabled={!session?.writable}>Resend…</Button>
    {confirmDismiss === request.requestId
      ? <><Button variant="outline" size="sm" className="h-7 rounded-lg text-xs" onClick={() => void dismiss(request.requestId)}>Dismiss it</Button>
        <Button variant="ghost" size="sm" className="h-7 rounded-lg text-xs" onClick={() => setConfirmDismiss(null)}>Keep</Button></>
      : <Button variant="ghost" size="sm" className="h-7 rounded-lg text-xs" onClick={() => setConfirmDismiss(request.requestId)}>Dismiss</Button>}
  </div>;
  const checkOutcome = async () => {
    if (!uncertain) return;
    try {
      const request = await api<WebRequest>(`/messages/${uncertain}`);
      // The answer goes into the request stream, so the status line shows it
      // live (and follows it to Completed) instead of a frozen copy.
      if (request.sessionId) { web.acceptRequest(request); setFeedback(""); }
      else setFeedback(labels[request.state]);
      // Unknown stays unresolved; refused and interrupted were not answered, so the draft is kept.
      if (request.state !== "unknown") { remember(null); if (request.state !== "refused" && request.state !== "interrupted") setDraft(""); }
      setReload((r) => r + 1);
    } catch { setFeedback("Cannot check yet. Your draft is still here."); }
  };
  const older = async () => {
    if (!history.nextCursor || historyStatus === "loading-older") return;
    const target = selectedId;
    setHistoryStatus("loading-older");
    try {
      const value = await api<HistoryPage>(`/sessions/${target}/messages?cursor=${encodeURIComponent(history.nextCursor)}`);
      if (historySession.current !== target) return;
      setHistory((old) => ({ revision: value.revision, messages: [...value.messages.filter((m) => !old.messages.some((item) => item.id === m.id)), ...old.messages], nextCursor: value.nextCursor }));
      setHistoryStatus("ready");
    } catch (error) {
      if (historySession.current !== target) return;
      if (error instanceof ApiError && error.status === 409 && error.code === "history_changed") {
        setHistory({ messages: [], nextCursor: null }); setHistoryStatus("loading");
        setReload((value) => value + 1);
      } else setHistoryStatus("error");
    }
  };
  const durable = recordedReplyIds(history);
  const blocks = web.blocks.filter((b) => b.sessionId === selectedId && !durable.has(b.turnId ?? b.requestId));
  const pendingUsers = pendingUserMessages(web.requests, history, selectedId, new Set(Object.keys(sentImages)));
  const latest = web.requests.filter((r) => r.sessionId === selectedId).at(-1);
  const settle = useCompletedSettle(latest);
  // Tool calls, inline: read from the session's transcript back to the oldest
  // loaded message (everything, once the whole history is loaded).
  const toolsSince = historyStatus === "ready" || historyStatus === "loading-older"
    ? (history.nextCursor ? history.messages[0]?.timestamp ?? 0 : 0) : null;
  const turnActive = latest?.state === "running" || latest?.state === "queued" || !!web.activity[selectedId];
  const tools = useSessionTools(selectedId, toolsSince, (web.toolTicks[selectedId] ?? 0) * 1_000_003 + web.revision, turnActive);
  const timeline = interleave(history.messages, tools.items, history.nextCursor ? toolsSince ?? 0 : 0);
  const messageIndex = new Map(history.messages.map((m, i) => [m.id, i]));
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  // A turn's step rows (calls, its todo list, its sources) sit close together; the last one keeps the gap before the next message.
  const toolBlock = (block: ToolBlock, running: boolean) => <div key={block.key} data-slot="turn-block" className="mx-auto mb-4 max-w-[740px] has-[+[data-slot=turn-block]]:mb-0.5">
    <TurnBlock block={block} running={running} choices={openGroups} onChoice={(key, value) => setOpenGroups((old) => ({ ...old, [key]: value }))} /></div>;
  // Rows of the scroller (see chat-rows.ts); the running turn's calls and reply ride in the last one.
  const rows = chatRows(timeline.entries, pendingUsers, timeline.trailing.length > 0 || blocks.length > 0);
  useEffect(() => { stamp.current = requestStamp(latest); });
  // The status line counts a running tool's seconds itself between the daemon's reports.
  const turn = web.turns[selectedId];
  const [now, setNow] = useState(() => Date.now());
  const ticking = turnActive && turn?.status.kind === "tool";
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  // Stop: offered in place of Send while a turn runs and there is nothing to send.
  const [stopping, setStopping] = useState(false);
  const canStop = !!session?.writable && turnActive && web.connection === "live";
  const showStop = canStop && !canSendWith(draft, attachments.items) && !sending && !uncertain;
  useEffect(() => { if (!turnActive) setStopping(false); }, [turnActive]);
  const stop = async () => {
    if (!web.bootstrap || stopping) return;
    setStopping(true); setFeedback("Stopping…");
    try {
      const { stopped } = await stopTurn(web.bootstrap, web.refreshBootstrap);
      if (!stopped) { setStopping(false); setFeedback("Nothing was running to stop."); }
    } catch { setStopping(false); setFeedback("Could not stop it. Try again."); }
  };
  // The SDK's predicted next message: offered only while the composer is empty and idle.
  const suggestion = session?.writable && !turnActive && !draft && !attachments.items.length && !resending && !uncertain ? web.suggestions[selectedId] : undefined;
  const usage = session?.stats;
  const hasContext = !!usage?.contextMax;
  const sessions = web.bootstrap?.sessions ?? [];
  const connectionLabel = web.connection === "live" ? "Connected" : web.connection === "locked" ? "Access link required" : web.connection === "connecting" ? "Connecting…" : "Reconnecting…";
  const notice = "rounded-xl border bg-muted/60 px-4 py-3 text-[13px]";
  return <AgentNameContext.Provider value={agent}><div className="flex h-dvh flex-col">
    <a className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-card focus:p-3" href={study ? "#study" : "#conversation"} onClick={(e) => { e.preventDefault(); document.getElementById(study ? "study" : "conversation")?.focus(); }}>{study ? `Skip to ${STUDY_LABELS[study]}` : "Skip to conversation"}</a>
    <header className="flex h-[72px] shrink-0 items-center gap-8 border-b px-8 max-[1024px]:px-6 max-[600px]:h-12 max-[600px]:gap-3 max-[600px]:px-3.5 max-[600px]:pt-[env(safe-area-inset-top)] max-[600px]:box-content">
      <Button ref={menuButton} variant="ghost" size="icon" aria-expanded={drawer} aria-controls="sidebar" title="Menu" aria-label="Menu: conversations, the Study, usage and theme"
        onClick={() => { setTasksOpen(false); setMenuOpen((open) => !open); }}
        className="-ml-1.5 hidden size-9 shrink-0 rounded-xl text-foreground hover:bg-foreground/[0.07] aria-expanded:bg-foreground/[0.11] max-[600px]:inline-flex [&_svg:not([class*='size-'])]:size-5"><PanelLeft strokeWidth={1.75} /></Button>
      <a className="flex items-center gap-2 font-serif text-[30px] tracking-[-1.5px] text-foreground no-underline max-[600px]:gap-1.5 max-[600px]:text-[22px] max-[600px]:tracking-[-1px]" href="/" aria-label="Tomo home">
        <Mark className="size-9 max-[600px]:size-7" /><span>tomo<span className="text-primary">.</span></span></a>
      <span className="border-l pl-8 text-sm text-muted-foreground max-[800px]:hidden">{study ? "The Study" : "Conversation"}</span>
      <div className="ml-auto flex items-center gap-4 max-[600px]:gap-1">
        <Button ref={tasksButton} variant="ghost" size="icon" aria-pressed={tasksOpen} aria-controls="tasks-rail" title="Tasks"
          aria-label={`Tasks${running ? `, ${running} running` : ""}`} onClick={() => { setMenuOpen(false); setTasksOpen((open) => !open); }}
          className="relative size-10 rounded-xl text-foreground max-[600px]:size-9 hover:bg-foreground/[0.07] aria-pressed:bg-foreground/[0.11] aria-pressed:hover:bg-foreground/[0.14] [&_svg:not([class*='size-'])]:size-5">
          <ListChecks strokeWidth={1.75} />
          {running > 0 && <span aria-hidden="true" className="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground ring-2 ring-background">{running > 99 ? "99+" : running}</span>}
        </Button>
        {screenAllowed && <Button ref={screenButton} variant="ghost" size="icon" aria-pressed={screen} aria-controls="screen-window" title="Screen"
          aria-label="Screen (read-only live view)" onClick={() => screen ? closeScreen() : setScreenOpen(true)}
          className="size-10 rounded-xl text-foreground max-[600px]:size-9 hover:bg-foreground/[0.07] aria-pressed:bg-foreground/[0.11] aria-pressed:hover:bg-foreground/[0.14] [&_svg:not([class*='size-'])]:size-5">
          <Monitor strokeWidth={1.75} /></Button>}
        <span role="status" className="flex items-center gap-2 tracking-[0.02em] text-xs text-muted-foreground">
          <i className={cn("size-1.5 rounded-full border border-muted-foreground", web.connection === "live" && "border-primary bg-primary")} />
          <span className="max-[600px]:sr-only">{connectionLabel}</span></span>
      </div>
    </header>
    <div className="flex min-h-0 flex-1">
      {phone && drawerMotion.mounted && <div aria-hidden="true" onClick={() => closeMenu()} data-state={drawerMotion.shown ? "open" : "closed"}
        className="fixed inset-0 top-[calc(3rem+env(safe-area-inset-top))] z-20 bg-black/20 transition-opacity duration-[220ms] data-[state=closed]:opacity-0" />}
      <aside ref={sidebar} id="sidebar" data-state={drawer ? "open" : "closed"} {...(drawer ? { role: "dialog", "aria-modal": true } : {})}
        className="flex w-[272px] shrink-0 flex-col gap-1 overflow-y-auto border-r px-6 py-8 [scrollbar-width:thin] max-[1024px]:w-[232px] max-[1024px]:px-5 max-[800px]:w-[204px] max-[800px]:px-4 max-[600px]:fixed max-[600px]:top-[calc(3rem+env(safe-area-inset-top))] max-[600px]:bottom-0 max-[600px]:left-0 max-[600px]:z-30 max-[600px]:w-[min(320px,86vw)] max-[600px]:bg-background max-[600px]:px-5 max-[600px]:pt-5 max-[600px]:pb-[max(1.25rem,env(safe-area-inset-bottom))] max-[600px]:shadow-2xl max-[600px]:transition-transform max-[600px]:duration-[220ms] max-[600px]:data-[state=closed]:-translate-x-full max-[600px]:data-[state=closed]:shadow-none"
        aria-label="Conversation details" inert={tasksModal || (phone && !drawer)} aria-hidden={phone && !drawer ? true : undefined}>
        <nav aria-label="Workspace" className="mb-7 flex flex-col gap-0.5">
          {([[null, "Conversation", MessageCircle], ["todos", "The Study", BookOpen]] as const).map(([target, label, Icon]) => {
            const current = target === null ? !study : !!study;
            return <Button key={label} variant="ghost" aria-current={current ? "page" : undefined} onClick={() => { setStudy(target === null ? null : study ?? target); if (drawer) closeMenu(false); }}
              className="h-9 justify-start gap-2.5 rounded-xl px-3 text-[13px] font-normal text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground aria-[current=page]:bg-foreground/[0.08] aria-[current=page]:font-medium aria-[current=page]:text-foreground max-[600px]:h-10 max-[600px]:text-[14px]">
              <Icon strokeWidth={1.75} /><span>{label}</span></Button>;
          })}
        </nav>
        <p className="eyebrow mb-3">Your conversations</p>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span id="session-label" className="text-[13px] font-medium">Session</span>
          <Badge variant="outline" className="rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground">{session?.kind === "group" ? "Read-only" : "Owner DM"}</Badge>
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild disabled={!sessions.length}>
            <Button variant="outline" aria-labelledby="session-label session-value"
              className="h-11 w-full min-w-0 justify-between rounded-xl bg-card px-3.5 text-[13px] font-normal shadow-xs hover:bg-accent">
              <span id="session-value" className="truncate">{session ? `${session.title}${session.kind === "group" ? " · read-only" : ""}` : "No session available"}</span>
              <ChevronsUpDown className="text-muted-foreground" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-xl p-1">
            <DropdownMenuLabel className="px-2 py-1.5 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Conversations</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={selectedId} onValueChange={(value) => { setSelected(value); setFeedback(""); if (drawer) closeMenu(false); }}>
              {sessions.map((s) => <DropdownMenuRadioItem key={s.id} value={s.id} className="rounded-lg py-2 text-[13px]">
                <span className="truncate">{s.title}</span>{s.kind === "group" && <span className="ml-auto pl-3 tracking-[0.02em] text-[10px] text-muted-foreground">read-only</span>}
              </DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{session?.kind === "group" ? "Shared history. Messages can be sent from the group's messaging channel." : `The same conversation you share with ${agent} across your messaging channels.`}</p>
        <section className="mt-8 border-t pt-7" aria-labelledby="context-heading">
          <div className="mb-3 flex items-center justify-between gap-2"><p className="eyebrow m-0" id="context-heading">Context window</p>
            <CompactButton bootstrap={web.bootstrap} refresh={web.refreshBootstrap} ownerSession={!!session && session.id === web.bootstrap?.ownerId}
              running={web.tasks.filter((t) => t.sessionId === web.bootstrap?.ownerId && t.state === "running" && !t.ambient).length}
              request={web.compact} /></div>
          <p className="mb-3 text-lg tabular-nums">{hasContext ? <>{usage!.contextUsed.toLocaleString()} <span className="text-xs text-muted-foreground">/ {usage!.contextMax.toLocaleString()}</span></> : "Unavailable"}</p>
          {hasContext && <Progress max={usage!.contextMax} value={Math.min(usage!.contextUsed, usage!.contextMax)} aria-label="Context tokens used" className="h-1.5 bg-border" />}
          <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{hasContext ? `${usage?.contextEstimated ? "Estimated" : "Reported"} tokens · last recorded turn` : "Usage appears after a turn reports its context window."}</p>
        </section>
        <PlanUsage ready={!!web.bootstrap} live={web.rateLimit} />
        {/* Theme: pinned to the bottom of the sidebar (and of the phone drawer). */}
        <div className="mt-auto flex items-center justify-between gap-3 border-t pt-4 max-[600px]:mt-8">
          <span className="eyebrow">Theme</span>
          <ToggleGroup type="single" aria-label="Color theme" value={theme} onValueChange={(value) => { if (value) setTheme(value as Theme); }}
            className="rounded-xl bg-foreground/[0.05] p-0.5">
            {THEMES.map(([value, label, Icon]) =>
              <ToggleGroupItem key={value} value={value} aria-label={label} title={label}
                className="size-7 rounded-[9px]! px-0 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-foreground/[0.13] [&_svg:not([class*='size-'])]:size-3.5">
                <Icon strokeWidth={1.75} /></ToggleGroupItem>)}
          </ToggleGroup>
        </div>
      </aside>
      {study && <Study page={study} onPage={(page) => setStudy(page)} session={session} reload={web.revision} inert={modal} focus={studyFocus} cronRevision={web.cronRevision}
        mutator={{ bootstrap: web.bootstrap, refresh: web.refreshBootstrap, live: web.connection === "live" }} />}
      <main id="conversation" hidden={!!study} {...dragProps} className="relative mx-auto flex min-w-0 max-w-[980px] flex-1 flex-col px-12 pt-6 pb-6 max-[1024px]:px-7 max-[800px]:px-5 max-[600px]:min-h-0 max-[600px]:w-full max-[600px]:px-3.5 max-[600px]:pt-2 max-[600px]:pb-[max(0.625rem,env(safe-area-inset-bottom))]" tabIndex={-1} inert={modal}>
        {dragging && <div aria-hidden="true" className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/80 text-[15px] font-medium text-foreground motion-enter">
          <span className="flex items-center gap-2"><ImagePlus className="size-5" strokeWidth={1.75} />Drop to attach</span></div>}
        {web.bootstrap?.setupRequired && <div className={cn(notice, "mx-auto mb-4 w-full max-w-[740px]")} role="alert">Choose an owner in <code>web.ownerIdentity</code> and restart Tomo. An unambiguous owner is required to chat.</div>}
        {web.connection === "locked" && <div className={cn(notice, "mx-auto mb-4 w-full max-w-[740px]")} role="alert">Open the access link in Tomo's private <code>web-access.log</code> to connect. The link includes your private access token.</div>}
        {/* A conversation (and a rewritten history) opens afresh: at its last turn. */}
        <ChatScroller key={`${selectedId}:${history.revision ?? ""}`} handle={scroller} busy={turnActive} lastRowId={rows.at(-1)?.id}
          keys={[...history.messages.map(messageKey), ...pendingUsers.map(pendingKey), ...blocks.map(blockKey)]} top={<>
          {history.nextCursor && <Button variant="outline" size="sm" className="mx-auto mb-6 flex rounded-full text-xs" onClick={() => void older()} disabled={historyStatus === "loading-older"}>{historyStatus === "loading-older" ? "Loading…" : "Load earlier messages"}</Button>}
          {!tools.complete && <p className="mx-auto mb-4 max-w-[740px] text-center text-[11.5px] text-muted-foreground" role="note">Older tool calls not shown</p>}
          {tools.unreadable && <ToolsUnreadableNote />}
          {historyStatus === "error" && <div className={cn(notice, "mx-auto mb-4 flex max-w-[740px] items-center gap-3")} role="alert">History is unavailable. <Button variant="outline" size="sm" className="rounded-lg" onClick={() => setReload((r) => r + 1)}>Try again</Button></div>}
          {historyStatus === "loading" && selectedId && <p className="text-center text-sm text-muted-foreground" role="status">Opening your conversation…</p>}
          {historyStatus === "ready" && history.messages.length === 0 && blocks.length === 0 && pendingUsers.length === 0 && <div className="m-auto flex h-full min-h-56 max-w-md flex-col items-center justify-center pb-12 text-center"><Mark className="mb-4 size-16 stroke-[1.3]" /><h2 className="mt-2 mb-3 font-serif text-[28px] font-normal">Start wherever you are.</h2><p className="m-0 max-w-80 text-sm text-muted-foreground">{session?.kind === "group" ? "There are no recorded messages in this group yet." : "A question, a half-formed idea, or something on your mind."}</p></div>}
          </>}>
          {rows.map((row, rowIndex) => <ChatRow key={row.id} row={row}>{row.kind === "message" && <>{row.tools.map((block) => toolBlock(block, false))}{(() => {
            const message = row.message; const index = messageIndex.get(message.id)!;
            const { reply, body } = parseReply(message.content); const quoted = reply && findQuoted(history.messages, index, reply);
            return <article id={`msg-${message.id}`} className={cn(`message ${message.role} mx-auto mb-7 max-w-[740px] rounded-2xl transition-[background-color,box-shadow] duration-700`, appeared.has(message.id) && !webRequestIds.has(message.requestId ?? "") && "motion-enter", flashId === message.id && "bg-primary/10 shadow-[0_0_0_8px_color-mix(in_srgb,var(--primary)_10%,transparent)]")} key={message.id}>
            <div className="mb-2 flex items-baseline gap-3 tracking-[0.02em] text-[11px] text-muted-foreground"><span className="font-sans text-[13px] font-semibold text-foreground">{message.role === "assistant" ? agent : message.role === "user" ? (session?.kind === "group" ? "Participant" : "You") : "System"}</span><time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>{message.channel === "web" ? "Web" : message.channel}</span>
              {message.role === "user" && historyBadge(message.requestId, web.requests) && <Badge variant="outline" className="self-center rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground">{historyBadge(message.requestId, web.requests)}</Badge>}</div>
            <div className={cn("markdown", message.role === "user" && "rounded-2xl rounded-tl-md bg-secondary px-5 py-3.5", message.role === "assistant" && "reading")}>
              {message.role === "assistant" && body.trim() === "NO_REPLY"
                // A turn that ended without a reply (silent by choice, or stopped): said plainly, not as the agent's words.
                ? <p className="m-0 font-sans text-[12.5px] text-muted-foreground">No reply</p>
                : <MessageBody body={body} reply={reply} sessionId={selectedId} onQuote={quoted ? () => showMessage(quoted.id) : undefined} thinking={message.role === "assistant" ? "joined" : undefined} />}</div>
            {message.role === "user" && interruptedActions(web.requests.find((r) => r.requestId === message.requestId && awaitingOwner(r)))}</article>; })()}</>}
          {row.kind === "pending" && ((request: WebRequest) => <article className="message user motion-enter mx-auto mb-7 max-w-[740px]" data-request-id={request.requestId} key={request.requestId}>
            <div className="mb-2 flex items-baseline gap-3 tracking-[0.02em] text-[11px] text-muted-foreground"><span className="font-sans text-[13px] font-semibold text-foreground">You</span><span>Web</span>
              <Badge variant="outline" className="self-center rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground">{pendingLabel(request)}</Badge></div>
            {!sentImages[request.requestId] && request.images?.length ? <div className="mb-2 opacity-80"><MessageBody sessionId={selectedId}
              body={`[Sent ${request.images.length === 1 ? "an image" : `${request.images.length} images`}, saved to: ${request.images.join(", ")}]`} /></div> : null}
            {sentImages[request.requestId] && <div className="mb-2 flex flex-wrap gap-2 opacity-80">{sentImages[request.requestId].map((src, i) =>
              <img key={i} src={src} alt="Image" className="block max-h-[280px] max-w-[280px] rounded-xl border object-contain" />)}</div>}
            {request.text && <div className="markdown rounded-2xl rounded-tl-md bg-secondary px-5 py-3.5 opacity-80"><Text breaks>{request.text}</Text></div>}
            {interruptedActions(awaitingOwner(request) ? request : undefined)}</article>)(row.request)}
          {rowIndex === rows.length - 1 && <>
          {timeline.trailing.map((block) => toolBlock(block, turnActive))}
          {blocks.map((block) => <article className="message assistant motion-enter mx-auto mb-7 max-w-[740px]" key={block.id}><div className="mb-2 flex items-baseline gap-3 tracking-[0.02em] text-[11px] text-muted-foreground"><span className="font-sans text-[13px] font-semibold text-foreground">{agent}</span><span>Reply in progress</span></div><div className="markdown reading"><MessageBody body={[block.text, ...(block.images ?? []).map((id) => `MEDIA:web:${id}`)].filter(Boolean).join("\n")} sessionId={selectedId} thinking="block" /></div></article>)}
          </>}</ChatRow>)}
        </ChatScroller>
        <div className="mx-auto w-full max-w-[740px]"><div className="flex min-h-7 items-baseline gap-3 pb-2">
          <div className={cn("feedback min-w-0 flex-1 tracking-[0.02em] text-xs leading-normal text-muted-foreground tabular-nums transition-opacity duration-200 [overflow-wrap:anywhere]", settle.fading && "opacity-0")} role="status" aria-live="polite">{composerStatus({ activity: web.activity[selectedId], note, latest, settled: settle.settled, agent, turn, now })}</div>
</div>
          {suggestion && <button type="button" onClick={() => { setDraft(suggestion); input.current?.focus(); }} title="Use this as your message"
            className="motion-enter mb-2 flex max-w-full items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-left text-[12.5px] text-muted-foreground shadow-xs transition-colors hover:border-muted-foreground/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <Sparkles className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" /><span className="truncate">{suggestion}</span></button>}
          {resending && <div className="mb-2 flex items-center gap-2 tracking-[0.02em] text-[11px] text-muted-foreground">
            <Badge variant="outline" className="rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground">Resending an interrupted message</Badge>
            <span>The original is dismissed once this one is accepted.</span>
            <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-[11px]" onClick={() => setResending(null)}>Not a resend</Button></div>}
          {attachments.items.length > 0 && <ul aria-label="Attached images" className="m-0 mb-2 flex list-none flex-wrap gap-2 p-0">
            {attachments.items.map((item, index) => <li key={item.key} aria-label={attachmentLabel(item, index)}
              className={cn("relative size-16 overflow-hidden rounded-xl border bg-muted/40 motion-enter", item.status === "failed" && "border-destructive/60")}>
              <img src={item.preview} alt="" className={cn("size-full object-cover", item.status !== "done" && "opacity-60")} />
              {item.status === "uploading" && <span className="absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded-full bg-background/70" role="progressbar" aria-label="Upload progress"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}><span className="block h-full bg-primary transition-[width] duration-150" style={{ width: `${Math.round(item.progress * 100)}%` }} /></span>}
              {item.status === "failed" && <button type="button" onClick={() => attachments.retry(item.key)} title={item.error} aria-label={`Retry upload${item.error ? ` (${item.error})` : ""}`}
                className="absolute inset-0 grid place-items-center bg-background/60 text-destructive hover:bg-background/40"><RotateCw className="size-4" /></button>}
              <button type="button" onClick={() => attachments.remove(item.key)} aria-label={`Remove ${item.file.name || `image ${index + 1}`}`}
                className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-foreground/70 text-background hover:bg-foreground"><X className="size-3" strokeWidth={2.5} /></button>
            </li>)}</ul>}
          {attachments.note && <p className="m-0 mb-2 text-[12px] text-muted-foreground" role="status">{attachments.note}</p>}
          <form onSubmit={(e) => void send(e)} className="composer flex items-end gap-1 rounded-[20px] border bg-card p-2.5 shadow-xs transition-[border-color,box-shadow] focus-within:border-muted-foreground/50 focus-within:shadow-md">
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif,.heic,.heif" multiple hidden
              onChange={(e) => { attachments.add(Array.from(e.target.files ?? [])); e.target.value = ""; input.current?.focus(); }} />
            <Button type="button" variant="ghost" size="icon" aria-label="Attach images" title={uploadsOn ? "Attach images (or drop / paste them)" : "Image uploads are off (saveInboundImages is false in config)"} disabled={!canAttach}
              onClick={() => fileInput.current?.click()} className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-[18px]"><ImagePlus strokeWidth={1.75} /></Button>
            <label className="sr-only" htmlFor="message">Message {agent}</label>
            <Textarea ref={input} id="message" placeholder={session?.kind === "group" ? "This group is read-only" : "What's on your mind?"} value={draft} maxLength={16_000} rows={1} disabled={!session?.writable}
              className="max-h-60 min-h-10 flex-1 resize-none rounded-none border-0 bg-transparent! py-[7px] pr-3 pl-1.5 text-[15px] leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:ring-0 disabled:opacity-80 md:text-[15px]"
              onChange={(e) => { setDraft(e.target.value); setResending((old) => resendAfterDraftChange(old, e.target.value)); }} onPaste={(e) => {
                const files = imageFiles(e.clipboardData?.items);
                if (!files.length || !canAttach) return;
                attachments.add(files);
                // An image on the clipboard is attached; text that came with it still pastes.
                if (!Array.from(e.clipboardData.types).includes("text/plain")) e.preventDefault();
              }} onCompositionStart={() => ime.current.start()} onCompositionEnd={() => ime.current.end()}
              onKeyDown={(e) => { if (ime.current.shouldSubmit({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            {showStop ? <Button type="button" size="icon" aria-label={`Stop ${agent}`} title="Stop" aria-busy={stopping} disabled={stopping} onClick={() => void stop()}
              className="size-9 shrink-0 rounded-full bg-foreground text-background transition-[background-color,transform] hover:bg-foreground/85 active:scale-[0.94] disabled:opacity-60 [&_svg:not([class*='size-'])]:size-3.5">
              <Square fill="currentColor" strokeWidth={0} /></Button> :
            <Button type="submit" size="icon" aria-label="Send" aria-busy={sending}
              className="size-9 shrink-0 rounded-full transition-[background-color,transform] hover:bg-primary/85 active:scale-[0.94] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 [&_svg:not([class*='size-'])]:size-[18px]"
              disabled={!session?.writable || !canSendWith(draft, attachments.items) || sending || !!uncertain || web.connection !== "live"}><ArrowUp strokeWidth={2.2} /></Button>}
          </form>
          {uncertain && !sending && <div className="mt-2 flex flex-wrap gap-2"><Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => void checkOutcome()}>Check message status</Button><Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => { remember(null); setFeedback("Draft kept. Review the conversation before sending it again."); }}>Keep draft for review</Button></div>}
        </div>
      </main>
      {/* Wide screens: the rail takes its full width at once (the chat reflows
          once, not every frame) and only its content slides and fades. Narrow
          ones: it slides over the chat, with a dimmed backdrop. It stays
          mounted for the closing transition. */}
      {railMotion.mounted && overlay && <div aria-hidden="true" onClick={closeTasks} data-state={railMotion.shown ? "open" : "closed"}
        className="fixed inset-0 top-[72px] z-20 bg-black/20 transition-opacity duration-[220ms] data-[state=closed]:opacity-0 max-[600px]:top-[calc(3rem+env(safe-area-inset-top))]" />}
      {railMotion.mounted && <aside ref={rail} id="tasks-rail" aria-label="Tasks" data-state={railMotion.shown ? "open" : "closed"} {...(modal ? { role: "dialog", "aria-modal": true } : {})}
        style={railSize.width !== null ? { width: railSize.width } : undefined}
        className="group/rail relative flex min-h-0 w-[300px] shrink-0 flex-col overflow-hidden border-l pt-4 pb-6 pl-3.5 max-[1024px]:w-[280px] max-[1024px]:pl-2.5 max-[800px]:fixed max-[800px]:top-[72px] max-[800px]:right-0 max-[800px]:bottom-0 max-[800px]:z-30 max-[800px]:w-[min(340px,88vw)] max-[800px]:bg-background max-[800px]:pt-3 max-[800px]:shadow-2xl max-[800px]:transition-transform max-[800px]:duration-[220ms] max-[800px]:data-[state=closed]:translate-x-full max-[600px]:top-[calc(3rem+env(safe-area-inset-top))]">
        <div className="flex min-h-0 min-w-[246px] flex-1 flex-col transition-[opacity,transform] duration-[220ms] min-[801px]:group-data-[state=closed]/rail:translate-x-4 min-[801px]:group-data-[state=closed]/rail:opacity-0"><TasksPanel tasks={web.tasks} sessions={sessions} onClose={closeTasks}
          footer={<ScheduledSection revision={web.cronRevision} onNavigate={() => { if (overlay) setTasksOpen(false); }} />} /></div>
        {railSize.separator && <div {...railSize.separator}
          className="group/handle absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none outline-none">
          <span className="absolute inset-y-0 left-0 w-px transition-colors group-hover/handle:bg-primary/60 group-focus-visible/handle:bg-primary" /></div>}</aside>}
      {/* While dragging only this guide moves (a transform); the rail and the chat resize once, on release. */}
      {railSize.separator && <div ref={railSize.guide} hidden aria-hidden="true" className="pointer-events-none fixed inset-y-0 left-0 z-40 w-0.5 bg-primary/70" />}
    </div>
    {screen && <ScreenWindow bootstrap={web.bootstrap} refresh={web.refreshBootstrap} live={web.connection === "live"} compact={phone} onClose={closeScreen} />}
  </div></AgentNameContext.Provider>;
}

createRoot(document.getElementById("root")!).render(<App />);
