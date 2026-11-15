import { createContext, useContext, useEffect, useImperativeHandle, useMemo, useRef, type ReactNode, type Ref } from "react";
import { ArrowDown } from "lucide-react";
import {
  MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
  useMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility,
} from "@/components/ui/message-scroller";
import type { ChatRow as Row } from "./chat-rows.js";
import { jumpLabel, jumpVisible, unseenKeys } from "./inline-tools.js";
import { useMountedFor } from "./motion.js";

/**
 * The main chat's scroll behaviour: shadcn's Message Scroller (follow the
 * live edge only while the reader is there, anchor a new turn near the top,
 * keep the reader's place when history is prepended or a row changes size,
 * reopen at the last turn), plus what Tomo adds on its hooks: the "N new
 * messages" pill and a quoted-message jump.
 *
 * Mount one per conversation (key it): the opening position is applied once.
 */
export interface ChatScrollerHandle {
  /** Brings a row (`rowId`) into view, centred; false when it is not mounted. */
  scrollToRow(id: string): boolean;
  /** A message this tab is sending: never "new" to this reader, so it anchors its turn wherever the reader was. */
  claim(key: string): void;
}

const NONE: ReadonlySet<string> = new Set();
/** Unseen message keys, for the rows: one that arrived while the reader was away does not pull them to it. */
const Unseen = createContext<ReadonlySet<string>>(NONE);
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
  const joined = keys.join("\n");
  // `joined` stands in for `keys`, a fresh array every render.
  const unseen = useMemo(() => atEnd ? NONE : unseenKeys(baseline.current!, keys), [atEnd, joined]);
  useEffect(() => { if (atEnd) baseline.current = new Set(keys); });
  useImperativeHandle(handle, () => ({
    scrollToRow: (id) => scrollToMessage(id, { align: "center", behavior: reducedMotion() ? "auto" : "smooth" }),
    claim: (key) => { baseline.current?.add(key); },
  }), [scrollToMessage]);
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
  const count = unseen.size;
  return <MessageScroller className="min-h-0 w-full flex-1">
    <MessageScrollerViewport ref={viewport} aria-label="Conversation history" className="pt-2 pr-4 pb-6 max-[600px]:pr-2"
      onPointerDown={(e) => { dragging.current = e.target === e.currentTarget; }} onPointerUp={() => { dragging.current = false; }}
      onScroll={(e) => { if (dragging.current) { dragging.current = false; e.currentTarget.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); } }}>
      {top}
      <MessageScrollerContent aria-busy={busy} className="min-h-0 gap-0"><Unseen.Provider value={unseen}>{children}</Unseen.Provider></MessageScrollerContent>
    </MessageScrollerViewport>
    <JumpToLatest visible={jumpVisible({ canScrollEnd: end, lastRowVisible: !lastRowId || visibleMessageIds.includes(lastRowId), unseen: count })} unseen={count} onJump={jump} />
  </MessageScroller>;
}

/** One transcript row. Its anchor yields while the message is unseen: arriving while the reader is away, it must not move them. */
export function ChatRow({ row, children }: { row: Row; children: ReactNode }) {
  const unseen = useContext(Unseen);
  return <MessageScrollerItem messageId={row.id} scrollAnchor={row.anchor && !unseen.has(row.key)}>{children}</MessageScrollerItem>;
}

/** Floats above the composer when the reader is up in the history; fades out at the end. */
function JumpToLatest({ visible, unseen, onJump }: { visible: boolean; unseen: number; onJump: () => void }) {
  const motion = useMountedFor(visible, 180);
  if (!motion.mounted) return null;
  const label = jumpLabel(unseen);
  return <button type="button" onClick={onJump} data-state={motion.shown ? "open" : "closed"} tabIndex={visible ? 0 : -1}
    aria-label={label ? `${label}, jump to latest` : "Jump to latest"}
    className="absolute bottom-3 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-card px-3 text-[12px] text-foreground shadow-md transition-[opacity,transform] duration-[180ms] ease-[var(--ease-soft)] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=closed]:pointer-events-none data-[state=closed]:translate-y-1 data-[state=closed]:opacity-0">
    {label && <span aria-hidden="true">{label}</span>}<ArrowDown className="size-3.5" strokeWidth={2} aria-hidden="true" /></button>;
}
