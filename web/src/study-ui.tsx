import type { ReactNode } from "react";
import type { WebBootstrap } from "./api.js";
import { cn } from "@/lib/utils";
import type { Resource } from "./study-data.js";
import { useTranslation } from "./i18n/index.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: study:error.*

/** What the Study's pages share: card and caption styles, a resource's loading / error state, an empty card, and what a write needs. */

export const card = "rounded-xl border bg-card shadow-xs";
export const meta = "text-[11px] tracking-[0.02em] text-muted-foreground";

const ERRORS: Record<string, "error.memory_not_found" | "error.memory_limit" | "error.memory_invalid_path" | "error.cron_unavailable" | "error.config_invalid" | "error.config_unavailable" | "error.session_not_found" | "error.request_limit"> = {
  memory_not_found: "error.memory_not_found", memory_limit: "error.memory_limit",
  memory_invalid_path: "error.memory_invalid_path", cron_unavailable: "error.cron_unavailable",
  config_invalid: "error.config_invalid", config_unavailable: "error.config_unavailable",
  session_not_found: "error.session_not_found", request_limit: "error.request_limit",
};

export function Status({ resource, empty, children }: { resource: Resource<unknown>; empty?: ReactNode; children?: ReactNode }) {
  const { t } = useTranslation(["study", "common"]);
  if (resource.state === "loading") return <p className="text-sm text-muted-foreground" role="status">{t("common:state.loading")}</p>;
  if (resource.state === "error") return <div className={cn(card, "px-4 py-3 text-[13px]")} role="alert">{ERRORS[resource.code] ? t(ERRORS[resource.code]!) : t("error.other")}</div>;
  return <>{empty ?? children}</>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={cn(card, "px-5 py-8 text-center text-sm text-muted-foreground")}>{children}</div>;
}

/** What a Study write needs: the page's bootstrap (CSRF token, daemon epoch) and a way to refresh it. */
export interface Mutator { bootstrap?: WebBootstrap; refresh: () => Promise<WebBootstrap>; live: boolean }
