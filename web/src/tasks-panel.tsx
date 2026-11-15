import { lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, TerminalIcon, X } from "lucide-react";
import type { WebSession, WebTask } from "../../src/web/protocol.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { measureExit, useAppeared, useExiting } from "./motion.js";
import type { TaskControl } from "./subagent-view.js";
import { isShellTask, shellLabel } from "./shell.js";
import { ShellPill } from "./shell-pill.js";
import { ChunkBoundary } from "./chunk-boundary.js";
import { ModelBadge } from "./model-badge.js";
import { type TaskRow, type TreeGuide, buildTaskView, elapsed, formatElapsed, lastStep, STATE_LABELS, taskKind, treeGuides } from "./tasks.js";
import { toolIcon } from "./tool-calls.js";

/** A task's transcript view: its own chunk, fetched when a task is opened. */
const SubagentView = lazy(() => import("./subagent-view.js").then((m) => ({ default: m.SubagentView })));

/**
 * Shows what is running. The list itself offers nothing to act on; an opened task of the owner
 * conversation can be stopped or moved to the background (`control`, see TaskControls).
 */
export function TasksPanel({ tasks, sessions, onClose, footer, control }: { tasks: WebTask[]; sessions: WebSession[]; onClose?: () => void; footer?: ReactNode; control?: TaskControl }) {
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
    className="size-8 rounded-lg max-[600px]:size-10 hover:bg-foreground/[0.07] active:bg-foreground/[0.11] [&_svg:not([class*='size-'])]:size-5"><X strokeWidth={1.75} /></Button>;
  // Task list ↔ task view slide: in from the right when opening, from the left when going back.
  if (openTask) return <div className="motion-from-right relative flex min-h-0 flex-1 flex-col">
    <div className="absolute top-0 right-1">{close}</div>
    <ChunkBoundary what="The task view" className="min-h-0 flex-1"><SubagentView key={`${openTask.sessionId}/${openTask.taskId}`} task={openTask} control={control} onBack={() => { setCameBack(true); setOpened(undefined); }} /></ChunkBoundary>
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
          <p className="mt-1 mb-1 px-2.5 tracking-[0.02em] text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{group.title}{group.kind === "group" ? <span> · group</span> : null}</p>
          <GroupRows sessionId={group.sessionId} rows={group.rows} now={now} openFolds={openFolds} setOpenFolds={setOpenFolds}
            onOpen={(task) => setOpened({ sessionId: task.sessionId, taskId: task.taskId })} />
        </div>)}
      {footer}
    </div>
  </section>;
}

/** Each level of nesting steps in this far. */
const INDENT = 16;
/** Where the line of `level` runs, measured from the left edge of a row at `depth`: under its parent's title. */
const lineX = (level: number, depth: number) => (level - depth) * INDENT - 6;

/**
 * A nested row's tree lines, drawn in CSS: the line of each shallower level that passes it on the
 * way to a later sibling (`through`), its own line going on to its next sibling (`stem`), and the
 * rounded elbow into it, at the height of its title (`elbowY`). The last child's line stops at its
 * elbow. Lines reach up over the 2px gap between rows, and the first child's into its parent's
 * bottom padding, so they join up.
 */
function TreeLines({ depth, guide, elbowY }: { depth: number; guide: TreeGuide; elbowY: number }) {
  if (depth === 0) return null;
  const x = lineX(depth, depth);
  return <span aria-hidden="true" data-tree-lines className="pointer-events-none absolute inset-y-0 left-0 text-[color-mix(in_oklab,var(--border)_70%,var(--muted-foreground))]">
    {guide.through.map((level) => <span key={level} data-tree-line="through" className="absolute -top-0.5 bottom-0 w-px bg-current" style={{ left: lineX(level, depth) }} />)}
    {!guide.last && <span data-tree-line="stem" className="absolute -top-2 bottom-0 w-px bg-current" style={{ left: x }} />}
    <span data-tree-line="elbow" className="absolute -top-2 w-3 rounded-bl-[6px] border-b border-l border-current" style={{ left: x, height: elbowY + 8 }} />
  </span>;
}

/** A task's kind, marked as the trace marks the call that started it: a robot for a subagent, a terminal for a monitor. */
function kindIcon(taskType: string): { Icon: ReturnType<typeof toolIcon>; kind: string } | undefined {
  if (taskType === "local_agent" || taskType === "remote_agent") return { Icon: toolIcon("Agent"), kind: "agent" };
  if (taskType === "monitor") return { Icon: toolIcon("Bash"), kind: "shell" };
  return undefined;
}

function TaskCard({ task, depth, guide, now, onOpen, motion }: { task: WebTask; depth: number; guide?: TreeGuide; now: number; onOpen: () => void; motion?: string }) {
  const step = lastStep(task);
  const time = formatElapsed(elapsed(task, now));
  const running = task.state === "running";
  const shell = isShellTask(task.taskType);
  const icon = shell ? undefined : kindIcon(task.taskType);
  return <li ref={motion?.includes("motion-exit") ? measureExit : undefined} style={{ marginLeft: depth * INDENT }} className={cn("relative", motion)}>
    <button type="button" title={shell ? `${shellLabel(task.description)}\n\n${task.description}\n\nOpen to see the full command` : taskKind(task)} onClick={onOpen}
      className={cn("block w-full cursor-pointer rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:outline-offset-0", "transition-[background-color,opacity] duration-200")}>
      <div className="flex min-w-0 items-baseline justify-between gap-2.5">
        {shell ? <span className="min-w-0"><ShellPill command={task.description} /></span>
          : <span className={cn("text-[13px] leading-normal font-medium [overflow-wrap:anywhere]", !running && "text-muted-foreground")}>
            {icon && <icon.Icon data-task-icon={icon.kind} aria-hidden="true" className="mr-1.5 inline-block size-3.5 align-[-2px] text-muted-foreground" />}
            {task.description || "Untitled task"}<ModelBadge model={task.model} /></span>}
        {running && <span className="shrink-0 tracking-[0.02em] text-[10px] text-muted-foreground tabular-nums">
          {task.background && <span data-testid="task-background" title="Keeps running after Tomo has replied">background · </span>}{time}</span>}
      </div>
      <p className="mt-0.5 mb-0 text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]">
        {running ? <><span className="shimmer">Working</span>{step && <> · {step}</>}</> : <>{STATE_LABELS[task.state]} · {time}</>}
      </p>
    </button>
    {guide && <TreeLines depth={depth} guide={guide} elbowY={18} />}
  </li>;
}

/** Two or more finished shell commands under one parent, folded into one row. */
function FoldedShells({ count, depth, guide, open, onToggle, motion }:
  { count: number; depth: number; guide?: TreeGuide; open: boolean; onToggle: () => void; motion?: string }) {
  return <li ref={motion?.includes("motion-exit") ? measureExit : undefined} style={{ marginLeft: depth * INDENT }} className={cn("relative", motion)}>
    <button type="button" aria-expanded={open} onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
      <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      <TerminalIcon className="size-3 shrink-0" aria-hidden="true" />{count} shell commands done</button>
    {guide && <TreeLines depth={depth} guide={guide} elbowY={15} />}
  </li>;
}

/** A row as laid out on screen: a task card, or a fold of finished commands. */
interface Line { key: string; depth: number; motion?: string; task?: WebTask; fold?: { count: number; open: boolean; id: string } }

const rowKey = (row: TaskRow) => (row.folded ? `folded:${row.foldKey}` : row.task.taskId);

/** One session's rows: new cards drop in, leaving ones fade and collapse. */
function GroupRows({ sessionId, rows, now, openFolds, setOpenFolds, onOpen }: {
  sessionId: string; rows: TaskRow[]; now: number; openFolds: Record<string, boolean>;
  setOpenFolds: (update: (old: Record<string, boolean>) => Record<string, boolean>) => void; onOpen: (task: WebTask) => void }) {
  const appeared = useAppeared(rows.map(rowKey), sessionId);
  const shown = useExiting(rows, rowKey);
  // Lines are drawn per row, so first lay out every row on screen (an open fold's commands
  // included, one level in) and work out which lines pass each one.
  const lines = shown.flatMap(({ item: row, exiting }): Line[] => {
    const motion = exiting ? "motion-exit pointer-events-none" : appeared.has(rowKey(row)) ? "motion-drop" : undefined;
    if (!row.folded) return [{ key: rowKey(row), depth: row.depth, task: row.task, motion }];
    const foldId = `${sessionId}/${row.foldKey}`;
    const open = !!openFolds[foldId];
    return [{ key: rowKey(row), depth: row.depth, fold: { count: row.folded.length, open, id: foldId }, motion },
      ...(open ? row.folded.map((task) => ({ key: task.taskId, depth: row.depth + 1, task })) : [])];
  });
  const guides = treeGuides(lines.map((line) => line.depth));
  return <ul className="m-0 list-none space-y-0.5 p-0">{lines.map((line, i) => line.fold
    ? <FoldedShells key={line.key} motion={line.motion} count={line.fold.count} depth={line.depth} guide={guides[i]} open={line.fold.open}
        onToggle={() => { const id = line.fold!.id; setOpenFolds((old) => ({ ...old, [id]: !old[id] })); }} />
    : <TaskCard key={line.key} motion={line.motion} task={line.task!} depth={line.depth} guide={guides[i]} now={now} onOpen={() => onOpen(line.task!)} />)}</ul>;
}
