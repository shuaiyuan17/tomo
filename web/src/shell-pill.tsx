import { useState } from "react";
import { TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { shellShortName, shortenPaths } from "./shell.js";

/** A shell command as a compact pill: terminal icon + short name; the full command in the tooltip. */
export function ShellPill({ command, className }: { command: string; className?: string }) {
  return <span title={command} className={cn("inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border/80 bg-muted/60 px-1.5 py-px align-middle font-mono text-[11.5px] leading-[18px] font-normal", className)}>
    <TerminalIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">{shellShortName(command)}</span></span>;
}


/** The full command of a shell task, pinned above its output: folded to two lines, expandable. */
export function CommandBrief({ command }: { command: string }) {
  const [open, setOpen] = useState(false);
  return <section aria-label="Command" className="mx-2.5 mb-2.5 rounded-lg border bg-card/70 px-2.5 py-2">
    <div className="mb-1 flex items-center justify-between gap-2">
      <p className="m-0 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Command</p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="rounded px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">{open ? "Show less" : "Show more"}</button>
    </div>
    <pre title={command} className={cn("m-0 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]", open ? "max-h-[40vh] overflow-y-auto" : "line-clamp-2")}>{open ? command : shortenPaths(command)}</pre>
  </section>;
}
