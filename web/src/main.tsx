import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, dismissRequest, sendMessage } from "./api.js";
import { useWeb } from "./use-web.js";
import { createCompositionGuard } from "./compose-keys.js";
import { Text } from "./markdown.js";
import { MessageBody } from "./message-body.js";
import { findQuoted, parseReply } from "./reply.js";
import { TasksPanel } from "./tasks-panel.js";
import { PlanUsage } from "./plan-usage.js";
import { ScheduledSection } from "./scheduled-section.js";
import { runningCount } from "./tasks.js";
import { ArrowUp, BookOpen, ChevronsUpDown, ListChecks, MessageCircle, Monitor, Moon, Sun, SunMoon } from "lucide-react";
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

const labels: Record<WebRequest["state"], string> = { queued: "Queued", running: "Tomo is working…", completed: "Completed",
  failed: "Delivery failed — check the conversation before sending again", refused: "Message was not accepted",
  unknown: "Outcome unknown — Tomo may already have acted on it. Check the conversation before sending again",
  interrupted: "Interrupted by a restart and not answered — Tomo may have started on it. Check before sending again" };
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
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const restoreScroll = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState<string | null>(() => {
    try { return sessionStorage.getItem("tomo-pending-request"); } catch { return null; }
  });
  const [feedback, setFeedback] = useState("");
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
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
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
  const overlay = useMediaQuery(OVERLAY_QUERY);
  const phone = useMediaQuery("(max-width: 600px)");
  const modal = tasksOpen && overlay;
  const closeTasks = () => { setTasksOpen(false); tasksButton.current?.focus(); };
  // On narrow screens the rail is a modal layer: focus moves into it, stays
  // there (the content under it is inert), and Escape anywhere closes it,
  // returning focus to the topbar button. A pinned desktop rail is not modal.
  useEffect(() => {
    if (!modal) return;
    rail.current?.querySelector<HTMLElement>("[data-tasks-close]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeTasks(); return; }
      if (event.key === "Tab" && rail.current) trapTab(rail.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modal]);
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
      setHistory({ messages: [], nextCursor: null }); setHistoryStatus("loading"); atBottom.current = true;
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

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (restoreScroll.current !== null) { element.scrollTop = element.scrollHeight - restoreScroll.current; restoreScroll.current = null; }
    else if (atBottom.current) element.scrollTop = element.scrollHeight;
  }, [history, web.blocks, web.requests]);

  useEffect(() => {
    web.discardRecordedBlocks(recordedReplyIds(history));
  }, [history, web.discardRecordedBlocks]);

  const remember = (id: string | null) => {
    setUncertain(id);
    try { if (id) sessionStorage.setItem("tomo-pending-request", id); else sessionStorage.removeItem("tomo-pending-request"); } catch { /* Optional recovery hint. */ }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!session?.writable || !draft.trim() || sending || uncertain || !web.bootstrap || web.connection !== "live") return;
    const text = draft.trim();
    const requestId = crypto.randomUUID();
    setSending(true); setFeedback("Sending…"); remember(requestId);
    try {
      const request = await sendMessage({ requestId, targetId: session.id, text }, web.bootstrap, web.refreshBootstrap);
      web.acceptRequest({ ...request, text, timestamp: Date.now() });
      // Accepted, and it really was that message (or the owner's edit of it):
      // only now does the interrupted one go.
      const replaced = dismissAfterAcceptedSend(resending, text);
      if (replaced) void dismiss(replaced, true);
      setResending(null);
      setDraft((old) => old.trim() === text ? "" : old);
      setFeedback(labels[request.state]); remember(null); setReload((r) => r + 1); atBottom.current = true;
    } catch (err) {
      // Definite refusals the daemon names (nothing was accepted), not network uncertainty.
      const refusal = err instanceof ApiError && err.status === 503 ? refusalReasons[err.code] : undefined;
      if (refusal) { remember(null); setFeedback(refusal); }
      else if (err instanceof ApiError && [400, 401, 403, 409, 413, 415, 429].includes(err.status)) {
        remember(null);
        setFeedback(err.status === 413 ? "Message is too large. Shorten it and send again; your draft is kept."
          : err.status === 401 ? "Open the private link in web-access.log to reconnect. Your draft is kept."
          : err.code === "owner_dm_only" ? "Group conversations are read-only." : "Message was not accepted. Your draft is saved here; reconnect or check web settings.");
      } else setFeedback(labels.unknown);
    } finally { setSending(false); }
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
    setFeedback("Review the message, then send it again. The interrupted one is dismissed once this is accepted.");
  };
  /** Resend / Dismiss for an interrupted request awaiting the owner, on its bubble (history or pending). */
  const interruptedActions = (request: WebRequest | undefined) => request && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <span>Not answered. Tomo may have started on it — check before resending.</span>
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
      setFeedback(labels[request.state]);
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
      const element = scroll.current;
      if (element) restoreScroll.current = element.scrollHeight - element.scrollTop;
      setHistory((old) => ({ revision: value.revision, messages: [...value.messages.filter((m) => !old.messages.some((item) => item.id === m.id)), ...old.messages], nextCursor: value.nextCursor }));
      setHistoryStatus("ready");
    } catch (error) {
      if (historySession.current !== target) return;
      if (error instanceof ApiError && error.status === 409 && error.code === "history_changed") {
        setHistory({ messages: [], nextCursor: null }); setHistoryStatus("loading");
        restoreScroll.current = null; atBottom.current = true; setReload((value) => value + 1);
      } else setHistoryStatus("error");
    }
  };
  const durable = recordedReplyIds(history);
  const blocks = web.blocks.filter((b) => b.sessionId === selectedId && !durable.has(b.turnId ?? b.requestId));
  const pendingUsers = pendingUserMessages(web.requests, history, selectedId);
  const latest = web.requests.filter((r) => r.sessionId === selectedId).at(-1);
  const usage = session?.stats;
  const hasContext = !!usage?.contextMax;
  const sessions = web.bootstrap?.sessions ?? [];
  const connectionLabel = web.connection === "live" ? "Connected" : web.connection === "locked" ? "Access link required" : web.connection === "connecting" ? "Connecting…" : "Reconnecting…";
  const notice = "rounded-xl border bg-muted/60 px-4 py-3 text-[13px]";
  return <div className="flex h-dvh flex-col">
    <a className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-card focus:p-3" href={study ? "#study" : "#conversation"} onClick={(e) => { e.preventDefault(); document.getElementById(study ? "study" : "conversation")?.focus(); }}>{study ? `Skip to ${STUDY_LABELS[study]}` : "Skip to conversation"}</a>
    <header className="flex h-[72px] shrink-0 items-center gap-8 border-b px-8 max-[1024px]:px-6 max-[600px]:h-16 max-[600px]:gap-3 max-[600px]:px-4">
      <a className="flex items-center gap-2 font-serif text-[30px] tracking-[-1.5px] text-foreground no-underline max-[600px]:text-[26px]" href="/" aria-label="Tomo home">
        <Mark className="size-9" /><span>tomo<span className="text-primary">.</span></span></a>
      <span className="border-l pl-8 text-sm text-muted-foreground max-[800px]:hidden">{study ? "The Study" : "Conversation"}</span>
      <div className="ml-auto flex items-center gap-4 max-[600px]:gap-2">
        <Button ref={tasksButton} variant="ghost" size="icon" aria-pressed={tasksOpen} aria-controls="tasks-rail" title="Tasks"
          aria-label={`Tasks${running ? `, ${running} running` : ""}`} onClick={() => setTasksOpen((open) => !open)}
          className="relative size-10 rounded-xl text-foreground hover:bg-foreground/[0.07] aria-pressed:bg-foreground/[0.11] aria-pressed:hover:bg-foreground/[0.14] [&_svg:not([class*='size-'])]:size-5">
          <ListChecks strokeWidth={1.75} />
          {running > 0 && <span aria-hidden="true" className="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground ring-2 ring-background">{running > 99 ? "99+" : running}</span>}
        </Button>
        {screenAllowed && <Button ref={screenButton} variant="ghost" size="icon" aria-pressed={screen} aria-controls="screen-window" title="Screen"
          aria-label="Screen (read-only live view)" onClick={() => screen ? closeScreen() : setScreenOpen(true)}
          className="size-10 rounded-xl text-foreground hover:bg-foreground/[0.07] aria-pressed:bg-foreground/[0.11] aria-pressed:hover:bg-foreground/[0.14] [&_svg:not([class*='size-'])]:size-5">
          <Monitor strokeWidth={1.75} /></Button>}
        <span role="status" className="flex items-center gap-2 tracking-[0.02em] text-xs text-muted-foreground">
          <i className={cn("size-1.5 rounded-full border border-muted-foreground", web.connection === "live" && "border-primary bg-primary")} />
          <span className="max-[600px]:sr-only">{connectionLabel}</span></span>
      </div>
    </header>
    <div className="flex min-h-0 flex-1 max-[600px]:flex-col">
      <aside className="flex w-[272px] shrink-0 flex-col gap-1 overflow-y-auto border-r px-6 py-8 [scrollbar-width:thin] max-[600px]:overflow-visible max-[1024px]:w-[232px] max-[1024px]:px-5 max-[800px]:w-[204px] max-[800px]:px-4 max-[600px]:w-full max-[600px]:flex-row max-[600px]:items-center max-[600px]:gap-3 max-[600px]:border-r-0 max-[600px]:border-b max-[600px]:px-4 max-[600px]:py-2.5"
        aria-label="Conversation details" inert={modal}>
        <nav aria-label="Workspace" className="mb-7 flex flex-col gap-0.5 max-[600px]:mb-0 max-[600px]:flex-row max-[600px]:gap-1">
          {([[null, "Conversation", MessageCircle], ["todos", "The Study", BookOpen]] as const).map(([target, label, Icon]) => {
            const current = target === null ? !study : !!study;
            return <Button key={label} variant="ghost" aria-current={current ? "page" : undefined} onClick={() => setStudy(target === null ? null : study ?? target)}
              className="h-9 justify-start gap-2.5 rounded-xl px-3 text-[13px] font-normal text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground aria-[current=page]:bg-foreground/[0.08] aria-[current=page]:font-medium aria-[current=page]:text-foreground max-[600px]:h-9 max-[600px]:px-2.5">
              <Icon strokeWidth={1.75} /><span className="max-[600px]:sr-only">{label}</span></Button>;
          })}
        </nav>
        <p className="eyebrow mb-3 max-[600px]:hidden">Your conversations</p>
        <div className="mb-1.5 flex items-center justify-between gap-2 max-[600px]:mb-0">
          <span id="session-label" className="text-[13px] font-medium">Session</span>
          <Badge variant="outline" className="rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground max-[600px]:hidden">{session?.kind === "group" ? "Read-only" : "Owner DM"}</Badge>
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild disabled={!sessions.length}>
            <Button variant="outline" aria-labelledby="session-label session-value"
              className="h-11 w-full min-w-0 justify-between rounded-xl bg-card px-3.5 text-[13px] font-normal shadow-xs hover:bg-accent max-[600px]:flex-1">
              <span id="session-value" className="truncate">{session ? `${session.title}${session.kind === "group" ? " · read-only" : ""}` : "No session available"}</span>
              <ChevronsUpDown className="text-muted-foreground" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-xl p-1">
            <DropdownMenuLabel className="px-2 py-1.5 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Conversations</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={selectedId} onValueChange={(value) => { setSelected(value); setFeedback(""); }}>
              {sessions.map((s) => <DropdownMenuRadioItem key={s.id} value={s.id} className="rounded-lg py-2 text-[13px]">
                <span className="truncate">{s.title}</span>{s.kind === "group" && <span className="ml-auto pl-3 tracking-[0.02em] text-[10px] text-muted-foreground">read-only</span>}
              </DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground max-[600px]:hidden">{session?.kind === "group" ? "Shared history. Messages can be sent from the group's messaging channel." : "The same conversation you share with Tomo across your messaging channels."}</p>
        <section className="mt-8 border-t pt-7 max-[600px]:hidden" aria-labelledby="context-heading"><p className="eyebrow mb-3" id="context-heading">Context window</p>
          <p className="mb-3 text-lg tabular-nums">{hasContext ? <>{usage!.contextUsed.toLocaleString()} <span className="text-xs text-muted-foreground">/ {usage!.contextMax.toLocaleString()}</span></> : "Unavailable"}</p>
          {hasContext && <Progress max={usage!.contextMax} value={Math.min(usage!.contextUsed, usage!.contextMax)} aria-label="Context tokens used" className="h-1.5 bg-border" />}
          <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{hasContext ? `${usage?.contextEstimated ? "Estimated" : "Reported"} tokens · last recorded turn` : "Usage appears after a turn reports its context window."}</p>
        </section>
        <PlanUsage ready={!!web.bootstrap} />
        {/* Theme: pinned to the bottom of the sidebar; in the phone-width top bar, one button at its end that cycles. */}
        <div className="mt-auto flex items-center justify-between gap-3 border-t pt-4 max-[600px]:hidden">
          <span className="eyebrow">Theme</span>
          <ToggleGroup type="single" aria-label="Color theme" value={theme} onValueChange={(value) => { if (value) setTheme(value as Theme); }}
            className="rounded-xl bg-foreground/[0.05] p-0.5">
            {THEMES.map(([value, label, Icon]) =>
              <ToggleGroupItem key={value} value={value} aria-label={label} title={label}
                className="size-7 rounded-[9px]! px-0 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-foreground/[0.13] [&_svg:not([class*='size-'])]:size-3.5">
                <Icon strokeWidth={1.75} /></ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        {(() => { const index = THEMES.findIndex(([value]) => value === theme); const [, label, Icon] = THEMES[index]; const next = THEMES[(index + 1) % THEMES.length];
          return <Button variant="ghost" size="icon" className="hidden size-9 shrink-0 rounded-xl text-muted-foreground hover:bg-foreground/[0.06] max-[600px]:inline-flex"
            aria-label={`${label}. Switch to ${next[1].toLowerCase()}`} title={label} onClick={() => setTheme(next[0])}><Icon strokeWidth={1.75} /></Button>; })()}
      </aside>
      {study && <Study page={study} onPage={(page) => setStudy(page)} session={session} reload={web.revision} inert={modal} focus={studyFocus} cronRevision={web.cronRevision}
        mutator={{ bootstrap: web.bootstrap, refresh: web.refreshBootstrap, live: web.connection === "live" }} />}
      <main id="conversation" hidden={!!study} className="mx-auto flex min-w-0 max-w-[980px] flex-1 flex-col px-12 pt-6 pb-6 max-[1024px]:px-7 max-[800px]:px-5 max-[600px]:min-h-0 max-[600px]:w-full max-[600px]:px-4 max-[600px]:pt-4 max-[600px]:pb-3" tabIndex={-1} inert={modal}>
        {web.bootstrap?.setupRequired && <div className={cn(notice, "mx-auto mb-4 w-full max-w-[740px]")} role="alert">Choose an owner in <code>web.ownerIdentity</code> and restart Tomo. An unambiguous owner is required to chat.</div>}
        {web.connection === "locked" && <div className={cn(notice, "mx-auto mb-4 w-full max-w-[740px]")} role="alert">Open the access link in Tomo's private <code>web-access.log</code> to connect. The link includes your private access token.</div>}
        <div className="min-h-0 w-full flex-1 overflow-y-auto pt-2 pr-4 pb-6 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] max-[600px]:pr-2" ref={scroll} aria-label="Conversation history" tabIndex={0} onScroll={() => { const e = scroll.current!; atBottom.current = e.scrollHeight - e.scrollTop - e.clientHeight < 80; }}>
          {history.nextCursor && <Button variant="outline" size="sm" className="mx-auto mb-6 flex rounded-full text-xs" onClick={() => void older()} disabled={historyStatus === "loading-older"}>{historyStatus === "loading-older" ? "Loading…" : "Load earlier messages"}</Button>}
          {historyStatus === "error" && <div className={cn(notice, "mx-auto mb-4 flex max-w-[740px] items-center gap-3")} role="alert">History is unavailable. <Button variant="outline" size="sm" className="rounded-lg" onClick={() => setReload((r) => r + 1)}>Try again</Button></div>}
          {historyStatus === "loading" && selectedId && <p className="text-center text-sm text-muted-foreground" role="status">Opening your conversation…</p>}
          {historyStatus === "ready" && history.messages.length === 0 && blocks.length === 0 && pendingUsers.length === 0 && <div className="m-auto flex h-full min-h-56 max-w-md flex-col items-center justify-center pb-12 text-center"><Mark className="mb-4 size-16 stroke-[1.3]" /><h2 className="mt-2 mb-3 font-serif text-[28px] font-normal">Start wherever you are.</h2><p className="m-0 max-w-80 text-sm text-muted-foreground">{session?.kind === "group" ? "There are no recorded messages in this group yet." : "A question, a half-formed idea, or something on your mind."}</p></div>}
          {history.messages.map((message, index) => { const { reply, body } = parseReply(message.content); const quoted = reply && findQuoted(history.messages, index, reply);
            return <article id={`msg-${message.id}`} className={cn(`message ${message.role} mx-auto mb-7 max-w-[740px] rounded-2xl transition-[background-color,box-shadow] duration-700`, flashId === message.id && "bg-primary/10 shadow-[0_0_0_8px_color-mix(in_srgb,var(--primary)_10%,transparent)]")} key={message.id}>
            <div className="mb-2 flex items-baseline gap-3 tracking-[0.02em] text-[11px] text-muted-foreground"><span className="font-sans text-[13px] font-semibold text-foreground">{message.role === "assistant" ? "Tomo" : message.role === "user" ? (session?.kind === "group" ? "Participant" : "You") : "System"}</span><time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>{message.channel === "web" ? "Web" : message.channel}</span>
              {message.role === "user" && historyBadge(message.requestId, web.requests) && <Badge variant="outline" className="self-center rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground">{historyBadge(message.requestId, web.requests)}</Badge>}</div>
            <div className={cn("markdown", message.role === "user" && "rounded-2xl rounded-tl-md bg-secondary px-5 py-3.5", message.role === "assistant" && "reading")}>
              <MessageBody body={body} reply={reply} sessionId={selectedId} onQuote={quoted ? () => showMessage(quoted.id) : undefined} /></div>
            {message.role === "user" && interruptedActions(web.requests.find((r) => r.requestId === message.requestId && awaitingOwner(r)))}</article>; })}
          {pendingUsers.map((request) => <article className="message user mx-auto mb-7 max-w-[740px]" data-request-id={request.requestId} key={request.requestId}>
            <div className="mb-2 flex items-baseline gap-3 tracking-[0.02em] text-[11px] text-muted-foreground"><span className="font-sans text-[13px] font-semibold text-foreground">You</span><span>Web</span>
              <Badge variant="outline" className="self-center rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground">{pendingLabel(request)}</Badge></div>
            <div className="markdown rounded-2xl rounded-tl-md bg-secondary px-5 py-3.5 opacity-80"><Text breaks>{request.text!}</Text></div>
            {interruptedActions(awaitingOwner(request) ? request : undefined)}</article>)}
          {blocks.map((block) => <article className="message assistant mx-auto mb-7 max-w-[740px]" key={block.id}><div className="mb-2 flex items-baseline gap-3 tracking-[0.02em] text-[11px] text-muted-foreground"><span className="font-sans text-[13px] font-semibold text-foreground">Tomo</span><span>Reply in progress</span></div><div className="markdown reading"><Text breaks>{block.text}</Text></div></article>)}
        </div>
        <div className="mx-auto w-full max-w-[740px]"><div className="min-h-7 pb-2 tracking-[0.02em] text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]" role="status" aria-live="polite">{web.activity[selectedId] || (latest && labels[latest.state]) || feedback}</div>
          {resending && <div className="mb-2 flex items-center gap-2 tracking-[0.02em] text-[11px] text-muted-foreground">
            <Badge variant="outline" className="rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground">Resending an interrupted message</Badge>
            <span>The original is dismissed once this one is accepted.</span>
            <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-[11px]" onClick={() => setResending(null)}>Not a resend</Button></div>}
          <form onSubmit={(e) => void send(e)} className="composer flex items-end gap-2 rounded-[20px] border bg-card py-2.5 pr-2.5 pl-1 shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-muted-foreground/50 focus-within:shadow-md">
            <label className="sr-only" htmlFor="message">Message Tomo</label>
            <Textarea ref={input} id="message" placeholder={session?.kind === "group" ? "This group is read-only" : "What's on your mind?"} value={draft} maxLength={16_000} rows={1} disabled={!session?.writable}
              className="max-h-60 min-h-10 flex-1 resize-none rounded-none border-0 bg-transparent! px-3.5 py-[7px] text-[15px] leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:ring-0 disabled:opacity-80 md:text-[15px]"
              onChange={(e) => { setDraft(e.target.value); setResending((old) => resendAfterDraftChange(old, e.target.value)); }} onCompositionStart={() => ime.current.start()} onCompositionEnd={() => ime.current.end()}
              onKeyDown={(e) => { if (ime.current.shouldSubmit({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            <Button type="submit" size="icon" aria-label="Send" aria-busy={sending}
              className="size-9 shrink-0 rounded-full transition-[background-color,transform] duration-150 hover:bg-primary/85 active:scale-[0.92] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 [&_svg:not([class*='size-'])]:size-[18px]"
              disabled={!session?.writable || !draft.trim() || sending || !!uncertain || web.connection !== "live"}><ArrowUp strokeWidth={2.2} /></Button>
          </form>
          {feedback && <p className="feedback mt-2 text-xs text-muted-foreground" role="status">{feedback}</p>}
          {uncertain && !sending && <div className="mt-2 flex flex-wrap gap-2"><Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => void checkOutcome()}>Check message status</Button><Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => { remember(null); setFeedback("Draft kept. Review the conversation before sending it again."); }}>Keep draft for review</Button></div>}
        </div>
      </main>
      {tasksOpen && <aside ref={rail} id="tasks-rail" aria-label="Tasks" {...(modal ? { role: "dialog", "aria-modal": true } : {})}
        className="flex min-h-0 w-[300px] shrink-0 flex-col border-l pt-4 pb-6 pl-3.5 max-[1024px]:w-[260px] max-[1024px]:pl-2.5 max-[800px]:fixed max-[800px]:top-[72px] max-[800px]:right-0 max-[800px]:bottom-0 max-[800px]:z-30 max-[800px]:w-[min(340px,88vw)] max-[800px]:bg-background max-[800px]:pt-3 max-[800px]:shadow-2xl max-[800px]:animate-[rail-in_180ms_ease-out] max-[600px]:top-16">
        <TasksPanel tasks={web.tasks} sessions={sessions} onClose={closeTasks}
          footer={<ScheduledSection revision={web.cronRevision} onNavigate={() => { if (overlay) setTasksOpen(false); }} />} /></aside>}
    </div>
    {screen && <ScreenWindow bootstrap={web.bootstrap} refresh={web.refreshBootstrap} live={web.connection === "live"} compact={phone} onClose={closeScreen} />}
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
