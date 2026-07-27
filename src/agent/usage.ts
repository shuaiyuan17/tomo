import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
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

interface UsageResponse {
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

interface UsageDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injectable token loader for tests; defaults to the real Keychain reader. */
  loadCredentials?: () => Promise<ClaudeCredentials>;
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
}

const API_KEY_MESSAGE =
  "📊 API-key auth — no subscription limits. Usage is billed per-token; see console.anthropic.com/settings/usage";
const GATEWAY_CAVEAT =
  "(gateway mode active — these are your Claude subscription limits, not necessarily what this session bills to)";

/**
 * Reads the current Claude subscription usage (5-hour and 7-day windows) and
 * returns a chat-native, multi-line report string. Never throws — every failure
 * mode (missing Keychain entry, non-macOS, expired/invalid token, network
 * error, non-200) resolves to a friendly one-line message.
 */
export async function buildUsageReport(deps: UsageDeps = {}): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const loadCredentials = deps.loadCredentials ?? readClaudeCredentials;

  // API-key auth has no session/weekly subscription cap — report that plainly
  // instead of an empty or zeroed subscription block. Authoritative config
  // signal, so it wins even if a stale Keychain OAuth token is still present.
  if (deps.authMethod === "api-key") {
    return API_KEY_MESSAGE;
  }

  let creds: ClaudeCredentials;
  try {
    creds = await loadCredentials();
  } catch (err) {
    return usageError(err);
  }

  const oauth = creds.claudeAiOauth;
  const token = oauth?.accessToken;
  if (!token) {
    return "Claude usage unavailable: no Claude Code credentials found. Log in with Claude Code first.";
  }

  // Pre-flight the recorded expiry so we can give a precise message instead of
  // a bare 401. A little skew tolerance so a token expiring seconds from now
  // still reads as expired.
  if (typeof oauth?.expiresAt === "number" && oauth.expiresAt <= now()) {
    return "Claude usage unavailable: access token expired. Re-login to Claude Code (`claude` → /login).";
  }

  let res: Response;
  try {
    res = await fetchImpl(USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        Accept: "application/json",
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `Claude usage unavailable: network error (${detail}).`;
  }

  if (res.status === 401 || res.status === 403) {
    return "Claude usage unavailable: token expired or unauthorized. Re-login to Claude Code (`claude` → /login).";
  }
  if (!res.ok) {
    return `Claude usage unavailable: usage endpoint returned HTTP ${res.status}.`;
  }

  let data: UsageResponse;
  try {
    data = await res.json() as UsageResponse;
  } catch {
    return "Claude usage unavailable: could not parse the usage response.";
  }

  return formatUsageReport(data, now(), oauth?.subscriptionType, deps.gatewayActive);
}

/** Turn a parsed usage payload into the plain-text chat report. */
export function formatUsageReport(
  data: UsageResponse,
  now: number,
  subscriptionType?: string,
  gatewayActive?: boolean,
): string {
  const planLabel = subscriptionLabel(subscriptionType);
  const lines: string[] = [`📊 Claude usage${planLabel ? ` (${planLabel})` : ""}`, ""];

  const limits = Array.isArray(data.limits) ? data.limits.filter((l): l is UsageLimit => Boolean(l)) : [];
  if (limits.length > 0) {
    // Primary path: render every limit entry so nothing (esp. active scoped
    // caps like a Fable weekly wall) is silently dropped.
    lines.push(...renderLimits(limits, now));
  } else {
    // Fallback for account shapes that don't return `limits`.
    lines.push(...windowLines("Session (5h): ", data.five_hour, now));
    lines.push(...windowLines("Weekly (7d):  ", data.seven_day, now));
    const opus = windowLines("  Opus (7d):  ", data.seven_day_opus, now, true);
    if (opus.length > 0) lines.push(...opus);
    const sonnet = windowLines("  Sonnet (7d):", data.seven_day_sonnet, now, true);
    if (sonnet.length > 0) lines.push(...sonnet);
  }

  const extra = data.extra_usage;
  if (extra && extra.is_enabled) {
    const currency = extra.currency === "USD" || !extra.currency ? "$" : `${extra.currency} `;
    const used = typeof extra.used_credits === "number" ? extra.used_credits : 0;
    const limit = typeof extra.monthly_limit === "number" ? extra.monthly_limit : 0;
    lines.push("");
    lines.push(`Extra usage: ${currency}${used.toFixed(2)} / ${currency}${limit} this month`);
  }

  if (gatewayActive) {
    lines.push("");
    lines.push(GATEWAY_CAVEAT);
  }

  return lines.join("\n");
}

/**
 * Render a labeled window as up to two lines:
 *   `<label> 36%`
 *   `  resets in 5d 23h  (Aug 2, 7:59 AM)`
 * Returns an empty array for a null/absent window (used to omit per-model rows).
 * When `compact` is set, the two lines are joined so per-model rows stay tight.
 */
function windowLines(label: string, window: UsageWindow | null | undefined, now: number, compact = false): string[] {
  if (!window) return [];
  const pct = typeof window.utilization === "number" ? `${Math.round(window.utilization)}%` : "n/a";
  const reset = window.resets_at ? formatReset(window.resets_at, now) : null;

  if (compact) {
    return [reset ? `${label} ${pct} — resets in ${reset.countdown} (${reset.clock})` : `${label} ${pct}`];
  }

  const out = [`${label} ${pct}`];
  if (reset) out.push(`  resets in ${reset.countdown}  (${reset.clock})`);
  return out;
}

/**
 * Render the `limits` array, one line per entry, grouped session-then-weekly
 * (then anything else), with the label column padded so percents align.
 */
function renderLimits(limits: UsageLimit[], now: number): string[] {
  // Stable sort (V8 Array.sort is stable): session group first, weekly next,
  // unknown groups last — original order preserved within each group.
  const sorted = [...limits].sort((a, b) => groupRank(a) - groupRank(b));
  const labels = sorted.map(limitLabel);
  const colWidth = Math.max(...labels.map((l) => l.length + 1)) + 2; // +1 colon, +2 gap
  return sorted.map((limit, i) => renderLimitLine(limit, labels[i], colWidth, now));
}

/** Rank a limit's group for ordering: session (0), weekly (1), other (2). */
function groupRank(limit: UsageLimit): number {
  const group = (limit.group ?? "").toLowerCase();
  const kind = (limit.kind ?? "").toLowerCase();
  if (group === "session" || kind.startsWith("session")) return 0;
  if (group === "weekly" || kind.includes("weekly")) return 1;
  return 2;
}

/** Build a human label from a limit's kind + scope (e.g. "Weekly · Fable"). */
function limitLabel(limit: UsageLimit): string {
  let base: string;
  switch (limit.kind) {
    case "session": base = "Session (5h)"; break;
    case "weekly_all": base = "Weekly (all)"; break;
    case "weekly_scoped": base = "Weekly"; break;
    default: base = prettifyKind(limit.kind);
  }
  const parts = [base];
  const model = limit.scope?.model?.display_name?.trim();
  if (model) parts.push(model);
  const surface = typeof limit.scope?.surface === "string" ? limit.scope.surface.trim() : "";
  if (surface) parts.push(surface);
  return parts.join(" · ");
}

/** Turn an unknown kind like "five_hour_scoped" into "Five Hour Scoped". */
function prettifyKind(kind: string | null | undefined): string {
  if (!kind) return "Usage";
  return kind
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * One rendered limit line:
 *   `Weekly · Fable:      43%  ← active · resets in 5d 16h (Aug 2, 7:59 AM)`
 * Elevated severity prefixes the line with ⚠️.
 */
function renderLimitLine(limit: UsageLimit, label: string, colWidth: number, now: number): string {
  const pct = typeof limit.percent === "number" ? `${Math.round(limit.percent)}%` : "n/a";
  const reset = limit.resets_at ? formatReset(limit.resets_at, now) : null;

  let line = `${label}:`.padEnd(colWidth) + pct.padEnd(5);
  if (limit.is_active) line += "← active ";
  if (reset) line += `· resets in ${reset.countdown} (${reset.clock})`;
  line = line.replace(/\s+$/, "");

  if (isElevatedSeverity(limit.severity)) line = `⚠️ ${line}`;
  return line;
}

/** Any severity other than normal/none is treated as elevated (⚠️). */
function isElevatedSeverity(severity: string | null | undefined): boolean {
  if (!severity) return false;
  const s = severity.toLowerCase();
  return s !== "normal" && s !== "none" && s !== "ok";
}

/** Format an ISO reset timestamp into a human countdown + local clock time. */
export function formatReset(resetsAt: string, now: number): { countdown: string; clock: string } {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return { countdown: "unknown", clock: "unknown" };
  return { countdown: formatCountdown(resetMs - now), clock: formatLocalClock(resetMs, now) };
}

/** "5d 23h" / "5h 12m" / "47m" / "now". Two coarsest non-zero units. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Local-zone clock for a reset instant. Shows the date when it is not today,
 * e.g. "7:59 PM" (today) vs "Aug 2, 7:59 AM" (another day).
 */
function formatLocalClock(resetMs: number, now: number): string {
  const reset = new Date(resetMs);
  const time = reset.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === reset.toDateString();
  if (sameDay) return time;
  const date = reset.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}

function subscriptionLabel(subscriptionType?: string): string {
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
      (err, stdout) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            // `security` not on PATH — not macOS-like; let the file path try.
            reject(new UsageCredentialError("`security` command not found on PATH.", true));
            return;
          }
          reject(new UsageCredentialError(
            "no Claude Code credentials in the macOS Keychain. Log in with Claude Code first.",
            true,
          ));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as ClaudeCredentials);
        } catch {
          reject(new UsageCredentialError("Keychain credentials were not valid JSON.", false));
        }
      },
    );
  });
}

async function readFileCredentials(): Promise<ClaudeCredentials> {
  let raw: string;
  try {
    raw = await readFile(CREDENTIALS_FILE, "utf-8");
  } catch {
    throw new UsageCredentialError(
      "no Claude Code credentials found. Log in with Claude Code first.",
      false,
    );
  }
  try {
    return JSON.parse(raw) as ClaudeCredentials;
  } catch {
    throw new UsageCredentialError("Claude Code credentials file was not valid JSON.", false);
  }
}

/** Credential-loading failure carrying a chat-friendly message. */
class UsageCredentialError extends Error {
  constructor(message: string, readonly tryFile: boolean) {
    super(message);
    this.name = "UsageCredentialError";
  }
}

function usageError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Claude usage unavailable: ${detail}`;
}
