import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const TOMO_HOME = join(HOME, ".tomo");
const CONFIG_PATH = join(TOMO_HOME, "config.json");

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

  if (!telegramToken) {
    throw new Error(
      "Telegram bot token not found. Run 'tomo init' or set TELEGRAM_BOT_TOKEN.",
    );
  }

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
  };
}

export const config = buildConfig();
