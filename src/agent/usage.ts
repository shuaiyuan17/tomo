import { spawn } from "node:child_process";
import { formatLocale, ownerT, type Locale, type OwnerT, type OwnerText } from "../i18n/index.js";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { credentialFailureText, readClaudeCredentials, UsageCredentialError, type ClaudeCredentials } from "./usage-credentials.js";
import { formatUsageReport, type UsageResponse } from "./usage-format.js";

// The credential readers and the report formatting live in their own modules;
// everything this module used to export is still exported from here.
export { keychainErrorMessage } from "./usage-credentials.js";
export { formatCountdown, formatReset, formatUsageReport, subscriptionLabel, usageWindows } from "./usage-format.js";
export type { UsageResponse, UsageWindowView } from "./usage-format.js";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 10_000;
/** Deadline for the delegated `claude -p /usage` token refresh (normally ~1s). */
const REFRESH_TIMEOUT_MS = 30_000;
/** After the deadline's SIGTERM, how long a child gets before SIGKILL. */
const REFRESH_KILL_GRACE_MS = 2_000;

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

/** AbortSignal.timeout aborts with a "TimeoutError" DOMException; a manually
 *  aborted request surfaces as "AbortError". Treat both as a timeout. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
