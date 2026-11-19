import { useEffect, useState } from "react";
import { ChevronRight, ShieldQuestion } from "lucide-react";
import { ApiError, decidePermission, type WebBootstrap } from "./api.js";
import { useAgentName } from "./agent-name.js";
import { timeLeft } from "./credential-card.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { WebPermissionDecision, WebPermissionRequest } from "../../src/web/protocol.js";

/** What the card says when the daemon refuses an answer (fixed codes only). */
export function permissionError(code: string): string {
  if (code === "permission_closed") return "This request is over: it was answered or it expired.";
  if (code === "permission_unknown") return "This request is no longer open.";
  if (code === "permission_config_unwritable") return "Could not save to config.json. Try again, or allow once.";
  if (code === "epoch_changed") return "Tomo restarted, so this request is gone.";
  return "Could not send. Try again.";
}

const DECISIONS: { decision: WebPermissionDecision; label: string; variant: "default" | "outline" | "ghost" }[] = [
  { decision: "once", label: "Allow once", variant: "default" },
  { decision: "always", label: "Always allow", variant: "outline" },
  { decision: "deny", label: "Deny", variant: "ghost" },
];

/**
 * A sandboxed group's `request_permission`: which group, which path (as the
 * harness resolved it), read or write, and the agent's own reason, with the
 * call that ran into the sandbox folded away. Three answers, each final: the
 * card goes when the daemon withdraws the request (`permission-requests`).
 */
export function PermissionCard({ request, bootstrap, refresh }: { request: WebPermissionRequest; bootstrap?: WebBootstrap; refresh: () => Promise<WebBootstrap> }) {
  const agent = useAgentName();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setError(""); setBusy(false); }, [request.id]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(t); }, []);
  const write = request.access === "write";
  const titleId = `permission-title-${request.id}`;

  const answer = async (decision: WebPermissionDecision) => {
    if (!bootstrap || busy) return;
    setBusy(true); setError("");
    try { await decidePermission(request.id, decision, bootstrap, refresh); }
    catch (err) { setError(permissionError(err instanceof ApiError ? err.code : "")); }
    finally { setBusy(false); }
  };

  return <section role="dialog" aria-modal="false" aria-labelledby={titleId} data-testid="permission-card"
    className="motion-enter mb-2 rounded-2xl border bg-card px-4 py-3 shadow-sm">
    <div className="flex items-center gap-2">
      <ShieldQuestion className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <h2 id={titleId} className="m-0 min-w-0 truncate text-[13px] font-medium">{request.group}</h2>
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums" aria-label="Time left">{timeLeft(request.expiresAt, now)}</span>
    </div>
    <div className="mt-2 flex items-start gap-2">
      <Badge variant="outline" className={cn("mt-px rounded-md px-1.5 text-[11px] font-medium",
        write ? "border-warn/40 bg-warn/10 text-warn" : "text-muted-foreground")}>{write ? "Write" : "Read"}</Badge>
      <code className="min-w-0 flex-1 font-mono text-[12.5px] leading-snug text-foreground [overflow-wrap:anywhere]" data-testid="permission-path">{request.path}</code>
    </div>
    <p className="mt-1.5 mb-0 text-[12.5px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
      <span className="text-foreground/80">{request.reason}</span> <span className="whitespace-nowrap">(from {agent}, not verified)</span></p>
    {request.command && <Collapsible>
      <CollapsibleTrigger className="group mt-2 flex cursor-pointer items-center gap-1 rounded text-[11.5px] text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />Triggering call</CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="m-0 mt-1.5 max-h-40 overflow-y-auto rounded-lg bg-muted/60 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{request.command}</pre>
      </CollapsibleContent>
    </Collapsible>}
    <div className="mt-3 grid grid-cols-3 gap-2 min-[480px]:flex">
      {DECISIONS.map(({ decision, label, variant }) => <Button key={decision} type="button" size="sm" variant={variant} disabled={busy}
        className={cn("h-8 rounded-lg", decision === "deny" && "text-muted-foreground hover:text-foreground min-[480px]:ml-auto")}
        onClick={() => void answer(decision)}>{label}</Button>)}
    </div>
    {error && <p role="status" className="m-0 mt-2 text-[12px] text-destructive">{error}</p>}
  </section>;
}
