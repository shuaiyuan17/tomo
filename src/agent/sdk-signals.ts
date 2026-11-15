/**
 * What the SDK says about a running turn (or the account) besides its content:
 * retries, rate-limit changes, refusals, tool progress, typed API errors,
 * prompt suggestions. LiveSession used to drop all of these;
 * they are now read here, in one pure function, and published on the watch
 * bus for the web UI.
 *
 * Read by shape, never imported from the SDK's types: an SDK release that
 * renames a field must degrade to "no signal", not fail the event loop.
 */

export type SdkErrorKind =
  | "authentication_failed" | "oauth_org_not_allowed" | "account_on_hold" | "verification_required"
  | "billing_error" | "rate_limit" | "overloaded" | "invalid_request" | "model_not_found"
  | "server_error" | "max_output_tokens" | "cloud_credential_error" | "unknown";

const ERROR_KINDS: ReadonlySet<string> = new Set<SdkErrorKind>([
  "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error",
  "rate_limit", "overloaded", "invalid_request", "model_not_found", "server_error", "max_output_tokens",
  "cloud_credential_error", "unknown",
]);

export type RateLimitStatus = "allowed" | "allowed_warning" | "rejected";

export type SdkSignal =
  /** The API call failed and the CLI is waiting to try again. */
  | { kind: "retry"; attempt: number; maxRetries: number; delayMs: number; error: SdkErrorKind; status?: number }
  /** The subscription's rate-limit state changed. `resetsAt`: ms epoch. `utilization`: 0–100. */
  | { kind: "rate_limit"; status: RateLimitStatus; limit?: string; resetsAt?: number; utilization?: number; overage?: boolean }
  /** The model declined; `fallbackModel` when the turn was retried on another one. */
  | { kind: "refusal"; model: string; fallbackModel?: string; category?: string }
  /** A tool call is still running. */
  | { kind: "tool_progress"; toolUseId: string; tool: string; elapsedSeconds: number }
  /** An assistant message ended on a typed API error. */
  | { kind: "error"; error: SdkErrorKind }
  /** The SDK's predicted next owner message (promptSuggestions). */
  | { kind: "suggestion"; text: string }
  /** The owner stopped the running turn. */
  | { kind: "stopped" };

const SUGGESTION_LIMIT = 300;
const MODEL_LIMIT = 128;

function errorKind(value: unknown): SdkErrorKind {
  return typeof value === "string" && ERROR_KINDS.has(value) ? value as SdkErrorKind : "unknown";
}
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}
/** The SDK reports reset times in epoch seconds; anything already in ms is kept. */
function epochMs(value: unknown): number | undefined {
  const n = finite(value);
  if (n === undefined || n <= 0) return undefined;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}
/** 0–1 fractions and 0–100 percentages both occur; the UI gets a percentage. */
function percent(value: unknown): number | undefined {
  const n = finite(value);
  if (n === undefined || n < 0) return undefined;
  return Math.min(100, Math.round(n <= 1 ? n * 100 : n));
}

/**
 * A predicted prompt can imitate the harness stamp every inbound message
 * carries (`[web · Wed 09/02 20:50 PDT] …`), because that is what the model
 * sees the owner "type". The chip must offer only what he would write.
 */
export function cleanSuggestion(value: unknown): string | undefined {
  const raw = text(value, SUGGESTION_LIMIT * 2);
  if (!raw) return undefined;
  const cleaned = raw.replace(/^(?:\[[^\]\n]{1,200}\]\s*)+/, "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, SUGGESTION_LIMIT) : undefined;
}

/** The signal an SDK event carries, if any. Subagent events (parent_tool_use_id) carry none. */
export function sdkSignalOf(event: unknown): SdkSignal | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, unknown>;
  if (e.parent_tool_use_id) return undefined;

  if (e.type === "system") {
    if (e.subtype === "api_retry") {
      const attempt = finite(e.attempt);
      if (attempt === undefined) return undefined;
      const status = finite(e.error_status);
      return { kind: "retry", attempt, maxRetries: finite(e.max_retries) ?? attempt, delayMs: Math.max(0, finite(e.retry_delay_ms) ?? 0),
        error: errorKind(e.error), ...(status !== undefined ? { status } : {}) };
    }
    if (e.subtype === "model_refusal_fallback" || e.subtype === "model_refusal_no_fallback") {
      // A subagent's or side question's fallback leaves the session model alone: not the owner's turn.
      if (e.scope === "local") return undefined;
      const model = text(e.original_model, MODEL_LIMIT);
      if (!model) return undefined;
      const fallbackModel = e.subtype === "model_refusal_fallback" ? text(e.fallback_model, MODEL_LIMIT) : undefined;
      const category = text(e.api_refusal_category, 64);
      return { kind: "refusal", model, ...(fallbackModel ? { fallbackModel } : {}), ...(category ? { category } : {}) };
    }
    return undefined;
  }

  if (e.type === "rate_limit_event") {
    const info = e.rate_limit_info as Record<string, unknown> | undefined;
    const status = info?.status;
    if (!info || (status !== "allowed" && status !== "allowed_warning" && status !== "rejected")) return undefined;
    const limit = text(info.rateLimitType, 64);
    const resetsAt = epochMs(info.resetsAt);
    const utilization = percent(info.utilization);
    return { kind: "rate_limit", status, ...(limit ? { limit } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(utilization !== undefined ? { utilization } : {}), ...(info.isUsingOverage === true ? { overage: true } : {}) };
  }

  if (e.type === "tool_progress") {
    const toolUseId = text(e.tool_use_id, 128);
    const tool = text(e.tool_name, 128);
    const elapsedSeconds = finite(e.elapsed_time_seconds);
    if (!toolUseId || !tool || elapsedSeconds === undefined) return undefined;
    return { kind: "tool_progress", toolUseId, tool, elapsedSeconds: Math.max(0, Math.round(elapsedSeconds)) };
  }

  if (e.type === "assistant" && typeof e.error === "string") return { kind: "error", error: errorKind(e.error) };

  if (e.type === "prompt_suggestion") {
    const suggestion = cleanSuggestion(e.suggestion);
    return suggestion ? { kind: "suggestion", text: suggestion } : undefined;
  }
  return undefined;
}
