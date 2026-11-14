import { useEffect, useRef, useState } from "react";

/**
 * Small helpers so things animate when they APPEAR, not when a page first
 * renders or reloads (no page-entrance animation).
 */

/** Ids that are new and come after every id already known (appended, not paged in above). */
export function appendedIds(known: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  let lastKnown = -1;
  ids.forEach((id, index) => { if (known.has(id)) lastKnown = index; });
  return new Set(ids.filter((id, index) => index > lastKnown && !known.has(id)));
}

/**
 * The ids to animate in this render: appended since the list was first
 * shown for `scope` (a session, a panel). The first non-empty render, and
 * every change of scope, animates nothing.
 */
export function useAppeared(ids: readonly string[], scope: string, ready = true): Set<string> {
  const known = useRef<{ scope: string; ids: Set<string> } | null>(null);
  const fresh = !ready || !known.current || known.current.scope !== scope ? new Set<string>() : appendedIds(known.current.ids, ids);
  useEffect(() => {
    if (!ready) return;
    if (!known.current || known.current.scope !== scope) known.current = { scope, ids: new Set(ids) };
    else for (const id of ids) known.current.ids.add(id);
  });
  return fresh;
}

/**
 * Items that just left `items` stay for `ms` (flagged `exiting`) so they can
 * fade and collapse instead of vanishing and making the list jump.
 */
export function useExiting<T>(items: readonly T[], key: (item: T) => string, ms = 200): Array<{ item: T; exiting: boolean }> {
  const [leaving, setLeaving] = useState<Map<string, { item: T; index: number }>>(new Map());
  const previous = useRef<readonly T[]>(items);
  useEffect(() => {
    const now = new Set(items.map(key));
    const gone = previous.current.map((item, index) => ({ item, index })).filter(({ item }) => !now.has(key(item)));
    previous.current = items;
    if (!gone.length) return;
    setLeaving((old) => { const next = new Map(old); for (const g of gone) next.set(key(g.item), g); return next; });
    const timer = setTimeout(() => setLeaving((old) => { const next = new Map(old); for (const g of gone) next.delete(key(g.item)); return next; }), ms);
    return () => clearTimeout(timer);
  }, [items, key, ms]);
  const out: Array<{ item: T; exiting: boolean }> = items.map((item) => ({ item, exiting: false }));
  for (const { item, index } of [...leaving.values()].sort((a, b) => a.index - b.index)) {
    if (!out.some((o) => key(o.item) === key(item))) out.splice(Math.min(index, out.length), 0, { item, exiting: true });
  }
  return out;
}

/** Mounted while open plus `ms` after closing, so a panel can animate out. */
export function useMountedFor(open: boolean, ms = 220): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Next frame: let the closed state paint first, then transition to open.
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(timer);
  }, [open, ms]);
  return { mounted, shown };
}

/**
 * Ref for an element starting its exit: records its real height so the
 * collapse starts from there (not from a guessed maximum).
 */
export function measureExit(el: HTMLElement | null): void {
  if (el) el.style.setProperty("--motion-exit-from", `${el.offsetHeight}px`);
}
