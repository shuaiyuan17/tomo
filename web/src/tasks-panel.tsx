import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { WebSession, WebTask } from "../../src/web/protocol.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { buildTaskView, elapsed, formatElapsed, lastStep, STATE_LABELS, taskKind } from "./tasks.js";

/** Read-only: shows what is running, never offers to stop it. */
export function TasksPanel({ tasks, sessions, onClose }: { tasks: WebTask[]; sessions: WebSession[]; onClose?: () => void }) {
  const [showAmbient, setShowAmbient] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const view = buildTaskView(tasks, sessions, showAmbient);
  const ticking = view.running > 0;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  const ambient = tasks.some((task) => task.ambient);
  return <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="tasks-heading">
    <div className="mb-2 flex items-center justify-between gap-3 px-2.5">
      <h2 id="tasks-heading" className="m-0 text-base font-semibold tracking-[-0.1px]">Tasks</h2>
      {onClose && <Button data-tasks-close variant="ghost" size="icon" aria-label="Close tasks" title="Close" onClick={onClose}
        className="size-9 rounded-xl hover:bg-foreground/[0.07] active:bg-foreground/[0.11] [&_svg:not([class*='size-'])]:size-5"><X strokeWidth={1.75} /></Button>}
    </div>
    {ambient && <label className="mb-2.5 flex cursor-pointer items-center gap-2 px-2.5 font-mono text-[10px] text-muted-foreground">
      <Checkbox checked={showAmbient} onCheckedChange={(value) => setShowAmbient(value === true)} className="size-3.5 rounded-[4px]" />
      Show watchers{view.hiddenAmbient ? ` (${view.hiddenAmbient})` : ""}</label>}
    <div className="min-h-0 flex-1 overflow-y-auto pr-2.5 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] focus-visible:outline-offset-0" tabIndex={0} aria-label="Task list">
      {view.groups.length === 0 ? <p className="m-0 px-2.5 text-[13px] text-muted-foreground">Nothing running in the background.</p>
        : view.groups.map((group) => <div className="[&+&]:mt-4" key={group.sessionId}>
          <p className="mt-1 mb-1 px-2.5 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{group.title}{group.kind === "group" ? <span className="opacity-80"> · group</span> : null}</p>
          <ul className="m-0 list-none space-y-0.5 p-0">{group.rows.map(({ task, depth }) => {
            const step = lastStep(task);
            const time = formatElapsed(elapsed(task, now));
            const running = task.state === "running";
            return <li key={task.taskId} title={taskKind(task)} style={{ marginLeft: depth * 16 }}
              className={cn("relative rounded-xl px-2.5 py-2 transition-colors duration-150 hover:bg-foreground/[0.06]", !running && "opacity-60",
                depth > 0 && "before:absolute before:top-2.5 before:-left-1.5 before:h-2.5 before:w-[7px] before:rounded-bl-[3px] before:border-b before:border-l before:content-['']")}>
              <div className="flex items-baseline justify-between gap-2.5">
                <span className="text-[13px] leading-normal [overflow-wrap:anywhere]">{task.description || "Untitled task"}</span>
                {running && <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums opacity-75">{time}</span>}
              </div>
              <p className="mt-0.5 mb-0 text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]">
                {running ? <><span className="shimmer">Working</span>{step && <> · {step}</>}</> : <>{STATE_LABELS[task.state]} · {time}</>}
              </p>
            </li>;
          })}</ul>
        </div>)}
    </div>
  </section>;
}
