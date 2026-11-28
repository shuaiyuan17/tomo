import { lazy, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { markSubsessionDone, messageSubsession, taskAction } from "./api.js";
import { activeSubsessions, useSubsessions } from "./subsessions.js";
import { useWeb } from "./use-web.js";
import { onResume, repaint } from "./resume.js";
import { trackKeyboardViewport } from "./keyboard-viewport.js";
import { TasksPanel } from "./tasks-panel.js";
import { ActivityEnvProvider, publishSubsessions } from "./activity-env.js";
import { ScheduledSection } from "./scheduled-section.js";
import { useMountedFor } from "./motion.js";
import { runningCount } from "./tasks.js";
import { studyLabel, useStudyRoute } from "./study-data.js";
import { applyConfiguredLocale, configuredLocaleUpdate, useTranslation } from "./i18n/index.js";
import { HomePage, useHomeRoute } from "./home/home-page.js";
import "./styles.css";
import { useRailWidth } from "./rail-width.js";
import { AgentNameContext, agentNameOf } from "./agent-name.js";
import { ChunkBoundary } from "./chunk-boundary.js";
import { AppHeader, type View } from "./app-header.js";
import { Sidebar } from "./sidebar.js";
import { Conversation } from "./conversation.js";
import { useHistory } from "./use-history.js";
import { OVERLAY_QUERY, PHONE_QUERY, useMediaQuery, useModalLayer, useStoredFlag } from "./layers.js";
import { useTheme } from "./theme.js";

// The Study and the screen window are off the chat's first paint: their own chunks, fetched when opened.
const Study = lazy(() => import("./study.js").then((m) => ({ default: m.Study })));
const ScreenWindow = lazy(() => import("./screen.js").then((m) => ({ default: m.ScreenWindow })));

const scrim = "fixed inset-0 top-(--app-header) z-20 bg-black/20 dark:bg-black/45";

/**
 * The app shell: where you are (conversation, Home, the Study), which
 * conversation, and the layers over it — the phone drawer, the Tasks rail,
 * the conversation beside Home's room, the screen window. Only one modal
 * layer is open at a time; each hands focus back to its button on closing.
 */
export function App() {
  const web = useWeb();
  const { t, i18n } = useTranslation();
  // Only an arrived bootstrap changes the configured locale; before that the one served on <html> stands.
  const bootstrapped = !!web.bootstrap;
  useEffect(() => {
    const update = configuredLocaleUpdate(web.bootstrap);
    if (update !== "keep") applyConfiguredLocale(update.locale);
  }, [bootstrapped, web.bootstrap?.locale]);
  const agent = agentNameOf(web.bootstrap?.agentName);
  const [study, setStudy, studyFocus] = useStudyRoute();
  const home = useHomeRoute() && !study;
  const view: View = study ? "study" : home ? "home" : "conversation";
  const sessions = web.bootstrap?.sessions ?? [];
  const ownerId = web.bootstrap?.ownerId ?? null;
  const [selected, setSelected] = useState("");
  const selectedId = selected || ownerId || sessions[0]?.id || "";
  const session = sessions.find((s) => s.id === selectedId);
  const history = useHistory(selectedId, web.revision);
  const [theme, setTheme] = useTheme();

  const overlay = useMediaQuery(OVERLAY_QUERY);
  const phone = useMediaQuery(PHONE_QUERY);
  const header = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const rail = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const tasksButton = useRef<HTMLButtonElement>(null);
  const chatButton = useRef<HTMLButtonElement>(null);
  const screenButton = useRef<HTMLButtonElement>(null);

  // Phone width: the sidebar (navigation, conversation picker, context,
  // plan usage, theme) is a drawer behind a button at the top left, so the
  // chat has the whole screen. It is a modal layer like the Tasks overlay.
  const [menuOpen, setMenuOpen] = useState(false);
  const drawer = phone && menuOpen;
  const drawerMotion = useMountedFor(drawer);
  const closeMenu = (refocus = true) => { setMenuOpen(false); if (refocus) menuButton.current?.focus(); };
  useModalLayer(drawer, sidebar, "button, a[href]", closeMenu);

  // The Tasks rail: pinned on wide screens (drag-to-resize), a modal layer
  // sliding over the chat on narrow ones. It stays mounted through its closing transition (see motion.ts).
  const [tasksOpen, setTasksOpen] = useStoredFlag("tomo-tasks-open");
  const railSize = useRailWidth({ enabled: !overlay, sidebar: () => sidebar.current?.offsetWidth ?? 272 });
  const railMotion = useMountedFor(tasksOpen);
  const tasksModal = tasksOpen && overlay && railMotion.mounted;
  const closeTasks = () => { setTasksOpen(false); tasksButton.current?.focus(); };
  useModalLayer(tasksModal, rail, "[data-tasks-close]", closeTasks);
  const subsessionList = useSubsessions(web.subsessionRevision);
  // Activity cards read a task's live state by id from this store (activity-env.tsx), not through props.
  useEffect(() => { publishSubsessions(subsessionList.tasks, subsessionList.available); }, [subsessionList]);
  /** The sub-session open in the rail: here, so a card in the chat can open one ("Open task"). */
  const [openedSub, setOpenedSub] = useState<string>();
  const ownerConversation = !!selectedId && selectedId === ownerId;
  const activityEnv = useMemo(() => ({ sessions, sessionId: selectedId, ownerConversation,
    openTask: (id: string) => { setOpenedSub(id); setMenuOpen(false); setTasksOpen(true); } }), [sessions, selectedId, ownerConversation, setTasksOpen]);
  // A sub-session running now counts on the Tasks button like a running subagent.
  const running = runningCount(web.tasks) + activeSubsessions(subsessionList.tasks);
  // The owner writes to one of their sub-sessions from its chat in the rail, and marks what its report asked done (same gate as a message).
  const railSubsessions = { tasks: subsessionList.tasks, revision: web.subsessionRevision,
    ...(web.bootstrap?.ownerId ? { send: async (id: string, requestId: string, text: string) => {
      if (!web.bootstrap) throw new Error("not ready");
      return (await messageSubsession(id, { requestId, text }, web.bootstrap, web.refreshBootstrap)).task;
    }, done: async (id: string, report: number) => {
      if (!web.bootstrap) throw new Error("not ready");
      return (await markSubsessionDone(id, { report }, web.bootstrap, web.refreshBootstrap)).task;
    } } : {}) };
  // Stop / move to background for an opened task of the owner conversation (same gate as a message).
  const taskControl = { ownerId: ownerId ?? undefined, act: async (task: { sessionId: string; taskId: string }, action: "stop" | "background") => {
    if (!web.bootstrap) return false;
    return (await taskAction(task.sessionId, task.taskId, action, web.bootstrap, web.refreshBootstrap)).done;
  } };

  // On Home the conversation (the same component, its stream and state) can open beside the room:
  // a pinned column on wide screens, a modal layer over the room on narrow ones.
  const [homeChatOpen, setHomeChatOpen] = useStoredFlag("tomo-home-chat-open");
  const chatPanel = home && homeChatOpen;
  const chatModal = chatPanel && overlay;
  const closeChat = () => { setHomeChatOpen(false); chatButton.current?.focus(); };
  const modal = tasksModal || drawer || chatModal;

  // A dot on the button while the conversation is out of sight on Home and a reply has come since it was last on screen.
  const lastMessage = history.history.messages.at(-1);
  const [seenMessage, setSeenMessage] = useState<string>();
  const chatInSight = (!study && !home) || chatPanel;
  useEffect(() => { if (chatInSight || seenMessage === undefined) setSeenMessage(lastMessage?.id ?? ""); }, [chatInSight, lastMessage?.id]);
  const chatUnread = home && !chatPanel && !!lastMessage && seenMessage !== undefined && lastMessage.id !== seenMessage && lastMessage.role === "assistant";

  // The screen is the owner's: offered only with the owner conversation selected.
  const [screenOpen, setScreenOpen] = useState(false);
  const screenAllowed = !!web.bootstrap?.capabilities?.screen && session?.kind !== "group";
  const screen = screenOpen && screenAllowed;
  const closeScreen = () => { setScreenOpen(false); screenButton.current?.focus(); };

  // Back from another app (or the back/forward cache): iOS Safari can hand
  // back a stale frame, the document nudged under its status bar (where
  // Safari blurs and dims whatever sits there) and a dimmed backdrop left
  // over the page. Drop the modal layers, put the document back at the top
  // and have the header repainted.
  const overlayNow = useRef(overlay); overlayNow.current = overlay;
  useEffect(() => onResume(() => {
    setMenuOpen(false);
    if (overlayNow.current) { setTasksOpen(false); setHomeChatOpen(false); }
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    repaint(header.current);
  }), []);
  // The on-screen keyboard shrinks the app, not scrolls the page (keyboard-viewport.ts).
  useEffect(() => trackKeyboardViewport(), []);
  // The tab says where you are: a Study page or a group being read.
  useEffect(() => {
    document.title = study ? t("title.study", { page: studyLabel(study) }) : home ? t("title.home") : session?.kind === "group" ? t("title.group", { title: session.title }) : t("title.app");
  }, [study, home, session?.kind, session?.title, t, i18n.language]);

  const navigate = (target: View) => {
    if (target === "home") window.location.hash = "home";
    else setStudy(target === "conversation" ? null : study ?? "todos");
  };
  const skipTarget = study ? "study" : home ? "home" : "conversation";
  return <AgentNameContext.Provider value={agent}><div data-app-shell className="flex h-[var(--app-height,100dvh)] [transform:var(--app-shift,none)] flex-col">
    <a className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-card focus:p-3" href={`#${skipTarget}`} onClick={(e) => { e.preventDefault(); document.getElementById(skipTarget)?.focus(); }}>{study ? t("skip.to", { target: studyLabel(study) }) : home ? t("skip.home") : t("skip.conversation")}</a>
    <AppHeader headerRef={header} connection={web.connection}
      title={study ? t("nav.study") : home ? t("nav.home") : session?.kind === "group" ? session.title : t("nav.conversation")}
      menu={{ ref: menuButton, pressed: drawer, onToggle: () => { setTasksOpen(false); setHomeChatOpen(false); setMenuOpen((open) => !open); } }}
      chat={home ? { ref: chatButton, pressed: chatPanel, unread: chatUnread, onToggle: () => { setMenuOpen(false); if (overlay) setTasksOpen(false); setHomeChatOpen((open) => !open); } } : undefined}
      tasks={{ ref: tasksButton, pressed: tasksOpen, running, onToggle: () => { setMenuOpen(false); if (overlay) setHomeChatOpen(false); setTasksOpen((open) => !open); } }}
      screen={screenAllowed ? { ref: screenButton, pressed: screen, onToggle: () => screen ? closeScreen() : setScreenOpen(true) } : undefined} />
    <div className="flex min-h-0 flex-1">
      {phone && drawerMotion.mounted && <div aria-hidden="true" onClick={() => closeMenu()} data-state={drawerMotion.shown ? "open" : "closed"}
        className="fixed inset-0 top-(--app-header) z-20 bg-black/20 transition-opacity dark:bg-black/45 duration-[220ms] data-[state=closed]:opacity-0" />}
      <Sidebar sidebarRef={sidebar} view={view} onNavigate={navigate} drawer={drawer} phone={phone} inert={tasksModal || chatModal}
        sessions={sessions} ownerId={ownerId} session={session} onSelect={setSelected} closeDrawer={closeMenu} theme={theme} onTheme={setTheme} web={web} />
      {study && <ChunkBoundary what={t("nav.study")} className="min-h-0 min-w-0 flex-1"><Study page={study} onPage={(page) => setStudy(page)} session={session} reload={web.revision} inert={modal} focus={studyFocus} cronRevision={web.cronRevision}
        mutator={{ bootstrap: web.bootstrap, refresh: web.refreshBootstrap, live: web.connection === "live" }} /></ChunkBoundary>}
      {home && <HomePage events={web.home} bootstrap={web.bootstrap} refresh={web.refreshBootstrap} inert={modal} />}
      {chatModal && <div aria-hidden="true" data-testid="chat-scrim" onClick={closeChat} className={`${scrim} motion-enter`} />}
      <ActivityEnvProvider value={activityEnv}>
      <Conversation web={web} agent={agent} session={session} sessionId={selectedId} ownerConversation={!!selectedId && selectedId === ownerId}
        history={history} hidden={!!study || (home && !chatPanel)} inert={tasksModal || drawer}
        panel={chatPanel ? { modal: chatModal, onClose: closeChat } : undefined} />
      </ActivityEnvProvider>
      {/* Wide screens: the rail takes its full width at once (the chat reflows
          once, not every frame) and only its content slides and fades. Narrow
          ones: it slides over the chat, with a dimmed backdrop. It stays
          mounted for the closing transition. */}
      {railMotion.mounted && overlay && <div aria-hidden="true" onClick={closeTasks} data-state={railMotion.shown ? "open" : "closed"}
        className={`${scrim} transition-opacity duration-[220ms] data-[state=closed]:opacity-0`} />}
      {railMotion.mounted && <aside ref={rail} id="tasks-rail" aria-label={t("header.tasks")} data-state={railMotion.shown ? "open" : "closed"} {...(modal ? { role: "dialog", "aria-modal": true } : {})}
        style={railSize.width !== null ? { width: railSize.width } : undefined}
        className="group/rail relative flex min-h-0 w-[300px] shrink-0 flex-col overflow-hidden border-l px-3.5 pt-3 pb-4 max-[1024px]:fixed max-[1024px]:top-(--app-header) max-[1024px]:right-0 max-[1024px]:bottom-0 max-[1024px]:z-30 max-[1024px]:w-[min(340px,88vw)] max-[1024px]:bg-background max-[1024px]:px-3 max-[1024px]:pt-3 max-[1024px]:shadow-2xl max-[1024px]:transition-transform max-[1024px]:duration-[220ms] max-[1024px]:data-[state=closed]:translate-x-full max-[600px]:pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex min-h-0 min-w-[246px] flex-1 flex-col transition-[opacity,transform] duration-[220ms] min-[1025px]:group-data-[state=closed]/rail:translate-x-4 min-[1025px]:group-data-[state=closed]/rail:opacity-0"><TasksPanel tasks={web.tasks} sessions={sessions} onClose={closeTasks} control={taskControl} subsessions={railSubsessions}
          openedSub={openedSub} onOpenSub={setOpenedSub}
          footer={<ScheduledSection revision={web.cronRevision} onNavigate={() => { if (overlay) setTasksOpen(false); }} />} /></div>
        {railSize.separator && <div {...railSize.separator}
          className="group/handle absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none outline-none">
          <span className="absolute inset-y-0 left-0 w-px transition-colors group-hover/handle:bg-primary/60 group-focus-visible/handle:bg-primary" /></div>}</aside>}
      {/* While dragging only this guide moves (a transform); the rail and the chat resize once, on release. */}
      {railSize.separator && <div ref={railSize.guide} hidden aria-hidden="true" className="pointer-events-none fixed inset-y-0 left-0 z-40 w-0.5 bg-primary/70" />}
    </div>
    {screen && <ChunkBoundary what={t("chunk.screen")} className="fixed right-4 bottom-4 z-40 rounded-xl border bg-card shadow-md"><ScreenWindow bootstrap={web.bootstrap} refresh={web.refreshBootstrap} live={web.connection === "live"} compact={phone} onClose={closeScreen} /></ChunkBoundary>}
  </div></AgentNameContext.Provider>;
}

createRoot(document.getElementById("root")!).render(<App />);
