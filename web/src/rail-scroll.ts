import { useCallback, useRef } from "react";

/**
 * A scroller in the Tasks rail whose scrollbar sits in the rail's right
 * padding, not inside the content: its content is then exactly as wide as
 * what is above and below it (the brief, the composer), with the same gap on
 * both sides, whether the platform's scrollbars overlay (no width) or take
 * room (Linux, Windows, macOS with "always show"). The gutter is kept
 * (`scrollbar-gutter: stable`) so the width never moves as content grows.
 */
export const RAIL_SCROLL = "[scrollbar-gutter:stable] [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]";
export function useScrollbarInPadding<T extends HTMLElement>(): (el: T | null) => void {
  const observer = useRef<ResizeObserver | undefined>(undefined);
  return useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = undefined;
    if (!el) return;
    const fit = () => {
      const width = el.offsetWidth - el.clientWidth - el.clientLeft * 2;
      const margin = width > 0 ? `-${width}px` : "";
      if (el.style.marginRight !== margin) el.style.marginRight = margin;
    };
    fit();
    if (typeof ResizeObserver !== "undefined") { observer.current = new ResizeObserver(fit); observer.current.observe(el); }
  }, []);
}
