import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { WebUsage } from "../../src/web/protocol.js";
import { api } from "./api.js";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { isWarn, resetLabel, splitWindows, updatedLabel, USAGE_REFRESH_MS, usageNotice, windowTitle } from "./usage.js";

/**
 * Claude subscription usage (the same numbers as `/usage`). Loads on open,
 * refreshes every 30 minutes while the tab is visible (catching up when it
 * becomes visible again), and on demand; the daemon caches and debounces.
 */
export function PlanUsage({ ready }: { ready: boolean }) {
  const [usage, setUsage] = useState<WebUsage>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastLoad = useRef(0);
  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try { setUsage(await api<WebUsage>(`/usage${refresh ? "?refresh=1" : ""}`)); setFailed(false); }
    catch { setFailed(true); }
    finally { lastLoad.current = Date.now(); setLoading(false); setNow(Date.now()); }
  }, []);
  // Only once the page is authenticated (bootstrap sets the cookie).
  useEffect(() => {
    if (!ready) return;
    void load(false);
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => { clearInterval(timer); timer = setInterval(() => void load(false), USAGE_REFRESH_MS); };
    const onVisibility = () => {
      if (document.hidden) { clearInterval(timer); timer = undefined; return; }
      if (Date.now() - lastLoad.current >= USAGE_REFRESH_MS) void load(false);
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearInterval(timer); clearInterval(tick); document.removeEventListener("visibilitychange", onVisibility); };
  }, [load, ready]);

  const { main, scoped } = splitWindows(usage?.windows ?? []);
  const notice = failed ? "Couldn't reach Tomo for usage." : usage && usageNotice(usage);
  return <section className="mt-8 border-t pt-7 max-[600px]:hidden" aria-labelledby="usage-heading">
    <div className="mb-3 flex items-center justify-between gap-2">
      <p className="eyebrow m-0" id="usage-heading">Plan usage{usage?.plan ? <span className="normal-case tracking-normal"> · {usage.plan}</span> : null}</p>
      <Button variant="ghost" size="icon" aria-label="Refresh plan usage" title="Refresh" disabled={loading} onClick={() => void load(true)}
        className="-my-1 size-7 rounded-lg text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground [&_svg:not([class*='size-'])]:size-3.5">
        <RefreshCw className={cn(loading && "animate-spin")} strokeWidth={1.75} /></Button>
    </div>
    {!usage && !failed && <p className="m-0 text-[13px] text-muted-foreground" role="status">Loading…</p>}
    {main.length > 0 && <div className="space-y-3.5">{main.map((window) => <UsageRow key={window.id} title={windowTitle(window)} window={window} now={now} />)}</div>}
    {scoped.length > 0 && <Collapsible className="group/models mt-3">
      <CollapsibleTrigger className="flex items-center gap-1 rounded-md px-0.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform duration-150 group-data-[state=open]/models:rotate-90" />By model ({scoped.length})</CollapsibleTrigger>
      <CollapsibleContent className="mt-2.5 space-y-3">{scoped.map((window) => <UsageRow key={window.id} title={windowTitle(window)} window={window} now={now} compact />)}</CollapsibleContent>
    </Collapsible>}
    {notice && <p className={cn("m-0 text-[12px] leading-relaxed text-muted-foreground", main.length && "mt-3")} role="status">{usage?.stale ? `${notice} Showing the last reading.` : notice}</p>}
    {usage && <p className="m-0 mt-3 text-[12px] text-muted-foreground">{updatedLabel(usage.updatedAt, now)}</p>}
  </section>;
}

function UsageRow({ title, window, now, compact }: { title: string; window: WebUsage["windows"][number]; now: number; compact?: boolean }) {
  const warn = isWarn(window);
  const reset = resetLabel(window, now);
  return <div>
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span className={cn("text-[13px]", compact && "text-[12px]")}>{title}</span>
      <span className={cn("text-[13px] tabular-nums", warn ? "font-medium text-warn" : "text-muted-foreground")}>{window.percent === null ? "—" : `${Math.round(window.percent)}%`}</span>
    </div>
    {window.percent !== null && <Progress max={100} value={Math.min(100, Math.max(0, window.percent))} aria-label={`${title} usage`}
      className={cn("h-1.5 bg-border", warn && "[&>[data-slot=progress-indicator]]:bg-warn")} />}
    {reset && <p className="m-0 mt-1 text-[11px] text-muted-foreground">{reset}</p>}
  </div>;
}
