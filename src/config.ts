import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
export const TOMO_HOME = join(HOME, ".tomo");
export const CONFIG_PATH = join(TOMO_HOME, "config.json");
export const RESTART_REASON_FILE = join(TOMO_HOME, "data", ".restart-reason");

export interface IdentityConfig {
  name: string;
  channels: Record<string, string>;  // channelName → chatId
  replyPolicy: string;               // "last-active" | channelName
}

type AuthMode = "subscription" | "api-key";

interface TomoConfig {
  /** Authentication mode: "subscription" (default, uses Claude CLI login) or "api-key" */
  auth: AuthMode;
  /** Anthropic API key. Used when auth is "api-key". Sourced from config or ANTHROPIC_API_KEY env var. */
  apiKey: string | null;
  telegramToken: string;
  model: string;
  workspaceDir: string;
  sessionsDir: string;
  historyLimit: number;
  logsDir: string;
  tomoHome: string;
  continuity: boolean;
  city: string | null;
  identities: IdentityConfig[];
  imessageUrl: string;
  imessagePassword: string;
  imessageWebhookPort: number;
  sessionModelOverrides: Record<string, string>;
  /** Per-channel allowlists. If set, only listed chatIds + identity-bound chatIds are allowed. */
  channelAllowlists: Record<string, string[]>;
  /** Secret phrase to activate tomo in a group chat. Null = group chat disabled. */
  groupSecret: string | null;
  /** If true, inbound image attachments are also persisted to workspace/memory/incoming-images/. Default true. */
  saveInboundImages: boolean;
}

function loadConfigFile(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function parseAllowlists(channels: Record<string, Record<string, unknown>>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, ch] of Object.entries(channels)) {
    if (Array.isArray(ch.allowlist)) {
      result[name] = ch.allowlist.map(String);
    }
  }
  return result;
}

function buildConfig(): TomoConfig {
  const file = loadConfigFile();
  const channels = (file.channels ?? {}) as Record<string, Record<string, unknown>>;

  const telegramToken =
    process.env.TELEGRAM_BOT_TOKEN ??
    (channels.telegram?.token as string | undefined) ??
    "";

  const imessageUrl =
    process.env.IMESSAGE_URL ??
    (channels.imessage?.url as string | undefined) ??
    "";

  const imessagePassword =
    process.env.IMESSAGE_PASSWORD ??
    (channels.imessage?.password as string | undefined) ??
    "";

  const imessageWebhookPort = Number(
    process.env.IMESSAGE_WEBHOOK_PORT ??
    (channels.imessage?.webhookPort as string | undefined) ??
    "3100",
  );

  // At least one channel must be configured
  if (!telegramToken && !imessageUrl) {
    throw new Error(
      "No channels configured. Run 'tomo init' or set TELEGRAM_BOT_TOKEN / IMESSAGE_URL.",
    );
  }

  // Parse identities
  const rawIdentities = (file.identities ?? []) as Array<{
    name?: string;
    channels?: Record<string, string>;
    replyPolicy?: string;
  }>;
  const identities: IdentityConfig[] = rawIdentities
    .filter((id) => id.name && id.channels)
    .map((id) => ({
      name: id.name!,
      channels: id.channels!,
      replyPolicy: id.replyPolicy ?? "last-active",
    }));

  // Auth mode: env var ANTHROPIC_API_KEY implies "api-key" unless explicitly overridden
  const apiKey = process.env.ANTHROPIC_API_KEY ?? (file.apiKey as string | undefined) ?? null;
  const auth: AuthMode = (process.env.TOMO_AUTH ?? file.auth ?? (apiKey ? "api-key" : "subscription")) as AuthMode;

  if (auth === "api-key" && !apiKey) {
    throw new Error(
      'Auth mode is "api-key" but no API key found. Set ANTHROPIC_API_KEY env var or "apiKey" in config.json.',
    );
  }

  return {
    auth,
    apiKey,
    telegramToken,
    model: (process.env.CLAUDE_MODEL ?? file.model ?? "claude-sonnet-4-6") as string,
    workspaceDir: process.env.TOMO_WORKSPACE ?? join(TOMO_HOME, "workspace"),
    sessionsDir: process.env.SESSIONS_DIR ?? join(TOMO_HOME, "data", "sessions"),
    historyLimit: Number(process.env.HISTORY_LIMIT ?? "20"),
    logsDir: join(TOMO_HOME, "logs"),
    tomoHome: TOMO_HOME,
    continuity: (process.env.TOMO_CONTINUITY ?? file.continuity ?? false) === true || process.env.TOMO_CONTINUITY === "true",
    city: (process.env.TOMO_CITY ?? file.city ?? null) as string | null,
    identities,
    imessageUrl,
    imessagePassword,
    imessageWebhookPort,
    sessionModelOverrides: (file.sessionModelOverrides ?? {}) as Record<string, string>,
    channelAllowlists: parseAllowlists(channels),
    groupSecret: (file.groupSecret as string) ?? null,
    saveInboundImages: file.saveInboundImages !== false,
  };
}

export const config = buildConfig();
