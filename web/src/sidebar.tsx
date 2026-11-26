import { Fragment, useRef, type Ref } from "react";
import { BookOpen, ChevronsUpDown, House, MessageCircle, Moon, Pin, Sun, SunMoon } from "lucide-react";
import type { WebSession } from "../../src/web/protocol.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { View } from "./app-header.js";
import { CompactButton } from "./compact-button.js";
import { PlanUsage } from "./plan-usage.js";
import { pinOwnerFirst } from "./session-order.js";
import type { Theme } from "./theme.js";
import type { useWeb } from "./use-web.js";
import { useTranslation } from "./i18n/index.js";
import { formatNumber } from "./i18n/format.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: common:nav.*
// i18n-dynamic: common:theme.*

type Web = ReturnType<typeof useWeb>;

const THEMES = [["system", "theme.system", SunMoon], ["light", "theme.light", Sun], ["dark", "theme.dark", Moon]] as const;
const NAVIGATION = [["conversation", "nav.conversation", MessageCircle], ["home", "nav.home", House], ["study", "nav.study", BookOpen]] as const;

/**
 * The sidebar: where to go (conversation, Home, the Study), which
 * conversation, its context window, plan usage and the theme. At phone width
 * it is a drawer (a modal layer) behind the top bar's menu button.
 */
export function Sidebar({ sidebarRef, view, onNavigate, drawer, phone, inert, sessions, ownerId, session, onSelect, closeDrawer, theme, onTheme, web }: {
  sidebarRef: Ref<HTMLElement>; view: View; onNavigate: (view: View) => void;
  /** Open as the phone drawer. */ drawer: boolean; phone: boolean; inert: boolean;
  sessions: WebSession[]; ownerId: string | null; session?: WebSession; onSelect: (id: string) => void;
  /** Closes the drawer; `refocus` hands focus back to the menu button. */ closeDrawer: (refocus: boolean) => void;
  theme: Theme; onTheme: (theme: Theme) => void;
  web: Pick<Web, "bootstrap" | "refreshBootstrap" | "compact" | "tasks" | "connection" | "rateLimit">;
}) {
  const { t } = useTranslation();
  return <aside ref={sidebarRef} id="sidebar" data-state={drawer ? "open" : "closed"} {...(drawer ? { role: "dialog", "aria-modal": true } : {})}
    className="flex w-[272px] shrink-0 flex-col gap-1 overflow-y-auto border-r px-4 pt-4 pb-4 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] max-[1024px]:w-[232px] max-[1024px]:px-3.5 max-[800px]:w-[204px] max-[800px]:px-3 max-[600px]:fixed max-[600px]:top-(--app-header) max-[600px]:bottom-0 max-[600px]:left-0 max-[600px]:z-30 max-[600px]:w-[min(320px,86vw)] max-[600px]:bg-background max-[600px]:px-4 max-[600px]:pt-4 max-[600px]:pb-[max(1.25rem,env(safe-area-inset-bottom))] max-[600px]:shadow-2xl max-[600px]:transition-transform max-[600px]:duration-[220ms] max-[600px]:data-[state=closed]:-translate-x-full max-[600px]:data-[state=closed]:shadow-none"
    aria-label={t("sidebar.label")} inert={inert || (phone && !drawer)} aria-hidden={phone && !drawer ? true : undefined}>
    <nav aria-label={t("sidebar.workspace")} className="mb-6 flex flex-col gap-0.5">
      {NAVIGATION.map(([target, label, Icon]) =>
        <Button key={label} variant="ghost" aria-current={view === target ? "page" : undefined} onClick={() => { onNavigate(target); if (drawer) closeDrawer(false); }}
          className="h-8 justify-start gap-2.5 rounded-lg px-2.5 text-[13px] font-normal text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground aria-[current=page]:bg-foreground/[0.08] aria-[current=page]:font-medium aria-[current=page]:text-foreground max-[600px]:h-10 max-[600px]:text-[14px]">
          <Icon strokeWidth={1.75} /><span>{t(label)}</span></Button>)}
    </nav>
    <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
      <p className="eyebrow">{t("sidebar.conversations")}</p>
      <span id="session-label" className="sr-only">{t("sidebar.session")}</span>
      {session?.kind === "group" && <Badge variant="outline" className="rounded-md tracking-[0.02em] text-[10px] font-normal text-muted-foreground">{t("sidebar.readOnly")}</Badge>}
    </div>
    <SessionPicker sessions={sessions} ownerId={ownerId} session={session} onSelect={onSelect} drawer={drawer} closeDrawer={closeDrawer} />
    {session?.kind === "group" && <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{t("sidebar.groupNote")}</p>}
    <ContextWindow session={session} web={web} />
    <PlanUsage ready={!!web.bootstrap} locked={web.connection === "locked"} live={web.rateLimit} />
    {/* Theme: pinned to the bottom of the sidebar (and of the phone drawer). */}
    <div className="mt-auto flex items-center justify-between gap-3 px-0.5 pt-6 max-[600px]:mt-6">
      <span className="eyebrow">{t("theme.heading")}</span>
      <ToggleGroup type="single" aria-label={t("theme.label")} value={theme} onValueChange={(value) => { if (value) onTheme(value as Theme); }}
        className="rounded-xl bg-foreground/[0.05] p-0.5 max-[600px]:rounded-[13px]">
        {THEMES.map(([value, label, Icon]) =>
          <ToggleGroupItem key={value} value={value} aria-label={t(label)} title={t(label)}
            className="size-7 rounded-[9px]! px-0 text-muted-foreground max-[600px]:size-10 max-[600px]:rounded-[11px]! hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-foreground/[0.13] [&_svg:not([class*='size-'])]:size-3.5 max-[600px]:[&_svg:not([class*='size-'])]:size-[18px]">
            <Icon strokeWidth={1.75} /></ToggleGroupItem>)}
      </ToggleGroup>
    </div>
  </aside>;
}

const mainTag = "ml-auto flex shrink-0 items-center gap-1 pl-3 tracking-[0.02em] text-[10px] whitespace-nowrap text-muted-foreground";

/** The conversation picker: the main (owner) session first, set apart; the rest keep the catalog's order. */
function SessionPicker({ sessions, ownerId, session, onSelect, drawer, closeDrawer }: {
  sessions: WebSession[]; ownerId: string | null; session?: WebSession; onSelect: (id: string) => void; drawer: boolean; closeDrawer: (refocus: boolean) => void;
}) {
  // A conversation picked with the pointer: the menu closes without handing focus back to
  // its trigger, which Chromium would then draw with a keyboard focus ring. Keys keep it.
  const pickedByPointer = useRef(false);
  // A pick in the phone drawer: the drawer closed and its menu button took focus already.
  const pickedInDrawer = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { t } = useTranslation();
  const pickerSessions = pinOwnerFirst(sessions, ownerId);
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild disabled={!sessions.length}>
      <Button ref={trigger} variant="outline" aria-labelledby="session-label session-value"
        className="h-9 w-full min-w-0 justify-between rounded-lg bg-card px-3 text-[13px] max-[600px]:h-10 font-normal shadow-xs hover:bg-accent">
        <span id="session-value" className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate" title={session?.title}>{session ? session.kind === "group" ? t("sidebar.groupTitle", { title: session.title }) : session.title : t("sidebar.noSession")}</span>
          {session && session.id === ownerId && <span data-testid="session-main" role="img" aria-label={t("sidebar.mainSession")} title={t("sidebar.mainSession")} className="ml-auto flex shrink-0 pl-1"><Pin aria-hidden="true" className="size-3.5 text-primary" strokeWidth={2} /></span>}
        </span>
        <ChevronsUpDown className="text-muted-foreground" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-auto max-w-[min(22rem,calc(100vw-2rem))] min-w-(--radix-dropdown-menu-trigger-width) rounded-xl p-1"
      onPointerDown={() => { pickedByPointer.current = true; }} onKeyDown={() => { pickedByPointer.current = false; }}
      onCloseAutoFocus={(event) => {
        // Focus goes back to the trigger (so Tab continues from there), without a ring after a pointer pick;
        // after a pick in the phone drawer it is already on the menu button (the trigger is inert by now).
        if (pickedInDrawer.current) event.preventDefault();
        else if (pickedByPointer.current) { event.preventDefault(); trigger.current?.focus({ focusVisible: false } as FocusOptions); }
        pickedByPointer.current = false; pickedInDrawer.current = false; }}>
      <DropdownMenuLabel className="px-2 py-1.5 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{t("sidebar.picker")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={session?.id ?? ""} onValueChange={(value) => { onSelect(value); if (drawer) { pickedInDrawer.current = true; closeDrawer(!pickedByPointer.current); } }}>
        {pickerSessions.map((s, i) => <Fragment key={s.id}>
          <DropdownMenuRadioItem value={s.id} className="rounded-lg py-2 text-[13px]">
            <span className="min-w-0 truncate" title={s.title}>{s.title}</span>
            {s.id === ownerId ? <span className={mainTag}><Pin aria-hidden="true" className="size-3 text-primary" strokeWidth={2} />{t("sidebar.mainTag")}</span>
              : s.kind === "group" && <span className={mainTag}>{t("sidebar.readOnlyTag")}</span>}
          </DropdownMenuRadioItem>
          {s.id === ownerId && i < pickerSessions.length - 1 && <DropdownMenuSeparator />}
        </Fragment>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** The selected conversation's context window, with Compact for the owner's own. */
function ContextWindow({ session, web }: { session?: WebSession; web: Pick<Web, "bootstrap" | "refreshBootstrap" | "compact" | "tasks"> }) {
  const { t } = useTranslation();
  const usage = session?.stats;
  const ownerId = web.bootstrap?.ownerId;
  return <section className="mt-7 px-0.5" aria-labelledby="context-heading">
    <div className="mb-2 flex items-center justify-between gap-2"><p className="eyebrow m-0" id="context-heading">{t("context.heading")}</p>
      <CompactButton bootstrap={web.bootstrap} refresh={web.refreshBootstrap} ownerSession={!!session && session.id === ownerId}
        running={web.tasks.filter((t) => t.sessionId === ownerId && t.state === "running" && !t.ambient).length}
        request={web.compact} /></div>
    {usage?.contextMax ? <>
      <p className="mb-2 text-base tabular-nums" title={usage.contextEstimated ? t("context.estimated") : t("context.reported")}>
        {usage.contextEstimated ? "~" : ""}{formatNumber(usage.contextUsed)} <span className="text-xs text-muted-foreground">/ {formatNumber(usage.contextMax)}</span></p>
      <Progress max={usage.contextMax} value={Math.min(usage.contextUsed, usage.contextMax)} aria-label={t("context.progress")} className="h-1.5 bg-border" />
    </> : <>
      <p className="mb-2 text-base tabular-nums">{t("context.unavailable")}</p>
      <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{t("context.empty")}</p>
    </>}
  </section>;
}
