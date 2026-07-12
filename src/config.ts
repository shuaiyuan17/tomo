import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
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
const DEFAULT_LIVE_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

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

export interface MetricsConfig {
  /** Serve Prometheus metrics + write the activity log. Default false. */
  enabled: boolean;
  /** Port for http://127.0.0.1:<port>/metrics (loopback-only by design). */
  port: number;
  /** Also write ~/.tomo/logs/activity.ndjson for log shippers (Loki). */
  activityLog: boolean;
  /** Include transcript message text in the activity log. Disable if the log
   *  is shipped off this machine. */
  includeMessageText: boolean;
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
  /** iMessage backend: BlueBubbles server (default) or the imsg CLI. */
  imessageProvider: "bluebubbles" | "imsg";
  imessageUrl: string;
  imessagePassword: string;
  imessageWebhookPort: number;
  /** Path to the imsg binary (provider "imsg"). Defaults to "imsg" on PATH. */
  imsgCliPath: string;
  /** Optional chat.db path forwarded to `imsg rpc --db` (provider "imsg"). */
  imsgDbPath: string | null;
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
  /** Inactivity timeout for one LiveSession send()/steer() turn. Default 10 minutes. */
  liveSessionTimeoutMs: number;
  /** Optional LiteLLM gateway. Keeps Claude Agent SDK as the runtime while routing model calls through LiteLLM. */
  litellm: LiteLlmConfig | null;
  /** External MCP servers from ~/.tomo/config.json. */
  mcpServers: Record<string, ExternalMcpServerConfig>;
  /** MCP tool allowlist entries for external servers. Defaults to mcp__<server>__* for each server. */
  mcpAllowedTools: string[];
  lcm: LcmConfig;
  metrics: MetricsConfig;
}

// ---------------------------------------------------------------------------
// Validation plumbing
//
// Every config value is checked by a zod schema. Invalid values still fall
// back to their defaults — CLI repair commands (`tomo init`, `tomo config`)
// must keep working on a broken file — but each fallback is recorded in
// `configIssues` and `assertConfigValid()` (called at daemon startup, next to
// assertAuthConfigured) refuses to start with the full list. Nothing falls
// back silently anymore.
// ---------------------------------------------------------------------------

const issues: string[] = [];

/** Validation problems found while building `config`. Empty for a valid setup. */
export const configIssues: readonly string[] = issues;

interface Validator<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: z.ZodError };
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Validate one value. Absent (undefined/null) → default, no issue. Invalid →
 *  default, with a descriptive entry in `configIssues`. */
function validated<T>(label: string, schema: Validator<T>, raw: unknown, fallback: T): T {
  if (raw === undefined || raw === null) return fallback;
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
  const fallbackNote = typeof fallback === "object" && fallback !== null
    ? "using defaults"
    : `using ${describeValue(fallback)}`;
  issues.push(`${label}: ${detail} (got ${describeValue(raw)}; ${fallbackNote})`);
  return fallback;
}

/** Env var for a numeric/boolean setting; empty string counts as unset. */
function envVar(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

// Coercing schemas: config.json values arrive typed, env overrides arrive as
// strings — z.coerce keeps the Number()-compatible semantics of the old
// hand-rolled parsers.
const positiveInt = z.coerce.number().positive("expected a positive number").transform(Math.floor);
const nonNegativeInt = z.coerce.number().min(0, "expected a non-negative number").transform(Math.floor);
const positiveNumber = z.coerce.number().positive("expected a positive number");
const boolLike = z.unknown().transform((value, ctx) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  ctx.addIssue({ code: "custom", message: "expected a boolean (true/false, or yes/no/on/off/1/0)" });
  return z.NEVER;
});
/** Chat ids may be written as JSON numbers (Telegram); normalize to strings. */
const chatId = z.union([z.string(), z.number()]).transform(String);

const channelEntrySchema = z.looseObject({
  token: z.string().optional(),
  url: z.string().optional(),
  password: z.string().optional(),
  provider: z.enum(["bluebubbles", "imsg"]).optional(),
  cliPath: z.string().optional(),
  dbPath: z.string().optional(),
  webhookPort: positiveInt.optional(),
  inboundSettleMs: nonNegativeInt.optional(),
  inboundMaxSettleMs: nonNegativeInt.optional(),
  typingStartDelayMs: nonNegativeInt.optional(),
  passiveTypingStartDelayMs: nonNegativeInt.optional(),
  allowlist: z.array(chatId).optional(),
  passiveGroups: z.array(chatId).optional(),
});
type ChannelEntry = z.output<typeof channelEntrySchema>;

const identitySchema = z.object({
  name: z.string().min(1, "expected a non-empty name"),
  channels: z.record(z.string(), chatId),
  replyPolicy: z.string().default("last-active"),
});

const DEFAULT_LCM: LcmConfig = {
  nudgeAtPct: 70,
  nudgeResetPct: 60,
  groupCompactStyle: "lcm",
  dailyFreshTail: 32,
  globalFreshTail: false,
};

const lcmSchema = z.object({
  nudgeAtPct: z.coerce.number().positive().max(100, "expected a percentage in (0, 100]").default(DEFAULT_LCM.nudgeAtPct),
  nudgeResetPct: z.coerce.number().min(0).optional(),
  groupCompactStyle: z.enum(["sdk", "lcm"]).default(DEFAULT_LCM.groupCompactStyle),
  dailyFreshTail: z.coerce.number().int().min(0, "expected a non-negative integer").default(DEFAULT_LCM.dailyFreshTail),
  globalFreshTail: boolLike.default(DEFAULT_LCM.globalFreshTail),
}).transform((lcm, ctx) => {
  // An omitted reset derives from the (possibly custom) nudge threshold: the
  // stock 60 when that sits below it, else 10 points under the threshold.
  // Only an EXPLICIT reset can conflict, and that is a real error.
  const nudgeResetPct = lcm.nudgeResetPct
    ?? (DEFAULT_LCM.nudgeResetPct < lcm.nudgeAtPct ? DEFAULT_LCM.nudgeResetPct : Math.max(0, lcm.nudgeAtPct - 10));
  if (nudgeResetPct >= lcm.nudgeAtPct) {
    ctx.addIssue({ code: "custom", path: ["nudgeResetPct"], message: "nudgeResetPct must be below nudgeAtPct" });
    return z.NEVER;
  }
  return { ...lcm, nudgeResetPct };
});

const DEFAULT_METRICS: MetricsConfig = {
  enabled: false,
  port: 9464,
  activityLog: true,
  includeMessageText: true,
};

const metricsSchema = z.object({
  enabled: boolLike.default(DEFAULT_METRICS.enabled),
  port: positiveInt.default(DEFAULT_METRICS.port),
  activityLog: boolLike.default(DEFAULT_METRICS.activityLog),
  includeMessageText: boolLike.default(DEFAULT_METRICS.includeMessageText),
});

function parseMetricsConfig(raw: unknown): MetricsConfig {
  const entry = validated("metrics", metricsSchema, raw, DEFAULT_METRICS);
  return {
    ...entry,
    enabled: validated(
      "metrics.enabled (TOMO_METRICS)",
      boolLike,
      envVar("TOMO_METRICS") ?? entry.enabled,
      DEFAULT_METRICS.enabled,
    ),
    port: validated(
      "metrics.port (TOMO_METRICS_PORT)",
      positiveInt,
      envVar("TOMO_METRICS_PORT") ?? entry.port,
      DEFAULT_METRICS.port,
    ),
  };
}

const continuityScriptEntrySchema = z.union([
  z.string().transform((path) => ({ path }) as { path?: string; timeoutMs?: unknown; maxOutputChars?: unknown }),
  z.looseObject({ path: z.string().optional(), timeoutMs: z.unknown().optional(), maxOutputChars: z.unknown().optional() }),
]);

const litellmEntrySchema = z.looseObject({
  mode: z.unknown().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});

function parseLiteLlmConfig(raw: unknown, defaultModel: string): LiteLlmConfig | null {
  const entry = validated("litellm", litellmEntrySchema, raw, {});
  const baseUrl = String(process.env.TOMO_LITELLM_BASE_URL ?? entry.baseUrl ?? "").trim();
  if (!baseUrl) return null;

  return {
    mode: inferLiteLlmMode(process.env.TOMO_LITELLM_MODE ?? entry.mode, defaultModel),
    baseUrl,
    apiKey: String(process.env.TOMO_LITELLM_API_KEY ?? entry.apiKey ?? "").trim(),
  };
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
  const entry = validated("continuityScript", continuityScriptEntrySchema, raw, {});
  const rawPath = String(process.env.TOMO_CONTINUITY_SCRIPT ?? entry.path ?? "").trim();

  if (!rawPath) return null;

  return {
    path: expandConfigPath(rawPath),
    timeoutMs: validated(
      "continuityScript.timeoutMs (TOMO_CONTINUITY_SCRIPT_TIMEOUT_MS)",
      positiveInt,
      envVar("TOMO_CONTINUITY_SCRIPT_TIMEOUT_MS") ?? entry.timeoutMs,
      DEFAULT_CONTINUITY_SCRIPT_TIMEOUT_MS,
    ),
    maxOutputChars: validated(
      "continuityScript.maxOutputChars (TOMO_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS)",
      positiveInt,
      envVar("TOMO_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS") ?? entry.maxOutputChars,
      DEFAULT_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS,
    ),
  };
}

function loadConfigFile(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    issues.push(`${CONFIG_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)} (ignoring the file)`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    issues.push(`${CONFIG_PATH} must contain a JSON object (got ${Array.isArray(parsed) ? "an array" : typeof parsed}; ignoring the file)`);
    return {};
  }
  return parsed as Record<string, unknown>;
}

function parseChannels(raw: unknown): Record<string, ChannelEntry> {
  const record = validated("channels", z.record(z.string(), z.unknown()), raw, {});
  const result: Record<string, ChannelEntry> = {};
  for (const [name, entry] of Object.entries(record)) {
    result[name] = validated(`channels.${name}`, channelEntrySchema, entry, {});
  }
  return result;
}

function parseIdentities(raw: unknown): IdentityConfig[] {
  const entries = validated("identities", z.array(z.unknown()), raw, []);
  const identities: IdentityConfig[] = [];
  for (const [index, entry] of entries.entries()) {
    const parsed = identitySchema.safeParse(entry);
    if (parsed.success) {
      identities.push(parsed.data);
    } else {
      const detail = parsed.error.issues
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; ");
      issues.push(`identities[${index}]: ${detail} (got ${describeValue(entry)}; dropping the entry)`);
    }
  }
  return identities;
}

function buildConfig(): TomoConfig {
  const file = loadConfigFile();
  const paths = defaultRuntimePaths;
  const channels = parseChannels(file.channels);
  const mcp = (file.mcp ?? {}) as Record<string, unknown>;
  const mcpServers = parseExternalMcpServers(file.mcpServers ?? mcp.servers);
  const mcpAllowedTools = validated(
    "mcpAllowedTools",
    z.array(z.string()),
    file.mcpAllowedTools ?? mcp.allowedTools,
    Object.keys(mcpServers).map((serverName) => `mcp__${serverName}__*`),
  );

  const model = validated(
    "model (CLAUDE_MODEL)",
    z.string().min(1, "expected a non-empty model name"),
    process.env.CLAUDE_MODEL ?? file.model,
    DEFAULT_MODEL,
  );

  const continuityIntervalMinutes = validated(
    "continuityIntervalMinutes (TOMO_CONTINUITY_INTERVAL_MINUTES)",
    positiveNumber,
    envVar("TOMO_CONTINUITY_INTERVAL_MINUTES") ?? file.continuityIntervalMinutes,
    DEFAULT_CONTINUITY_INTERVAL_MINUTES,
  );

  return {
    auth: parseAnthropicAuthConfig(file.auth),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? channels.telegram?.token ?? "",
    model,
    workspaceDir: paths.workspaceDir,
    sessionsDir: paths.sessionsDir,
    sdkSessionsDir: paths.sdkSessionsDir,
    historyLimit: validated("HISTORY_LIMIT", positiveInt, envVar("HISTORY_LIMIT"), 20),
    logsDir: paths.logsDir,
    tomoHome: paths.tomoHome,
    continuity: validated("continuity (TOMO_CONTINUITY)", boolLike, envVar("TOMO_CONTINUITY") ?? file.continuity, false),
    continuityIntervalMs: Math.round(Math.max(continuityIntervalMinutes, MIN_CONTINUITY_INTERVAL_MINUTES) * 60_000),
    continuityScript: parseContinuityScriptConfig(file.continuityScript),
    city: validated("city (TOMO_CITY)", z.string().nullable(), process.env.TOMO_CITY ?? file.city, null),
    identities: parseIdentities(file.identities),
    imessageProvider: validated(
      "channels.imessage.provider (IMESSAGE_PROVIDER)",
      z.enum(["bluebubbles", "imsg"]),
      envVar("IMESSAGE_PROVIDER") ?? channels.imessage?.provider,
      "bluebubbles",
    ),
    imessageUrl: process.env.IMESSAGE_URL ?? channels.imessage?.url ?? "",
    imessagePassword: process.env.IMESSAGE_PASSWORD ?? channels.imessage?.password ?? "",
    imsgCliPath: validated(
      "channels.imessage.cliPath (IMSG_CLI_PATH)",
      z.string().min(1, "expected a non-empty path"),
      envVar("IMSG_CLI_PATH") ?? channels.imessage?.cliPath,
      "imsg",
    ),
    imsgDbPath: validated(
      "channels.imessage.dbPath (IMSG_DB_PATH)",
      z.string().min(1, "expected a non-empty path").nullable(),
      envVar("IMSG_DB_PATH") ?? channels.imessage?.dbPath,
      null,
    ),
    imessageWebhookPort: validated(
      "channels.imessage.webhookPort (IMESSAGE_WEBHOOK_PORT)",
      positiveInt,
      envVar("IMESSAGE_WEBHOOK_PORT") ?? channels.imessage?.webhookPort,
      3100,
    ),
    imessageInboundSettleMs: validated(
      "channels.imessage.inboundSettleMs (IMESSAGE_INBOUND_SETTLE_MS)",
      nonNegativeInt,
      envVar("IMESSAGE_INBOUND_SETTLE_MS") ?? channels.imessage?.inboundSettleMs,
      DEFAULT_IMESSAGE_INBOUND_SETTLE_MS,
    ),
    imessageInboundMaxSettleMs: validated(
      "channels.imessage.inboundMaxSettleMs (IMESSAGE_INBOUND_MAX_SETTLE_MS)",
      nonNegativeInt,
      envVar("IMESSAGE_INBOUND_MAX_SETTLE_MS") ?? channels.imessage?.inboundMaxSettleMs,
      DEFAULT_IMESSAGE_INBOUND_MAX_SETTLE_MS,
    ),
    imessageTypingStartDelayMs: validated(
      "channels.imessage.typingStartDelayMs (IMESSAGE_TYPING_START_DELAY_MS)",
      nonNegativeInt,
      envVar("IMESSAGE_TYPING_START_DELAY_MS") ?? channels.imessage?.typingStartDelayMs,
      DEFAULT_IMESSAGE_TYPING_START_DELAY_MS,
    ),
    imessagePassiveTypingStartDelayMs: validated(
      "channels.imessage.passiveTypingStartDelayMs (IMESSAGE_PASSIVE_TYPING_START_DELAY_MS)",
      nonNegativeInt,
      envVar("IMESSAGE_PASSIVE_TYPING_START_DELAY_MS") ?? channels.imessage?.passiveTypingStartDelayMs,
      DEFAULT_IMESSAGE_PASSIVE_TYPING_START_DELAY_MS,
    ),
    sessionModelOverrides: validated("sessionModelOverrides", z.record(z.string(), z.string()), file.sessionModelOverrides, {}),
    channelAllowlists: Object.fromEntries(
      Object.entries(channels).flatMap(([name, ch]) => (ch.allowlist ? [[name, ch.allowlist]] : [])),
    ),
    passiveGroups: Object.fromEntries(
      Object.entries(channels).flatMap(([name, ch]) => (ch.passiveGroups ? [[name, ch.passiveGroups]] : [])),
    ),
    groupSecret: validated("groupSecret", z.string().min(1, "expected a non-empty string"), file.groupSecret, null),
    summonExpiryMinutes: validated(
      "summonExpiryMinutes (TOMO_SUMMON_EXPIRY_MINUTES)",
      nonNegativeInt,
      envVar("TOMO_SUMMON_EXPIRY_MINUTES") ?? file.summonExpiryMinutes,
      60,
    ),
    saveInboundImages: validated("saveInboundImages", boolLike, file.saveInboundImages, true),
    maxTurns: validated("maxTurns (TOMO_MAX_TURNS)", positiveInt, envVar("TOMO_MAX_TURNS") ?? file.maxTurns, 50),
    steering: validated("steering (TOMO_STEERING)", boolLike, envVar("TOMO_STEERING") ?? file.steering, true),
    liveSessionTimeoutMs: validated(
      "liveSessionTimeoutMs (TOMO_LIVE_SESSION_TIMEOUT_MS)",
      positiveInt,
      envVar("TOMO_LIVE_SESSION_TIMEOUT_MS") ?? file.liveSessionTimeoutMs,
      DEFAULT_LIVE_SESSION_TIMEOUT_MS,
    ),
    litellm: parseLiteLlmConfig(file.litellm, model),
    mcpServers,
    mcpAllowedTools,
    lcm: validated("lcm", lcmSchema, file.lcm, DEFAULT_LCM),
    metrics: parseMetricsConfig(file.metrics),
  };
}

export const config = buildConfig();

/** Validate Anthropic auth at daemon startup without blocking config repair commands. */
export function assertAuthConfigured(cfg: Pick<TomoConfig, "auth"> = config): void {
  if (cfg.auth.error) throw new Error(cfg.auth.error);
}

/**
 * Refuse daemon startup while the config has validation problems. Called at
 * startup — NOT during config build, so `tomo init`, `tomo config`, and other
 * repair commands still work against a broken file (they see the defaults
 * plus `configIssues`).
 */
export function assertConfigValid(issueList: readonly string[] = configIssues): void {
  if (issueList.length === 0) return;
  throw new Error([
    `Invalid Tomo configuration (${CONFIG_PATH} / environment):`,
    ...issueList.map((issue) => `  - ${issue}`),
    "Fix the value(s), or remove them to use the defaults.",
  ].join("\n"));
}

/**
 * Validate that at least one channel is configured. Called at daemon startup —
 * NOT during config build, so that `tomo init`, `tomo --help`, and other CLI
 * commands work on a fresh install with no config at all.
 */
export function assertChannelsConfigured(cfg: TomoConfig = config): void {
  if (!cfg.telegramToken && !imessageConfigured(cfg)) {
    throw new Error(
      "No channels configured. Run 'tomo init' or set TELEGRAM_BOT_TOKEN / IMESSAGE_URL.",
    );
  }
}

/**
 * Whether an iMessage backend is configured: BlueBubbles needs a server URL,
 * while the imsg provider only needs to be selected (the CLI path defaults to
 * "imsg" on PATH).
 */
export function imessageConfigured(cfg: Pick<TomoConfig, "imessageProvider" | "imessageUrl"> = config): boolean {
  if (cfg.imessageProvider === "imsg") return true;
  return Boolean(cfg.imessageUrl);
}
