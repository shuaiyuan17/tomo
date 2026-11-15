/*!
 * Adapted from AI Elements `tool.tsx` (https://github.com/vercel/ai-elements),
 * Copyright 2023 Vercel, Inc., licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0; full text in web/public/THIRD_PARTY_LICENSES.txt, shipped as dist/web-assets/THIRD_PARTY_LICENSES.txt).
 * Modified for tomo.
 * Changes: only the input/output section is kept — the row itself is a
 * Trace line (components/ui/trace.tsx, tool-calls.tsx); no `ai` SDK types or
 * runtime (rows come from our own transcript reader); plain <pre> instead of
 * the Shiki CodeBlock (Shiki emits inline style attributes our CSP refuses);
 * capped "Show more"; paper-palette styling.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { preview } from "../../subagent.js";

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
