import { useEffect, useState } from "react";
import { api } from "./api.js";
import { TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isProseDescription, shellLabel, shortenPaths } from "./shell.js";

/**
 * A shell task as a compact pill: terminal icon + its label (shellLabel). A command line is set in
 * mono by its short name, on one line; a description in words is shown whole, in the text face, as
 * the trace does, wrapping when the row is narrow.
 */
export function ShellPill({ command, className }: { command: string; className?: string }) {
  const prose = isProseDescription(command);
  return <span data-shell-label className={cn("inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border/80 bg-muted/60 px-1.5 py-px align-middle leading-[18px] font-normal",
    prose ? "items-start text-[12px]" : "font-mono text-[11.5px]", className)}>
    <TerminalIcon data-task-icon="shell" className={cn("size-3 shrink-0 text-muted-foreground", prose && "mt-[3px]")} aria-hidden="true" /><span className={prose ? "min-w-0 [overflow-wrap:anywhere]" : "truncate"}>{shellLabel(command)}</span></span>;
}

/**
 * The full command of a shell task, pinned above its output: fetched on
 * demand from the daemon (redacted there), folded to two lines, expandable.
 */
export function CommandBrief({ base, fallback }: { base: string; fallback: string }) {
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState<{ text: string; truncated: boolean }>();
  useEffect(() => {
    const controller = new AbortController();
    void api<{ text: string; truncated: boolean }>(`${base}/command`, { signal: controller.signal }).then(setCommand, () => {});
    return () => controller.abort();
  }, [base]);
  const text = command?.text ?? fallback;
  return <section aria-label="Command" className="mx-2.5 mb-2.5 rounded-lg border bg-card/70 px-2.5 py-2">
    <div className="mb-1 flex items-center justify-between gap-2">
      <p className="m-0 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Command</p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="rounded px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">{open ? "Show less" : "Show more"}</button>
    </div>
    <pre className={cn("m-0 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]", open ? "max-h-[40vh] overflow-y-auto" : "line-clamp-2")}>
      {open ? text : shortenPaths(text)}{open && command?.truncated ? "\n… (truncated)" : ""}</pre>
  </section>;
}
