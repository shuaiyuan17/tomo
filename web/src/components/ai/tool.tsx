/*!
 * Adapted from AI Elements `tool.tsx` (https://github.com/vercel/ai-elements),
 * Copyright 2023 Vercel, Inc., licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0; full text in web/public/THIRD_PARTY_LICENSES.txt, shipped as dist/web-assets/THIRD_PARTY_LICENSES.txt).
 * Modified for tomo.
 * Changes: no `ai` SDK types or runtime (rows come from our own transcript
 * reader); plain <pre> instead of the Shiki CodeBlock (Shiki emits inline
 * style attributes our CSP refuses); collapsed one-line header; capped
 * "Show more"; paper-palette styling.
 */
import { useState, type ComponentProps, type ReactNode } from "react";
import { CheckIcon, ChevronRightIcon, LoaderIcon, XIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { preview } from "../../subagent.js";

export type ToolState = "running" | "done" | "error";

export function Tool({ className, ...props }: ComponentProps<typeof Collapsible>) {
  return <Collapsible className={cn("group/tool w-full", className)} {...props} />;
}

const stateIcon: Record<ToolState, ReactNode> = {
  running: <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" aria-label="Running" />,
  done: <CheckIcon className="size-3.5 text-muted-foreground" aria-label="Done" />,
  error: <XIcon className="size-3.5 text-destructive" aria-label="Failed" />,
};

/** One line: chevron, the call (e.g. `Read src/web/http.ts`), status. */
export function ToolHeader({ title, state, className }: { title: string; state: ToolState; className?: string }) {
  return <CollapsibleTrigger className={cn("flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left font-mono text-[11.5px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground", className)}>
    <ChevronRightIcon className="size-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]/tool:rotate-90" />
    <span className="min-w-0 flex-1 truncate">{title}</span>
    {stateIcon[state]}
  </CollapsibleTrigger>;
}

export function ToolContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return <CollapsibleContent className={cn("space-y-2.5 pt-1.5 pb-2 pl-6", className)} {...props} />;
}

/** A labelled, scrollable block of text with a capped "Show more". */
export function ToolSection({ label, text, truncated, error }:
  { label: string; text: string; truncated?: boolean; error?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = preview(text, false).more;
  const shown = preview(text, expanded).text;
  return <div className="space-y-1">
    <p className="m-0 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">{label}</p>
    <pre className={cn("m-0 max-h-72 overflow-auto rounded-lg px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
      error ? "bg-destructive/10 text-destructive" : "bg-muted/70 text-foreground")}>{shown || "(empty)"}</pre>
    {(long || truncated) && <p className="m-0 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
      {long && <button type="button" className="rounded px-1 underline-offset-2 hover:text-foreground hover:underline" onClick={() => setExpanded((v) => !v)}>{expanded ? "Show less" : "Show more"}</button>}
      {truncated && (expanded || !long) && <span>Truncated</span>}
    </p>}
  </div>;
}
