import { z } from "zod";

export const positiveInt = z.coerce.number().positive("expected a positive number").transform(Math.floor);
export const nonNegativeInt = z.coerce.number().min(0, "expected a non-negative number").transform(Math.floor);
export const positiveNumber = z.coerce.number().positive("expected a positive number");
export const boolLike = z.unknown().transform((value, ctx) => {
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
export const chatId = z.union([z.string(), z.number()]).transform(String);

export const channelEntrySchema = z.looseObject({
  token: z.string().optional(),
  // Deliberately a bare string, not an enum: an unrecognized provider must not
  // fail the WHOLE channel entry (which would fall the allowlist back to {} as
  // well). The value is checked on its own at the `imessageProvider` build
  // site, so a stale `"bluebubbles"` yields one targeted issue, not a wiped
  // iMessage config.
  provider: z.string().optional(),
  cliPath: z.string().optional(),
  dbPath: z.string().optional(),
  inboundSettleMs: nonNegativeInt.optional(),
  inboundMaxSettleMs: nonNegativeInt.optional(),
  typingStartDelayMs: nonNegativeInt.optional(),
  passiveTypingStartDelayMs: nonNegativeInt.optional(),
  allowlist: z.array(chatId).optional(),
  passiveGroups: z.array(chatId).optional(),
});

/**
 * `channels.imessage.provider`. Only `"imsg"` remains — the BlueBubbles
 * backend was removed on 2026-08-27.
 *
 * An absent key means iMessage is off (see `validated()`: undefined/null takes
 * the fallback without an issue), so installs that never opted in keep working
 * and never spawn an `imsg` child they didn't ask for. A config still pinned to
 * `"bluebubbles"` deliberately raises a startup issue instead of being quietly
 * switched to a backend the owner never chose, or quietly losing its iMessage
 * channel.
 */
export const imessageProviderSchema = z.unknown().transform((value, ctx): "imsg" | null => {
  if (value === "imsg") return "imsg";
  if (value === "bluebubbles") {
    ctx.addIssue({
      code: "custom",
      message: 'the BlueBubbles backend has been removed — set "imsg" to use the local imsg CLI, or delete the key to turn iMessage off',
    });
    return z.NEVER;
  }
  ctx.addIssue({ code: "custom", message: 'expected "imsg"' });
  return z.NEVER;
});

export const identitySchema = z.object({
  name: z.string().min(1, "expected a non-empty name"),
  channels: z.record(z.string(), chatId),
  replyPolicy: z.string().default("last-active"),
});

export const DEFAULT_LCM: import("../config.js").LcmConfig = {
  nudgeAtPct: 70,
  nudgeResetPct: 60,
  groupCompactStyle: "lcm",
  dailyFreshTail: 32,
  globalFreshTail: false,
};

export const lcmSchema = z.object({
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


export const continuityScriptEntrySchema = z.union([
  z.string().transform((path) => ({ path }) as { path?: string; timeoutMs?: unknown; maxOutputChars?: unknown }),
  z.looseObject({ path: z.string().optional(), timeoutMs: z.unknown().optional(), maxOutputChars: z.unknown().optional() }),
]);

export const litellmEntrySchema = z.looseObject({
  mode: z.unknown().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});


export const pluginEntrySchema = z.union([
  z.string().min(1, "expected a non-empty plugin path or name"),
  z
    .object({
      path: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      skipMcpDiscovery: z.boolean().optional(),
    })
    .refine((o) => Boolean(o.path) !== Boolean(o.name), {
      message: "expected exactly one of `path` or `name`",
    }),
]);


export const agentProfileSchema = z.object({
  writeRoots: z.array(z.string()).default([]),
  denyPaths: z.array(z.string()).default([]),
  denyReadPaths: z.array(z.string()).default([]),
  // Narrowest default: see AgentProfile.bash.
  bash: z.enum(["none", "readonly", "worktree", "full"]).default("none"),
});


/** Raw file validation. Keep raw placeholders/unknown extensions on save;
 * these are the same coercing validators consumed by daemon startup. */
export const mcpServerName = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).refine((s) => !["__proto__", "constructor", "prototype"].includes(s));
export const stringRecord = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export const mcpServerSchema = z.looseObject({
  type: z.enum(["stdio", "http", "sse", "streamable-http"]).optional(),
  enabled: z.boolean().optional(), disabled: z.boolean().optional(),
  command: z.string().optional(), args: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  env: stringRecord.optional(), url: z.string().optional(), headers: stringRecord.optional(),
  timeout: positiveNumber.optional(), alwaysLoad: z.boolean().optional(),
  tools: z.array(z.object({ name: z.string(), permission_policy: z.enum(["always_allow", "always_ask", "always_deny"]) })).optional(),
  oauth: z.looseObject({ authorizationServer: z.string().optional(), clientId: z.string().optional(),
    scopes: z.union([z.array(z.string()), z.string()]).optional(), tokenStoreKey: z.string().optional(),
    redirectUri: z.string().optional(), clientName: z.string().optional() }).optional(),
}).superRefine((entry, ctx) => {
  if (entry.enabled === false || entry.disabled === true) return;
  const field = entry.type && entry.type !== "stdio" ? "url" : "command";
  if (!entry[field]?.trim()) ctx.addIssue({ code: "custom", path: [field], message: "Required for this transport" });
});
export const mcpServersSchema = z.record(mcpServerName, mcpServerSchema);
