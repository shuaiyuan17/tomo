import { useEffect, useState } from "react";
import { CalendarClock, ChevronRight, Repeat } from "lucide-react";
import type { WebCronJob } from "../../src/web/protocol.js";
import { Button } from "@/components/ui/button";
import { formatUntil, upcomingJobs } from "./scheduled.js";
import { cronJobHash, useResource } from "./study-data.js";

/** Re-read /cron at least this often while the rail is open (writes from the Study or the CLI emit no event). */
const REFRESH_MS = 60_000;

/**
 * The next few enabled cron jobs, under the Tasks list. Same data and the
 * same visibility as the Study's Cron tab (the owner's whole schedule).
 * Read-only: a row opens that job in the Study. Hidden when nothing is scheduled.
 */
export function ScheduledSection({ revision, onNavigate }: { revision: number; onNavigate?: () => void }) {
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); setTick((value) => value + 1); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const [resource] = useResource<{ jobs: WebCronJob[] }>("/cron", revision + tick);
  const jobs = resource.state === "ready" ? upcomingJobs(resource.value.jobs) : [];
  if (!jobs.length) return null;
  const go = (hash: string) => { window.location.hash = hash; onNavigate?.(); };
  return <section className="mt-3 border-t pt-3 pr-2.5" aria-labelledby="scheduled-heading">
    <h3 id="scheduled-heading" className="mt-0 mb-1 px-2.5 font-mono text-[11px] font-normal tracking-[0.12em] text-muted-foreground uppercase">Scheduled</h3>
    <ul className="m-0 list-none space-y-0.5 p-0">{jobs.map((job) => {
      const oneShot = job.schedule.kind === "at" || job.deleteAfterRun;
      const Icon = oneShot ? CalendarClock : Repeat;
      return <li key={job.id}>
        <button type="button" onClick={() => go(cronJobHash(job.id))} title={`${job.scheduleLabel}\n${job.sessionKey}`}
          className="block w-full cursor-pointer rounded-xl px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/[0.06] focus-visible:outline-offset-0">
          <span className="block text-[13px] leading-normal font-medium [overflow-wrap:anywhere]">{job.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <time dateTime={new Date(job.nextRunAt!).toISOString()} className="tabular-nums">{formatUntil(job.nextRunAt!, now)}</time>
            <span aria-hidden="true">·</span>
            <Icon className="size-3 shrink-0" strokeWidth={1.75} aria-hidden="true" /><span>{oneShot ? "Once" : "Repeats"}</span>
          </span>
        </button>
      </li>;
    })}</ul>
    <Button variant="ghost" size="sm" onClick={() => go("#study/cron")}
      className="mt-1 ml-1 h-8 gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">View all<ChevronRight className="size-3.5" /></Button>
  </section>;
}
