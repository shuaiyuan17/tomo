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

type NudgeDoc = Pick<Document, "createElement" | "querySelectorAll"> & { body: Pick<HTMLElement, "appendChild"> };
type NudgeView = Pick<Window, "scrollTo" | "scrollY" | "requestAnimationFrame">;

/**
 * Has Safari re-lay its own top-edge glass. On an iPhone Duo's cover screen,
 * after switching back from another app, Safari draws that glass over the
 * page header (apple.com too); a real scroll of the document clears it,
 * scrolling an inner pane does not. The app's document never scrolls, so
 * give it one extra pixel, scroll it by that pixel and back, then take the
 * pixel away; and touch theme-color, which Safari also re-reads for its bars.
 */
export function nudgeBrowserChrome(doc: NudgeDoc = document, view: NudgeView = window): void {
  const spacer = doc.createElement("div");
  spacer.setAttribute("aria-hidden", "true");
  spacer.style.cssText = "height:2px;width:1px;pointer-events:none";
  doc.body.appendChild(spacer);
  const top = view.scrollY;
  view.scrollTo(0, top + 1);
  const metas = [...doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  const colours = metas.map((meta) => meta.content);
  for (const meta of metas) meta.content = meta.content.toUpperCase() === meta.content ? meta.content.toLowerCase() : meta.content.toUpperCase();
  view.requestAnimationFrame(() => {
    view.scrollTo(0, top);
    metas.forEach((meta, i) => { meta.content = colours[i]!; });
    view.requestAnimationFrame(() => spacer.remove());
  });
}
