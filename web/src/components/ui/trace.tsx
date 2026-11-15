/*!
 * Adapted from shadcn/ui `trace.tsx` (https://github.com/shadcn-ui/ui, MIT).
 * Modified for tomo: the `cn-trace*` style classes inlined from the "mira"
 * style (the densest, closest to Tomo's 12px rows), lucide's chevron for the
 * icon placeholder, Tomo's own `.shimmer` for a running title (styles.css),
 * a hover wash and padding on the trigger so a row keeps today's tap target,
 * and the app's own collapsible height animation instead of accordion
 * keyframes.
 */
import type * as React from "react";
import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type TraceStatus = "running" | "error" | "pending";

/** A list of lines (steps). Nest one in a TraceCollapsibleContent for a step's sub-steps. */
function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="trace" className={cn("flex w-full min-w-0 flex-col gap-0.5", className)} {...props} />;
}

/** One line: TraceIcon, TraceTitle, optional TraceDescription. `status` colours it (error), dims it (pending) or shimmers its title (running). */
function TraceLine({ className, status, ...props }: React.ComponentProps<"span"> & { status?: TraceStatus }) {
  return <span data-slot="trace-line" data-status={status}
    className={cn("flex w-fit max-w-full min-w-0 items-center gap-1.5 text-[12px] leading-normal text-muted-foreground transition-colors",
      "in-[a:hover,button:hover]:text-foreground data-[status=error]:text-destructive data-[status=error]:in-[a:hover,button:hover]:text-destructive data-[status=pending]:opacity-60",
      className)} {...props} />;
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-icon" aria-hidden="true"
    className={cn("flex size-3.5 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5", className)} {...props} />;
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-title" className={cn("min-w-0 truncate", className)} {...props} />;
}

/** Secondary text after the title: a count, a duration. Never truncated. */
function TraceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-description" className={cn("shrink-0 text-muted-foreground/70 tabular-nums", className)} {...props} />;
}

function TraceCollapsible({ className, ...props }: React.ComponentProps<typeof Collapsible>) {
  return <Collapsible data-slot="trace-collapsible" className={cn("group/trace flex w-full min-w-0 flex-col", className)} {...props} />;
}

/** The line that opens a step; the chevron follows it and turns when open. */
function TraceCollapsibleTrigger({ className, children, ...props }: Omit<React.ComponentProps<typeof CollapsibleTrigger>, "asChild">) {
  return <CollapsibleTrigger data-slot="trace-collapsible-trigger"
    className={cn("group/trace-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-lg px-1.5 py-1 text-left text-[12px] leading-normal text-muted-foreground transition-colors outline-none",
      "hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30", className)} {...props}>
    {children}
    <TraceIcon className="text-muted-foreground/70 transition-transform group-aria-expanded/trace-trigger:rotate-90"><ChevronRightIcon /></TraceIcon>
  </CollapsibleTrigger>;
}

/** What a step opens to, hung from a rule under the line's icon. */
function TraceCollapsibleContent({ className, children, ...props }: Omit<React.ComponentProps<typeof CollapsibleContent>, "asChild">) {
  return <CollapsibleContent data-slot="trace-collapsible-content" className="min-w-0" {...props}>
    <div data-slot="trace-collapsible-content-inner"
      className={cn("mt-0.5 mb-1 ml-[calc(--spacing(3.25)-1px)] min-w-0 border-l border-border/70 pr-1 pl-2.5 wrap-break-word text-muted-foreground", className)}>
      {children}
    </div>
  </CollapsibleContent>;
}

/** A line that does not open, padded like a trigger so static and opening lines align. */
function TraceStatic({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="trace-static" className={cn("flex w-fit max-w-full min-w-0 px-1.5 py-1", className)} {...props} />;
}

export { Trace, TraceLine, TraceIcon, TraceTitle, TraceDescription, TraceCollapsible, TraceCollapsibleTrigger, TraceCollapsibleContent, TraceStatic };
