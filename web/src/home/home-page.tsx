import { useEffect, useRef, useState } from "react";
import { api, ApiError, postHomeSnapshot, type WebBootstrap } from "../api.js";
import { useAgentName } from "../agent-name.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WebHome } from "../../../src/web/protocol.js";
import type { HomeEvents } from "../use-web.js";
import { cronFlashing, homeCaption, localizeHomeStatus, newerStatus, type LocalHomeStatus } from "./caption.js";
import { HOME_SNAPSHOT_MAX_BYTES } from "./contract.js";
import { snapshotBody } from "./snapshot.js";
import type { RoomFailure, RoomHandle } from "./room-view.js";
import { i18n } from "../i18n/index.js";

/**
 * The Home page: Tomo's room, drawn from the scene Tomo wrote, and one line
 * saying what Tomo is doing. The caption needs nothing but HomeStatus, so it
 * works even where the room cannot be drawn; the room's code (three.js) is
 * loaded only when this page opens.
 */

type RoomModule = typeof import("./room-view.js");
/** While the page shows in a visible tab, /home is read at least this often. */
export const HOME_READ_EVERY_MS = 60_000;
/** A read of /home is due: the tab is visible and the last read, for any reason, is a minute old. */
export function homeReadDue(lastRead: number, now: number, hidden: boolean): boolean { return !hidden && now - lastRead >= HOME_READ_EVERY_MS; }
type Loaded = { state: "loading" } | { state: "ready"; home: WebHome } | { state: "error"; code: string };

/** `#home`: linkable, and the back button leaves it. */
export function isHomeHash(hash: string): boolean { return hash === "#home"; }
export function useHomeRoute(): boolean {
  const [home, setHome] = useState(() => isHomeHash(window.location.hash));
  useEffect(() => {
    const update = () => setHome(isHomeHash(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return home;
}

/** Keeps `now` fresh enough for the caption: every second while a cron flash runs, else every 15 s. */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), fast ? 1_000 : 15_000);
    return () => clearInterval(timer);
  }, [fast]);
  return now;
}

export function HomePage({ events, bootstrap, refresh, inert }: {
  events: HomeEvents; bootstrap?: WebBootstrap; refresh: () => Promise<WebBootstrap>; inert?: boolean;
}) {
  const agent = useAgentName();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [fetched, setFetched] = useState<LocalHomeStatus>();
  const [local, setLocal] = useState(0);
  /** When /home was last read, for whatever reason. */
  const lastRead = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    lastRead.current = Date.now();
    api<WebHome>("/home", { signal: controller.signal }).then((home) => {
      if (controller.signal.aborted) return;
      setLoaded({ state: "ready", home });
      setFetched(localizeHomeStatus(home.status, Date.now()));
    }, (error: unknown) => {
      if (!controller.signal.aborted) setLoaded((old) => old.state === "ready" ? old : { state: "error", code: error instanceof ApiError ? error.code : "unavailable" });
    });
    return () => controller.abort();
  }, [events.revision, local]);
  // The daemon takes a recent read of /home as "someone is looking": while
  // this page shows in a visible tab, it is read at least once a minute
  // (counting the reads it makes anyway, on open, on `home` and on reconnect).
  useEffect(() => {
    const check = () => { if (homeReadDue(lastRead.current, Date.now(), document.hidden)) setLocal((n) => n + 1); };
    const timer = setInterval(check, 5_000);
    document.addEventListener("visibilitychange", check);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, []);

  const status = newerStatus(fetched, events.status)?.status;
  // Never behind the status itself (the ticker may be older than the answer it reads).
  const now = Math.max(useNow(!!status && cronFlashing(status, Date.now())), status?.at ?? 0);
  const caption = status ? homeCaption(status, now) : loaded.state === "error" ? i18n.t("home:unknownStatus", { agent }) : "…";

  // three.js arrives in its own chunk, only now.
  const [room, setRoom] = useState<RoomModule | null>(null);
  const [failure, setFailure] = useState<RoomFailure | "chunk" | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    import("./room-view.js").then((module) => { if (live) setRoom(module); }, () => { if (live) setFailure("chunk"); });
    return () => { live = false; };
  }, [attempt]);

  // Tomo asked to look: answered only while this page shows, and only when asked.
  const handle = useRef<RoomHandle | null>(null);
  const [drawn, setDrawn] = useState(false);
  const seen = useRef(events.look?.seq ?? 0);
  const [pending, setPending] = useState<{ requestId: string } | null>(null);
  useEffect(() => {
    if (!events.look || events.look.seq === seen.current) return;
    seen.current = events.look.seq;
    setPending({ requestId: events.look.requestId });
  }, [events.look]);
  useEffect(() => {
    if (!pending || !drawn || loaded.state !== "ready" || !bootstrap || !handle.current) return;
    const look = pending;
    setPending(null);
    // Next frame: the stage has the latest state applied by then.
    requestAnimationFrame(() => {
      const png = handle.current?.capture(HOME_SNAPSHOT_MAX_BYTES);
      if (png) void postHomeSnapshot(snapshotBody(look.requestId, loaded.home.revision, png), bootstrap, refresh).catch(() => { /* Tomo times out on its side. */ });
    });
  }, [pending, drawn, loaded, bootstrap, refresh]);

  const home = loaded.state === "ready" ? loaded.home : undefined;
  const backdrop = home?.scene.room.backdrop ?? "#1b1a19";
  const failureText = failure === "chunk" ? i18n.t("home:failure.chunk")
    : failure === "webgl" ? i18n.t("home:failure.webgl")
    : failure === "lost" ? i18n.t("home:failure.lost") : null;
  const working = !!status && (status.working || status.compacting);
  return <main id="home" tabIndex={-1} inert={inert} className="flex min-h-0 min-w-0 flex-1 flex-col px-8 pt-6 pb-4 max-overlay:px-6 max-[800px]:px-5 max-phone:px-0 max-phone:pt-0 max-phone:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
    <h1 className="sr-only">{i18n.t("home:heading", { agent })}</h1>
    <div className={cn("relative min-h-0 flex-1 overflow-hidden rounded-2xl border max-phone:rounded-none max-phone:border-x-0 max-phone:border-t-0", (failureText || loaded.state === "error") && "bg-muted/40")}
      style={failureText || loaded.state === "error" ? undefined : { backgroundColor: backdrop }} data-testid="home-room">
      {failureText ? <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-muted-foreground" role="note">
          <p className="m-0 max-w-80">{i18n.t("home:failure.note", { failure: failureText, agent })}</p>
          {failure !== "webgl" && <Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => { if (failure === "chunk") window.location.reload(); else { setFailure(null); setRoom(null); setAttempt((n) => n + 1); } }}>{i18n.t("home:retry")}</Button>}</div>
        : loaded.state === "error" ? <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-muted-foreground" role="note">
          <p className="m-0 max-w-80">{loaded.code === "not_found" ? i18n.t("home:notFound", { agent }) : i18n.t("home:unreadable", { agent })}</p>
          <Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => setLocal((n) => n + 1)}>{i18n.t("home:retry")}</Button></div>
        : home && room && status ? <room.RoomView key={attempt} scene={home.scene} revision={home.revision} status={status} now={now}
          label={i18n.t("home:roomLabel", { agent, name: home.scene.name ?? i18n.t("home:smallRoom"), caption })} handle={handle} onFailure={setFailure} onReady={() => setDrawn(true)} />
        : <p className="sr-only" role="status">{i18n.t("home:opening")}</p>}
    </div>
    <div className="w-full px-1 pt-3 max-phone:px-4">
      <p className="m-0 flex items-baseline gap-2 text-[13px] leading-relaxed text-muted-foreground" role="status" aria-live="polite">
        <i aria-hidden="true" className={cn("relative top-[-1px] size-1.5 shrink-0 rounded-full border border-muted-foreground", working && "border-primary bg-primary", status?.trouble && "border-warn bg-warn")} />
        <span className="min-w-0 flex-1" data-testid="home-caption">{caption}</span>
        {home?.scene.name && <span className="shrink-0 text-[11px] tracking-[0.02em] max-phone:hidden">{home.scene.name}</span>}</p>
      {home?.problems?.length ? <details className="mt-1 text-[12px] text-muted-foreground">
          <summary className="cursor-pointer select-none">{i18n.t("home:problem", { agent })}</summary>
          <ul className="mt-1 mb-0 pl-5">{home.problems.slice(0, 20).map((problem, i) => <li key={i} className="[overflow-wrap:anywhere]">{problem}</li>)}</ul></details>
        : null}
      {home?.starter && <p className="m-0 mt-1 text-[12px] text-muted-foreground">{i18n.t("home:starter", { agent })}</p>}
    </div>
  </main>;
}
