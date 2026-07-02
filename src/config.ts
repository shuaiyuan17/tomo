import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type ExternalMcpServerConfig, parseExternalMcpServers } from "./mcp/external-config.js";
import { inferLiteLlmMode, type LiteLlmMode } from "./litellm.js";
import {
  DEFAULT_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS,
  DEFAULT_CONTINUITY_SCRIPT_TIMEOUT_MS,
  type ContinuityScriptConfig,
} from "./continuity-script.js";
import { DEFAULT_CONTINUITY_INTERVAL_MINUTES, MIN_CONTINUITY_INTERVAL_MINUTES } from "./continuity-defaults.js";
import { parseAnthropicAuthConfig, type AnthropicAuthConfig } from "./auth.js";
import { defaultRuntimePaths } from "./runtime-paths.js";
import { DEFAULT_MODEL } from "./models.js";

const HOME = defaultRuntimePaths.homeDir;
export const TOMO_HOME = defaultRuntimePaths.tomoHome;
export const CONFIG_PATH = defaultRuntimePaths.configPath;
export const CONFIG_BACKUP_PATH = defaultRuntimePaths.configBackupPath;
export const RESTART_REASON_FILE = defaultRuntimePaths.restartReasonFile;
const DEFAULT_IMESSAGE_INBOUND_SETTLE_MS = 1500;
const DEFAULT_IMESSAGE_INBOUND_MAX_SETTLE_MS = 5000;
const DEFAULT_IMESSAGE_TYPING_START_DELAY_MS = 1200;
const DEFAULT_IMESSAGE_PASSIVE_TYPING_START_DELAY_MS = 4000;

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
  /** When true, the fresh tail is kept GLOBALLY (newest N conversational turns
   *  across all days) instead of only for today's rollup — so a new day doesn't
   *  cold-start with summaries only. N reuses `dailyFreshTail`. Default false
   *  (preserves the today-only behavior). */
  globalFreshTail: boolean;
}

export interface LiteLlmConfig {
  /** Gateway mode. ChatGPT mode documents the subscription/OAuth LiteLLM setup; runtime env wiring is the same. */
  mode: LiteLlmMode;
  /** Base URL for a LiteLLM proxy exposing Anthropic-compatible endpoints. */
  baseUrl: string;
  /** Proxy API key sent as ANTHROPIC_API_KEY to the Claude Agent SDK child. */
  apiKey: string;
}

export interface TomoConfig {
  /** Anthropic authentication used for direct Claude model sessions. */
  auth: AnthropicAuthConfig;
  telegramToken: string;
  model: string;
  workspaceDir: string;
  sessionsDir: string;
  /** Claude Agent SDK JSONL directory derived from workspaceDir. */
  sdkSessionsDir: string;
  historyLimit: number;
  logsDir: string;
  tomoHome: string;
  continuity: boolean;
  /** Minutes between scheduled continuity heartbeats. Default 55. */
  continuityIntervalMs: number;
  /** Optional local script to run once per continuity heartbeat and append to the heartbeat prompt. */
  continuityScript: ContinuityScriptConfig | null;
  city: string | null;
  identities: IdentityConfig[];
  imessageUrl: string;
  imessagePassword: string;
  imessageWebhookPort: number;
  /** Delay before processing inbound iMessage bursts, so split text/link/media fragments coalesce. */
  imessageInboundSettleMs: number;
  /** Maximum total delay for one continuously extended iMessage inbound burst. */
  imessageInboundMaxSettleMs: number;
  /** Delay before showing iMessage typing for ordinary turns. */
  imessageTypingStartDelayMs: number;
  /** Longer delay before showing iMessage typing in passive group turns. */
  imessagePassiveTypingStartDelayMs: number;
  sessionModelOverrides: Record<string, string>;
  /** Per-channel allowlists. If set, only listed chatIds + identity-bound chatIds are allowed. */
  channelAllowlists: Record<string, string[]>;
  /** Per-channel "passive" group chatIds. Tomo sees every message in these
   *  groups (no @mention required) and decides via NO_REPLY whether to respond.
   *  iMessage groups are always passive regardless of this list. */
  passiveGroups: Record<string, string[]>;
  /** Secret phrase to activate tomo in a group chat. Null = group chat disabled. */
  groupSecret: string | null;
  /** Minutes of group inactivity after which a /summon lapses and the group is
   *  handed back to its own session. 0 disables expiry. Default 60. */
  summonExpiryMinutes: number;
  /** If true, inbound image attachments are also persisted to workspace/memory/incoming-images/. Default true. */
  saveInboundImages: boolean;
  /** Max agent turns per single user message (one turn ≈ one tool-use round). Default 50. */
  maxTurns: number;
  /** Steer messages that arrive while a turn is in flight into that turn at the
   *  next tool-call boundary, instead of queueing them behind it. Default true. */
  steering: boolean;
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

function parseNonNegativeMs(raw: unknown, fallback: number): number {
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : fallback;
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
    globalFreshTail: r.globalFreshTail === true,
  };
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parsePositiveMinutesAsMs(raw: unknown, fallbackMinutes: number): number {
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallbackMinutes * 60_000;
  const ms = Math.round(Math.max(minutes, MIN_CONTINUITY_INTERVAL_MINUTES) * 60_000);
  return ms > 0 ? ms : fallbackMinutes * 60_000;
}

function parseBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function expandConfigPath(rawPath: string): string {
  const withEnv = rawPath.replace(/\$(\w+)|\$\{([^}]+)\}/g, (_match, bare: string | undefined, braced: string | undefined) => {
    const name = bare ?? braced ?? "";
    return process.env[name] ?? "";
  });
  const withHome = withEnv === "~"
    ? HOME
    : (withEnv.startsWith("~/") ? join(HOME, withEnv.slice(2)) : withEnv);
  return isAbsolute(withHome) ? withHome : join(TOMO_HOME, withHome);
}

function parseContinuityScriptConfig(raw: unknown): ContinuityScriptConfig | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawPath = String(
    process.env.TOMO_CONTINUITY_SCRIPT
    ?? (typeof raw === "string" ? raw : r.path)
    ?? "",
  ).trim();

  if (!rawPath) return null;

  return {
    path: expandConfigPath(rawPath),
    timeoutMs: parsePositiveInt(
      process.env.TOMO_CONTINUITY_SCRIPT_TIMEOUT_MS ?? r.timeoutMs,
      DEFAULT_CONTINUITY_SCRIPT_TIMEOUT_MS,
    ),
    maxOutputChars: parsePositiveInt(
      process.env.TOMO_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS ?? r.maxOutputChars,
      DEFAULT_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS,
    ),
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
  const paths = defaultRuntimePaths;
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

  const imessageWebhookPort = parsePositiveInt(
    process.env.IMESSAGE_WEBHOOK_PORT ??
    (channels.imessage?.webhookPort as string | undefined),
    3100,
  );
  const imessageInboundSettleMs = parseNonNegativeMs(
    process.env.IMESSAGE_INBOUND_SETTLE_MS ??
    (channels.imessage?.inboundSettleMs as string | number | undefined) ??
    DEFAULT_IMESSAGE_INBOUND_SETTLE_MS,
    DEFAULT_IMESSAGE_INBOUND_SETTLE_MS,
  );
  const imessageInboundMaxSettleMs = parseNonNegativeMs(
    process.env.IMESSAGE_INBOUND_MAX_SETTLE_MS ??
    (channels.imessage?.inboundMaxSettleMs as string | number | undefined) ??
    DEFAULT_IMESSAGE_INBOUND_MAX_SETTLE_MS,
    DEFAULT_IMESSAGE_INBOUND_MAX_SETTLE_MS,
  );
  const imessageTypingStartDelayMs = parseNonNegativeMs(
    process.env.IMESSAGE_TYPING_START_DELAY_MS ??
    (channels.imessage?.typingStartDelayMs as string | number | undefined) ??
    DEFAULT_IMESSAGE_TYPING_START_DELAY_MS,
    DEFAULT_IMESSAGE_TYPING_START_DELAY_MS,
  );
  const imessagePassiveTypingStartDelayMs = parseNonNegativeMs(
    process.env.IMESSAGE_PASSIVE_TYPING_START_DELAY_MS ??
    (channels.imessage?.passiveTypingStartDelayMs as string | number | undefined) ??
    DEFAULT_IMESSAGE_PASSIVE_TYPING_START_DELAY_MS,
    DEFAULT_IMESSAGE_PASSIVE_TYPING_START_DELAY_MS,
  );

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

  const model = (process.env.CLAUDE_MODEL ?? file.model ?? DEFAULT_MODEL) as string;

  return {
    auth: parseAnthropicAuthConfig(file.auth),
    telegramToken,
    model,
    workspaceDir: paths.workspaceDir,
    sessionsDir: paths.sessionsDir,
    sdkSessionsDir: paths.sdkSessionsDir,
    historyLimit: parsePositiveInt(process.env.HISTORY_LIMIT, 20),
    logsDir: paths.logsDir,
    tomoHome: paths.tomoHome,
    continuity: (process.env.TOMO_CONTINUITY ?? file.continuity ?? false) === true || process.env.TOMO_CONTINUITY === "true",
    continuityIntervalMs: parsePositiveMinutesAsMs(
      process.env.TOMO_CONTINUITY_INTERVAL_MINUTES ?? file.continuityIntervalMinutes,
      DEFAULT_CONTINUITY_INTERVAL_MINUTES,
    ),
    continuityScript: parseContinuityScriptConfig(file.continuityScript),
    city: (process.env.TOMO_CITY ?? file.city ?? null) as string | null,
    identities,
    imessageUrl,
    imessagePassword,
    imessageWebhookPort,
    imessageInboundSettleMs,
    imessageInboundMaxSettleMs,
    imessageTypingStartDelayMs,
    imessagePassiveTypingStartDelayMs,
    sessionModelOverrides: (file.sessionModelOverrides ?? {}) as Record<string, string>,
    channelAllowlists: parseAllowlists(channels),
    passiveGroups: parsePassiveGroups(channels),
    groupSecret: (file.groupSecret as string) ?? null,
    summonExpiryMinutes: parseNonNegativeMs(process.env.TOMO_SUMMON_EXPIRY_MINUTES ?? file.summonExpiryMinutes ?? 60, 60),
    saveInboundImages: file.saveInboundImages !== false,
    maxTurns: parsePositiveInt(process.env.TOMO_MAX_TURNS ?? file.maxTurns, 50),
    steering: parseBoolean(process.env.TOMO_STEERING, parseBoolean(file.steering, true)),
    litellm: parseLiteLlmConfig(file.litellm, model),
    mcpServers,
    mcpAllowedTools,
    lcm: parseLcmConfig(file.lcm),
  };
}

export const config = buildConfig();

/** Validate Anthropic auth at daemon startup without blocking config repair commands. */
export function assertAuthConfigured(cfg: Pick<TomoConfig, "auth"> = config): void {
  if (cfg.auth.error) throw new Error(cfg.auth.error);
}

/**
 * Validate that at least one channel is configured. Called at daemon startup —
 * NOT during config build, so that `tomo init`, `tomo --help`, and other CLI
 * commands work on a fresh install with no config at all.
 */
export function assertChannelsConfigured(cfg: TomoConfig = config): void {
  if (!cfg.telegramToken && !cfg.imessageUrl) {
    throw new Error(
      "No channels configured. Run 'tomo init' or set TELEGRAM_BOT_TOKEN / IMESSAGE_URL.",
    );
  }
}
