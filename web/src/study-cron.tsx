import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Pause, Play, Trash2 } from "lucide-react";
import type { WebCronJob } from "../../src/web/protocol.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ApiError, mutate } from "./api.js";
import { formatWhen, useResource } from "./study-data.js";
import { card, Empty, meta, Status, type Mutator } from "./study-ui.js";

/** The Study's Cron tab: scheduled jobs, when they last ran, and pause / resume / delete behind a confirmation. */

export function cronStatus(job: WebCronJob): { label: string; tone: "ok" | "warn" | "muted" } {
  if (job.interruptedAt) return { label: "Interrupted", tone: "warn" };
  if (job.lastStatus === "error") return { label: "Last run failed", tone: "warn" };
  if (job.lastStatus === "empty") return { label: "Last run gave no reply", tone: "warn" };
  if (job.lastStatus === "ok") return { label: "Last run ok", tone: "ok" };
  return { label: "Not run yet", tone: "muted" };
}

export function CronJobRow({ job, actions, highlighted }: { job: WebCronJob; actions?: ReactNode; highlighted?: boolean }) {
  const status = cronStatus(job);
  return <li id={cronRowId(job.id)} tabIndex={-1} aria-current={highlighted ? "true" : undefined}
    className={cn(card, "scroll-mt-4 px-5 py-4 transition-[box-shadow,background-color] duration-700", !job.enabled && "opacity-75",
      // Inset: the Study panel scrolls (overflow), which clips a ring drawn outside the card.
      highlighted && "bg-accent/60 ring-2 ring-inset ring-primary/50")}>
    <Collapsible>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="m-0 text-[15px] font-medium">{job.name}</h2>
            <Badge variant={job.enabled ? "secondary" : "outline"} className="rounded-md text-[10px] font-normal tracking-[0.02em]">{job.enabled ? "Enabled" : "Paused"}</Badge>
            {job.deleteAfterRun && <Badge variant="outline" className="rounded-md text-[10px] font-normal tracking-[0.02em]">One-shot</Badge>}</div>
          <p className={cn(meta, "mt-1 mb-0")}>{job.scheduleLabel} · {job.sessionKey}</p>
        </div>
        {actions}
      </div>
      <dl className="mt-3 mb-0 grid grid-cols-3 gap-3 text-[13px] max-[600px]:grid-cols-1">
        <div><dt className={meta}>Next run</dt><dd className="m-0">{job.enabled ? formatWhen(job.nextRunAt) : "—"}</dd></div>
        <div><dt className={meta}>Last run</dt><dd className="m-0">{formatWhen(job.lastRunAt)}</dd></div>
        <div><dt className={meta}>Status</dt><dd className={cn("m-0", status.tone === "warn" && "text-destructive")}>{status.label}</dd></div>
      </dl>
      <CollapsibleTrigger className="group mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />Message</CollapsibleTrigger>
      <CollapsibleContent><p className="mt-2 mb-0 rounded-lg bg-muted px-4 py-3 text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]">{job.message}</p></CollapsibleContent>
    </Collapsible>
  </li>;
}

/** DOM id of a job's row, the target of `#study/cron/<jobId>`. */
export function cronRowId(id: string): string { return `cron-job-${id}`; }

/** How long a linked job stays highlighted. */
const HIGHLIGHT_MS = 2500;

export function CronList({ jobs, actions, focus = null }: { jobs: WebCronJob[]; actions?: (job: WebCronJob) => ReactNode; focus?: string | null }) {
  const sorted = useMemo(() => [...jobs].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)), [jobs]);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const present = !!focus && jobs.some((job) => job.id === focus);
  // Scroll to and briefly highlight the linked job once it is listed.
  useEffect(() => {
    if (!focus || !present) return;
    const row = document.getElementById(cronRowId(focus));
    row?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    row?.focus({ preventScroll: true });
    setHighlighted(focus);
    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focus, present]);
  if (!jobs.length) return <Empty>No scheduled jobs.</Empty>;
  return <>
    {focus && !present && <p className={cn(meta, "mt-0 mb-3")} role="status">That job is no longer scheduled.</p>}
    <ul className="m-0 list-none space-y-3 p-0">{sorted.map((job) => <CronJobRow key={job.id} job={job} actions={actions?.(job)} highlighted={highlighted === job.id} />)}</ul>
  </>;
}

const CRON_ERRORS: Record<string, string> = {
  cron_changed: "This job changed since you opened it. The list has been refreshed; review it and try again.",
  job_not_found: "This job no longer exists.",
  unschedulable: "This schedule has no future run left, so it cannot be resumed.",
  epoch_changed: "Tomo restarted since this page loaded. The list has been refreshed; review it and try again.",
  cron_unavailable: "The cron store could not be read or written.",
};

type CronAction = "pause" | "resume" | "delete";

/** Pause / resume / delete, each behind a confirmation naming the job. */
function CronActions({ job, mutator, onDone }: { job: WebCronJob; mutator: Mutator; onDone: () => void }) {
  const [open, setOpen] = useState<CronAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const overdueOneShot = job.schedule.kind === "at" && Date.parse(job.schedule.at) <= Date.now();
  const disabled = !mutator.bootstrap || !mutator.live;
  const confirm = async () => {
    if (!open || !mutator.bootstrap) return;
    setBusy(true); setError("");
    try {
      await mutate(`/cron/${encodeURIComponent(job.id)}`, open === "delete" ? "DELETE" : "PATCH",
        { revision: job.revision, confirm: true, ...(open === "delete" ? {} : { enabled: open === "resume" }) }, mutator.bootstrap, mutator.refresh);
      setOpen(null); onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unavailable";
      setError(CRON_ERRORS[code] ?? "The change could not be confirmed. Refresh and check the job before trying again.");
      if (code === "cron_changed" || code === "epoch_changed" || code === "job_not_found") onDone();
    } finally { setBusy(false); }
  };
  const copy: Record<CronAction, { title: string; body: string; action: string }> = {
    pause: { title: `Pause “${job.name}”?`, action: "Pause job",
      body: "It will not run again until you resume it. A run already in progress is not stopped." },
    resume: { title: `Resume “${job.name}”?`, action: "Resume job",
      body: overdueOneShot ? "Its scheduled time has passed, so it will run at the scheduler's next check, within about 30 seconds." : "It will run again on its schedule." },
    delete: { title: `Delete “${job.name}”?`, action: "Delete job",
      body: "The job is removed from the schedule. This cannot be undone from here. A run already in progress is not stopped." },
  };
  const toggle: CronAction = job.enabled ? "pause" : "resume";
  const iconButton = "size-8 rounded-lg text-muted-foreground max-[600px]:size-10 hover:bg-foreground/[0.07] hover:text-foreground";
  return <AlertDialog open={open !== null} onOpenChange={(value) => { if (!value && !busy) { setOpen(null); setError(""); } }}>
    <div className="flex shrink-0 items-center gap-1">
      <AlertDialogTrigger asChild><Button variant="ghost" size="icon" className={iconButton} disabled={disabled} onClick={() => setOpen(toggle)}
        aria-label={`${job.enabled ? "Pause" : "Resume"} ${job.name}`} title={job.enabled ? "Pause" : "Resume"}>{job.enabled ? <Pause strokeWidth={1.75} /> : <Play strokeWidth={1.75} />}</Button></AlertDialogTrigger>
      <AlertDialogTrigger asChild><Button variant="ghost" size="icon" className={cn(iconButton, "hover:text-destructive")} disabled={disabled} onClick={() => setOpen("delete")}
        aria-label={`Delete ${job.name}`} title="Delete"><Trash2 strokeWidth={1.75} /></Button></AlertDialogTrigger>
    </div>
    {open && <AlertDialogContent className="rounded-2xl bg-card sm:max-w-md">
      <AlertDialogHeader>
        <AlertDialogTitle className="font-serif text-[22px] leading-snug font-normal">{copy[open].title}</AlertDialogTitle>
        <AlertDialogDescription className="text-[13px] leading-relaxed">{copy[open].body}</AlertDialogDescription>
      </AlertDialogHeader>
      <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 rounded-xl bg-muted px-4 py-3 text-[13px]">
        <dt className={meta}>Schedule</dt><dd className="m-0 font-mono text-xs [overflow-wrap:anywhere]">{job.scheduleLabel}</dd>
        <dt className={meta}>Session</dt><dd className="m-0 font-mono text-xs [overflow-wrap:anywhere]">{job.sessionKey}</dd>
        <dt className={meta}>Message</dt><dd className="m-0 line-clamp-3 [overflow-wrap:anywhere]">{job.message}</dd>
      </dl>
      {error && <p className="m-0 text-[13px] text-destructive" role="alert">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy} className="rounded-xl">Cancel</AlertDialogCancel>
        <AlertDialogAction disabled={busy || !!error} onClick={(event) => { event.preventDefault(); void confirm(); }}
          className={cn("rounded-xl", open === "delete" && "bg-destructive text-white hover:bg-destructive/90")}>{busy ? "Working…" : copy[open].action}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>}
  </AlertDialog>;
}

export function Cron({ reload, mutator, focus }: { reload: number; mutator: Mutator; focus: string | null }) {
  const [resource, refetch] = useResource<{ jobs: WebCronJob[] }>("/cron", reload);
  return <Status resource={resource}>{resource.state === "ready" && <>
    {!mutator.live && <p className={cn(meta, "mt-0 mb-3")}>Changes are available while connected.</p>}
    <CronList jobs={resource.value.jobs} focus={focus} actions={(job) => <CronActions job={job} mutator={mutator} onDone={refetch} />} />
  </>}</Status>;
}
