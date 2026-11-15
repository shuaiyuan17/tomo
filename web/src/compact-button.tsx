import { useEffect, useState } from "react";
import { useAgentName } from "./agent-name.js";
import { FoldVertical } from "lucide-react";
import { ApiError, requestCompact, type WebBootstrap } from "./api.js";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { compactButton, compactError } from "./compact.js";
import type { WebCompactState } from "../../src/web/protocol.js";

/**
 * Asks Tomo to compact the owner's session (Tomo runs the lcm compact skill
 * itself). Disabled while tasks run — the server refuses then too. A light
 * non-modal Popover confirms (a modal Radix dialog's inline style is
 * blocked by the CSP).
 */
export function CompactButton({ bootstrap, refresh, ownerSession, running, request }:
  { bootstrap?: WebBootstrap; refresh: () => Promise<WebBootstrap>; ownerSession: boolean; running: number; request?: WebCompactState }) {
  const [open, setOpen] = useState(false);
  const agent = useAgentName();
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // When this browser saw the request reach its current state (local clock).
  const [seenAt, setSeenAt] = useState(() => Date.now());
  useEffect(() => { setSeenAt(Date.now()); setNow(Date.now()); }, [request?.requestId, request?.state]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(t); }, []);
  const button = compactButton({ ownerSession, running, request, seenAt, now });
  if (button.state === "hidden") return null;
  const confirm = async () => {
    setOpen(false); setError("");
    if (!bootstrap) return;
    try { await requestCompact(bootstrap, refresh); }
    catch (err) { setError(compactError(err instanceof ApiError ? err.code : "")); setTimeout(() => setError(""), 6_000); }
  };
  return <span className="relative">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={button.label} title={button.label} disabled={button.state === "busy" || button.state === "requested"}
          className={cn("-my-1 size-7 rounded-lg text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground disabled:opacity-40 [&_svg:not([class*='size-'])]:size-3.5",
            button.state === "requested" && "disabled:opacity-100")}>
          <FoldVertical strokeWidth={1.75} className={cn(button.state === "requested" && "animate-pulse")} /></Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 rounded-xl p-3 text-[13px]">
        <p className="m-0 mb-2.5">Ask {agent} to compact now?</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" className="h-7 rounded-lg text-[12px]" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" className="h-7 rounded-lg text-[12px]" onClick={() => void confirm()}>Compact</Button>
        </div>
      </PopoverContent>
    </Popover>
    {button.state === "requested" && <span className="absolute top-1/2 right-8 -translate-y-1/2 text-[11px] whitespace-nowrap"><span className="shimmer">Requested…</span></span>}
    {button.state === "done" && <span role="status" className="absolute top-1/2 right-8 -translate-y-1/2 text-[11px] whitespace-nowrap text-muted-foreground">Compacted</span>}
    {button.state === "ready" && button.note && !error && <span role="status" className="absolute top-7 right-0 z-10 w-52 rounded-lg border bg-popover px-2 py-1.5 text-[11.5px] text-muted-foreground shadow-sm">{button.note}</span>}
    {error && <span role="status" className="absolute top-7 right-0 z-10 w-52 rounded-lg border bg-popover px-2 py-1.5 text-[11.5px] text-muted-foreground shadow-sm">{error}</span>}
  </span>;
}
