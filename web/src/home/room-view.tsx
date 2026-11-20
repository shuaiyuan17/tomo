import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { HomeScene } from "../../../src/home/scene.js";
import type { HomeStatus } from "../../../src/home/status.js";
import { homeConditions, signValues } from "./evaluate.js";
import { skyOf } from "./sky.js";
import { HomeStage, type StageState } from "./three/stage.js";
import { i18n, useTranslation } from "../i18n/index.js";

/**
 * The room itself: the only module that loads three.js, in its own chunk
 * (home-page.tsx imports it on demand). It owns one HomeStage for as long as
 * it is mounted and hands it the evaluated state.
 */

export interface RoomHandle { capture(maxBytes: number): string | null }
export type RoomFailure = "webgl" | "lost";

const TURN_PER_KEY = 0.12;
const ZOOM_PER_KEY = 1.15;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const list = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(list.matches);
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function RoomView({ scene, revision, status, now, label, handle, onFailure, onReady }: {
  scene: HomeScene; revision: string; status: HomeStatus; now: number; label: string;
  handle: MutableRefObject<RoomHandle | null>; onFailure: (failure: RoomFailure) => void; onReady?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HomeStage | null>(null);
  const [ready, setReady] = useState(false);
  /** The owner moved the view away from the default: a reset button shows. */
  const [moved, setMoved] = useState(false);
  const reduced = usePrefersReducedMotion();
  const failure = useRef(onFailure);
  failure.current = onFailure;

  // One stage per mount; disposed (with its GL context) on unmount.
  useEffect(() => {
    if (!canvas.current || !box.current) return;
    let made: HomeStage;
    try { made = new HomeStage(canvas.current, (name) => `/api/v1/home/assets/${encodeURIComponent(name)}`); }
    catch { failure.current("webgl"); return; }
    stage.current = made;
    // The view, rounded, on the element: for tests and anything that reads the DOM.
    made.onView = (view) => {
      box.current?.setAttribute("data-view", JSON.stringify({ ...view, target: view.target.map((v) => Math.round(v * 100) / 100), distance: Math.round(view.distance * 1000) / 1000,
        azimuth: Math.round(view.azimuth * 1000) / 1000, elevation: Math.round(view.elevation * 1000) / 1000 }));
      setMoved(made.isMoved());
    };
    handle.current = { capture: (maxBytes) => made.capture(maxBytes) };
    const element = box.current, surface = canvas.current;
    const observer = new ResizeObserver(() => made.resize(element.clientWidth, element.clientHeight));
    observer.observe(element);
    made.resize(element.clientWidth, element.clientHeight);
    const visibility = () => { if (document.hidden) made.pause(); else made.resume(); };
    document.addEventListener("visibilitychange", visibility);
    visibility();
    const lost = (event: Event) => { event.preventDefault(); failure.current("lost"); };
    surface.addEventListener("webglcontextlost", lost);
    setReady(true);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      surface.removeEventListener("webglcontextlost", lost);
      handle.current = null; stage.current = null;
      made.dispose();
      setReady(false);
    };
  }, [handle]);

  useEffect(() => { if (stage.current) stage.current.reducedMotion = reduced; stage.current?.invalidate(); }, [reduced, ready]);
  useEffect(() => { if (ready) { stage.current?.setScene(scene, revision); onReady?.(); } }, [scene, revision, ready]);

  // Pure evaluation; the stage only hears about it when something it shows changed.
  // The sign values are words (an idle span, the caption): worked out again when the language changes.
  const { i18n: language } = useTranslation();
  const state = useMemo<StageState>(() => ({ conditions: homeConditions(status, now), values: signValues(status, now), subagents: status.subagents, hasPet: !!status.pet, sky: skyOf(status, now) }),
    [status, now, language.language]);
  // The sun and moon move slowly: their place is rounded so a tick does not redraw the window for nothing.
  const signature = JSON.stringify([[...state.conditions].sort(), state.values, state.subagents, state.hasPet, { ...state.sky, progress: Math.round(state.sky.progress * 200) }]);
  useEffect(() => { if (ready) stage.current?.setState(state); }, [signature, ready, scene, revision]);

  // The room is the owner's to look round (OrbitControls, in the stage): drag
  // to orbit, pinch or wheel to zoom, two fingers or right / Shift drag to
  // pan, double-click to go back. touch-action: none keeps those gestures off
  // the page's own scrolling. The keyboard does the same from the arrows.
  return <><div ref={box} data-testid="home-view" className="relative size-full min-h-0 touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    role="img" aria-label={i18n.t("home:viewLabel", { label })} tabIndex={0} data-state={ready ? "ready" : "loading"}
    onKeyDown={(event) => {
      const key = event.key;
      if (key === "ArrowLeft" || key === "ArrowRight") stage.current?.turn(key === "ArrowLeft" ? TURN_PER_KEY : -TURN_PER_KEY);
      else if (key === "ArrowUp" || key === "ArrowDown") stage.current?.turn(0, key === "ArrowUp" ? TURN_PER_KEY : -TURN_PER_KEY);
      else if (key === "+" || key === "=" || key === "-") stage.current?.zoom(key === "-" ? ZOOM_PER_KEY : 1 / ZOOM_PER_KEY);
      else if (key === "Home") stage.current?.resetView();
      else return;
      event.preventDefault();
    }}
    onDoubleClick={() => stage.current?.resetView()}>
    <canvas ref={canvas} className="block size-full cursor-grab touch-none active:cursor-grabbing" />
  </div>
  {moved ? <button type="button" onClick={() => stage.current?.resetView()} onDoubleClick={(event) => event.stopPropagation()}
      className="absolute right-3 bottom-2.5 rounded-full bg-background/75 px-2 py-0.5 text-[11px] tracking-[0.02em] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{i18n.t("home:resetView")}</button>
      : <span aria-hidden="true" className="pointer-events-none absolute right-3 bottom-2.5 rounded-full bg-background/75 px-2 py-0.5 text-[11px] tracking-[0.02em] text-muted-foreground">{i18n.t("home:dragHint")}</span>}
  </>;
}
