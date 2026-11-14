/*!
 * Adapted from AI Elements `terminal.tsx` (https://github.com/vercel/ai-elements),
 * Copyright 2023 Vercel, Inc., licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0; full text in web/public/THIRD_PARTY_LICENSES.txt, shipped as dist/web-assets/THIRD_PARTY_LICENSES.txt).
 * Modified for tomo.
 * Changes: read-only (no clear/copy), escape sequences stripped to plain text
 * instead of `ansi-to-react`, follows the tail while the reader is at the
 * bottom, paper-palette styling.
 */
import { useLayoutEffect, useRef } from "react";
import { TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { stripAnsi } from "../../subagent.js";

export function Terminal({ output, size, className }: { output: string; size: number; className?: string }) {
  const body = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = body.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [output]);
  const tailOnly = size > new TextEncoder().encode(output).length;
  return <div className={cn("overflow-hidden rounded-xl border bg-card", className)}>
    <div className="flex items-center gap-2 border-b px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
      <TerminalIcon className="size-3.5" />Output{tailOnly ? " · last part" : ""}</div>
    <pre ref={body} tabIndex={0} aria-label="Task output" onScroll={() => { const e = body.current!; pinned.current = e.scrollHeight - e.scrollTop - e.clientHeight < 24; }}
      className="m-0 max-h-[60vh] overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{stripAnsi(output) || "(no output yet)"}</pre>
  </div>;
}
