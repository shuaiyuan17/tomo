/**
 * Keeps the app the height of what is actually visible, so the on-screen
 * keyboard (iOS / iPadOS Safari) does not push the page up.
 *
 * Safari does not shrink the layout viewport (nor `dvh`) when the keyboard
 * opens: it shrinks the visual viewport and scrolls the whole document to
 * keep the focused field in view, top bar and Tasks rail included. Sizing the
 * app to the visual viewport (`--app-height`) puts the composer above the
 * keyboard on its own, and any scroll Safari did anyway is put back, so the
 * top bar stays where it is and only the chat above the composer gives way.
 * Safari can also pan the visual viewport inside the layout viewport with the
 * document unscrolled; the shell follows that pan (`--vv-top`, a transform),
 * which also makes it the containing block of the fixed layers (the Tasks
 * overlay, the Home chat panel, scrims), so they end at the keyboard too.
 *
 * Nothing here touches focus. While an IME is composing (Chinese, Japanese)
 * the scroll reset waits for `compositionend`, so the candidate window is not
 * moved under the user's fingers; the height still follows the keyboard.
 */
export interface KeyboardViewportDeps {
  viewport: Pick<VisualViewport, "height" | "offsetTop" | "scale" | "addEventListener" | "removeEventListener"> | null | undefined;
  root: { style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty"> };
  doc: Pick<Document, "addEventListener" | "removeEventListener">;
  win: { scrollX: number; scrollY: number; scrollTo(x: number, y: number): void };
  frame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
}

export const APP_HEIGHT_VAR = "--app-height";
export const VIEWPORT_TOP_VAR = "--vv-top";

export function trackKeyboardViewport(deps: Partial<KeyboardViewportDeps> = {}): () => void {
  const viewport = deps.viewport === undefined ? (typeof window === "undefined" ? undefined : window.visualViewport) : deps.viewport;
  if (!viewport) return () => {};
  const root = deps.root ?? document.documentElement;
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const frame = deps.frame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = deps.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));

  let composing = false;
  const clear = () => { root.style.removeProperty(APP_HEIGHT_VAR); root.style.removeProperty(VIEWPORT_TOP_VAR); };
  let pending: number | undefined;
  const settle = () => {
    pending = undefined;
    // Pinch-zoomed: the visual viewport is smaller because it is magnified,
    // not because a keyboard covers it. Leave the page alone.
    if (Math.abs(viewport.scale - 1) > 0.01) { clear(); return; }
    root.style.setProperty(APP_HEIGHT_VAR, `${Math.round(viewport.height)}px`);
    if (!composing && (win.scrollX || win.scrollY)) win.scrollTo(0, 0);
    // Whatever pan is left (Safari's own, or a scroll kept during composition)
    // the shell follows, so the top bar stays at the top of what is visible.
    const top = Math.max(0, Math.round(viewport.offsetTop + win.scrollY));
    if (top) root.style.setProperty(VIEWPORT_TOP_VAR, `${top}px`);
    else root.style.removeProperty(VIEWPORT_TOP_VAR);
  };
  const schedule = () => { if (pending === undefined) pending = frame(settle); };
  const start = () => { composing = true; };
  const end = () => { composing = false; schedule(); };

  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  doc.addEventListener("compositionstart", start);
  doc.addEventListener("compositionend", end);
  settle();
  return () => {
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    doc.removeEventListener("compositionstart", start);
    doc.removeEventListener("compositionend", end);
    if (pending !== undefined) cancelFrame(pending);
    clear();
  };
}
