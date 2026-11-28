import { lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, TerminalIcon, X } from "lucide-react";
import type { WebSession, WebSubsession, WebTask } from "../../src/web/protocol.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { measureExit, useAppeared, useExiting } from "./motion.js";
import type { TaskControl } from "./subagent-view.js";
import { isShellTask, shellLabel } from "./shell.js";
import { ShellPill } from "./shell-pill.js";
import { ChunkBoundary } from "./chunk-boundary.js";
import { ModelBadge } from "./model-badge.js";
import { type TaskRow, type TreeGuide, buildTaskView, formatElapsed, lastStep, railSections, rowElapsed, stateLabel, taskKind, treeGuides } from "./tasks.js";
import { i18n, useTranslation } from "./i18n/index.js";
import { formatNumber } from "./i18n/format.js";
import { toolIcon } from "./tool-calls.js";
import { asksOwner, isOpenSubsession, subsessionState, subsessionStateLabel, isWorkingState, todaysSubsessions, useToday } from "./subsessions.js";
import { IdPill, SubsessionView, type SubsessionDone, type SubsessionSend } from "./subsession-view.js";
import { RAIL_SCROLL, useScrollbarInPadding } from "./rail-scroll.js";

/** A task's transcript view: its own chunk, fetched when a task is opened. */
const SubagentView = lazy(() => import("./subagent-view.js").then((m) => ({ default: m.SubagentView })));

/** The owner's sub-sessions as the rail shows them: the list, its revision (an open chat re-reads on it), how to write to one and to mark its report's ask done. */
export interface RailSubsessions { tasks: WebSubsession[]; revision: number; send?: SubsessionSend; done?: SubsessionDone }

/**
 * Shows what is running. The list itself offers nothing to act on; an opened task of the owner
 * conversation can be stopped or moved to the background (`control`, see TaskControls). The
 * owner conversation's own tasks come first, then the owner's sub-sessions in their own group
 * (one opens as a chat in the rail), then other conversations. Ended sub-sessions from before
 * today stay folded under "N earlier" until asked for.
 */
export function TasksPanel({ tasks, sessions, onClose, footer, control, subsessions, openedSub: openedFromOutside, onOpenSub }: { tasks: WebTask[]; sessions: WebSession[]; onClose?: () => void; footer?: ReactNode; control?: TaskControl; subsessions?: RailSubsessions;
  /** The sub-session open in the rail, when the page keeps it (an activity card's "Open task" sets it); otherwise the rail keeps its own. */
  openedSub?: string; onOpenSub?: (id: string | undefined) => void }) {
  const { t } = useTranslation("tasks");
  const [showAmbient, setShowAmbient] = useState(false);
  const listGutter = useScrollbarInPadding<HTMLDivElement>();
  /** Open "N shell commands done" rows, per session and parent. */
  const [openFolds, setOpenFolds] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<{ sessionId: string; taskId: string }>();
  const [cameBack, setCameBack] = useState(false);
  const [ownOpenedSub, setOwnOpenedSub] = useState<string>();
  const openedSub = onOpenSub ? openedFromOutside : ownOpenedSub;
  const setOpenedSub = onOpenSub ?? setOwnOpenedSub;
  // A sub-session opened from outside (a card's "Open task") replaces a subagent view left open, so Back leads to the list.
  useEffect(() => { if (openedFromOutside !== undefined) setOpened(undefined); }, [openedFromOutside]);
  /** Ended sub-sessions from before today are listed too. Not kept: the rail opens tidy again. */
  const [showEarlier, setShowEarlier] = useState(false);
  const today = useToday();
  // As for a task: a sub-session that leaves the list (archived) keeps its last copy while open.
  const lastSub = useRef<WebSubsession | undefined>(undefined);
  const openSub = openedSub !== undefined ? subsessions?.tasks.find((task) => task.id === openedSub) ?? (lastSub.current?.id === openedSub ? lastSub.current : undefined) : undefined;
  lastSub.current = openSub;
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
  const subs = todaysSubsessions(subsessions?.tasks ?? [], today);
  const sections = railSections(view.groups, !!subsessions?.tasks.length);
  const close = onClose && <Button data-tasks-close variant="ghost" size="icon" aria-label={t("close")} title={t("closeTitle")} onClick={onClose}
    className="size-8 rounded-lg max-phone:size-10 hover:bg-foreground/[0.07] active:bg-foreground/[0.11] [&_svg:not([class*='size-'])]:size-5"><X strokeWidth={1.75} /></Button>;
  // Task list ↔ task view slide: in from the right when opening, from the left when going back.
  // Above the view: its slide-in leaves it a layer of its own, which would cover the button.
  if (openSub && subsessions) return <div className="relative flex min-h-0 flex-1 flex-col">
    <div className="absolute top-0 right-1 z-10">{close}</div>
    <SubsessionView key={openSub.id} summary={openSub} revision={subsessions.revision} send={subsessions.send} done={subsessions.done} onBack={() => { setCameBack(true); setOpenedSub(undefined); }} />
  </div>;
  if (openTask) return <div className="motion-from-right relative flex min-h-0 flex-1 flex-col">
    <div className="absolute top-0 right-1">{close}</div>
    <ChunkBoundary what={t("view")} className="min-h-0 flex-1"><SubagentView key={`${openTask.sessionId}/${openTask.taskId}`} task={openTask} control={control} onBack={() => { setCameBack(true); setOpened(undefined); }} /></ChunkBoundary>
  </div>;
  return <section className={cn("flex min-h-0 flex-1 flex-col", cameBack && "motion-from-left")} aria-labelledby="tasks-heading">
    <div className="mb-1.5 flex items-center justify-between gap-3 pr-1 pl-2.5">
      <h2 id="tasks-heading" className="m-0 text-base font-semibold tracking-[-0.1px]">{t("heading")}</h2>
      {close}
    </div>
    {ambient && <label className="mb-2.5 flex cursor-pointer items-center gap-2 px-2.5 tracking-[0.02em] text-[10px] text-muted-foreground">
      <Checkbox checked={showAmbient} onCheckedChange={(value) => setShowAmbient(value === true)} className="size-3.5 rounded-[4px]" />
      {view.hiddenAmbient ? t("watchersCount", { count: view.hiddenAmbient }) : t("watchers")}</label>}
    <div ref={listGutter} className={cn("min-h-0 flex-1 overflow-y-auto focus-visible:outline-offset-0", RAIL_SCROLL)} tabIndex={0} aria-label={t("list")}>
      {sections.length === 0 ? <p className="m-0 px-2.5 text-[13px] text-muted-foreground">{t("empty")}</p>
        : sections.map((group) => group === "subsessions" ? <div className="[&+&]:mt-4" key="subsessions" data-testid="subsessions">
          <p className="mt-1 mb-1 px-2.5 tracking-[0.02em] text-[11px] text-muted-foreground">{t("subsession.group")}</p>
          <ul className="m-0 list-none space-y-0.5 p-0">
            {subs.shown.map((task) => <SubsessionCard key={task.id} task={task} onOpen={() => setOpenedSub(task.id)} />)}
            {subs.earlier.length > 0 && <li><button type="button" data-testid="subsessions-earlier" aria-expanded={showEarlier} onClick={() => setShowEarlier((old) => !old)}
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-offset-0">
              <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", showEarlier && "rotate-90")} />{t("subsession.earlier", { count: subs.earlier.length, n: formatNumber(subs.earlier.length) })}</button></li>}
            {showEarlier && subs.earlier.map((task) => <SubsessionCard key={task.id} task={task} onOpen={() => setOpenedSub(task.id)} />)}
          </ul>
        </div> : <div className="[&+&]:mt-4" key={group.sessionId}>
          <p className="mt-1 mb-1 px-2.5 tracking-[0.02em] text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{group.title}{group.kind === "group" ? <span>{t("groupTag")}</span> : null}</p>
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

function TaskCard({ task, depth, guide, now, onOpen, motion, childrenRunning, settledAt }: { task: WebTask; depth: number; guide?: TreeGuide; now: number; onOpen: () => void; motion?: string;
  childrenRunning?: boolean; settledAt?: number }) {
  const { t } = useTranslation("tasks");
  const step = lastStep(task);
  // A task that ended while work it started still runs reads as working, its time running until the last of that ends.
  const time = formatElapsed(rowElapsed({ task, ...(childrenRunning ? { childrenRunning: true as const } : {}), ...(settledAt !== undefined ? { settledAt } : {}) }, now));
  const running = task.state === "running" || !!childrenRunning;
  const shell = isShellTask(task.taskType);
  const icon = shell ? undefined : kindIcon(task.taskType);
  return <li ref={motion?.includes("motion-exit") ? measureExit : undefined} style={{ marginLeft: depth * INDENT }} className={cn("relative", motion)}>
    <button type="button" title={shell ? t("shellTitle", { label: shellLabel(task.description), command: task.description }) : taskKind(task)} onClick={onOpen}
      className={cn("block w-full cursor-pointer rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:outline-offset-0", "transition-[background-color,opacity] duration-200")}>
      <div className="flex min-w-0 items-baseline justify-between gap-2.5">
        {shell ? <span className="min-w-0"><ShellPill command={task.description} /></span>
          : <span className={cn("text-[13px] leading-normal font-medium [overflow-wrap:anywhere]", !running && "text-muted-foreground")}>
            {icon && <icon.Icon data-task-icon={icon.kind} aria-hidden="true" className="mr-1.5 inline-block size-3.5 align-[-2px] text-muted-foreground" />}
            {task.description || t("untitled")}<ModelBadge model={task.model} /></span>}
        {running && <span className="shrink-0 tracking-[0.02em] text-[10px] text-muted-foreground tabular-nums">
          {task.background && <span data-testid="task-background" title={t("backgroundTitle")}>{t("backgroundTag")}</span>}{time}</span>}
      </div>
      <p className="mt-0.5 mb-0 text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]">
        {childrenRunning && task.state !== "running" ? <><span className="shimmer">{t("working")}</span> · <span data-testid="task-children-running">{t("childrenRunning")}</span></>
          : running ? <><span className="shimmer">{t("working")}</span>{step && <> · {step}</>}</> : <>{stateLabel(task.state)} · {time}</>}
      </p>
    </button>
    {guide && <TreeLines depth={depth} guide={guide} elbowY={18} />}
  </li>;
}

/** A sub-session: its id, title, state and the plan step it is on. Opens as a chat. */
function SubsessionCard({ task, onOpen }: { task: WebSubsession; onOpen: () => void }) {
  const { t } = useTranslation("tasks");
  const state = subsessionState(task);
  const open = isOpenSubsession(task);
  return <li data-subsession-row={task.id}>
    <button type="button" onClick={onOpen} title={t("subsession.openTitle", { id: task.id })}
      className="block w-full cursor-pointer rounded-xl px-2.5 py-2 text-left transition-[background-color,opacity] duration-200 hover:bg-foreground/[0.06] focus-visible:outline-offset-0">
      <span className={cn("block text-[13px] leading-normal font-medium [overflow-wrap:anywhere]", !open && "text-muted-foreground")}>
        <IdPill id={task.id} className="mr-1.5 align-[1px]" />{task.title}<ModelBadge model={task.model} /></span>
      <p className="mt-0.5 mb-0 line-clamp-2 text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]">
        {isWorkingState(state) ? <span className="shimmer">{subsessionStateLabel(task)}</span>
          : <span className={cn(asksOwner(state) && "font-medium text-foreground/80")}>{subsessionStateLabel(task)}</span>}
        {state === "needsYou" ? <> · {task.ownerAction}</> : task.step && open && <> · {task.step}</>}</p>
    </button>
  </li>;
}

/** Two or more finished shell commands under one parent, folded into one row. */
function FoldedShells({ count, depth, guide, open, onToggle, motion }:
  { count: number; depth: number; guide?: TreeGuide; open: boolean; onToggle: () => void; motion?: string }) {
  return <li ref={motion?.includes("motion-exit") ? measureExit : undefined} style={{ marginLeft: depth * INDENT }} className={cn("relative", motion)}>
    <button type="button" aria-expanded={open} onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
      <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      <TerminalIcon className="size-3 shrink-0" aria-hidden="true" />{i18n.t("tasks:foldedShells", { count })}</button>
    {guide && <TreeLines depth={depth} guide={guide} elbowY={15} />}
  </li>;
}

/** A row as laid out on screen: a task card, or a fold of finished commands. */
interface Line { key: string; depth: number; motion?: string; task?: WebTask; fold?: { count: number; open: boolean; id: string };
  childrenRunning?: boolean; settledAt?: number }

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
    if (!row.folded) return [{ key: rowKey(row), depth: row.depth, task: row.task, motion, childrenRunning: row.childrenRunning, settledAt: row.settledAt }];
    const foldId = `${sessionId}/${row.foldKey}`;
    const open = !!openFolds[foldId];
    return [{ key: rowKey(row), depth: row.depth, fold: { count: row.folded.length, open, id: foldId }, motion },
      ...(open ? row.folded.map((task) => ({ key: task.taskId, depth: row.depth + 1, task })) : [])];
  });
  const guides = treeGuides(lines.map((line) => line.depth));
  return <ul className="m-0 list-none space-y-0.5 p-0">{lines.map((line, i) => line.fold
    ? <FoldedShells key={line.key} motion={line.motion} count={line.fold.count} depth={line.depth} guide={guides[i]} open={line.fold.open}
        onToggle={() => { const id = line.fold!.id; setOpenFolds((old) => ({ ...old, [id]: !old[id] })); }} />
    : <TaskCard key={line.key} motion={line.motion} task={line.task!} depth={line.depth} guide={guides[i]} now={now} childrenRunning={line.childrenRunning} settledAt={line.settledAt} onOpen={() => onOpen(line.task!)} />)}</ul>;
}
