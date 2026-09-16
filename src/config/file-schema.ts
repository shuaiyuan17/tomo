import { z } from "zod";
import { webConfigSchema } from "../web/config.js";
import { agentProfileSchema, boolLike, channelEntrySchema, continuityScriptEntrySchema, identitySchema,
  imessageProviderSchema, lcmSchema, litellmEntrySchema, mcpServersSchema, nonNegativeInt, pluginEntrySchema,
  positiveInt, positiveNumber } from "./schema.js";

export const fileConfigSchema = z.looseObject({
  model: z.string().min(1).nullish(),
  auth: z.looseObject({ method: z.enum(["subscription", "api-key"]).optional(), apiKey: z.string().nullish() }).nullish(),
  channels: z.record(z.string(), channelEntrySchema).nullish(),
  identities: z.array(identitySchema).nullish(),
  continuity: boolLike.nullish(), continuityIntervalMinutes: positiveNumber.nullish(),
  continuityScript: continuityScriptEntrySchema.pipe(z.looseObject({ path: z.string().optional(), timeoutMs: positiveInt.optional(), maxOutputChars: positiveInt.optional() })).nullish(), city: z.string().nullish(),
  sessionModelOverrides: z.record(z.string(), z.string()).nullish(), groupSecret: z.string().min(1).nullish(),
  summonExpiryMinutes: nonNegativeInt.nullish(), saveInboundImages: boolLike.nullish(), saveInboundFiles: boolLike.nullish(),
  maxTurns: positiveInt.nullish(), steering: boolLike.nullish(), showThinking: boolLike.nullish(), liveSessionTimeoutMs: positiveInt.nullish(),
  litellm: litellmEntrySchema.nullish(), mcpServers: mcpServersSchema.nullish(), mcpAllowedTools: z.array(z.string()).nullish(),
  mcp: z.looseObject({ servers: mcpServersSchema.optional(), allowedTools: z.array(z.string()).optional() }).nullish(),
  plugins: z.array(pluginEntrySchema).nullish(), agentProfiles: z.record(z.string(), agentProfileSchema).nullish(),
  groupShellAllowlist: z.array(z.string()).nullish(), lcm: lcmSchema.nullish(),
  metrics: z.looseObject({ enabled: boolLike.optional(), port: positiveInt.optional(), activityLog: boolLike.optional(), includeMessageText: boolLike.optional() }).nullish(),
  web: webConfigSchema.nullish(),
}).superRefine((cfg, ctx) => {
  const provider = cfg.channels?.imessage?.provider;
  if (provider !== undefined && !imessageProviderSchema.safeParse(provider).success)
    ctx.addIssue({ code: "custom", path: ["channels", "imessage", "provider"], message: "Unsupported provider" });
});

export interface ConfigField {
  path: string[]; label: string; kind: "text" | "number" | "boolean" | "json";
  secret?: boolean; options?: string[]; env?: string; runningKey?: string;
}
const field = (path: string, kind: ConfigField["kind"] = "text", extras: Partial<ConfigField> = {}): ConfigField =>
  ({ path: path.split("."), label: path, kind, ...extras });
/** UI annotations live beside the common file validator, never in React. */
export const configFields: ConfigField[] = [
  field("model", "text", { env: "CLAUDE_MODEL", runningKey: "model" }),
  field("auth.method", "text", { options: ["subscription", "api-key"] }),
  field("auth.apiKey", "text", { secret: true, env: "ANTHROPIC_API_KEY" }),
  field("channels.telegram.token", "text", { secret: true, env: "TELEGRAM_BOT_TOKEN", runningKey: "telegramToken" }),
  field("channels.telegram.allowlist", "json"), field("channels.telegram.passiveGroups", "json"),
  field("channels.imessage.provider", "text", { options: ["imsg"], env: "IMESSAGE_PROVIDER", runningKey: "imessageProvider" }),
  field("channels.imessage.cliPath", "text", { env: "IMSG_CLI_PATH", runningKey: "imsgCliPath" }),
  field("channels.imessage.dbPath", "text", { env: "IMSG_DB_PATH", runningKey: "imsgDbPath" }),
  field("channels.imessage.allowlist", "json"), field("channels.imessage.passiveGroups", "json"),
  ...["inboundSettleMs", "inboundMaxSettleMs", "typingStartDelayMs", "passiveTypingStartDelayMs"].map((key) => field(`channels.imessage.${key}`, "number")),
  field("identities", "json"), field("sessionModelOverrides", "json", { runningKey: "sessionModelOverrides" }),
  field("continuity", "boolean", { env: "TOMO_CONTINUITY", runningKey: "continuity" }),
  field("continuityIntervalMinutes", "number", { env: "TOMO_CONTINUITY_INTERVAL_MINUTES" }),
  field("continuityScript", "json", { secret: true }), field("city", "text", { env: "TOMO_CITY", runningKey: "city" }),
  field("groupSecret", "text", { secret: true }), field("summonExpiryMinutes", "number", { env: "TOMO_SUMMON_EXPIRY_MINUTES", runningKey: "summonExpiryMinutes" }),
  field("saveInboundImages", "boolean", { runningKey: "saveInboundImages" }),
  field("saveInboundFiles", "boolean", { env: "TOMO_SAVE_INBOUND_FILES", runningKey: "saveInboundFiles" }),
  ...["maxTurns", "steering", "showThinking", "liveSessionTimeoutMs"].map((key) => field(key, ["steering", "showThinking"].includes(key) ? "boolean" : "number", {
    runningKey: key, env: ({ maxTurns: "TOMO_MAX_TURNS", steering: "TOMO_STEERING", showThinking: "TOMO_SHOW_THINKING", liveSessionTimeoutMs: "TOMO_LIVE_SESSION_TIMEOUT_MS" } as Record<string, string>)[key],
  })),
  field("litellm.mode", "text", { env: "TOMO_LITELLM_MODE", options: ["anthropic-compatible", "chatgpt-subscription"] }),
  field("litellm.baseUrl", "text", { secret: true, env: "TOMO_LITELLM_BASE_URL" }),
  field("litellm.apiKey", "text", { secret: true, env: "TOMO_LITELLM_API_KEY" }),
  field("mcpServers", "json", { secret: true }), field("mcp", "json", { secret: true }), field("mcpAllowedTools", "json"),
  field("plugins", "json", { secret: true }), field("agentProfiles", "json", { secret: true }), field("groupShellAllowlist", "json"),
  field("lcm.nudgeAtPct", "number"), field("lcm.nudgeResetPct", "number"),
  field("lcm.groupCompactStyle", "text", { options: ["lcm", "sdk"] }), field("lcm.dailyFreshTail", "number"), field("lcm.globalFreshTail", "boolean"),
  field("metrics.enabled", "boolean", { env: "TOMO_METRICS" }), field("metrics.port", "number", { env: "TOMO_METRICS_PORT" }),
  field("metrics.activityLog", "boolean"), field("metrics.includeMessageText", "boolean"),
  field("web.enabled", "boolean"), field("web.port", "number"), field("web.ownerIdentity"), field("web.externalOrigin"),
];
export function validateFileConfig(value: unknown): void {
  const parsed = fileConfigSchema.safeParse(value);
  if (!parsed.success) throw new ConfigValidationError(parsed.error.issues.map((issue) => issue.path.map(String).join(".")));
}
export class ConfigValidationError extends Error {
  constructor(readonly fields: string[]) { super("Invalid configuration fields"); }
}
