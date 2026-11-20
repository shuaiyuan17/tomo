import { useEffect, useState } from "react";
import { Check, ChevronRight, Copy, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import { ApiError, decidePermission, type WebBootstrap } from "./api.js";
import { useAgentName } from "./agent-name.js";
import { timeLeft } from "./credential-card.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { WebPermissionDecision, WebPermissionRequest } from "../../src/web/protocol.js";
import { i18n, Trans, useTranslation } from "./i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: chat:permission.once
// i18n-dynamic: chat:permission.always
// i18n-dynamic: chat:permission.deny

/** What the card says when the daemon refuses an answer (fixed codes only). */
export function permissionError(code: string): string {
  if (code === "permission_closed") return i18n.t("chat:permission.error.closed");
  if (code === "permission_unknown") return i18n.t("chat:permission.error.unknown");
  if (code === "permission_config_unwritable") return i18n.t("chat:permission.error.unwritable");
  if (code === "epoch_changed") return i18n.t("chat:permission.error.restarted");
  return i18n.t("chat:permission.error.other");
}

const DECISIONS = [
  { decision: "once", label: "permission.once", variant: "default" },
  { decision: "always", label: "permission.always", variant: "outline" },
  { decision: "deny", label: "permission.deny", variant: "ghost" },
] as const satisfies readonly { decision: WebPermissionDecision; label: string; variant: "default" | "outline" | "ghost" }[];

/**
 * A sandboxed group's `request_permission`: which group, which path (as the
 * harness resolved it), read or write, and the agent's own reason, with the
 * call that ran into the sandbox folded away. Three answers, each final: the
 * card goes when the daemon withdraws the request (`permission-requests`).
 */
export function PermissionCard({ request, bootstrap, refresh, onAlways }: { request: WebPermissionRequest; bootstrap?: WebBootstrap; refresh: () => Promise<WebBootstrap>;
  /** An Always allow was saved: the page keeps its grant id on screen (the request's card is about to go). */
  onAlways?: (granted: GrantedPermission) => void }) {
  const agent = useAgentName();
  const { t } = useTranslation("chat");
  /** The daemon's refusal code (worded at render, so it follows the language); null: none. */
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setError(null); setBusy(false); }, [request.id]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(t); }, []);
  const write = request.access === "write";
  const titleId = `permission-title-${request.id}`;

  const answer = async (decision: WebPermissionDecision) => {
    if (!bootstrap || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await decidePermission(request.id, decision, bootstrap, refresh);
      if (result.status === "allowed_always" && result.grantId) onAlways?.({ grantId: result.grantId, group: request.group, path: request.path });
    }
    catch (err) { setError(err instanceof ApiError ? err.code : ""); }
    finally { setBusy(false); }
  };

  return <section role="dialog" aria-modal="false" aria-labelledby={titleId} data-testid="permission-card"
    className="motion-enter mb-2 rounded-2xl border bg-card px-4 py-3 shadow-sm">
    <div className="flex items-center gap-2">
      <ShieldQuestion className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <h2 id={titleId} className="m-0 min-w-0 truncate text-[13px] font-medium">{request.group}</h2>
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums" aria-label={t("card.timeLeft")}>{timeLeft(request.expiresAt, now)}</span>
    </div>
    <div className="mt-2 flex items-start gap-2">
      <Badge variant="outline" className={cn("mt-px rounded-md px-1.5 text-[11px] font-medium",
        write ? "border-warn/40 bg-warn/10 text-warn" : "text-muted-foreground")}>{write ? t("permission.write") : t("permission.read")}</Badge>
      <code className="min-w-0 flex-1 font-mono text-[12.5px] leading-snug text-foreground [overflow-wrap:anywhere]" data-testid="permission-path">{request.path}</code>
    </div>
    <p className="mt-1.5 mb-0 text-[12.5px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
      <span className="text-foreground/80">{request.reason}</span> <span className="whitespace-nowrap">{t("permission.unverified", { agent })}</span></p>
    {request.command && <Collapsible>
      <CollapsibleTrigger className="group mt-2 flex cursor-pointer items-center gap-1 rounded text-[11.5px] text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />{t("permission.call")}</CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="m-0 mt-1.5 max-h-40 overflow-y-auto rounded-lg bg-muted/60 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{request.command}</pre>
      </CollapsibleContent>
    </Collapsible>}
    <div className="mt-3 grid grid-cols-3 gap-2 min-[480px]:flex">
      {DECISIONS.map(({ decision, label, variant }) => <Button key={decision} type="button" size="sm" variant={variant} disabled={busy}
        className={cn("h-8 rounded-lg", decision === "deny" && "text-muted-foreground hover:text-foreground min-[480px]:ml-auto")}
        onClick={() => void answer(decision)}>{t(label)}</Button>)}
    </div>
    <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">{t("permission.hint")}</p>
    {error !== null && <p role="status" className="m-0 mt-2 text-[12px] text-destructive">{permissionError(error)}</p>}
  </section>;
}

/** An Always allow just saved from a card: what to quote to take it back. */
export interface GrantedPermission { grantId: string; group: string; path: string }

/**
 * What stays after an Always allow: the grant id (copyable), until the owner
 * closes it. Revoke with `revoke <id>` in the DM, or the Permissions page.
 */
export function PermissionGranted({ granted, onClose }: { granted: GrantedPermission; onClose: () => void }) {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(granted.grantId).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1_500); }, () => {});
  };
  return <section role="status" aria-label={t("permission.granted")} data-testid="permission-granted"
    className="motion-enter mb-2 flex items-center gap-2.5 rounded-2xl border bg-card py-2 pr-1.5 pl-4 shadow-sm">
    <ShieldCheck className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <p className="m-0 text-[13px] font-medium"><Trans t={t} ns="chat" i18nKey="permission.grantedId" values={{ id: granted.grantId }} components={{ id: <code className="font-mono select-all" data-testid="permission-grant-id" /> }} /></p>
      <p className="m-0 truncate text-[11.5px] text-muted-foreground" title={granted.path}>{granted.group} · {granted.path}</p>
    </div>
    <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
      aria-label={copied ? t("actions.copied") : t("permission.copyId")} title={t("permission.copyId")} onClick={copy}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button>
    <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
      aria-label={t("card.close")} onClick={onClose}><X className="size-3.5" /></Button>
  </section>;
}
