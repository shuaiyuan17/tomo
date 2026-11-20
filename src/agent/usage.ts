import { execFile, spawn, type ExecFileException } from "node:child_process";
import { formatLocale, joinText, ownerT, type Locale, type OwnerT, type OwnerText } from "../i18n/index.js";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 10_000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** Deadline for the delegated `claude -p /usage` token refresh (normally ~1s). */
const REFRESH_TIMEOUT_MS = 30_000;
/** After the deadline's SIGTERM, how long a child gets before SIGKILL. */
const REFRESH_KILL_GRACE_MS = 2_000;
/** Fallback credentials file used on Linux / non-macOS installs. */
const CREDENTIALS_FILE = join(homedir(), ".claude", ".credentials.json");

/** One usage window as returned by the OAuth usage endpoint. */
interface UsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
}

interface ExtraUsage {
  is_enabled?: boolean | null;
  monthly_limit?: number | null;
  used_credits?: number | null;
  currency?: string | null;
}

/** Scope a limit applies to — a specific model and/or surface, or null (all). */
interface UsageLimitScope {
  model?: { id?: string | null; display_name?: string | null } | null;
  surface?: string | null;
}

/**
 * One entry of the `limits` array — the authoritative per-window / per-model
 * usage cap. `kind` is open-ended (session / weekly_all / weekly_scoped and
 * possibly others), so we render any kind generically rather than dropping it.
 */
interface UsageLimit {
  kind?: string | null;
  group?: string | null;
  percent?: number | null;
  severity?: string | null;
  resets_at?: string | null;
  scope?: UsageLimitScope | null;
  is_active?: boolean | null;
}

export interface UsageResponse {
  /** Authoritative source of truth when present/non-empty. */
  limits?: UsageLimit[] | null;
  // Legacy top-level windows — fallback for older/other account shapes that
  // don't return `limits`. These miss scoped (per-model) caps.
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  extra_usage?: ExtraUsage | null;
}

/** Shape of the OAuth blob stored in the Keychain / credentials file. */
interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    refreshToken?: string;
    subscriptionType?: string;
  };
}

/**
 * What happened to the delegated refresh. "completed" means Claude Code ran to
 * exit — it had its chance to refresh, so a still-stale token afterwards is a
 * real failure. "timed_out" / "failed_to_start" mean it never got that chance.
 */
export type RefreshOutcome = "completed" | "timed_out" | "failed_to_start";

interface UsageDeps {
  fetchImpl?: typeof fetch;
  /** Sees every successfully parsed usage body (e.g. the quota history in usage/limits-log.ts). Must not throw; if it does, it is ignored. */
  onData?: (data: UsageResponse) => void;
  now?: () => number;
  /** Injectable token loader for tests; defaults to the real Keychain reader. */
  loadCredentials?: () => Promise<ClaudeCredentials>;
  /**
   * Ask Claude Code itself to refresh its stored OAuth access token (it rotates
   * the refresh token and persists both under its own cross-process lock).
   * Resolves whether or not a refresh happened — callers re-read the
   * credentials to find out. Tomo never refreshes or writes the credentials
   * itself. Defaults to running the SDK's bundled `claude` binary.
   */
  refreshCredentials?: () => Promise<RefreshOutcome>;
  /**
   * Anthropic auth mode for direct Claude sessions (`config.auth.method`).
   * "api-key" means there is no subscription session/weekly cap at all — usage
   * is billed per-token in the Console — so we short-circuit to a pointer
   * instead of a zeroed/empty subscription report. This is the authoritative
   * signal; we do NOT infer api-key mode from a merely-absent Keychain token
   * (a stale token can linger after switching auth modes).
   */
  authMethod?: "subscription" | "api-key";
  /**
   * True when a LiteLLM gateway is configured (`config.litellm.baseUrl`). The
   * subscription numbers still render, but with a caveat that this session may
   * bill through the gateway rather than the subscription.
   */
  gatewayActive?: boolean;
  /** Language of the `/usage` reply (default: config `locale`). */
  locale?: Locale;
}

/**
 * Reads the current Claude subscription usage (5-hour and 7-day windows) and
 * returns a chat-native, multi-line report string. Never throws — every failure
 * mode (missing Keychain entry, non-macOS, expired/invalid token, network
 * error, non-200) resolves to a friendly one-line message.
 */
export async function buildUsageReport(deps: UsageDeps = {}): Promise<OwnerText> {
  // Unset: English text, and the system default for clock times, as before.
  const locale = deps.locale ?? formatLocale();
  const result = await fetchUsage(deps);
  if (!result.ok) return result.render(locale ?? "en");
  // The format phase must not throw out of the never-throws boundary: malformed
  // endpoint data is guarded per-field, and this catch is the final backstop.
  try {
    return formatUsageReport(result.data, (deps.now ?? Date.now)(), result.subscriptionType, deps.gatewayActive, locale);
  } catch {
    return ownerT("usage", locale ?? "en")("failure.badResponse");
  }
}

/** Why usage could not be read — distinct so a UI can say which. */
export type UsageFailure =
  | "api_key" | "no_token" | "credentials_unreadable" | "token_expired" | "refresh_pending"
  | "unauthorized" | "network" | "timeout" | "http_error" | "bad_response";
export type UsageResult =
  | { ok: true; data: UsageResponse; subscriptionType?: string }
  /** `message` is English (the web card's text); `render` writes it in any locale. */
  | { ok: false; reason: UsageFailure; message: string; render: (locale: Locale) => OwnerText };
const fail = (reason: UsageFailure, text: (t: OwnerT<"usage">) => OwnerText): UsageResult =>
  ({ ok: false, reason, message: text(ownerT("usage", "en")), render: (locale) => text(ownerT("usage", locale)) });
/** A failed request (the web card's fallback uses it too). */
export const requestFailure = (kind: "timeout" | "network"): UsageResult =>
  kind === "timeout" ? fail("timeout", (t: OwnerT<"usage">) => t("failure.timeout")) : fail("network", (t: OwnerT<"usage">) => t("failure.network"));

/**
 * The structured half of `/usage`: credentials (with Claude Code's delegated
 * refresh), the request, and the parsed body — or a classified failure whose
 * message is the same text `/usage` prints. Never throws.
 */
export async function fetchUsage(deps: UsageDeps = {}): Promise<UsageResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const loadCredentials = deps.loadCredentials ?? readClaudeCredentials;

  // API-key auth has no session/weekly subscription cap — report that plainly
  // instead of an empty or zeroed subscription block. Authoritative config
  // signal, so it wins even if a stale Keychain OAuth token is still present.
  if (deps.authMethod === "api-key") {
    return fail("api_key", (t: OwnerT<"usage">) => t("failure.apiKey"));
  }

  let creds: ClaudeCredentials;
  try {
    creds = await loadCredentials();
  } catch (err) {
    if (!(err instanceof UsageCredentialError)) return fail("credentials_unreadable", (t: OwnerT<"usage">) => t("failure.credentialsGeneric"));
    const kind = err.kind;
    return fail(kind === "keychain_not_found" || kind === "file_missing" ? "no_token" : "credentials_unreadable",
      (t: OwnerT<"usage">) => credentialFailureText(t, kind));
  }

  // Parsed JSON can be semantically malformed (e.g. a literal `null`, which is
  // typeof "object"): accessing `.claudeAiOauth` on it would throw outside any
  // catch. Guard the shape before extraction.
  if (!creds || typeof creds !== "object") {
    return fail("credentials_unreadable", (t: OwnerT<"usage">) => t("failure.malformed"));
  }

  let oauth = creds.claudeAiOauth;
  const initialToken = oauth?.accessToken;
  if (!initialToken) {
    return fail("no_token", (t: OwnerT<"usage">) => t("failure.noToken"));
  }
  let token: string = initialToken;

  // The access token in the Keychain is short-lived; Claude Code refreshes it
  // (and rotates the refresh token) only when it next makes an API call. So an
  // expired `expiresAt` is the normal state between agent turns, not a broken
  // login. Delegate the refresh to Claude Code and re-read — never refresh
  // here: a rotated refresh token that isn't written back exactly as Claude
  // Code expects would break the agent itself.
  let refreshAttempted = false;
  let lastOutcome: RefreshOutcome | undefined;
  if (isExpired(oauth?.expiresAt, now())) {
    if (!oauth?.refreshToken) {
      return fail("token_expired", (t: OwnerT<"usage">) => t("failure.expired"));
    }
    refreshAttempted = true;
    const { outcome, oauth: fresh, readFailed } = await refreshAndReload(deps, loadCredentials);
    if (readFailed) return fail("credentials_unreadable", (t: OwnerT<"usage">) => t("failure.rereadFailed"));
    if (!fresh?.accessToken || isExpired(fresh.expiresAt, now())) {
      return outcome === "completed" ? fail("token_expired", (t: OwnerT<"usage">) => t("failure.refreshFailed")) : fail("refresh_pending", (t: OwnerT<"usage">) => t("failure.refreshPending"));
    }
    lastOutcome = outcome;
    oauth = fresh;
    token = fresh.accessToken;
  }

  let res = await requestUsage(fetchImpl, token);
  if (typeof res === "string") return requestFailure(res);

  // A 401 with a future `expiresAt` still usually means a stale token (e.g. it
  // was rotated by another Claude Code process after we read it). Give Claude
  // Code one chance to refresh, and retry once only if the token changed.
  if (res.status === 401 && oauth?.refreshToken && !refreshAttempted) {
    const { outcome, oauth: fresh, readFailed } = await refreshAndReload(deps, loadCredentials);
    if (readFailed) return fail("credentials_unreadable", (t: OwnerT<"usage">) => t("failure.rereadFailed"));
    lastOutcome = outcome;
    if (fresh?.accessToken && fresh.accessToken !== token && !isExpired(fresh.expiresAt, now())) {
      oauth = fresh;
      token = fresh.accessToken;
      res = await requestUsage(fetchImpl, token);
      if (typeof res === "string") return requestFailure(res);
    }
  }

  if (res.status === 401 && oauth?.refreshToken) {
    // Only claim "it'll refresh next turn" when Claude Code never got to try;
    // once it ran and the token is still rejected, say so honestly.
    return lastOutcome === "completed" ? fail("unauthorized", (t: OwnerT<"usage">) => t("failure.rejectedAfterRefresh")) : fail("refresh_pending", (t: OwnerT<"usage">) => t("failure.refreshPending"));
  }
  if (res.status === 401 || res.status === 403) {
    return fail("unauthorized", (t: OwnerT<"usage">) => t("failure.unauthorized"));
  }
  if (!res.ok) {
    return fail("http_error", (t: OwnerT<"usage">) => t("failure.http", { status: res.status }));
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    if (isTimeout(err)) return requestFailure("timeout");
    return fail("bad_response", (t: OwnerT<"usage">) => t("failure.badResponse"));
  }
  // A body of literal `null` is not an error here: `/usage` renders it as an
  // empty report, and the web card as "no usage data".
  const body = (data ?? {}) as UsageResponse;
  try { deps.onData?.(body); } catch { /* an observer never breaks the read */ }
  return { ok: true, data: body, subscriptionType: oauth?.subscriptionType };
}

/** True when a recorded `expiresAt` (ms epoch) is at or before `nowMs`. */
function isExpired(expiresAt: number | undefined, nowMs: number): boolean {
  return typeof expiresAt === "number" && expiresAt <= nowMs;
}

/**
 * GET the usage endpoint. Returns the Response, or a fixed chat message for a
 * network failure / timeout. The body must be read before the deadline too:
 * the signal is tied to the response stream, so a stalled body aborts as well.
 */
async function requestUsage(fetchImpl: typeof fetch, token: string): Promise<Response | "timeout" | "network"> {
  // Without a deadline, /usage could hang indefinitely on an unresponsive
  // endpoint.
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        Accept: "application/json",
      },
      signal,
    });
  } catch (err) {
    if (isTimeout(err)) return "timeout";
    // Never interpolate the raw error: a future fetch wrapper that echoed
    // request headers could leak the bearer token through err.message.
    return "network";
  }
}

/**
 * Have Claude Code refresh its token, then re-read the stored credentials.
 * `readFailed` means the re-read itself failed (so the token's state is
 * unknown); otherwise `oauth` is whatever is stored now (null if absent).
 * Never throws.
 */
async function refreshAndReload(
  deps: UsageDeps,
  loadCredentials: () => Promise<ClaudeCredentials>,
): Promise<{ outcome: RefreshOutcome; oauth: NonNullable<ClaudeCredentials["claudeAiOauth"]> | null; readFailed: boolean }> {
  let outcome: RefreshOutcome;
  try {
    outcome = await (deps.refreshCredentials ?? (() => runClaudeRefresh(resolveClaudeBinary())))();
  } catch {
    outcome = "failed_to_start";
  }
  try {
    const creds = await loadCredentials();
    if (!creds || typeof creds !== "object") return { outcome, oauth: null, readFailed: true };
    return { outcome, oauth: creds.claudeAiOauth ?? null, readFailed: false };
  } catch {
    return { outcome, oauth: null, readFailed: true };
  }
}

/** Arguments for the delegated refresh; exported for tests. */
export const CLAUDE_REFRESH_ARGS = ["-p", "/usage", "--safe-mode", "--no-session-persistence"] as const;

/**
 * Delegate the OAuth refresh to Claude Code: `claude -p /usage` refreshes an
 * expiring access token at startup — under Claude Code's own refresh lock,
 * writing the rotated tokens back in its own storage format — and `/usage` is
 * a local command, so no model call is made. `--safe-mode` keeps the user's
 * hooks, plugins and MCP servers from running.
 *
 * Resolves by `timeoutMs` at the latest, whatever the child does: at the
 * deadline it is sent SIGTERM and, if still alive `killGraceMs` later, SIGKILL.
 * Never throws; child output is discarded (it never reaches the chat).
 */
export function runClaudeRefresh(
  binary: string,
  opts: {
    timeoutMs?: number;
    killGraceMs?: number;
    cwd?: string;
    /** Injectable for tests (a fake child gives deterministic signal handling). */
    spawnImpl?: typeof spawn;
  } = {},
): Promise<RefreshOutcome> {
  const timeoutMs = opts.timeoutMs ?? REFRESH_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? REFRESH_KILL_GRACE_MS;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: RefreshOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = (opts.spawnImpl ?? spawn)(binary, [...CLAUDE_REFRESH_ARGS], {
        cwd: opts.cwd ?? tmpdir(),
        // stdin ignored: `-p` would otherwise wait on an open stdin pipe.
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      settle("failed_to_start");
      return;
    }

    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      // Resolve now, independent of the child; then make sure it dies.
      settle("timed_out");
      if (exited) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, killGraceMs);
    }, timeoutMs);

    child.once("error", () => {
      exited = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      settle("failed_to_start");
    });
    child.once("exit", () => {
      exited = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      settle("completed");
    });
  });
}

/**
 * Path of the native `claude` binary the Agent SDK spawns (its per-platform
 * optional dependency), resolved the same way the SDK does — including its
 * musl-first ordering on musl Linux, where both variants can be installed but
 * only the musl one runs. Falls back to `claude` on PATH.
 */
function resolveClaudeBinary(): string {
  try {
    const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
    const exe = process.platform === "win32" ? ".exe" : "";
    const sdk = "@anthropic-ai/claude-agent-sdk";
    const linux = `${sdk}-linux-${process.arch}`;
    // Same package names and order as the SDK's own lookup.
    const candidates = process.platform === "android"
      ? [`${linux}-android`]
      : process.platform === "linux"
        ? (isMuslLinux() ? [`${linux}-musl`, linux] : [linux, `${linux}-musl`])
        : [`${sdk}-${process.platform}-${process.arch}`];
    for (const pkg of candidates) {
      try {
        return sdkRequire.resolve(`${pkg}/claude${exe}`);
      } catch {
        // try the next candidate
      }
    }
  } catch {
    // SDK not resolvable from here — fall through to PATH
  }
  return "claude";
}

/** Same check the SDK uses: a glibc runtime reports glibcVersionRuntime. */
function isMuslLinux(): boolean {
  const report = typeof process.report?.getReport === "function"
    ? process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
    : null;
  return report != null && report.header?.glibcVersionRuntime === undefined;
}

/** Turn a parsed usage payload into the plain-text chat report. */
export function formatUsageReport(
  data: UsageResponse,
  now: number,
  subscriptionType?: string,
  gatewayActive?: boolean,
  locale?: Locale,
): OwnerText {
  const t = ownerT("usage", locale ?? "en");
  // Endpoint data is untrusted: a JSON body of literal `null`, or fields with
  // the wrong type (e.g. group: 7), must degrade gracefully rather than throw
  // out of the never-throws boundary. Coerce to a safe object up front and
  // normalize each field before any string/number method runs on it.
  const d: UsageResponse = data && typeof data === "object" ? data : {};

  const planLabel = subscriptionLabel(subscriptionType);
  const lines: OwnerText[] = [planLabel ? t("titlePlan", { plan: planLabel }) : t("title")];

  const limits = (Array.isArray(d.limits) ? d.limits : [])
    .map(toSafeLimit)
    .filter((l): l is SafeLimit => l !== null);
  if (limits.length > 0) {
    // Primary path: render every limit entry so nothing (esp. active scoped
    // caps like a Fable weekly wall) is silently dropped.
    lines.push(...renderLimits(t, limits, now, locale));
  } else {
    // Fallback for account shapes that don't return `limits`.
    lines.push(...windowLines(t, t("window.session"), d.five_hour, now, locale));
    lines.push(...windowLines(t, t("window.weekly"), d.seven_day, now, locale));
    const opus = windowLines(t, t("window.opus"), d.seven_day_opus, now, locale, true);
    if (opus.length > 0) lines.push(...opus);
    const sonnet = windowLines(t, t("window.sonnet"), d.seven_day_sonnet, now, locale, true);
    if (sonnet.length > 0) lines.push(...sonnet);
  }

  const extra = d.extra_usage;
  if (extra && typeof extra === "object" && extra.is_enabled === true) {
    const used = typeof extra.used_credits === "number" && Number.isFinite(extra.used_credits) ? extra.used_credits : 0;
    const limit = typeof extra.monthly_limit === "number" && Number.isFinite(extra.monthly_limit) ? extra.monthly_limit : 0;
    const currency = typeof extra.currency === "string" && extra.currency && extra.currency !== "USD"
      ? `${extra.currency} `
      : "$";
    lines.push(t("extra", { used: `${currency}${used.toFixed(2)}`, limit: `${currency}${limit}` }));
  }

  if (gatewayActive) lines.push(t("gateway"));

  return joinText(lines);
}

/** One usage window as structured data (the web card's rows). */
export interface UsageWindowView {
  id: string;
  label: string;
  /** session = the 5-hour window, weekly = 7-day; scoped = per model/surface. */
  group: "session" | "weekly" | "other";
  scoped: boolean;
  /** 0–100, or null when the endpoint gave none. */
  percent: number | null;
  /** ms epoch, or null. */
  resetsAt: number | null;
  active: boolean;
  elevated: boolean;
}

/**
 * The same windows `/usage` prints, as data: the authoritative `limits` array
 * when present (sorted session → weekly → other), else the legacy top-level
 * windows. Untrusted input is narrowed per field, as in formatUsageReport.
 */
export function usageWindows(data: UsageResponse | null | undefined): UsageWindowView[] {
  const d: UsageResponse = data && typeof data === "object" ? data : {};
  const resets = (value: string | null | undefined) => {
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const limits = (Array.isArray(d.limits) ? d.limits : []).map(toSafeLimit).filter((l): l is SafeLimit => l !== null);
  if (limits.length > 0) {
    return [...limits].sort((a, b) => groupRank(a) - groupRank(b)).map((limit, index) => {
      const rank = groupRank(limit);
      return {
        id: `${limit.kind || "limit"}:${limit.modelName}:${limit.surface}:${index}`,
        label: limitLabel(limit),
        group: rank === 0 ? "session" : rank === 1 ? "weekly" : "other",
        scoped: !!(limit.modelName || limit.surface) || limit.kind.endsWith("_scoped"),
        percent: limit.percent,
        resetsAt: resets(limit.resetsAt),
        active: limit.isActive,
        elevated: isElevatedSeverity(limit.severity),
      };
    });
  }
  const legacy: Array<[string, string, UsageWindowView["group"], boolean, UsageWindow | null | undefined]> = [
    ["five_hour", "Session (5h)", "session", false, d.five_hour],
    ["seven_day", "Weekly (all)", "weekly", false, d.seven_day],
    ["seven_day_opus", "Weekly · Opus", "weekly", true, d.seven_day_opus],
    ["seven_day_sonnet", "Weekly · Sonnet", "weekly", true, d.seven_day_sonnet],
  ];
  return legacy.filter(([, , , , w]) => w && typeof w === "object").map(([id, label, group, scoped, w]) => ({
    id, label, group, scoped,
    percent: typeof w!.utilization === "number" && Number.isFinite(w!.utilization) ? w!.utilization : null,
    resetsAt: resets(w!.resets_at), active: false, elevated: false,
  }));
}

/**
 * Render a labeled window as up to two lines:
 *   `<label> 36%`
 *   `  resets in 5d 23h  (Aug 2, 7:59 AM)`
 * Returns an empty array for a null/absent window (used to omit per-model rows).
 * When `compact` is set, the two lines are joined so per-model rows stay tight.
 */
function windowLines(t: OwnerT<"usage">, label: string, window: UsageWindow | null | undefined, now: number, locale: Locale | undefined, compact = false): OwnerText[] {
  if (!window || typeof window !== "object") return [];
  const percent = typeof window.utilization === "number" && Number.isFinite(window.utilization)
    ? `${Math.round(window.utilization)}%`
    : t("noPercent");
  const reset = typeof window.resets_at === "string" ? formatReset(window.resets_at, now, locale) : null;
  // The legacy labels share one column; compact rows (per model) are indented under the weekly one.
  const column = (compact ? `  ${label}` : label).padEnd(14);

  if (compact) {
    return [reset ? t("windowLineReset", { label: column, percent, countdown: reset.countdown, clock: reset.clock }) : t("windowLine", { label: column, percent })];
  }

  const out = [t("windowLine", { label: column, percent })];
  if (reset) out.push(t("resetLine", { countdown: reset.countdown, clock: reset.clock }));
  return out;
}

/**
 * A limit entry with every field narrowed to a safe, already-typed value, so
 * the render helpers below never call a string/number method on untrusted data.
 */
interface SafeLimit {
  kind: string;
  group: string;
  percent: number | null;
  severity: string;
  resetsAt: string | null;
  modelName: string;
  surface: string;
  isActive: boolean;
}

/**
 * Normalize one raw `limits` entry into a SafeLimit, coercing every field with
 * a typeof check. Returns null for a non-object entry (dropped by the caller).
 */
function toSafeLimit(raw: unknown): SafeLimit | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  const scope = l.scope && typeof l.scope === "object" ? l.scope as Record<string, unknown> : undefined;
  const model = scope?.model && typeof scope.model === "object" ? scope.model as Record<string, unknown> : undefined;
  return {
    kind: typeof l.kind === "string" ? l.kind : "",
    group: typeof l.group === "string" ? l.group : "",
    percent: typeof l.percent === "number" && Number.isFinite(l.percent) ? l.percent : null,
    severity: typeof l.severity === "string" ? l.severity : "",
    resetsAt: typeof l.resets_at === "string" ? l.resets_at : null,
    modelName: typeof model?.display_name === "string" ? model.display_name.trim() : "",
    surface: typeof scope?.surface === "string" ? scope.surface.trim() : "",
    isActive: l.is_active === true,
  };
}

/**
 * Render the `limits` array, one line per entry, grouped session-then-weekly
 * (then anything else), with the label column padded so percents align.
 */
function renderLimits(t: OwnerT<"usage">, limits: SafeLimit[], now: number, locale: Locale | undefined): OwnerText[] {
  // Stable sort (V8 Array.sort is stable): session group first, weekly next,
  // unknown groups last — original order preserved within each group.
  const sorted = [...limits].sort((a, b) => groupRank(a) - groupRank(b));
  const labels = sorted.map((limit) => limitLabel(limit, locale));
  const colWidth = Math.max(...labels.map((l) => l.length + 1)) + 2; // +1 colon, +2 gap
  return sorted.map((limit, i) => renderLimitLine(t, limit, labels[i], colWidth, now, locale));
}

/** Rank a limit's group for ordering: session (0), weekly (1), other (2). */
function groupRank(limit: SafeLimit): number {
  const group = limit.group.toLowerCase();
  const kind = limit.kind.toLowerCase();
  if (group === "session" || kind.startsWith("session")) return 0;
  if (group === "weekly" || kind.includes("weekly")) return 1;
  return 2;
}

/** Build a human label from a limit's kind + scope (e.g. "Weekly · Fable"). */
function limitLabel(limit: SafeLimit, locale?: Locale): string {
  const t = ownerT("usage", locale ?? "en");
  let base: string;
  switch (limit.kind) {
    case "session": base = t("limit.session"); break;
    case "weekly_all": base = t("limit.weeklyAll"); break;
    case "weekly_scoped": base = t("limit.weekly"); break;
    default: base = prettifyKind(limit.kind) ?? t("limit.fallback");
  }
  const parts = [base];
  if (limit.modelName) parts.push(limit.modelName);
  if (limit.surface) parts.push(limit.surface);
  return parts.join(" · ");
}

/** Turn an unknown kind like "five_hour_scoped" into "Five Hour Scoped". */
function prettifyKind(kind: string): string | undefined {
  const words = kind.split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * One rendered limit line:
 *   `Weekly · Fable:      43%  ← active · resets in 5d 16h (Aug 2, 7:59 AM)`
 * Elevated severity prefixes the line with ⚠️.
 */
function renderLimitLine(t: OwnerT<"usage">, limit: SafeLimit, label: string, colWidth: number, now: number, locale: Locale | undefined): OwnerText {
  const pct = limit.percent !== null ? `${Math.round(limit.percent)}%` : t("noPercent");
  const reset = limit.resetsAt ? formatReset(limit.resetsAt, now, locale) : null;

  const line = {
    column: `${label}:`.padEnd(colWidth) + pct.padEnd(5),
    active: limit.isActive ? t("active") : "",
    resets: reset ? t("resetsIn", { countdown: reset.countdown, clock: reset.clock }) : "",
  };
  // The trailing pad goes when nothing follows it.
  if (!line.resets && line.active) line.active = line.active.trimEnd();
  else if (!line.resets) line.column = line.column.trimEnd();
  return isElevatedSeverity(limit.severity) ? t("limitLineElevated", line) : t("limitLine", line);
}

/** Any severity other than normal/none is treated as elevated (⚠️). */
function isElevatedSeverity(severity: string): boolean {
  if (!severity) return false;
  const s = severity.toLowerCase();
  return s !== "normal" && s !== "none" && s !== "ok";
}

/** Format an ISO reset timestamp into a human countdown + local clock time. */
/** `locale` undefined (unset): English, and the system's own clock format. */
export function formatReset(resetsAt: string, now: number, locale?: Locale): { countdown: string; clock: string } {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) {
    const unknown = ownerT("usage", locale ?? "en")("countdown.unknown");
    return { countdown: unknown, clock: unknown };
  }
  return { countdown: formatCountdown(resetMs - now, locale), clock: formatLocalClock(resetMs, now, locale) };
}

/** "5d 23h" / "5h 12m" / "47m" / "now". Two coarsest non-zero units. */
export function formatCountdown(ms: number, locale?: Locale): string {
  const t = ownerT("usage", locale ?? "en");
  if (ms <= 0) return t("countdown.now");
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return t("countdown.daysHours", { d: days, h: hours });
  if (hours > 0) return t("countdown.hoursMinutes", { h: hours, m: minutes });
  return t("countdown.minutes", { m: minutes });
}

/**
 * Local-zone clock for a reset instant. Shows the date when it is not today,
 * e.g. "7:59 PM" (today) vs "Aug 2, 7:59 AM" (another day).
 */
function formatLocalClock(resetMs: number, now: number, locale: Locale | undefined): string {
  const reset = new Date(resetMs);
  // Unset (undefined): the system's own conventions, as before.
  const time = reset.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === reset.toDateString();
  if (sameDay) return time;
  const date = reset.toLocaleDateString(locale, { month: "short", day: "numeric" });
  return ownerT("usage", locale ?? "en")("dateTime", { date, time });
}

export function subscriptionLabel(subscriptionType?: string): string {
  if (!subscriptionType) return "";
  const map: Record<string, string> = {
    max: "Max",
    max_5x: "Max 5x",
    max_20x: "Max 20x",
    pro: "Pro",
    team: "Team",
    enterprise: "Enterprise",
  };
  return map[subscriptionType] ?? subscriptionType;
}

/**
 * Read the Claude Code OAuth credentials. On macOS they live only in the login
 * Keychain; elsewhere Claude Code writes ~/.claude/.credentials.json. Try the
 * Keychain first, then the file. Rejects with a friendly Error otherwise.
 */
async function readClaudeCredentials(): Promise<ClaudeCredentials> {
  if (process.platform === "darwin") {
    try {
      return await readKeychainCredentials();
    } catch (err) {
      // Fall through to the file only if the Keychain tool itself is missing;
      // otherwise surface the Keychain error (missing entry, locked, etc.).
      if (!(err instanceof UsageCredentialError) || !err.tryFile) throw err;
    }
  }
  return await readFileCredentials();
}

function readKeychainCredentials(): Promise<ClaudeCredentials> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) {
          const code = err.code;
          // ONLY the `security` binary being absent (non-macOS / not on PATH)
          // may fall back to the on-disk credentials file. Node reports this as
          // a string "ENOENT" code; a real Keychain error carries a numeric
          // exit code instead.
          if (code === "ENOENT") {
            reject(new UsageCredentialError("security_missing", true));
            return;
          }
          // Operational Keychain failures (item-not-found, locked, access
          // denied, timeout) must NOT fall back to a possibly-stale on-disk
          // credential — surface an actionable message instead.
          reject(new UsageCredentialError(keychainErrorKind(err, stderr), false));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout.trim());
          if (!parsed || typeof parsed !== "object") {
            reject(new UsageCredentialError("malformed", false));
            return;
          }
          resolve(parsed as ClaudeCredentials);
        } catch {
          reject(new UsageCredentialError("keychain_json", false));
        }
      },
    );
  });
}

/** Map a `security` non-ENOENT failure to a fixed, actionable message (English). */
export function keychainErrorMessage(err: ExecFileException, stderr: string | Buffer | undefined): string {
  return CREDENTIAL_MESSAGES[keychainErrorKind(err, stderr)];
}

/** Which fixed failure a `security` non-ENOENT exit is. */
function keychainErrorKind(err: ExecFileException, stderr: string | Buffer | undefined): CredentialFailure {
  // When Node's own execFile `timeout` fires, it kills the child and sets
  // killed=true WITH the kill signal — that pair is the timeout signature.
  // Require both: a child terminated externally by SIGTERM has killed=false
  // (Node didn't kill it), so it must NOT be mislabeled a timeout — it falls
  // through to the generic message. Checked first because a timeout usually
  // leaves stderr empty, which the stderr branches can't distinguish.
  if (err.killed === true && err.signal != null) {
    return "keychain_timeout";
  }
  const code = err.code;
  const text = String(stderr ?? "").toLowerCase();
  // errSecItemNotFound → exit 44, or the tool prints "could not be found".
  if (code === 44 || code === "44" || text.includes("could not be found")) {
    return "keychain_not_found";
  }
  if (text.includes("interaction is not allowed") || text.includes("denied") || text.includes("locked")) {
    return "keychain_locked";
  }
  return "keychain_unreadable";
}

async function readFileCredentials(): Promise<ClaudeCredentials> {
  let raw: string;
  try {
    raw = await readFile(CREDENTIALS_FILE, "utf-8");
  } catch {
    throw new UsageCredentialError("file_missing", false);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageCredentialError("file_json", false);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new UsageCredentialError("malformed", false);
  }
  return parsed as ClaudeCredentials;
}

/** Why the Claude Code credentials could not be read: each is a fixed message of ours. */
type CredentialFailure =
  | "security_missing" | "keychain_timeout" | "keychain_not_found" | "keychain_locked" | "keychain_unreadable"
  | "keychain_json" | "malformed" | "file_missing" | "file_json";

/** The English text of each (the web card's message; also `Error.message`). */
const CREDENTIAL_MESSAGES: Record<CredentialFailure, string> = {
  security_missing: "`security` command not found on PATH.",
  keychain_timeout: "the macOS Keychain lookup timed out — unlock the Keychain and try /usage again.",
  keychain_not_found: "no Claude Code credentials in the macOS Keychain. Log in with Claude Code first.",
  keychain_locked: "the macOS Keychain is locked or denied access — unlock it and try /usage again.",
  keychain_unreadable: "could not read Claude Code credentials from the macOS Keychain.",
  keychain_json: "Keychain credentials were not valid JSON.",
  malformed: "Claude Code credentials were malformed. Re-login to Claude Code (`claude` → /login).",
  file_missing: "no Claude Code credentials found. Log in with Claude Code first.",
  file_json: "Claude Code credentials file was not valid JSON.",
};

/** A credential failure, in the reply's language. */
function credentialFailureText(t: OwnerT<"usage">, kind: CredentialFailure): OwnerText {
  switch (kind) {
    case "security_missing": return t("failure.credential.securityMissing");
    case "keychain_timeout": return t("failure.credential.keychainTimeout");
    case "keychain_not_found": return t("failure.credential.keychainNotFound");
    case "keychain_locked": return t("failure.credential.keychainLocked");
    case "keychain_unreadable": return t("failure.credential.keychainUnreadable");
    case "keychain_json": return t("failure.credential.keychainJson");
    case "malformed": return t("failure.malformed");
    case "file_missing": return t("failure.credential.fileMissing");
    case "file_json": return t("failure.credential.fileJson");
  }
}

/** Credential-loading failure: a fixed kind, so the reply can be written in any language. */
class UsageCredentialError extends Error {
  constructor(readonly kind: CredentialFailure, readonly tryFile: boolean) {
    super(CREDENTIAL_MESSAGES[kind]);
    this.name = "UsageCredentialError";
  }
}

/** AbortSignal.timeout aborts with a "TimeoutError" DOMException; a manually
 *  aborted request surfaces as "AbortError". Treat both as a timeout. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * Surface only our own curated credential messages; anything else collapses to
 * a fixed string. This structurally guarantees no arbitrary err.message (which
 * a future layer could populate with sensitive data) reaches the chat.
 */
