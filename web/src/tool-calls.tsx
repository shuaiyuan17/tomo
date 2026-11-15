import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tool, ToolContent, ToolHeader, ToolSection } from "@/components/ai/tool";
import { groupLabel, pendingTool, type ToolRow } from "./subagent.js";

/**
 * Tool calls as the task view and the main chat both show them: one call is
 * a row (its INPUT / OUTPUT render only once it is opened); a run of calls
 * is one folded group whose summary names the running call, shimmering.
 */
export function ToolCall({ row, running }: { row: ToolRow; running: boolean }) {
  return <Tool>
    <ToolHeader title={row.summary || row.name} state={row.result ? (row.result.isError ? "error" : "done") : running ? "running" : "done"} />
    <ToolContent>
      <ToolSection label="Input" text={row.input} truncated={row.inputTruncated} />
      {row.result && <ToolSection label={row.result.isError ? "Error" : "Output"} text={row.result.output} truncated={row.result.truncated} error={row.result.isError} />}
    </ToolContent>
  </Tool>;
}

/** `running`: this is the run still growing (its last call without a result is named in the summary). */
export function ToolGroup({ tools, open, onOpenChange, running, className }:
  { tools: ToolRow[]; open: boolean; onOpenChange: (open: boolean) => void; running: boolean; className?: string }) {
  const label = groupLabel(tools, running ? pendingTool(tools) : undefined);
  return <Collapsible open={open} onOpenChange={onOpenChange} className={cn("group/calls", className)}>
    <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
      <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/calls:rotate-90" />
      <span className="min-w-0 flex-1 truncate">{label.lead}{label.running && <span className="shimmer">{label.running}</span>}</span>
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-0.5 border-l border-border/70 py-0.5 pl-1.5 ml-3">
      {tools.map((row) => <ToolCall key={row.id} row={row} running={running} />)}
    </CollapsibleContent>
  </Collapsible>;
}
