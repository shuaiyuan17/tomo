import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { BOTTOM_SLACK, isFar, jumpVisible, scrollAction, unseenCount } from "./inline-tools.js";

/**
 * The chat's "N new messages ↓" pill. `atBottom` is the page's own ref (the
 * render effect follows the end only while it is true, so a reader up in
 * the history is never pulled down). `keys`: the conversation's messages in
 * order (messageKey / blockKey / pendingKey), so a streamed reply and its
 * recorded copy count once. What was there when the reader was last at the
 * bottom is the baseline; only messages appended after it count.
 *
 * After every render it keeps the reader's place: back where they were after
 * "Load earlier" (`restore`: distance from the end to keep), at the end
 * while following, untouched otherwise.
 */
export function useJumpToLatest(scroll: RefObject<HTMLDivElement | null>, atBottom: { current: boolean }, keys: readonly string[], scope: string,
  restore: { current: number | null }) {
  /** Where the view last stood when we knew it: a lower scrollTop since means the reader moved up (its scroll event may not have run yet). */
  const lastTop = useRef(0);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (atBottom.current && element.scrollTop + 1 < lastTop.current) atBottom.current = false;
    const action = scrollAction({ restoring: restore.current !== null, atBottom: atBottom.current });
    if (action === "restore") { element.scrollTop = element.scrollHeight - restore.current!; restore.current = null; }
    else if (action === "bottom") element.scrollTop = element.scrollHeight;
    lastTop.current = element.scrollTop;
  });
  // A picture has no height until it loads, which is after the render that
  // followed the end: the view was left short of the bottom, with the image
  // cut off. `load` does not bubble, so it is caught on the way down; while
  // the reader is following, the view follows the picture's real height too.
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const follow = (event: Event) => {
      if (!(event.target instanceof HTMLImageElement) || !atBottom.current || restore.current !== null) return;
      element.scrollTop = element.scrollHeight;
      lastTop.current = element.scrollTop;
    };
    element.addEventListener("load", follow, true);
    return () => element.removeEventListener("load", follow, true);
  }, [scroll, atBottom, restore]);
  const baseline = useRef<{ scope: string; keys: Set<string> }>({ scope: "", keys: new Set() });
  const [position, setPosition] = useState({ atBottom: true, far: false });
  const fresh = baseline.current.scope !== scope;
  const unseen = position.atBottom || fresh ? 0 : unseenCount(baseline.current.keys, keys);
  useEffect(() => {
    if (atBottom.current || baseline.current.scope !== scope) baseline.current = { scope, keys: new Set(keys) };
  });
  useEffect(() => { setPosition({ atBottom: true, far: false }); }, [scope]);
  const onScroll = () => {
    const element = scroll.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    atBottom.current = distance < BOTTOM_SLACK;
    lastTop.current = element.scrollTop;
    const next = { atBottom: atBottom.current, far: isFar(distance, element.clientHeight) };
    setPosition((old) => (old.atBottom === next.atBottom && old.far === next.far ? old : next));
  };
  const jump = () => {
    const element = scroll.current;
    if (!element) return;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Follow from now on, so whatever lands during the scroll is followed too.
    atBottom.current = true;
    baseline.current = { scope, keys: new Set(keys) };
    setPosition({ atBottom: true, far: false });
    lastTop.current = 0;
    element.scrollTo({ top: element.scrollHeight, behavior: reduced ? "auto" : "smooth" });
    // The button goes away under the pointer; keyboard focus stays in the conversation.
    element.focus({ preventScroll: true });
  };
  return { onScroll, jump, unseen, visible: jumpVisible({ ...position, unseen }) };
}
