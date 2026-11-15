import { useEffect, useState } from "react";
import { ArrowUpRightIcon, BotIcon, BrainIcon, CircleCheckIcon, CircleDotIcon, CircleIcon, FilePenLineIcon, FileTextIcon, GlobeIcon, ImageIcon,
  LayersIcon, ListTodoIcon, MessageSquareTextIcon, SearchIcon, TerminalIcon, WrenchIcon, type LucideIcon } from "lucide-react";
import type { TodoEntry, WebSource } from "../../src/web/protocol.js";
import { cn } from "@/lib/utils";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle,
  type TraceStatus } from "@/components/ui/trace";
import { ToolSection } from "@/components/ai/tool";
import { Text } from "./markdown.js";
import { LINK_PROPS, safeHref, sourceHost } from "./links.js";
import { callDuration, elapsedSince, groupDuration, groupLabel, groupStart, todoSections, todoSummary, type ThinkingRow, type TodosRow, type ToolRow,
  type ViewBlock } from "./subagent.js";

/**
 * What the agent does in a turn, as the task view and the main chat both
 * show it: every step is one Trace line (components/ui/trace.tsx) — icon,
 * title, optional description, running / error state — that opens to its
 * detail. A call opens to its INPUT / OUTPUT (rendered only once opened); a
 * run of calls is one folded group whose summary names the running call,
 * shimmering; thinking opens to its text; the turn's todo list and the pages
 * it used are a line each.
 */

const TOOL_ICONS: Record<string, LucideIcon> = {
  Bash: TerminalIcon, Read: FileTextIcon,
  Edit: FilePenLineIcon, Write: FilePenLineIcon, MultiEdit: FilePenLineIcon, NotebookEdit: FilePenLineIcon,
  Grep: SearchIcon, Glob: SearchIcon, WebSearch: SearchIcon, WebFetch: GlobeIcon,
  Agent: BotIcon, Task: BotIcon, TodoWrite: ListTodoIcon,
  SubagentMessage: MessageSquareTextIcon, BackgroundTask: TerminalIcon,
};
/**
 * Rows whose title is a sentence, not a command: a subagent's run, a
 * background task reporting back, and a web search (its query is words, often
 * not English). A Bash call the model described says so (`prose`); a command,
 * path, pattern or URL stays monospace.
 */
const PROSE_TITLES = new Set(["Agent", "Task", "SubagentMessage", "BackgroundTask", "WebSearch"]);
/** What a row's result is called: a subagent hands back a report, a tool returns output. */
const resultLabel = (name: string, isError: boolean) => isError ? "Error" : name === "SubagentMessage" || name === "Agent" || name === "Task" ? "Report" : "Output";
/** A tool's trace icon; the Tasks panel marks its subagent and shell tasks with the same ones. */
export const toolIcon = (name: string) => TOOL_ICONS[name] ?? WrenchIcon;

/**
 * In front of a running step: Tomo's own ring, drawing itself. The accent
 * colour and the motion both say "working"; with reduced motion it is the
 * still ring, and the title still shimmers.
 */
const MARK_PATH = "M 32 14 C 36 20, 32 32, 20 32 C 8 32, 5 22, 10 14 C 14 7, 26 6, 30 12";
export function RunningMark() {
  return <svg viewBox="0 0 40 40" aria-hidden="true" data-slot="running-mark" className="fill-none stroke-primary [stroke-linecap:round] [stroke-width:4.5]">
    {/* A faint ring is always there, so the mark never blinks out between passes. */}
    <path d={MARK_PATH} className="opacity-25" />
    <path pathLength={100} d={MARK_PATH} className="animate-mark [stroke-dasharray:100] motion-reduce:hidden" /></svg>;
}
/** A clock that ticks once a second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Said to a screen reader after the title: the state the colour or shimmer shows. */
const StateText = ({ status }: { status?: TraceStatus }) => status === "running" ? <span className="sr-only">Running</span>
  : status === "error" ? <span className="sr-only">Failed</span> : null;

export function ToolCall({ row, running }: { row: ToolRow; running: boolean }) {
  const result = row.result;
  const label = resultLabel(row.name, result?.isError === true);
  const status: TraceStatus | undefined = result?.isError ? "error" : !result && running ? "running" : undefined;
  const now = useNow(status === "running");
  const duration = status === "running" ? elapsedSince(row.ts, now) : callDuration(row);
  const Icon = status === "running" ? RunningMark : toolIcon(row.name);
  return <TraceCollapsible data-kind="tool">
    <TraceCollapsibleTrigger>
      <TraceLine status={status}>
        <TraceIcon><Icon /></TraceIcon>
        <TraceTitle className={row.prose || PROSE_TITLES.has(row.name) ? undefined : "font-mono text-[11.5px]"}>{row.summary || row.name}</TraceTitle>
        {duration && <TraceDescription>{duration}</TraceDescription>}
        <StateText status={status} />
      </TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="space-y-2.5 pt-1 pb-1.5">
      {row.input && <ToolSection label="Input" text={row.input} truncated={row.inputTruncated} />}
      {result && (result.output || !result.images) && <ToolSection label={label} text={result.output} truncated={result.truncated} error={result.isError} />}
      {result?.images ? <div className="space-y-1">
        {!result.output && <p className="m-0 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">{label}</p>}
        <ImageOutput count={result.images} /></div> : null}
    </TraceCollapsibleContent>
  </TraceCollapsible>;
}

/** An image in a tool's output: named, never fetched (the server does not serve its bytes). */
function ImageOutput({ count }: { count: number }) {
  return <span className="inline-flex items-center gap-1.5 rounded-lg border bg-card/70 px-2 py-1 text-[11.5px] text-muted-foreground">
    <ImageIcon className="size-3.5" aria-hidden="true" />{count > 1 ? `${count} image outputs, not shown` : "Image output, not shown"}</span>;
}

/** A thinking block: one folded, muted line (sans, never the reply serif), opening in place to the text. */
export function Thinking({ text, truncated = false, className }: { text: string; truncated?: boolean; className?: string }) {
  return <TraceCollapsible data-kind="thinking" className={cn("font-sans", className)}>
    <TraceCollapsibleTrigger>
      <TraceLine><TraceIcon><BrainIcon /></TraceIcon><TraceTitle>Thinking</TraceTitle></TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="py-1">
      <div className="markdown text-[12.5px]! leading-relaxed! text-muted-foreground [&_:is(h1,h2,h3)]:font-sans [&_:is(h1,h2,h3)]:text-[13px]!">
        <Text>{text + (truncated ? "\n\n…" : "")}</Text></div>
    </TraceCollapsibleContent>
  </TraceCollapsible>;
}

/** `running`: this is the run still growing (its last call without a result is named in the summary). `steps`: the calls with any thinking between them, in order. */
export function ToolGroup({ tools, steps, open, onOpenChange, running, className }:
  { tools: ToolRow[]; steps?: Array<ToolRow | ThinkingRow>; open: boolean; onOpenChange: (open: boolean) => void; running: boolean; className?: string }) {
  const label = groupLabel(tools, running);
  const failed = tools.filter((tool) => tool.result?.isError).length;
  const now = useNow(running);
  const duration = running ? elapsedSince(groupStart(tools), now) : groupDuration(tools);
  return <TraceCollapsible data-kind="group" open={open} onOpenChange={onOpenChange} className={className}>
    <TraceCollapsibleTrigger>
      <TraceLine>
        <TraceIcon>{running ? <RunningMark /> : <LayersIcon />}</TraceIcon>
        <TraceTitle>{label.lead}{label.running && <span className="shimmer">{label.running}</span>}</TraceTitle>
        {failed > 0 && <TraceDescription className="text-destructive/80">{failed === 1 ? "1 failed" : `${failed} failed`}</TraceDescription>}
        {duration && <TraceDescription>{duration}</TraceDescription>}
      </TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="py-0.5 pl-1">
      <Trace>
        {(steps ?? tools).map((row) => row.kind === "thinking" ? <Thinking key={row.id} text={row.text} truncated={row.truncated} />
          : <ToolCall key={row.id} row={row} running={running} />)}
      </Trace>
    </TraceCollapsibleContent>
  </TraceCollapsible>;
}

/**
 * The agent's todo list (its latest TodoWrite in the turn): "To-dos · 3 of 7
 * done", opening to what is in progress (its `activeForm`, shimmering while
 * the turn runs), what is left and what is done. Open while the turn runs,
 * folded once it is over, unless the reader chose.
 */
export function TodoList({ row, running, open, onOpenChange }: { row: TodosRow; running: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { active, left, done } = todoSections(row.todos);
  return <TraceCollapsible data-kind="todos" open={open} onOpenChange={onOpenChange} className="font-sans">
    <TraceCollapsibleTrigger>
      <TraceLine>
        <TraceIcon><ListTodoIcon /></TraceIcon>
        <TraceTitle>To-dos</TraceTitle>
        <TraceDescription>{todoSummary(row)}</TraceDescription>
      </TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="py-0.5">
      <Trace className="gap-0" aria-label="To-dos">
        {active.map((todo, i) => <Todo key={`a${i}`} todo={todo} state="active" running={running} />)}
        {left.map((todo, i) => <Todo key={`l${i}`} todo={todo} state="left" running={running} />)}
        {done.map((todo, i) => <Todo key={`d${i}`} todo={todo} state="done" running={running} />)}
        {row.more > 0 && <p className="m-0 px-1.5 py-0.5 text-[11.5px] text-muted-foreground/70">+{row.more} more</p>}
      </Trace>
    </TraceCollapsibleContent>
  </TraceCollapsible>;
}

function Todo({ todo, state, running }: { todo: TodoEntry; state: "active" | "left" | "done"; running: boolean }) {
  const Icon = state === "done" ? CircleCheckIcon : state === "active" ? CircleDotIcon : CircleIcon;
  const status: TraceStatus | undefined = state === "active" && running ? "running" : state === "left" ? "pending" : undefined;
  const said = state === "active" && running ? todo.activeForm ?? todo.content : todo.content;
  return <div className="flex px-1.5 py-0.5" data-todo={state}>
    <TraceLine status={status} className={cn("items-start", state === "active" && "text-foreground/85")}>
      <TraceIcon className="mt-[2.5px]"><Icon /></TraceIcon>
      <TraceTitle className={cn("whitespace-normal [overflow-wrap:anywhere]", state === "done" && "line-through decoration-muted-foreground/40")}>{said}</TraceTitle>
      <span className="sr-only">{state === "done" ? " (done)" : state === "active" ? " (in progress)" : " (to do)"}</span>
    </TraceLine>
  </div>;
}

/** The pages a turn used: one folded line opening to a link per page (title when known, and its host). Nothing is fetched until a link is clicked. */
export function Sources({ sources, open, onOpenChange }: { sources: WebSource[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const shown = sources.filter((source) => safeHref(source.url));
  if (!shown.length) return null;
  return <TraceCollapsible data-kind="sources" open={open} onOpenChange={onOpenChange} className="font-sans">
    <TraceCollapsibleTrigger>
      <TraceLine>
        <TraceIcon><GlobeIcon /></TraceIcon>
        <TraceTitle>Sources</TraceTitle>
        <TraceDescription>{shown.length}</TraceDescription>
      </TraceLine>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="py-0.5">
      <Trace className="gap-0">
        {shown.map((source) => {
          const host = sourceHost(source.url);
          return <a key={source.url} href={source.url} {...LINK_PROPS} title={source.url}
            className="flex w-fit max-w-full min-w-0 rounded-lg px-1.5 py-0.5 no-underline! outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/30">
            <TraceLine>
              <TraceTitle className="text-foreground/85">{source.title ?? shortUrl(source.url)}<span className="sr-only"> (opens in a new tab)</span></TraceTitle>
              {source.title && <TraceDescription>{host}</TraceDescription>}
              <TraceIcon><ArrowUpRightIcon /></TraceIcon>
            </TraceLine>
          </a>;
        })}
      </Trace>
    </TraceCollapsibleContent>
  </TraceCollapsible>;
}

/** A page without a title: its URL without the scheme. */
const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

export type TurnStep = Extract<ViewBlock, { kind: "tool" | "group" | "thinking" | "todos" | "sources" }>;

/**
 * One step block of a turn, with its open/closed state: `choices` holds the
 * reader's choice per block key. Groups and Sources start folded; a todo
 * list starts open while its turn runs and folded once it is over.
 */
export function TurnBlock({ block, running, choices, onChoice }:
  { block: TurnStep; running: boolean; choices: Readonly<Record<string, boolean>>; onChoice: (key: string, open: boolean) => void }) {
  switch (block.kind) {
    case "tool": return <ToolCall row={block.row} running={running} />;
    case "thinking": return <Thinking text={block.row.text} truncated={block.row.truncated} />;
    case "group": return <ToolGroup tools={block.tools} steps={block.steps} running={running} open={choices[block.key] ?? false}
      onOpenChange={(value) => onChoice(block.key, value)} />;
    case "todos": return <TodoList row={block.row} running={running} open={choices[block.key] ?? running} onOpenChange={(value) => onChoice(block.key, value)} />;
    case "sources": return <Sources sources={block.sources} open={choices[block.key] ?? false} onOpenChange={(value) => onChoice(block.key, value)} />;
  }
}

/** The server met transcript lines it could not read (a changed SDK format, a corrupt line): say so rather than show less in silence. */
export function UnreadableNote({ children = "Some entries could not be read.", className }: { children?: string; className?: string }) {
  return <p role="note" className={cn("m-0 text-[11.5px] text-muted-foreground", className)}>{children}</p>;
}

/** The main chat's note, styled like its "Older tool calls not shown". */
export function ToolsUnreadableNote() {
  return <UnreadableNote className="mx-auto mb-4 max-w-[740px] text-center">Some tool calls could not be read</UnreadableNote>;
}
