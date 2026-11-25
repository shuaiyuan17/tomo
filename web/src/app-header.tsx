import type { ReactNode, Ref } from "react";
import { ListChecks, MessageCircle, Monitor, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { useWeb } from "./use-web.js";
import { useTranslation } from "./i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: common:connection.*

export type View = "conversation" | "home" | "study";

/** Tomo's mark: one open stroke. */
export function Mark({ className }: { className?: string }) {
  return <svg className={cn("size-10 shrink-0 fill-none stroke-primary stroke-2 [stroke-linecap:round]", className)} viewBox="0 0 40 40" aria-hidden="true"><path d="M 32 14 C 36 20, 32 32, 20 32 C 8 32, 5 22, 10 14 C 14 7, 26 6, 30 12" /></svg>;
}

/** A layer toggle in the top bar (pressed while its layer is open). */
interface Toggle { ref: Ref<HTMLButtonElement>; pressed: boolean; onToggle: () => void }

const toggleClass = "relative size-10 rounded-xl text-foreground max-[600px]:size-11 compact:size-11 hover:bg-foreground/[0.07] aria-pressed:bg-foreground/[0.11] aria-pressed:hover:bg-foreground/[0.14] [&_svg:not([class*='size-'])]:size-5";

const CONNECTION_LABELS = {
  live: "connection.live", locked: "connection.locked", connecting: "connection.connecting", reconnecting: "connection.reconnecting",
} as const satisfies Record<ReturnType<typeof useWeb>["connection"], string>;

/**
 * The top bar: the phone menu button, the wordmark, where you are, and the
 * layer toggles (the conversation beside Home's room, Tasks, the screen) with
 * the connection state.
 */
export function AppHeader({ headerRef, view, phoneTitle, menu, chat, tasks, screen, connection }: {
  headerRef: Ref<HTMLElement>; view: View;
  /** Phones have no sidebar on screen: Home, or a group being read, is named in the bar. */
  phoneTitle?: string;
  menu: Toggle;
  /** Home only: the conversation beside the room, with a dot for a reply not seen yet. */
  chat?: Toggle & { unread: boolean };
  tasks: Toggle & { running: number };
  /** Offered with the owner conversation only. */
  screen?: Toggle;
  connection: ReturnType<typeof useWeb>["connection"];
}) {
  const { t } = useTranslation();
  return <header ref={headerRef} className="flex h-[72px] shrink-0 items-center gap-8 border-b px-8 max-[1024px]:px-6 max-[600px]:h-12 max-[600px]:gap-3 max-[600px]:px-3.5 max-[600px]:pt-[env(safe-area-inset-top)] max-[600px]:box-content compact:h-12 compact:gap-4 compact:px-5 compact:pt-[env(safe-area-inset-top)] compact:box-content">
    <Button ref={menu.ref} variant="ghost" size="icon" aria-expanded={menu.pressed} aria-controls="sidebar" title={t("header.menu")} aria-label={t("header.menuLabel")}
      onClick={menu.onToggle}
      className="-ml-2.5 hidden size-11 shrink-0 rounded-xl text-foreground hover:bg-foreground/[0.07] aria-expanded:bg-foreground/[0.11] max-[600px]:inline-flex [&_svg:not([class*='size-'])]:size-5"><PanelLeft strokeWidth={1.75} /></Button>
    <a className="flex shrink-0 items-center gap-2 font-serif text-[30px] tracking-[-1.5px] text-foreground no-underline max-[600px]:gap-1.5 max-[600px]:text-[22px] max-[600px]:tracking-[-1px] compact:gap-1.5 compact:text-[22px] compact:tracking-[-1px]" href="/" aria-label={t("header.homeLink")}>
      <Mark className="size-9 max-[600px]:size-7 compact:size-7" /><span>tomo<span className="text-primary">.</span></span></a>
    <span className="border-l pl-8 text-sm text-muted-foreground max-[800px]:hidden compact:pl-4">{view === "study" ? t("nav.study") : view === "home" ? t("nav.home") : t("nav.conversation")}</span>
    {phoneTitle && <span className="hidden min-w-0 truncate border-l pl-3 text-[13px] text-muted-foreground max-[600px]:block" title={view === "home" ? undefined : phoneTitle}>{phoneTitle}</span>}
    <div className="ml-auto flex items-center gap-0.5">
      {chat && <ToggleButton toggle={chat} controls="conversation" title={t("nav.conversation")} label={chat.unread ? t("header.chatUnread") : t("header.chat")}>
        <MessageCircle strokeWidth={1.75} />
        {chat.unread && <span aria-hidden="true" data-testid="chat-unread" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-background" />}
      </ToggleButton>}
      <ToggleButton toggle={tasks} controls="tasks-rail" title={t("header.tasks")} label={tasks.running ? t("header.tasksRunning", { count: tasks.running }) : t("header.tasks")}>
        <ListChecks strokeWidth={1.75} />
        {tasks.running > 0 && <span aria-hidden="true" className="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground ring-2 ring-background">{tasks.running > 99 ? "99+" : tasks.running}</span>}
      </ToggleButton>
      {screen && <ToggleButton toggle={screen} controls="screen-window" title={t("header.screen")} label={t("header.screenLabel")}><Monitor strokeWidth={1.75} /></ToggleButton>}
      <span role="status" data-connection={connection} className="ml-1.5 flex items-center gap-2 tracking-[0.02em] text-xs text-muted-foreground max-[600px]:ml-0">
        <i className={cn("size-1.5 rounded-full border border-muted-foreground", connection === "live" && "border-primary bg-primary", connection !== "live" && connection !== "locked" && "animate-pulse")} />
        <span className={cn(connection === "live" && "max-[600px]:sr-only")}>{t(CONNECTION_LABELS[connection])}</span></span>
    </div>
  </header>;
}

function ToggleButton({ toggle, controls, title, label, children }: { toggle: Toggle; controls: string; title: string; label: string; children: ReactNode }) {
  return <Button ref={toggle.ref} variant="ghost" size="icon" aria-pressed={toggle.pressed} aria-controls={controls} title={title}
    aria-label={label} onClick={toggle.onToggle} className={toggleClass}>{children}</Button>;
}
