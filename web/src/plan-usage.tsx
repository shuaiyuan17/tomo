import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { WebRateLimit, WebUsage } from "../../src/web/protocol.js";
import { rateLimitNotice } from "./composer-status.js";
import { api } from "./api.js";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { isWarn, localizeUsage, planName, nextUsageDelay, RequestGate, resetLabel, splitWindows, updatedLabel, usageNotice, windowTitle, type UsageSchedule } from "./usage.js";

/**
 * Claude subscription usage (the same numbers as `/usage`). Loads on open,
 * then again when the server's 30-minute cache expires (plus a few seconds)
 * while the tab is visible, and on demand; the daemon caches and debounces.
 */
export function PlanUsage({ ready, locked, live }: { ready: boolean;
  /** The page has no access link yet: nothing will load until it is opened with one. */
  locked?: boolean;
  /** The rate-limit state the SDK last pushed (`rate_limit_event`): shown at once, and the bars are re-read when it changes. */
  live?: WebRateLimit }) {
  const [usage, setUsage] = useState<WebUsage>();
  const [loading, setLoading] = useState(false);
  // The refresh icon spins while loading and finishes its turn instead of
  // snapping back when a read comes back quickly.
  const [spinning, setSpinning] = useState(false);
  useEffect(() => {
    if (loading) setSpinning(true);
    else if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) setSpinning(false);
  }, [loading]);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The latest answer, for scheduling outside React's render cycle.
  const latest = useRef<UsageSchedule>({ failed: false, lastAttemptAt: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const schedule = useCallback((load: (refresh: boolean) => Promise<void>) => {
    clearTimeout(timer.current);
    if (document.hidden) return;
    const delay = nextUsageDelay(latest.current, Date.now());
    timer.current = setTimeout(() => void load(false), delay);
  }, []);
  // One request at a time; each carries a sequence number and a response
  // that is not from the latest request is dropped.
  const gate = useRef(new RequestGate());
  const load = useCallback(async (refresh: boolean): Promise<void> => {
    const mine = gate.current.begin();
    if (mine === null) return;
    clearTimeout(timer.current);
    // Recorded when the request starts, so a slow answer cannot push the next one back.
    latest.current = { ...latest.current, lastAttemptAt: Date.now() };
    setLoading(true);
    try {
      const raw = await api<WebUsage>(`/usage${refresh ? "?refresh=1" : ""}`);
      if (!gate.current.current(mine)) return;
      const value = localizeUsage(raw, Date.now());
      latest.current = { ...latest.current, usage: value, failed: false }; setUsage(value); setFailed(false);
    } catch {
      if (!gate.current.current(mine)) return;
      latest.current = { ...latest.current, failed: true }; setFailed(true);
    } finally {
      gate.current.end();
      if (gate.current.current(mine)) { setLoading(false); setNow(Date.now()); schedule(load); }
    }
  }, [schedule]);
  // Only once the page is authenticated (bootstrap sets the cookie). Next
  // reads follow the server's cache expiry; hidden tabs pause, and a tab
  // that comes back past the expiry reads at once (else waits for it).
  useEffect(() => {
    if (!ready) return;
    void load(false);
    const onVisibility = () => { if (document.hidden) clearTimeout(timer.current); else schedule(load); };
    document.addEventListener("visibilitychange", onVisibility);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearTimeout(timer.current); clearInterval(tick); document.removeEventListener("visibilitychange", onVisibility); };
  }, [load, schedule, ready]);

  // A pushed change of state (a warning, a rejection, a reset) is newer than the cached bars.
  const liveKey = live ? `${live.status}:${live.limit ?? ""}` : "";
  const seenLive = useRef(liveKey);
  useEffect(() => {
    if (!ready || seenLive.current === liveKey) return;
    seenLive.current = liveKey;
    void load(true);
  }, [liveKey, ready, load]);
  const liveNotice = rateLimitNotice(live, now);
  const { main, scoped } = splitWindows(usage?.windows ?? []);
  const notice = failed ? "Couldn't reach Tomo for usage." : usage && usageNotice(usage);
  return <section className="mt-8 border-t pt-7" aria-labelledby="usage-heading">
    <div className="mb-3 flex items-center justify-between gap-2">
      <p className="eyebrow m-0" id="usage-heading">Plan usage{usage?.plan ? <span className="normal-case tracking-normal"> · {planName(usage.plan)}</span> : null}</p>
      <Button variant="ghost" size="icon" aria-label="Refresh plan usage" title={usage ? `Refresh · ${updatedLabel(usage.updatedAt, now)}` : "Refresh"} disabled={loading || !ready} onClick={() => void load(true)}
        className="-my-1 size-7 rounded-lg text-muted-foreground max-[600px]:-my-2 max-[600px]:size-9 hover:bg-foreground/[0.07] hover:text-foreground [&_svg:not([class*='size-'])]:size-3.5">
        <RefreshCw className={cn(spinning && "animate-spin")} onAnimationIteration={() => { if (!loading) setSpinning(false); }} strokeWidth={1.75} /></Button>
    </div>
    {liveNotice && <p className="m-0 mb-3 text-[12px] leading-relaxed font-medium text-warn" role="status">{liveNotice}</p>}
    {!usage && !failed && <p className="m-0 text-[13px] text-muted-foreground" role="status">{locked ? "Shown once connected." : "Loading…"}</p>}
    {main.length > 0 && <div className="space-y-3.5">{main.map((window) => <UsageRow key={window.id} title={windowTitle(window)} window={window} now={now} />)}</div>}
    {scoped.length > 0 && <Collapsible className="group/models mt-3">
      <CollapsibleTrigger className="flex items-center gap-1 rounded-md px-0.5 py-0.5 text-[12px] max-[600px]:-my-2 max-[600px]:py-2.5 text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/models:rotate-90" />By model ({scoped.length})</CollapsibleTrigger>
      <CollapsibleContent className="mt-2.5 space-y-3">{scoped.map((window) => <UsageRow key={window.id} title={windowTitle(window)} window={window} now={now} compact />)}</CollapsibleContent>
    </Collapsible>}
    {notice && <p className={cn("m-0 text-[12px] leading-relaxed text-muted-foreground", main.length && "mt-3")} role="status">{usage?.stale ? `${notice} Showing the last reading.` : notice}</p>}
  </section>;
}

function UsageRow({ title, window, now, compact }: { title: string; window: WebUsage["windows"][number]; now: number; compact?: boolean }) {
  const warn = isWarn(window);
  const reset = resetLabel(window, now)?.replace(/^R/, "r");
  return <div>
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span className={cn("min-w-0 truncate text-[13px]", compact && "text-[12px]")}>{title}{reset && <span className="ml-2 text-[11px] text-muted-foreground">{reset}</span>}</span>
      <span className={cn("text-[13px] tabular-nums", warn ? "font-medium text-warn" : "text-muted-foreground")}>{window.percent === null ? "—" : `${Math.round(window.percent)}%`}</span>
    </div>
    {window.percent !== null && <Progress max={100} value={Math.min(100, Math.max(0, window.percent))} aria-label={`${title} usage`}
      className={cn("h-1.5 bg-border", warn && "[&>[data-slot=progress-indicator]]:bg-warn")} />}
  </div>;
}
