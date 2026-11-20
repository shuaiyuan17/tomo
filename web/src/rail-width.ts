import { i18n } from "./i18n/index.js";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

/** Tasks rail width the owner chose by dragging, kept across reloads. */
export const RAIL_WIDTH_KEY = "tomo.tasksRailWidth";
export const RAIL_MIN = 280;
export const RAIL_MAX = 720;
/** The conversation never gets narrower than this because of the rail. */
export const CHAT_MIN = 480;
export const RAIL_KEY_STEP = 16;
export const RAIL_KEY_STEP_LARGE = 64;

export interface RailBounds { min: number; max: number }

/** The stylesheet's width for the pinned rail (main.tsx: w-[300px]; at 1024 and below the rail is an overlay and is not resized, so 280 there is only a floor); never below RAIL_MIN. */
export function railDefaultWidth(viewport: number): number {
  return viewport <= 1024 ? 280 : 300;
}

/**
 * How wide the rail may be: at least RAIL_MIN; at most RAIL_MAX, half the
 * viewport, and whatever leaves the chat CHAT_MIN next to the sidebar.
 * Null when even RAIL_MIN would squeeze the chat: no resizing there.
 */
export function railBounds(viewport: number, sidebar: number): RailBounds | null {
  const max = Math.floor(Math.min(RAIL_MAX, viewport / 2, viewport - sidebar - CHAT_MIN));
  return max >= RAIL_MIN ? { min: RAIL_MIN, max } : null;
}

export function clampRailWidth(width: number, bounds: RailBounds): number {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

/**
 * localStorage, or undefined where the browser refuses it. Reading the
 * PROPERTY can throw (SecurityError when storage is blocked), not just
 * getItem/setItem, so it is fetched inside the try too; without storage the
 * width lives in memory only.
 */
export function safeLocalStorage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** The stored width, if it is a sane number (bounds are applied at use). */
export function readRailWidth(storage: Pick<Storage, "getItem"> | undefined): number | null {
  try {
    const value = Number(storage?.getItem(RAIL_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

export function writeRailWidth(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, width: number | null): void {
  try {
    if (width === null) storage?.removeItem(RAIL_WIDTH_KEY);
    else storage?.setItem(RAIL_WIDTH_KEY, String(Math.round(width)));
  } catch { /* private mode: the width just does not persist */ }
}

/**
 * Keyboard on the separator. The rail sits on the right, so ArrowLeft
 * widens it and ArrowRight narrows it; Shift takes bigger steps; Home and
 * End go to the bounds. Undefined for any other key.
 */
export function railWidthForKey(key: string, shift: boolean, width: number, bounds: RailBounds): number | undefined {
  const step = shift ? RAIL_KEY_STEP_LARGE : RAIL_KEY_STEP;
  if (key === "ArrowLeft") return clampRailWidth(width + step, bounds);
  if (key === "ArrowRight") return clampRailWidth(width - step, bounds);
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  return undefined;
}

/**
 * The rail's width state and the separator's handlers.
 *
 * DRAGGING NEVER REFLOWS THE CHAT PER FRAME (the #500 lesson). While the
 * pointer moves, only a thin guide line follows it: a transform written
 * straight to a fixed element, at most once per frame, with no React state
 * (so the page does not even re-render). The rail and the chat keep their
 * widths; the width is written once, on release, so the conversation
 * reflows once.
 */
export function useRailWidth(options: { enabled: boolean; sidebar: () => number }) {
  const [storage] = useState(safeLocalStorage);
  const [stored, setStored] = useState<number | null>(() => readRailWidth(storage));
  const [viewport, setViewport] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  const guide = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const frame = useRef(0);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const bounds = options.enabled ? railBounds(viewport, options.sidebar()) : null;
  /** The width to apply inline, or null to keep the stylesheet default. */
  const width = bounds && stored !== null ? clampRailWidth(stored, bounds) : null;
  const current = width ?? railDefaultWidth(viewport);

  const commit = useCallback((next: number | null) => {
    setStored(next);
    writeRailWidth(storage, next);
  }, [storage]);

  const placeGuide = (x: number | null) => {
    const line = guide.current;
    if (!line) return;
    line.hidden = x === null;
    if (x !== null) line.style.transform = `translateX(${x}px)`;
  };
  const widthAt = (clientX: number) => (bounds ? clampRailWidth(viewport - clientX, bounds) : current);
  const moved = useRef(false);
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!bounds || event.button !== 0) return;
    // No preventDefault: it would cancel the compatibility mouse events and
    // with them the double-click that resets the width. Text selection is
    // held off by the body class instead.
    moved.current = false;
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("rail-resizing");
    placeGuide(viewport - current);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!dragging.current || !bounds) return;
    moved.current = true;
    const x = viewport - widthAt(event.clientX);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => placeGuide(x));
  };
  const finish = (event: PointerEvent<HTMLElement>, keep: boolean) => {
    if (!dragging.current) return;
    dragging.current = false;
    cancelAnimationFrame(frame.current);
    document.body.classList.remove("rail-resizing");
    placeGuide(null);
    // A press without a move (a click, half of a double-click) changes nothing.
    if (keep && bounds && moved.current) commit(widthAt(event.clientX));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!bounds) return;
    const next = railWidthForKey(event.key, event.shiftKey, current, bounds);
    if (next === undefined) return;
    event.preventDefault();
    commit(next);
  };
  const separator = bounds ? {
    role: "separator" as const,
    tabIndex: 0,
    "aria-label": i18n.t("common:tasksRail.resize"),
    "aria-orientation": "vertical" as const,
    "aria-valuenow": current,
    "aria-valuemin": bounds.min,
    "aria-valuemax": bounds.max,
    onPointerDown, onPointerMove,
    onPointerUp: (event: PointerEvent<HTMLElement>) => finish(event, true),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => finish(event, false),
    onKeyDown,
    // Double-click resets. Read off the second press's click count: pointer
    // capture keeps the browser from synthesising a dblclick on the handle.
    onMouseDown: (event: MouseEvent<HTMLElement>) => { if (event.detail === 2) commit(null); },
  } : null;
  return { width, separator, guide };
}
