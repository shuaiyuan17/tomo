import { ChevronRight, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tool, ToolContent, ToolHeader, ToolSection } from "@/components/ai/tool";
import { Text } from "./markdown.js";
import { groupLabel, pendingTool, type ThinkingRow, type ToolRow } from "./subagent.js";

/**
 * Tool calls as the task view and the main chat both show them: one call is
 * a row (its INPUT / OUTPUT render only once it is opened); a run of calls
 * is one folded group whose summary names the running call, shimmering.
 */
export function ToolCall({ row, running }: { row: ToolRow; running: boolean }) {
  const result = row.result;
  const label = result?.isError ? "Error" : "Output";
  return <Tool>
    <ToolHeader title={row.summary || row.name} state={result ? (result.isError ? "error" : "done") : running ? "running" : "done"} />
    <ToolContent>
      <ToolSection label="Input" text={row.input} truncated={row.inputTruncated} />
      {result && (result.output || !result.images) && <ToolSection label={label} text={result.output} truncated={result.truncated} error={result.isError} />}
      {result?.images ? <div className="space-y-1">
        {!result.output && <p className="m-0 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">{label}</p>}
        <ImageOutput count={result.images} /></div> : null}
    </ToolContent>
  </Tool>;
}

/** An image in a tool's output: named, never fetched (the server does not serve its bytes). */
function ImageOutput({ count }: { count: number }) {
  return <span className="inline-flex items-center gap-1.5 rounded-lg border bg-card/70 px-2 py-1 text-[11.5px] text-muted-foreground">
    <ImageIcon className="size-3.5" aria-hidden="true" />{count > 1 ? `${count} image outputs, not shown` : "Image output, not shown"}</span>;
}

/**
 * A thinking block: one folded, muted line in the same rhythm as a tool
 * row (sans, never the reply serif), opening in place to the text.
 */
export function Thinking({ text, truncated = false, className }: { text: string; truncated?: boolean; className?: string }) {
  return <Collapsible className={cn("group/thinking font-sans", className)}>
    <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] leading-normal text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
      <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/thinking:rotate-90" />
      <span className="min-w-0 flex-1 truncate">Thinking</span>
    </CollapsibleTrigger>
    <CollapsibleContent className="ml-3 border-l border-border/70 py-1 pr-1 pl-3">
      <div className="markdown text-[12.5px]! leading-relaxed! text-muted-foreground [&_:is(h1,h2,h3)]:font-sans [&_:is(h1,h2,h3)]:text-[13px]!">
        <Text>{text + (truncated ? "\n\n…" : "")}</Text></div>
    </CollapsibleContent>
  </Collapsible>;
}

/** `running`: this is the run still growing (its last call without a result is named in the summary). `steps`: the calls with any thinking between them, in order. */
export function ToolGroup({ tools, steps, open, onOpenChange, running, className }:
  { tools: ToolRow[]; steps?: Array<ToolRow | ThinkingRow>; open: boolean; onOpenChange: (open: boolean) => void; running: boolean; className?: string }) {
  const label = groupLabel(tools, running ? pendingTool(tools) : undefined);
  return <Collapsible open={open} onOpenChange={onOpenChange} className={cn("group/calls", className)}>
    <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
      <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/calls:rotate-90" />
      <span className="min-w-0 flex-1 truncate">{label.lead}{label.running && <span className="shimmer">{label.running}</span>}</span>
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-0.5 border-l border-border/70 py-0.5 pl-1.5 ml-3">
      {(steps ?? tools).map((row) => row.kind === "thinking" ? <Thinking key={row.id} text={row.text} truncated={row.truncated} />
        : <ToolCall key={row.id} row={row} running={running} />)}
    </CollapsibleContent>
  </Collapsible>;
}

/** The server met transcript lines it could not read (a changed SDK format, a corrupt line): say so rather than show less in silence. */
export function UnreadableNote({ children = "Some entries could not be read.", className }: { children?: string; className?: string }) {
  return <p role="note" className={cn("m-0 text-[11.5px] text-muted-foreground", className)}>{children}</p>;
}

/** The main chat's note, styled like its "Older tool calls not shown". */
export function ToolsUnreadableNote() {
  return <UnreadableNote className="mx-auto mb-4 max-w-[740px] text-center">Some tool calls could not be read</UnreadableNote>;
}
