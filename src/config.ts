import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
export const TOMO_HOME = join(HOME, ".tomo");
export const CONFIG_PATH = join(TOMO_HOME, "config.json");

export interface IdentityConfig {
  name: string;
  channels: Record<string, string>;  // channelName → chatId
  replyPolicy: string;               // "last-active" | channelName
}

interface TomoConfig {
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
}

function loadConfigFile(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function buildConfig(): TomoConfig {
  const file = loadConfigFile();
  const channels = (file.channels ?? {}) as Record<string, Record<string, string>>;

  const telegramToken =
    process.env.TELEGRAM_BOT_TOKEN ??
    channels.telegram?.token ??
    "";

  const imessageUrl =
    process.env.IMESSAGE_URL ??
    channels.imessage?.url ??
    "";

  const imessagePassword =
    process.env.IMESSAGE_PASSWORD ??
    channels.imessage?.password ??
    "";

  const imessageWebhookPort = Number(
    process.env.IMESSAGE_WEBHOOK_PORT ??
    channels.imessage?.webhookPort ??
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

  return {
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
  };
}

export const config = buildConfig();
