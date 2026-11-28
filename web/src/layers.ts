import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

/**
 * The app shell's layers: media queries that switch a panel between pinned
 * and overlaid, panel flags remembered across reloads, and the keyboard
 * contract of a modal layer (focus moves in, Tab stays inside, Escape closes).
 */

// The same media queries Tailwind writes for `max-overlay:` and `max-phone:` (styles.css), so the
// script and the stylesheet switch at the same pixel: below the width, not at it.
// tests/web-breakpoints.test.ts holds the two together.
/** Below 1024 px the Tasks rail and the Home conversation slide over the page: pinned beside a 232 px sidebar they would leave under ~500 px. */
export const OVERLAY_QUERY = "not all and (min-width: 1024px)";
/** Below 600 px (phone width) the sidebar becomes a drawer behind the menu button. */
export const PHONE_QUERY = "not all and (min-width: 600px)";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** A panel's open state, remembered in localStorage ("1" / "0"); storage may be unavailable. */
export function useStoredFlag(key: string): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* Storage can be unavailable. */ }
  }, [key, value]);
  return [value, setValue];
}

/** Keeps Tab / Shift+Tab inside `container`. */
export function trapTab(container: HTMLElement, event: KeyboardEvent) {
  const items = [...container.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.hasAttribute("disabled"));
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  const inside = container.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
}

/**
 * While `active`, `container` is a modal layer: focus moves to `initial`
 * (a selector inside it), Tab stays inside, and Escape anywhere calls
 * `onClose` (which hands focus back to whatever opened it).
 */
export function useModalLayer(active: boolean, container: RefObject<HTMLElement | null>, initial: string, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!active) return;
    container.current?.querySelector<HTMLElement>(initial)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); return; }
      if (event.key === "Tab" && container.current) trapTab(container.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, container, initial]);
}
