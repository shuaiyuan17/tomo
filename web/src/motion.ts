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

/** The entrance's length: `--motion-enter` in styles.css (a test keeps the two equal). */
export const ENTER_MS = 260;

/**
 * For an element that takes over from one already rising in (a streamed reply
 * block, replaced by the recorded message): the `animation-delay` (negative)
 * that carries the entrance on from where the first one was, or null when
 * that entrance is over and the new element should just be there.
 */
export function resumeDelay(shownAt: number, now: number, duration = ENTER_MS): number | null {
  const elapsed = Math.max(0, now - shownAt);
  return elapsed < duration ? 0 - Math.round(elapsed) : null;
}

/** How long an id stays "appeared": longer than any entrance (see the `--motion-*` durations in styles.css). */
export const APPEARED_HOLD_MS = 400;

/** The ids that appeared less than `hold` ms before `now`. */
export function heldIds(appearedAt: ReadonlyMap<string, number>, now: number, hold = APPEARED_HOLD_MS): string[] {
  return [...appearedAt].filter(([, at]) => now - at < hold).map(([id]) => id);
}

/**
 * The ids to animate: appended since the list was first shown for `scope`
 * (a session, a panel). The first non-empty render, and every change of
 * scope, animates nothing.
 *
 * An id stays in the set for APPEARED_HOLD_MS, not for one render: the
 * entrance class must outlive the renders that follow at once (a streamed
 * block, a status tick), or the animation is cut off as it starts. Then it
 * leaves (one re-render), so an element shown again later (a hidden page
 * coming back) does not play it a second time.
 */
export function useAppeared(ids: readonly string[], scope: string, ready = true): Set<string> {
  const known = useRef<{ scope: string; ids: Set<string>; appearedAt: Map<string, number> } | null>(null);
  const [, rerender] = useState(0);
  const sameScope = ready && known.current?.scope === scope ? known.current : null;
  const fresh = sameScope ? appendedIds(sameScope.ids, ids) : new Set<string>();
  if (sameScope) for (const id of heldIds(sameScope.appearedAt, performance.now())) fresh.add(id);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    if (!ready) return;
    if (!known.current || known.current.scope !== scope) { known.current = { scope, ids: new Set(ids), appearedAt: new Map() }; return; }
    const { ids: seen, appearedAt } = known.current;
    const now = performance.now();
    for (const [id, at] of appearedAt) if (now - at >= APPEARED_HOLD_MS) appearedAt.delete(id);
    const added = appendedIds(seen, ids);
    for (const id of ids) seen.add(id);
    if (!added.size) return;
    for (const id of added) appearedAt.set(id, now);
    const timer = setTimeout(() => { timers.current.delete(timer); rerender((n) => n + 1); }, APPEARED_HOLD_MS + 20);
    timers.current.add(timer);
  });
  useEffect(() => { const all = timers.current; return () => { for (const timer of all) clearTimeout(timer); all.clear(); }; }, []);
  return fresh;
}

/**
 * Items that just left `items` stay for `ms` (flagged `exiting`) so they can
 * fade and collapse instead of vanishing and making the list jump.
 */
export function useExiting<T>(items: readonly T[], key: (item: T) => string, ms = 200): Array<{ item: T; exiting: boolean }> {
  const [leaving, setLeaving] = useState<Map<string, { item: T; index: number }>>(new Map());
  const previous = useRef<readonly T[]>(items);
  // One removal timer per leaving item, kept across renders. A parent that re-renders with a fresh
  // `items` array (the Tasks panel does every second) must not cancel them: an item whose timer was
  // cancelled stayed in the list for good, as an invisible row holding open a gap.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const now = new Set(items.map(key));
    const gone = previous.current.map((item, index) => ({ item, index })).filter(({ item }) => !now.has(key(item)));
    previous.current = items;
    const back = [...timers.current.keys()].filter((k) => now.has(k));
    for (const k of back) { clearTimeout(timers.current.get(k)); timers.current.delete(k); }
    if (!gone.length && !back.length) return;
    setLeaving((old) => {
      const next = new Map(old);
      for (const k of back) next.delete(k);
      for (const g of gone) next.set(key(g.item), g);
      return next;
    });
    for (const g of gone) {
      const k = key(g.item);
      clearTimeout(timers.current.get(k));
      timers.current.set(k, setTimeout(() => {
        timers.current.delete(k);
        setLeaving((old) => { const next = new Map(old); next.delete(k); return next; });
      }, ms));
    }
  }, [items, key, ms]);
  useEffect(() => { const all = timers.current; return () => { for (const t of all.values()) clearTimeout(t); all.clear(); }; }, []);
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
