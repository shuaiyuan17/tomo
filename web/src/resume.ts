/**
 * The page came back: the tab was hidden and shows again, or the page was
 * restored from the back/forward cache (`pageshow` with `persisted`). iOS
 * Safari suspends a backgrounded page outright: timers stop, an open fetch
 * stream can be dropped without an error ever reaching the reader, and the
 * compositor can keep a stale frame. Whatever survived the suspension is
 * suspect, so callers re-sync here. `hiddenFor` is how long the page was
 * away (Infinity after a back/forward-cache restore).
 */
export function onResume(callback: (hiddenFor: number) => void, target: Pick<Document, "addEventListener" | "removeEventListener"> & { hidden: boolean } = document,
  view: Pick<Window, "addEventListener" | "removeEventListener"> = window, now: () => number = Date.now): () => void {
  let hiddenAt = target.hidden ? now() : undefined;
  const visibility = () => {
    if (target.hidden) { hiddenAt ??= now(); return; }
    if (hiddenAt === undefined) return;
    const hiddenFor = now() - hiddenAt;
    hiddenAt = undefined;
    callback(hiddenFor);
  };
  // A page restored from the back/forward cache was frozen for an unknown time.
  const pageshow = (event: Event) => { if ((event as PageTransitionEvent).persisted) { hiddenAt = undefined; callback(Infinity); } };
  target.addEventListener("visibilitychange", visibility);
  view.addEventListener("pageshow", pageshow);
  return () => { target.removeEventListener("visibilitychange", visibility); view.removeEventListener("pageshow", pageshow); };
}

/** Has the compositor redraw `element`: a one-frame layer of its own, then back. */
export function repaint(element: HTMLElement | null | undefined): void {
  if (!element) return;
  element.style.transform = "translateZ(0)";
  requestAnimationFrame(() => { element.style.transform = ""; });
}
