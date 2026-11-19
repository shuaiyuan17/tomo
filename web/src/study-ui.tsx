import type { ReactNode } from "react";
import type { WebBootstrap } from "./api.js";
import { cn } from "@/lib/utils";
import type { Resource } from "./study-data.js";

/** What the Study's pages share: card and caption styles, a resource's loading / error state, an empty card, and what a write needs. */

export const card = "rounded-xl border bg-card shadow-xs";
export const meta = "text-[11px] tracking-[0.02em] text-muted-foreground";

const ERRORS: Record<string, string> = {
  memory_not_found: "That file is not available.", memory_limit: "That file is too large to show here.",
  memory_invalid_path: "That path cannot be opened.", cron_unavailable: "The cron store could not be read.",
  config_invalid: "config.json is not valid JSON.", config_unavailable: "config.json could not be read.",
  session_not_found: "That conversation is no longer available.", request_limit: "Busy — try again in a moment.",
};

export function Status({ resource, empty, children }: { resource: Resource<unknown>; empty?: ReactNode; children?: ReactNode }) {
  if (resource.state === "loading") return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  if (resource.state === "error") return <div className={cn(card, "px-4 py-3 text-[13px]")} role="alert">{ERRORS[resource.code] ?? "Unavailable right now."}</div>;
  return <>{empty ?? children}</>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={cn(card, "px-5 py-8 text-center text-sm text-muted-foreground")}>{children}</div>;
}

/** What a Study write needs: the page's bootstrap (CSRF token, daemon epoch) and a way to refresh it. */
export interface Mutator { bootstrap?: WebBootstrap; refresh: () => Promise<WebBootstrap>; live: boolean }
