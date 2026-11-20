import { createContext, useContext, useEffect, useImperativeHandle, useMemo, useRef, type ReactNode, type Ref } from "react";
import { ArrowDown } from "lucide-react";
import {
  MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
  useMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility,
} from "@/components/ui/message-scroller";
import { openingAnchors, type ChatRow as Row } from "./chat-rows.js";
import { jumpLabel, jumpVisible, unseenKeys } from "./inline-tools.js";
import { useMountedFor } from "./motion.js";
import { i18n } from "./i18n/index.js";

/**
 * The main chat's scroll behaviour: shadcn's Message Scroller (follow the
 * live edge only while the reader is there, keep the reader's place when
 * history is prepended or a row changes size, reopen at the last turn), plus
 * what Tomo adds on its hooks: the "N new messages" pill and a quoted-message
 * jump.
 *
 * A new turn is not anchored near the top: the scroller would hold a spacer
 * of nearly a screen under it for the reply, mostly empty while the reply is
 * short or not there yet. Only the rows the conversation opened with may be
 * scroll anchors (that is all "last-anchor" needs); after that a message goes
 * in at the end and, while the reader is there, the view follows the end, so
 * a sent message (and its picture, once loaded) is just fully shown, then the
 * reply as it grows.
 *
 * Mount one per conversation (key it): the opening position is applied once.
 */
export interface ChatScrollerHandle {
  /** Brings a row (`rowId`) into view, centred; false when it is not mounted. */
  scrollToRow(id: string): boolean;
  /** A message this tab is sending: never "new" to this reader, and it takes the reader to the end, to follow its turn. */
  claim(key: string): void;
}

const NONE: ReadonlySet<string> = new Set();
/** The rows that may be scroll anchors: those the conversation opened with. */
const Anchors = createContext<ReadonlySet<string>>(NONE);
/** Keys that scroll a viewport down. */
const DOWN_KEYS: ReadonlySet<string> = new Set(["End", "PageDown", "ArrowDown", " "]);
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * `keys`: the conversation's messages in order (messageKey / pendingKey /
 * blockKey), so a streamed reply and its recorded copy count once.
 * `top`: what sits above the transcript (Load earlier, notes); not rows.
 */
export function ChatScroller(props: { keys: readonly string[]; lastRowId?: string; busy: boolean; top: ReactNode; handle: Ref<ChatScrollerHandle>; children: ReactNode }) {
  return <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor"><Frame {...props} /></MessageScrollerProvider>;
}

function Frame({ keys, lastRowId, busy, top, handle, children }: Parameters<typeof ChatScroller>[0]) {
  const { end } = useMessageScrollerScrollable();
  const { visibleMessageIds } = useMessageScrollerVisibility();
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  const viewport = useRef<HTMLDivElement>(null);
  // At the end (or following it) the scroller reports nothing to scroll toward.
  const atEnd = !end;
  // What was there when the reader was last at the end; only what came after it counts.
  const baseline = useRef<Set<string> | null>(null);
  if (!baseline.current) baseline.current = new Set(keys);
  const claimed = useRef(new Set<string>());
  const opening = useRef<ReadonlySet<string> | null>(null);
  if (!opening.current && keys.length) opening.current = openingAnchors(keys, claimed.current);
  const joined = keys.join("\n");
  // `joined` stands in for `keys`, a fresh array every render.
  const unseen = useMemo(() => atEnd ? NONE : unseenKeys(baseline.current!, keys), [atEnd, joined]);
  useEffect(() => { if (atEnd) baseline.current = new Set(keys); });
  useImperativeHandle(handle, () => ({
    scrollToRow: (id) => scrollToMessage(id, { align: "center", behavior: reducedMotion() ? "auto" : "smooth" }),
    claim: (key) => { baseline.current?.add(key); claimed.current.add(key); scrollToEnd({ behavior: "auto" }); },
  }), [scrollToMessage, scrollToEnd]);
  const jump = () => {
    scrollToEnd({ behavior: reducedMotion() ? "auto" : "smooth" });
    // The pill goes away under the pointer; keyboard focus stays in the conversation.
    viewport.current?.focus({ preventScroll: true });
  };
  // Dragging the scrollbar is a scroll by the reader too, but the scroller
  // only hears wheel, touch and keys: without this, a view anchored to a turn
  // would snap back to it at the next layout change. A synthetic wheel event
  // reaches its handler (and scrolls nothing).
  const dragging = useRef(false);
  // The scroller lets go of the end on any wheel, touch or scroll key, and
  // only takes it back on a scroll that lands there. At the end already, a
  // move further down scrolls nothing, so the view would stop following the
  // reply under a reader who never left: take the end back for it.
  const refollow = (el: HTMLElement) => { if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) scrollToEnd({ behavior: "auto" }); };
  const touchY = useRef<number | null>(null);
  const count = unseen.size;
  return <MessageScroller className="-mr-4 min-h-0 w-auto flex-1 self-stretch max-[600px]:-mr-2">
    <MessageScrollerViewport ref={viewport} aria-label={i18n.t("chat:scroll.history")} className="pt-2 pr-4 pb-6 max-[600px]:pr-2"
      onPointerDown={(e) => { dragging.current = e.target === e.currentTarget; }} onPointerUp={() => { dragging.current = false; }}
      onWheel={(e) => { if (e.deltaY > 0) refollow(e.currentTarget); }}
      onKeyDown={(e) => { if (DOWN_KEYS.has(e.key) && !(e.key === " " && e.shiftKey)) refollow(e.currentTarget); }}
      onTouchStart={(e) => { touchY.current = e.touches[0]?.clientY ?? null; }}
      onTouchMove={(e) => { const y = e.touches[0]?.clientY; if (touchY.current !== null && y !== undefined && y < touchY.current) refollow(e.currentTarget); }}
      onScroll={(e) => { if (dragging.current) { dragging.current = false; e.currentTarget.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); } }}>
      {top}
      <MessageScrollerContent aria-busy={busy} className="min-h-0 gap-0"><Anchors.Provider value={opening.current ?? NONE}>{children}</Anchors.Provider></MessageScrollerContent>
    </MessageScrollerViewport>
    {/* The history softens into the composer: an overlay beside the viewport, never a mask on it (an
        ancestor's mask clips fixed descendants such as the image Lightbox). It leaves the scrollbar gutter alone. */}
    <div aria-hidden="true" data-slot="chat-fade" className="pointer-events-none absolute right-4 bottom-0 left-0 h-5 bg-linear-to-b from-transparent to-background max-[600px]:right-2" />
    <JumpToLatest visible={jumpVisible({ canScrollEnd: end, lastRowVisible: !lastRowId || visibleMessageIds.includes(lastRowId), unseen: count })} unseen={count} onJump={jump} />
  </MessageScroller>;
}

/** One transcript row: a scroll anchor only when it is the latest turn of the conversation as it opened. */
export function ChatRow({ row, children }: { row: Row; children: ReactNode }) {
  const anchors = useContext(Anchors);
  return <MessageScrollerItem messageId={row.id} scrollAnchor={row.anchor && anchors.has(row.key)}>{children}</MessageScrollerItem>;
}

/** Floats above the composer when the reader is up in the history; fades out at the end. */
function JumpToLatest({ visible, unseen, onJump }: { visible: boolean; unseen: number; onJump: () => void }) {
  const motion = useMountedFor(visible, 180);
  if (!motion.mounted) return null;
  const label = jumpLabel(unseen);
  return <button type="button" onClick={onJump} data-state={motion.shown ? "open" : "closed"} tabIndex={visible ? 0 : -1}
    aria-label={label ? i18n.t("chat:scroll.jumpWith", { label }) : i18n.t("chat:scroll.jump")}
    className="absolute bottom-3 left-[calc(50%-0.5rem)] z-10 max-[600px]:left-[calc(50%-0.25rem)] flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-card px-3 text-[12px] text-foreground shadow-md transition-[opacity,transform] duration-[180ms] ease-[var(--ease-soft)] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=closed]:pointer-events-none data-[state=closed]:translate-y-1 data-[state=closed]:opacity-0">
    {label && <span aria-hidden="true">{label}</span>}<ArrowDown className="size-3.5" strokeWidth={2} aria-hidden="true" /></button>;
}
