import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { HomeScene } from "../../../src/home/scene.js";
import type { HomeStatus } from "../../../src/home/status.js";
import { homeConditions, signValues } from "./evaluate.js";
import { skyOf } from "./sky.js";
import { HomeStage, type StageState } from "./three/stage.js";

/**
 * The room itself: the only module that loads three.js, in its own chunk
 * (home-page.tsx imports it on demand). It owns one HomeStage for as long as
 * it is mounted and hands it the evaluated state.
 */

export interface RoomHandle { capture(maxBytes: number): string | null }
export type RoomFailure = "webgl" | "lost";

const TURN_PER_PIXEL = 0.008;
const TURN_PER_KEY = 0.12;

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
  const [turned, setTurned] = useState(false);
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
  const state = useMemo<StageState>(() => ({ conditions: homeConditions(status, now), values: signValues(status, now), subagents: status.subagents, hasPet: !!status.pet, sky: skyOf(status, now) }), [status, now]);
  // The sun and moon move slowly: their place is rounded so a tick does not redraw the window for nothing.
  const signature = JSON.stringify([[...state.conditions].sort(), state.values, state.subagents, state.hasPet, { ...state.sky, progress: Math.round(state.sky.progress * 200) }]);
  useEffect(() => { if (ready) stage.current?.setState(state); }, [signature, ready, scene, revision]);

  // Dragging turns the room; vertical swipes still scroll the page (touch-action: pan-y).
  const drag = useRef<{ id: number; x: number } | null>(null);
  return <div ref={box} className="relative size-full min-h-0 touch-pan-y select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    role="img" aria-label={label} tabIndex={0} data-state={ready ? "ready" : "loading"}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); stage.current?.turn(event.key === "ArrowLeft" ? TURN_PER_KEY : -TURN_PER_KEY); setTurned(true); }
      if (event.key === "Home") { event.preventDefault(); stage.current?.resetView(); }
    }}
    onPointerDown={(event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      drag.current = { id: event.pointerId, x: event.clientX };
      if (event.pointerType === "mouse") event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!drag.current || drag.current.id !== event.pointerId) return;
      const dx = event.clientX - drag.current.x;
      drag.current.x = event.clientX;
      if (dx) { stage.current?.turn(-dx * TURN_PER_PIXEL); setTurned(true); }
    }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
    onDoubleClick={() => stage.current?.resetView()}>
    <canvas ref={canvas} className="block size-full cursor-grab active:cursor-grabbing" />
    {!turned && <span aria-hidden="true" className="pointer-events-none absolute right-3 bottom-2.5 rounded-full bg-background/75 px-2 py-0.5 text-[11px] tracking-[0.02em] text-muted-foreground">Drag to turn</span>}
  </div>;
}
