import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, Pause, Play, X } from "lucide-react";
import type { WebScreenFrame } from "../../src/web/protocol.js";
import { ApiError, type WebBootstrap } from "./api.js";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { clampGeometry, pictureAge, readGeometry, readScreen, SCREEN_RATES, streamWanted, TITLE_BAR, updatedAgo, windowHeight, writeGeometry,
  type ScreenGeometry, type ScreenRate } from "./screen-stream.js";
import { i18n } from "./i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: screen:notice.*

function storedRate(): ScreenRate {
  try { const value = Number(localStorage.getItem("tomo-screen-fps")); return (SCREEN_RATES as readonly number[]).includes(value) ? value as ScreenRate : 1; }
  catch { return 1; }
}
function safeStorage(): Storage | undefined { try { return localStorage; } catch { return undefined; } }
function viewport() { return { width: window.innerWidth, height: window.innerHeight }; }

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** The stream's trouble, worded where it is shown. */
type StreamError = "" | "unavailable" | "reconnecting";
const NOTICE = {
  locked: "screen:notice.locked", away: "screen:notice.away", unconfirmed: "screen:notice.unconfirmed",
  unavailable: "screen:notice.unavailable", too_large: "screen:notice.too_large",
} as const satisfies Record<Exclude<WebScreenFrame["status"], "live">, string>;

/**
 * The Mac's main display in a floating, non-modal window: read-only, no
 * input or control. Frames stream only while the window is open, the tab is
 * visible and it is not paused; closing the window (unmounting) closes the
 * stream, and with no viewer left the daemon side stops capturing.
 */
export function ScreenWindow({ bootstrap, refresh, live, compact, onClose }: {
  bootstrap?: WebBootstrap; refresh: () => Promise<WebBootstrap>; live: boolean; compact: boolean; onClose: () => void;
}) {
  const [rate, setRate] = useState<ScreenRate>(storedRate);
  const [paused, setPaused] = useState(false);
  const [frame, setFrame] = useState<WebScreenFrame>();
  const [image, setImage] = useState<{ src: string; capturedAt: number }>();
  const [error, setError] = useState<StreamError>("");
  const [now, setNow] = useState(() => Date.now());
  const [geometry, setGeometry] = useState<ScreenGeometry>(() => readGeometry(safeStorage(), viewport()));
  const visible = usePageVisible();
  const root = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLDivElement>(null);
  const epoch = bootstrap?.epoch;
  const streaming = streamWanted({ open: true, live, visible, paused, epoch });

  useEffect(() => { try { localStorage.setItem("tomo-screen-fps", String(rate)); } catch { /* Optional. */ } }, [rate]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { root.current?.focus(); }, []);
  // Keep the window inside the viewport when the browser window shrinks.
  useEffect(() => {
    const onResize = () => setGeometry((old) => clampGeometry(old, viewport()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    if (!streaming || !epoch) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      setError("");
      readScreen(rate, epoch, controller.signal, (next) => {
        setFrame(next);
        if (next.status === "live" && next.jpeg) setImage({ src: `data:image/jpeg;base64,${next.jpeg}`, capturedAt: next.capturedAt });
      }).catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.code === "epoch_changed") { void refresh().catch(() => {}); return; }
        if (err instanceof ApiError && err.code === "screen_unavailable") { setError("unavailable"); return; }
        setError("reconnecting");
        retry = setTimeout(open, 3000);
      });
    };
    open();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [streaming, epoch, rate, refresh]);

  /** Drag (title bar) or resize (corner) with pointer capture; saved when released. */
  const track = (mode: "move" | "resize") => (event: ReactPointerEvent<HTMLElement>) => {
    if (compact || event.button !== 0 || (mode === "move" && (event.target as HTMLElement).closest("button, [role=radio], [role=group]"))) return;
    event.preventDefault();
    const start = { px: event.clientX, py: event.clientY, ...geometry };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let latest = geometry;
    const move = (e: PointerEvent) => {
      latest = clampGeometry(mode === "move"
        ? { ...start, x: start.x + e.clientX - start.px, y: start.y + e.clientY - start.py }
        : { ...start, width: start.width + e.clientX - start.px }, viewport());
      setGeometry(latest);
    };
    const up = () => {
      target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); target.removeEventListener("pointercancel", up);
      writeGeometry(safeStorage(), latest);
    };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", up); target.addEventListener("pointercancel", up);
  };
  const fullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void picture.current?.requestFullscreen?.(); };

  const stale = frame && frame.status !== "live";
  const errorText = error === "unavailable" ? i18n.t("screen:unavailable") : error === "reconnecting" ? i18n.t("common:connection.reconnecting") : "";
  const status = !live ? i18n.t("screen:status.disconnected") : paused ? i18n.t("screen:status.paused") : !visible ? i18n.t("screen:status.hidden")
    : error === "unavailable" ? i18n.t("screen:status.unavailable") : errorText || (frame?.status === "live" ? updatedAgo(frame.capturedAt, now) : frame ? i18n.t("screen:status.notLive") : i18n.t("common:connection.connecting"));
  const iconButton = "size-7 rounded-lg text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground [&_svg:not([class*='size-'])]:size-4";
  return <div ref={root} id="screen-window" role="dialog" aria-label={i18n.t("screen:label")} tabIndex={-1}
    onKeyDown={(event) => { if (event.key === "Escape" && !document.fullscreenElement) { event.stopPropagation(); onClose(); } }}
    style={compact ? undefined : { left: geometry.x, top: geometry.y, width: geometry.width, height: windowHeight(geometry.width) }}
    className={cn("fixed z-40 flex flex-col overflow-hidden border bg-card shadow-2xl outline-none",
      compact ? "inset-x-0 bottom-0 max-h-[calc(var(--app-height,100dvh)*0.7)] rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)] animate-in slide-in-from-bottom-4" : "rounded-2xl")}>
    <div onPointerDown={track("move")} style={compact ? undefined : { height: TITLE_BAR }}
      className={cn("flex shrink-0 items-center gap-2 border-b px-3 select-none", compact ? "h-12" : "cursor-grab active:cursor-grabbing")}>
      <i className={cn("size-1.5 shrink-0 rounded-full border border-muted-foreground", streaming && frame?.status === "live" && "border-primary bg-primary")} />
      <span className="text-[13px] font-medium">{i18n.t("common:header.screen")}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] tracking-[0.02em] text-muted-foreground" role="status" aria-live="polite">{status}</span>
      <ToggleGroup type="single" aria-label={i18n.t("screen:rate")} value={String(rate)} onValueChange={(value) => { if (value) setRate(Number(value) as ScreenRate); }}
        className="rounded-lg bg-foreground/[0.05] p-0.5">
        {SCREEN_RATES.map((value) => <ToggleGroupItem key={value} value={String(value)} aria-label={i18n.t("screen:rateLabel", { count: value })} title={i18n.t("screen:fps", { value })}
          className="h-6 rounded-md! px-1.5 text-[11px] tracking-[0.02em] tabular-nums text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-foreground/[0.13]">{value}</ToggleGroupItem>)}
      </ToggleGroup>
      <Button variant="ghost" size="icon" className={iconButton} onClick={() => setPaused((value) => !value)} aria-pressed={paused}
        aria-label={paused ? i18n.t("cron:resume") : i18n.t("cron:pause")} title={paused ? i18n.t("cron:resume") : i18n.t("cron:pause")}>{paused ? <Play strokeWidth={1.75} /> : <Pause strokeWidth={1.75} />}</Button>
      <Button variant="ghost" size="icon" className={iconButton} onClick={fullscreen} aria-label={i18n.t("screen:fullscreen")} title={i18n.t("screen:fullscreen")} disabled={!image}><Maximize2 strokeWidth={1.75} /></Button>
      <Button variant="ghost" size="icon" className={iconButton} onClick={onClose} aria-label={i18n.t("screen:close")} title={i18n.t("tasks:closeTitle")}><X strokeWidth={1.75} /></Button>
    </div>
    <div ref={picture} onDoubleClick={fullscreen}
      className="relative flex min-h-0 flex-1 items-center justify-center bg-black/[0.04] dark:bg-black/30 [&:fullscreen]:bg-black">
      {image ? <img src={image.src} alt={i18n.t("screen:alt")} draggable={false}
        title={i18n.t("screen:permissionHint")}
        className={cn("block max-h-full max-w-full object-contain", compact && "max-h-[calc(var(--app-height,100dvh)*0.7-48px)]", (stale || paused) && "opacity-50 grayscale")} />
        : <p className="m-0 px-6 py-10 text-center text-[13px] text-muted-foreground">{frame && frame.status !== "live" ? i18n.t(NOTICE[frame.status]) : paused ? i18n.t("screen:pausedNote") : errorText || i18n.t("screen:waiting")}</p>}
      {image && (stale || paused) && <span className="absolute top-2 left-2 max-w-[calc(100%-1rem)] rounded-lg bg-card/90 px-2 py-1 text-[11px] text-foreground shadow-sm">
        {i18n.t("screen:lastPicture", { state: stale ? i18n.t(NOTICE[frame!.status as Exclude<WebScreenFrame["status"], "live">]) : i18n.t("screen:status.paused"), age: pictureAge(image.capturedAt, now) })}</span>}
      {!compact && <span onPointerDown={track("resize")} aria-hidden="true" title={i18n.t("screen:resize")}
        className="absolute right-0.5 bottom-0.5 size-4 cursor-nwse-resize bg-[linear-gradient(135deg,transparent_42%,var(--muted-foreground)_42%,var(--muted-foreground)_50%,transparent_50%,transparent_67%,var(--muted-foreground)_67%,var(--muted-foreground)_75%,transparent_75%)] opacity-50 transition-opacity hover:opacity-90" />}
    </div>
  </div>;
}
