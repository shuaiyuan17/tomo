import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, TerminalIcon, X } from "lucide-react";
import type { WebSession, WebTask } from "../../src/web/protocol.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { measureExit, useAppeared, useExiting } from "./motion.js";
import { SubagentView } from "./subagent-view.js";
import { isShellTask, shellShortName } from "./shell.js";
import { ShellPill } from "./shell-pill.js";
import { ModelBadge } from "./model-badge.js";
import { type TaskRow, buildTaskView, elapsed, formatElapsed, lastStep, STATE_LABELS, taskKind } from "./tasks.js";

/** Read-only: shows what is running, never offers to stop it. */
export function TasksPanel({ tasks, sessions, onClose, footer }: { tasks: WebTask[]; sessions: WebSession[]; onClose?: () => void; footer?: ReactNode }) {
  const [showAmbient, setShowAmbient] = useState(false);
  /** Open "N shell commands done" rows, per session and parent. */
  const [openFolds, setOpenFolds] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<{ sessionId: string; taskId: string }>();
  const [cameBack, setCameBack] = useState(false);
  // The board drops a task a minute after it ends; an open view keeps the
  // last copy it saw (as ended) rather than vanishing under the reader.
  const lastOpened = useRef<WebTask | undefined>(undefined);
  const openTask = opened && (tasks.find((t) => t.sessionId === opened.sessionId && t.taskId === opened.taskId)
    ?? (lastOpened.current && { ...lastOpened.current, state: lastOpened.current.state === "running" ? "ended" as const : lastOpened.current.state }));
  lastOpened.current = openTask;
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
  const close = onClose && <Button data-tasks-close variant="ghost" size="icon" aria-label="Close tasks" title="Close" onClick={onClose}
    className="size-8 rounded-lg hover:bg-foreground/[0.07] active:bg-foreground/[0.11] [&_svg:not([class*='size-'])]:size-5"><X strokeWidth={1.75} /></Button>;
  // Task list ↔ task view slide: in from the right when opening, from the left when going back.
  if (openTask) return <div className="motion-from-right relative flex min-h-0 flex-1 flex-col">
    <div className="absolute top-0 right-1">{close}</div>
    <SubagentView key={`${openTask.sessionId}/${openTask.taskId}`} task={openTask} onBack={() => { setCameBack(true); setOpened(undefined); }} />
  </div>;
  return <section className={cn("flex min-h-0 flex-1 flex-col", cameBack && "motion-from-left")} aria-labelledby="tasks-heading">
    <div className="mb-1.5 flex items-center justify-between gap-3 pr-1 pl-2.5">
      <h2 id="tasks-heading" className="m-0 text-base font-semibold tracking-[-0.1px]">Tasks</h2>
      {close}
    </div>
    {ambient && <label className="mb-2.5 flex cursor-pointer items-center gap-2 px-2.5 tracking-[0.02em] text-[10px] text-muted-foreground">
      <Checkbox checked={showAmbient} onCheckedChange={(value) => setShowAmbient(value === true)} className="size-3.5 rounded-[4px]" />
      Show watchers{view.hiddenAmbient ? ` (${view.hiddenAmbient})` : ""}</label>}
    <div className="min-h-0 flex-1 overflow-y-auto pr-2.5 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] focus-visible:outline-offset-0" tabIndex={0} aria-label="Task list">
      {view.groups.length === 0 ? <p className="m-0 px-2.5 text-[13px] text-muted-foreground">Nothing running in the background.</p>
        : view.groups.map((group) => <div className="[&+&]:mt-4" key={group.sessionId}>
          <p className="mt-1 mb-1 px-2.5 tracking-[0.02em] text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{group.title}{group.kind === "group" ? <span className="opacity-80"> · group</span> : null}</p>
          <GroupRows sessionId={group.sessionId} rows={group.rows} now={now} openFolds={openFolds} setOpenFolds={setOpenFolds}
            onOpen={(task) => setOpened({ sessionId: task.sessionId, taskId: task.taskId })} />
        </div>)}
      {footer}
    </div>
  </section>;
}

const branch = "relative before:absolute before:top-2.5 before:-left-1.5 before:h-2.5 before:w-[7px] before:rounded-bl-[3px] before:border-b before:border-l before:content-['']";

function TaskCard({ task, depth, now, onOpen, motion }: { task: WebTask; depth: number; now: number; onOpen: () => void; motion?: string }) {
  const step = lastStep(task);
  const time = formatElapsed(elapsed(task, now));
  const running = task.state === "running";
  const shell = isShellTask(task.taskType);
  return <li ref={motion?.includes("motion-exit") ? measureExit : undefined} style={{ marginLeft: depth * 16 }} className={cn("relative", depth > 0 && branch, motion)}>
    <button type="button" title={shell ? `${shellShortName(task.description)}\n\n${task.description}\n\nOpen to see the full command` : taskKind(task)} onClick={onOpen}
      className={cn("block w-full cursor-pointer rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:outline-offset-0", "transition-[background-color,opacity] duration-200", !running && "opacity-60")}>
      <div className="flex min-w-0 items-baseline justify-between gap-2.5">
        {shell ? <span className="min-w-0"><ShellPill command={task.description} /></span>
          : <span className="text-[13px] leading-normal font-medium [overflow-wrap:anywhere]">{task.description || "Untitled task"}<ModelBadge model={task.model} /></span>}
        {running && <span className="shrink-0 tracking-[0.02em] text-[10px] text-muted-foreground tabular-nums opacity-75">{time}</span>}
      </div>
      <p className="mt-0.5 mb-0 text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]">
        {running ? <><span className="shimmer">Working</span>{step && <> · {step}</>}</> : <>{STATE_LABELS[task.state]} · {time}</>}
      </p>
    </button>
  </li>;
}

/** Two or more finished shell commands under one parent, folded into one row. */
function FoldedShells({ tasks, depth, now, open, onToggle, onOpen, motion }:
  { tasks: WebTask[]; depth: number; now: number; open: boolean; onToggle: () => void; onOpen: (task: WebTask) => void; motion?: string }) {
  return <>
    <li ref={motion?.includes("motion-exit") ? measureExit : undefined} style={{ marginLeft: depth * 16 }} className={cn("relative", depth > 0 && branch, motion)}>
      <button type="button" aria-expanded={open} onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-xs text-muted-foreground opacity-80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <TerminalIcon className="size-3 shrink-0" aria-hidden="true" />{tasks.length} shell commands done</button>
    </li>
    {open && tasks.map((task) => <TaskCard key={task.taskId} task={task} depth={depth + 1} now={now} onOpen={() => onOpen(task)} />)}
  </>;
}

const rowKey = (row: TaskRow) => (row.folded ? `folded:${row.foldKey}` : row.task.taskId);

/** One session's rows: new cards drop in, leaving ones fade and collapse. */
function GroupRows({ sessionId, rows, now, openFolds, setOpenFolds, onOpen }: {
  sessionId: string; rows: TaskRow[]; now: number; openFolds: Record<string, boolean>;
  setOpenFolds: (update: (old: Record<string, boolean>) => Record<string, boolean>) => void; onOpen: (task: WebTask) => void }) {
  const appeared = useAppeared(rows.map(rowKey), sessionId);
  const shown = useExiting(rows, rowKey);
  return <ul className="m-0 list-none space-y-0.5 p-0">{shown.map(({ item: row, exiting }) => {
    const motion = exiting ? "motion-exit pointer-events-none" : appeared.has(rowKey(row)) ? "motion-drop" : undefined;
    return row.folded
      ? <FoldedShells key={rowKey(row)} motion={motion} tasks={row.folded} depth={row.depth} now={now}
          open={!!openFolds[`${sessionId}/${row.foldKey}`]}
          onToggle={() => setOpenFolds((old) => { const k = `${sessionId}/${row.foldKey}`; return { ...old, [k]: !old[k] }; })}
          onOpen={onOpen} />
      : <TaskCard key={rowKey(row)} motion={motion} task={row.task} depth={row.depth} now={now} onOpen={() => onOpen(row.task)} />;
  })}</ul>;
}
