import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { type ExternalMcpServerConfig, parseExternalMcpServers } from "./mcp/external-config.js";
import { inferLiteLlmMode, type LiteLlmMode } from "./litellm.js";

const HOME = homedir();
export const TOMO_HOME = join(HOME, ".tomo");
export const CONFIG_PATH = join(TOMO_HOME, "config.json");
export const CONFIG_BACKUP_PATH = join(TOMO_HOME, "config.json.bak");
export const RESTART_REASON_FILE = join(TOMO_HOME, "data", ".restart-reason");

export interface IdentityConfig {
  name: string;
  channels: Record<string, string>;  // channelName → chatId
  replyPolicy: string;               // "last-active" | channelName
}

export interface LcmConfig {
  /** Context-usage % at which the harness nudges the agent to run `tomo lcm daily`. */
  nudgeAtPct: number;
  /** Context-usage % below which the "already nudged" flag resets (hysteresis). */
  nudgeResetPct: number;
  /** Compaction strategy for group sessions. "lcm" runs the same hierarchical
   *  LCM nudges as DMs (default); "sdk" leaves SDK auto-compact on instead. */
  groupCompactStyle: "sdk" | "lcm";
  /** Number of most-recent raw user/assistant events kept outside today's daily
   *  rollup so mid-day compacts don't wipe warm short-term texture. Counts SDK
   *  events (one tool round = multiple events), not user-typed messages. */
  dailyFreshTail: number;
}

export interface LiteLlmConfig {
  /** Gateway mode. ChatGPT mode documents the subscription/OAuth LiteLLM setup; runtime env wiring is the same. */
  mode: LiteLlmMode;
  /** Base URL for a LiteLLM proxy exposing Anthropic-compatible endpoints. */
  baseUrl: string;
  /** Proxy API key sent as ANTHROPIC_API_KEY to the Claude Agent SDK child. */
  apiKey: string;
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
  /** Delay before processing inbound iMessage bursts, so split text/link/media fragments coalesce. */
  imessageInboundSettleMs: number;
  sessionModelOverrides: Record<string, string>;
  /** Per-channel allowlists. If set, only listed chatIds + identity-bound chatIds are allowed. */
  channelAllowlists: Record<string, string[]>;
  /** Per-channel "passive" group chatIds. Tomo sees every message in these
   *  groups (no @mention required) and decides via NO_REPLY whether to respond.
   *  iMessage groups are always passive regardless of this list. */
  passiveGroups: Record<string, string[]>;
  /** Secret phrase to activate tomo in a group chat. Null = group chat disabled. */
  groupSecret: string | null;
  /** If true, inbound image attachments are also persisted to workspace/memory/incoming-images/. Default true. */
  saveInboundImages: boolean;
  /** Max agent turns per single user message (one turn ≈ one tool-use round). Default 50. */
  maxTurns: number;
  /** Optional LiteLLM gateway. Keeps Claude Agent SDK as the runtime while routing model calls through LiteLLM. */
  litellm: LiteLlmConfig | null;
  /** External MCP servers from ~/.tomo/config.json. */
  mcpServers: Record<string, ExternalMcpServerConfig>;
  /** MCP tool allowlist entries for external servers. Defaults to mcp__<server>__* for each server. */
  mcpAllowedTools: string[];
  lcm: LcmConfig;
}

function parseLiteLlmConfig(raw: unknown, defaultModel: string): LiteLlmConfig | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const baseUrl = String(process.env.TOMO_LITELLM_BASE_URL ?? r.baseUrl ?? "").trim();
  if (!baseUrl) return null;

  return {
    mode: inferLiteLlmMode(process.env.TOMO_LITELLM_MODE ?? r.mode, defaultModel),
    baseUrl,
    apiKey: String(process.env.TOMO_LITELLM_API_KEY ?? r.apiKey ?? "").trim(),
  };
}

function parseLcmConfig(raw: unknown): LcmConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const nudgeAt = Number(r.nudgeAtPct ?? 70);
  const nudgeReset = Number(r.nudgeResetPct ?? 60);
  const style = r.groupCompactStyle === "sdk" ? "sdk" : "lcm";
  const tail = Number(r.dailyFreshTail ?? 32);

  // Fall back to defaults on nonsense input (out of [1,100], or LOW >= HIGH).
  const validHigh = Number.isFinite(nudgeAt) && nudgeAt > 0 && nudgeAt <= 100;
  const validLow = Number.isFinite(nudgeReset) && nudgeReset >= 0 && nudgeReset < nudgeAt;
  const validTail = Number.isInteger(tail) && tail >= 0;
  return {
    nudgeAtPct: validHigh ? nudgeAt : 70,
    nudgeResetPct: validHigh && validLow ? nudgeReset : (validHigh ? Math.max(0, nudgeAt - 10) : 60),
    groupCompactStyle: style,
    dailyFreshTail: validTail ? tail : 32,
  };
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

function parsePassiveGroups(channels: Record<string, Record<string, unknown>>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, ch] of Object.entries(channels)) {
    if (Array.isArray(ch.passiveGroups)) {
      result[name] = ch.passiveGroups.map(String);
    }
  }
  return result;
}

function buildConfig(): TomoConfig {
  const file = loadConfigFile();
  const channels = (file.channels ?? {}) as Record<string, Record<string, unknown>>;
  const mcp = (file.mcp ?? {}) as Record<string, unknown>;
  const mcpServers = parseExternalMcpServers(file.mcpServers ?? mcp.servers);
  const rawMcpAllowedTools = file.mcpAllowedTools ?? mcp.allowedTools;
  const mcpAllowedTools = Array.isArray(rawMcpAllowedTools)
    ? rawMcpAllowedTools.map(String)
    : Object.keys(mcpServers).map((serverName) => `mcp__${serverName}__*`);

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
  const imessageInboundSettleMs = Number(
    process.env.IMESSAGE_INBOUND_SETTLE_MS ??
    (channels.imessage?.inboundSettleMs as string | number | undefined) ??
    "750",
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

  const model = (process.env.CLAUDE_MODEL ?? file.model ?? "claude-sonnet-4-6[1m]") as string;

  return {
    telegramToken,
    model,
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
    imessageInboundSettleMs: Number.isFinite(imessageInboundSettleMs) && imessageInboundSettleMs >= 0
      ? Math.floor(imessageInboundSettleMs)
      : 750,
    sessionModelOverrides: (file.sessionModelOverrides ?? {}) as Record<string, string>,
    channelAllowlists: parseAllowlists(channels),
    passiveGroups: parsePassiveGroups(channels),
    groupSecret: (file.groupSecret as string) ?? null,
    saveInboundImages: file.saveInboundImages !== false,
    maxTurns: Number(process.env.TOMO_MAX_TURNS ?? file.maxTurns ?? "50"),
    litellm: parseLiteLlmConfig(file.litellm, model),
    mcpServers,
    mcpAllowedTools,
    lcm: parseLcmConfig(file.lcm),
  };
}

export const config = buildConfig();
