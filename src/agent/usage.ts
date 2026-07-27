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

interface UsageResponse {
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
}

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

  return formatUsageReport(data, now(), oauth?.subscriptionType);
}

/** Turn a parsed usage payload into the plain-text chat report. */
export function formatUsageReport(data: UsageResponse, now: number, subscriptionType?: string): string {
  const planLabel = subscriptionLabel(subscriptionType);
  const lines: string[] = [`📊 Claude usage${planLabel ? ` (${planLabel})` : ""}`, ""];

  lines.push(...windowLines("Session (5h): ", data.five_hour, now));
  lines.push(...windowLines("Weekly (7d):  ", data.seven_day, now));

  const opus = windowLines("  Opus (7d):  ", data.seven_day_opus, now, true);
  if (opus.length > 0) lines.push(...opus);
  const sonnet = windowLines("  Sonnet (7d):", data.seven_day_sonnet, now, true);
  if (sonnet.length > 0) lines.push(...sonnet);

  const extra = data.extra_usage;
  if (extra && extra.is_enabled) {
    const currency = extra.currency === "USD" || !extra.currency ? "$" : `${extra.currency} `;
    const used = typeof extra.used_credits === "number" ? extra.used_credits : 0;
    const limit = typeof extra.monthly_limit === "number" ? extra.monthly_limit : 0;
    lines.push("");
    lines.push(`Extra usage: ${currency}${used.toFixed(2)} / ${currency}${limit} this month`);
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
