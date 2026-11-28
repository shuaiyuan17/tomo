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

/**
 * 32px on a desktop, 36px where a finger taps (a phone, or any touch screen), inside the 45px bar;
 * there an invisible 4px margin (::after) still gives each a 44px target, and the toggles sit 8px
 * apart so those targets meet without overlapping.
 */
const touchTarget = "max-phone:after:absolute max-phone:after:-inset-1 max-phone:after:content-[''] pointer-coarse:after:absolute pointer-coarse:after:-inset-1 pointer-coarse:after:content-['']";
const toggleClass = "relative size-8 shrink-0 rounded-lg text-foreground max-phone:size-9 pointer-coarse:size-9 " + touchTarget + " hover:bg-foreground/[0.07] aria-pressed:bg-foreground/[0.11] aria-pressed:hover:bg-foreground/[0.14] [&_svg:not([class*='size-'])]:size-[18px]";

const CONNECTION_LABELS = {
  live: "connection.live", locked: "connection.locked", connecting: "connection.connecting", reconnecting: "connection.reconnecting",
} as const satisfies Record<ReturnType<typeof useWeb>["connection"], string>;

/**
 * The top bar, 45px on every screen: the phone menu button, the wordmark, the
 * name of where you are (one line, nothing under it), and the layer toggles
 * (the conversation beside Home's room, Tasks, the screen) with the
 * connection state.
 */
export function AppHeader({ headerRef, title, menu, chat, tasks, screen, connection }: {
  headerRef: Ref<HTMLElement>;
  /** Where you are: the page's name, or the group being read. */
  title: string;
  menu: Toggle;
  /** Home only: the conversation beside the room, with a dot for a reply not seen yet. */
  chat?: Toggle & { unread: boolean };
  tasks: Toggle & { running: number };
  /** Offered with the owner conversation only. */
  screen?: Toggle;
  connection: ReturnType<typeof useWeb>["connection"];
}) {
  const { t } = useTranslation();
  return <header ref={headerRef} data-testid="app-header" className="relative z-10 flex h-(--app-header) shrink-0 items-center gap-3 border-b px-5 pt-[env(safe-area-inset-top)] max-overlay:px-4 max-phone:gap-2 max-phone:px-2.5">
    <Button ref={menu.ref} variant="ghost" size="icon" aria-expanded={menu.pressed} aria-controls="sidebar" title={t("header.menu")} aria-label={t("header.menuLabel")}
      onClick={menu.onToggle}
      className={cn(touchTarget, "relative hidden size-9 shrink-0 rounded-lg text-foreground hover:bg-foreground/[0.07] aria-expanded:bg-foreground/[0.11] max-phone:inline-flex [&_svg:not([class*='size-'])]:size-[18px]")}><PanelLeft strokeWidth={1.75} /></Button>
    <a className="flex shrink-0 items-center gap-1.5 font-serif text-[21px] leading-none tracking-[-0.8px] text-foreground no-underline" href="/" aria-label={t("header.homeLink")}>
      <Mark className="size-6" /><span className="max-[360px]:sr-only">tomo<span className="text-primary">.</span></span></a>
    <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
    <span data-testid="header-title" className="min-w-0 truncate text-[13px] text-muted-foreground" title={title}>{title}</span>
    <div className="ml-auto flex shrink-0 items-center gap-0.5 max-phone:gap-2 pointer-coarse:gap-2">
      {chat && <ToggleButton toggle={chat} controls="conversation" title={t("nav.conversation")} label={chat.unread ? t("header.chatUnread") : t("header.chat")}>
        <MessageCircle strokeWidth={1.75} />
        {chat.unread && <span aria-hidden="true" data-testid="chat-unread" className="absolute top-1 right-1 size-2 rounded-full bg-primary ring-2 ring-background" />}
      </ToggleButton>}
      <ToggleButton toggle={tasks} controls="tasks-rail" title={t("header.tasks")} label={tasks.running ? t("header.tasksRunning", { count: tasks.running }) : t("header.tasks")}>
        <ListChecks strokeWidth={1.75} />
        {tasks.running > 0 && <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground ring-2 ring-background">{tasks.running > 99 ? "99+" : tasks.running}</span>}
      </ToggleButton>
      {screen && <ToggleButton toggle={screen} controls="screen-window" title={t("header.screen")} label={t("header.screenLabel")}><Monitor strokeWidth={1.75} /></ToggleButton>}
      <span role="status" data-connection={connection} className="ml-1.5 flex items-center gap-2 tracking-[0.02em] text-xs text-muted-foreground max-phone:ml-0.5">
        <i className={cn("size-1.5 shrink-0 rounded-full border border-muted-foreground", connection === "live" && "border-primary bg-primary", connection !== "live" && connection !== "locked" && "animate-pulse")} />
        {/* Connected, the dot says it (the words stay for screen readers). Otherwise the words show: beside the dot on a wide screen;
            on a phone, which has no room in the bar, they hang just under it, whole, and taps go through them to what is under. */}
        <span data-testid="connection-words" className={cn("whitespace-nowrap", connection === "live" ? "sr-only"
          : "max-phone:pointer-events-none max-phone:absolute max-phone:top-full max-phone:right-2.5 max-phone:mt-1.5 max-phone:rounded-full max-phone:border max-phone:bg-card max-phone:px-2.5 max-phone:py-1 max-phone:shadow-xs")}>{t(CONNECTION_LABELS[connection])}</span></span>
    </div>
  </header>;
}

function ToggleButton({ toggle, controls, title, label, children }: { toggle: Toggle; controls: string; title: string; label: string; children: ReactNode }) {
  return <Button ref={toggle.ref} variant="ghost" size="icon" aria-pressed={toggle.pressed} aria-controls={controls} title={title}
    aria-label={label} onClick={toggle.onToggle} className={toggleClass}>{children}</Button>;
}
