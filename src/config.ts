import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { type ExternalMcpServerConfig, parseExternalMcpServers } from "./mcp/external-config.js";
import type { PluginSpec } from "./agent/plugins.js";
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
import { redactSecrets } from "./redact.js";
import { log } from "./logger.js";

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

/**
 * How much of the Bash tool an agent type keeps.
 *
 *  - `none`     — no Bash at all.
 *  - `readonly` — a write has to NAME ITS DESTINATION, and that destination has
 *                 to be inside `writeRoots`. `touch /tmp/marker` is fine when
 *                 `/tmp` is a writeRoot; `rm -rf x` and `rm -rf *` are not,
 *                 because nothing in this process can say where they land. So
 *                 is `>`/`>>` onto an absolute target outside `writeRoots`.
 *                 Command substitution, backticks and pipes stay: a reviewer
 *                 lives on `git log $(git merge-base main HEAD)`, and v1 is
 *                 aimed at accidents, not at an agent deliberately assembling
 *                 `rm` out of `$(…)`. That is a sandbox's job, not a policy
 *                 layer's — see the "not a sandbox" note in the README.
 *  - `worktree` — `readonly` minus the must-name-it clause. An ABSOLUTE path
 *                 token on a write command still has to land inside
 *                 `writeRoots`; a RELATIVE one is not judged for the allow side
 *                 at all, because the daemon is not told where a subagent's cwd
 *                 is, so `rm -rf build/Old` works. See AgentProfile for what
 *                 that does and does not fence.
 *  - `full`     — only `denyPaths` / `denyReadPaths` apply, to Bash AND to the
 *                 file-writing tools: `writeRoots` stop constraining the agent
 *                 entirely.
 */
export type AgentBashMode = "none" | "readonly" | "worktree" | "full";

/**
 * The permission envelope for one subagent type.
 *
 * ABSENCE IS NOT DENIAL. An agent type with no profile runs exactly as it does
 * today (fail-open, one `log.warn` per session per type). This is the
 * deliberate v1 posture: nobody knows the real tool surface of
 * `general-purpose`/`Explore`/ad-hoc delegations yet, and a fail-closed default
 * would break every one of them on the first turn. The warning is how that
 * surface gets measured before the default is flipped.
 *
 * THE TWO DENY LISTS ARE NOT THE SAME KIND OF THING.
 *
 * `denyPaths` is a WRITE fence. A reviewer's whole job is to read the checkouts
 * it must never modify, so `git -C ~/Developer/bloom log` and
 * `cat ~/Developer/bloom/App.swift` are fine while `git -C ~/Developer/bloom
 * commit` and `rm -rf ~/Developer/bloom` are not. `denyReadPaths` is the
 * secrets list: any MENTION by any tool is refused, which is the older and
 * blunter rule, kept for the handful of paths where reading is the harm
 * (`~/.ssh`, the config file with the tokens in it, the owner's private
 * memory).
 *
 * WHAT `worktree` MODE DOES NOT FENCE. A relative token is resolved against the
 * WORKSPACE for the deny check and not judged at all for the allow check, so an
 * agent working inside its own worktree keeps a normal shell there
 * (`mkdir -p Sources/New`, `rm -rf build/Old`, `git commit -m msg`), and the
 * accidents that hit the workspace it inherited its cwd from (`rm -rf memory`,
 * `rm -rf *`, `git clean -fdx`, `rm -rf .`) are refused. It does NOT stop an
 * agent from destroying its own worktree, and it cannot: the daemon is never
 * told where that worktree is.
 *
 * Paths are expanded at config load (`~`, `$VAR`, `${VAR}`) and must come out
 * absolute. What happens to one that does not depends on WHICH list it is in —
 * see `expandProfilePaths`.
 */
export interface AgentProfile {
  /** Absolute roots this agent may write into. Empty ⇒ it may write nowhere
   *  (unless `bash` is `full`, which switches writeRoots off entirely). */
  writeRoots: string[];
  /** Absolute paths this agent may not WRITE to. Reads are unaffected. Beats
   *  `writeRoots`: a denyPath nested inside a writeRoot still denies, and a
   *  destructive verb aimed at an ANCESTOR of one is denied too, because
   *  `rm -rf <parent>` takes the protected path with it. */
  denyPaths: string[];
  /** Absolute paths this agent may not NAME AT ALL, by any tool — the secrets
   *  list. Strictly stronger than `denyPaths`; a path in here needs no entry
   *  there. */
  denyReadPaths: string[];
  /** How much of Bash survives. Defaults to `none` — registering a profile is
   *  an act of narrowing, so the omitted field is the narrow one. */
  bash: AgentBashMode;
}

/** `agent_type` stand-in the guard uses for a subagent that reported an
 *  `agent_id` and no type. Rejected as a profile KEY at parse time: a profile
 *  under this name would silently apply to every untyped subagent, which is
 *  not something anyone means to configure. */
export const RESERVED_AGENT_TYPE = "(unknown)";

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
  /** iMessage backend, from `channels.imessage.provider`. `"imsg"` (the only
   *  backend) enables the channel; `null` means iMessage is off. Kept as a
   *  named provider rather than a boolean because it is what existing config
   *  files already carry on disk. */
  imessageProvider: "imsg" | null;
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
  /** If true, inbound attachments are persisted under workspace/memory/:
   *  images to incoming-images/, PDFs to incoming-documents/, and every other
   *  MIME type to incoming-files/ (the last is path-only — those bytes are not
   *  attached to the message and are not sent to the API automatically, though
   *  the agent is told the path and may open it deliberately, so turning this
   *  off means the agent is told a file arrived but has nothing to open).
   *  Default true. */
  saveInboundImages: boolean;
  /** If true, inbound attachments whose MIME is neither an image nor a
   *  supported document are persisted to workspace/memory/incoming-files/.
   *  This path is path-only: the bytes are not attached to the message and are
   *  not sent to the API automatically — the agent is told the file arrived,
   *  its type and size, and where it is, and can open it deliberately. When
   *  unspecified this follows `saveInboundImages`, so an install that already
   *  opted out of inbound storage stays opted out. Turning it off does NOT
   *  silence the notice; the agent is still told a file arrived, just without
   *  a path to open (silence is what caused the 2026-08-27 incident). */
  saveInboundFiles: boolean;
  /** Max agent turns per single user message (one turn ≈ one tool-use round). Default 50. */
  maxTurns: number;
  /** Steer messages that arrive while a turn is in flight into that turn at the
   *  next tool-call boundary, instead of queueing them behind it. Default true. */
  steering: boolean;
  /** Deliver the model's `thinking` content blocks to the chat alongside its
   *  `text` blocks. Default false.
   *
   *  Purely a content-block-type decision: when on, each thinking block is
   *  prefixed with a marker so the reader can tell it from the reply; when
   *  off, thinking blocks are dropped before the response string is built.
   *  Outbound text is never pattern-matched to guess what is "thinking" — a
   *  `text` block is always the model's chosen words and always ships. */
  showThinking: boolean;
  /** Inactivity timeout for one LiveSession send()/steer() turn. Default 10 minutes. */
  liveSessionTimeoutMs: number;
  /** Optional LiteLLM gateway. Keeps Claude Agent SDK as the runtime while routing model calls through LiteLLM. */
  litellm: LiteLlmConfig | null;
  /** External MCP servers from ~/.tomo/config.json. */
  mcpServers: Record<string, ExternalMcpServerConfig>;
  /** MCP tool allowlist entries for external servers. Defaults to mcp__<server>__* for each server. */
  mcpAllowedTools: string[];
  /** Claude Code plugins to load into every session. Entries are local paths
   *  ("./x", "~/x", "/x") or CLI-installed plugin refs ("name" or
   *  "name@marketplace" from `claude plugin install`). */
  plugins: PluginSpec[];
  /** Per-subagent-type permission scoping, keyed by the SDK `agent_type` name
   *  (`.claude/agents/<name>.md`). An agent type with no entry here is
   *  UNCONSTRAINED — see {@link AgentProfile}. */
  agentProfiles: Record<string, AgentProfile>;
  /** Group session keys whose Bash calls skip the `sandbox-exec` wrapper
   *  entirely — they run unsandboxed, same as DM sessions. The
   *  Read/Edit/Glob/Grep/MEDIA guards for `memory/private/` still apply;
   *  only the Bash sandbox is bypassed. */
  groupShellAllowlist: string[];
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

/**
 * Render a config value for a `configIssues` entry.
 *
 * `configIssues` is printed by `tomo status`, the `tomo config` banner, and
 * `assertConfigValid()`'s throw (which lands in `~/.tomo/logs/launchd.err.log`
 * under launchd), so anything it stringifies is effectively published. The
 * validators run against whole objects — `parseChannels` checks a channel
 * entry in one go — so a mistyped `allowlist` used to print its sibling
 * `token` alongside it.
 *
 * Secret-named fields are therefore reduced to `***` + their last four
 * characters before stringifying. That is still an actionable message: the
 * failing field is named by `label` and by the zod path, and the operator can
 * tell which token is on disk without the message handing it out. `label` also
 * covers the case where the whole value is the secret (`groupSecret: 42`).
 */
function describeValue(value: unknown, label?: string): string {
  const safe = redactSecrets(value, label === undefined ? undefined : fieldNameOf(label));
  try {
    return JSON.stringify(safe) ?? String(safe);
  } catch {
    return String(safe);
  }
}

/** Last path segment of an issue label: `litellm.apiKey (TOMO_…)` → `apiKey`. */
function fieldNameOf(label: string): string {
  return label.split(" ")[0].split(".").pop()!.replace(/\[\d+\]$/, "");
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
    // No label: the fallback is OURS, not the operator's secret, so describing
    // it under a secret-named label would print `using "***"` for a plain
    // `null` default and hide which default was applied.
    : `using ${describeValue(fallback)}`;
  issues.push(`${label}: ${detail} (got ${describeValue(raw, label)}; ${fallbackNote})`);
  return fallback;
}

/**
 * Environment overrides that were SET but blank, and so were ignored.
 *
 * Unlike `configIssues` this is not a startup blocker — falling back to the
 * config file is the right outcome. It is recorded because the fallback is
 * otherwise completely silent: nothing (`tomo status`, `tomo config`) prints
 * the *effective* model, token or gateway, so `CLAUDE_MODEL=$TYPO` looks
 * exactly like a working override. The daemon logs it once at startup.
 */
const ignoredEnvOverrides: string[] = [...defaultRuntimePaths.ignoredEnvOverrides];
export const ignoredEnvOverrideNames: readonly string[] = ignoredEnvOverrides;

/**
 * One line naming the blank overrides that were ignored, or undefined when
 * there were none. `tomo start` prints it whichever way startup goes: as a log
 * line on success, and after the error when a config assertion fails —
 * "set TELEGRAM_BOT_TOKEN" is a baffling instruction to someone whose shell
 * already has `TELEGRAM_BOT_TOKEN=` in it.
 */
export function ignoredEnvOverridesNotice(): string | undefined {
  if (ignoredEnvOverrides.length === 0) return undefined;
  return `Ignoring blank environment overrides (${ignoredEnvOverrides.join(", ")}); using the config file or default value`;
}

/**
 * Env var for a setting; empty string counts as unset.
 *
 * `FOO=` (and `export FOO=""`) is the ordinary way to blank a variable out in
 * a shell or a launchd plist, it is what a `.env` line with nothing after the
 * `=` produces, and it is what `FOO=$UNSET` expands to. Reading
 * `process.env.FOO ?? file.foo` would let that empty string win over the
 * config file, because `??` only falls through on null/undefined — so every
 * env override parsed in this file goes through here. Exported for any CLI
 * module that reads its own override.
 *
 * (`src/runtime-paths.ts` cannot import this — config.ts imports IT — and
 * keeps its own copy of the same rule.)
 */
export function envVar(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    if (!ignoredEnvOverrides.includes(name)) ignoredEnvOverrides.push(name);
    return undefined;
  }
  return value;
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
type ChannelEntry = z.output<typeof channelEntrySchema>;

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
const imessageProviderSchema = z.unknown().transform((value, ctx): "imsg" | null => {
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

/**
 * Validate the metrics block field by field.
 *
 * Falling the whole object back to DEFAULT_METRICS on one bad field is not a
 * safe default here: the defaults turn `activityLog` and `includeMessageText`
 * back ON, so a typo in `port` would start writing transcript text into
 * activity.ndjson for a user who had deliberately turned it off (the field is
 * documented as "disable if the log is shipped off this machine"). Drop only
 * the offending field, as parseIdentities and parsePlugins already do — each
 * bad field still raises its own configIssue.
 */
function parseMetricsConfig(raw: unknown): MetricsConfig {
  const entry = validated("metrics", z.looseObject({}), raw, {}) as Record<string, unknown>;
  return {
    activityLog: validated("metrics.activityLog", boolLike, entry.activityLog, DEFAULT_METRICS.activityLog),
    includeMessageText: validated(
      "metrics.includeMessageText",
      boolLike,
      entry.includeMessageText,
      DEFAULT_METRICS.includeMessageText,
    ),
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
  const baseUrl = String(envVar("TOMO_LITELLM_BASE_URL") ?? entry.baseUrl ?? "").trim();
  if (!baseUrl) return null;

  return {
    mode: inferLiteLlmMode(envVar("TOMO_LITELLM_MODE") ?? entry.mode, defaultModel),
    baseUrl,
    apiKey: String(envVar("TOMO_LITELLM_API_KEY") ?? entry.apiKey ?? "").trim(),
  };
}

/** `$VAR` / `${VAR}` / leading `~` expansion, with no opinion about what a
 *  path that is still relative afterwards should mean — callers decide that.
 *  An unset variable expands to the empty string, as a shell does. */
function expandUserPath(rawPath: string): string {
  const withEnv = rawPath.replace(/\$(\w+)|\$\{([^}]+)\}/g, (_match, bare: string | undefined, braced: string | undefined) => {
    const name = bare ?? braced ?? "";
    return process.env[name] ?? "";
  });
  return withEnv === "~"
    ? HOME
    : (withEnv.startsWith("~/") ? join(HOME, withEnv.slice(2)) : withEnv);
}

function expandConfigPath(rawPath: string): string {
  const withHome = expandUserPath(rawPath);
  return isAbsolute(withHome) ? withHome : join(TOMO_HOME, withHome);
}

function parseContinuityScriptConfig(raw: unknown): ContinuityScriptConfig | null {
  const entry = validated("continuityScript", continuityScriptEntrySchema, raw, {});
  const rawPath = String(envVar("TOMO_CONTINUITY_SCRIPT") ?? entry.path ?? "").trim();

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

const pluginEntrySchema = z.union([
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

/** Parse the `plugins` config array into normalized PluginSpec entries.
 *  Invalid entries are dropped with a configIssues record (same policy as
 *  identities): one bad plugin must not take the daemon down. */
function parsePlugins(raw: unknown): PluginSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push(`plugins: expected an array (got ${describeValue(raw)}; ignoring)`);
    return [];
  }
  const specs: PluginSpec[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = pluginEntrySchema.safeParse(entry);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
      issues.push(`plugins[${index}]: ${detail} (got ${describeValue(entry)}; dropping the entry)`);
      continue;
    }
    const value = parsed.data;
    if (typeof value === "string") {
      specs.push({ ref: value });
    } else if (value.path) {
      specs.push({ ref: value.path, isPath: true, ...(value.skipMcpDiscovery ? { skipMcpDiscovery: true } : {}) });
    } else {
      specs.push({ ref: value.name!, isPath: false, ...(value.skipMcpDiscovery ? { skipMcpDiscovery: true } : {}) });
    }
  }
  return specs;
}

const agentProfileSchema = z.object({
  writeRoots: z.array(z.string()).default([]),
  denyPaths: z.array(z.string()).default([]),
  denyReadPaths: z.array(z.string()).default([]),
  // Narrowest default: see AgentProfile.bash.
  bash: z.enum(["none", "readonly", "worktree", "full"]).default("none"),
});

/**
 * Expand one profile's path list, dropping anything that does not come out
 * absolute.
 *
 * THE SEVERITY IS ASYMMETRIC, because the two directions of failure are not
 * comparable. A dropped `writeRoot` only NARROWS the agent — it loses a
 * directory it was allowed to write to, and the worst case is a denial the
 * operator has to go and fix. A dropped `denyPath`/`denyReadPath` WIDENS it:
 * the operator wrote down a path this agent must never touch and the daemon
 * would run without it.
 *
 * So a bad writeRoot is a `log.warn` and a bad deny entry is a `configIssues`
 * entry, which refuses daemon startup. That asymmetry is also what keeps an
 * unset `$TMPDIR` from bricking the daemon: `$TMPDIR` is a writeRoot, it is
 * absent under a bare `launchctl load`, and the right answer to "this machine
 * has no TMPDIR" is a warning and a slightly narrower agent — not a daemon
 * that will not start.
 */
function expandProfilePaths(label: string, raw: string[], onInvalid: "warn" | "issue"): string[] {
  const out: string[] = [];
  for (const [index, entry] of raw.entries()) {
    const expanded = expandUserPath(entry).trim();
    if (!expanded || !isAbsolute(expanded)) {
      const detail = `${label}[${index}]: expected a path that expands to an absolute path `
        + `(got ${describeValue(entry)}, expanded to ${describeValue(expanded)}; dropping the entry)`;
      if (onInvalid === "issue") issues.push(detail);
      else log.warn({ entry, expanded }, detail);
      continue;
    }
    // `resolve` also strips the trailing slash `$TMPDIR` carries on macOS
    // (`/var/folders/…/T/`), which every containment test compares against an
    // unsuffixed parent.
    out.push(resolvePath(expanded));
  }
  return out;
}

/**
 * Parse `agentProfiles` — per-subagent-type permission scoping, keyed by the
 * SDK's `agent_type`.
 *
 * One bad entry drops only that agent type (the policy of `parseIdentities` and
 * `parsePlugins`), because the alternative — falling the whole map back to `{}`
 * — would silently unscope every OTHER agent that was configured correctly.
 * Every drop still raises a `configIssues` entry, so the daemon refuses to
 * start rather than running an agent the operator believes is fenced in.
 */
function parseAgentProfiles(raw: unknown): Record<string, AgentProfile> {
  if (raw === undefined || raw === null) return {};
  const record = validated("agentProfiles", z.record(z.string(), z.unknown()), raw, {});
  const profiles: Record<string, AgentProfile> = {};
  for (const [name, entry] of Object.entries(record)) {
    if (name === RESERVED_AGENT_TYPE) {
      // The guard substitutes this for a subagent that reports an `agent_id`
      // and no `agent_type`, so a profile under this key would quietly govern
      // every untyped subagent — never what someone means to write down.
      issues.push(`agentProfiles.${name}: "${RESERVED_AGENT_TYPE}" is reserved for subagents that report no agent type (dropping the entry)`);
      continue;
    }
    const parsed = agentProfileSchema.safeParse(entry);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; ");
      issues.push(`agentProfiles.${name}: ${detail} (got ${describeValue(entry)}; dropping the entry)`);
      continue;
    }
    const profile: AgentProfile = {
      writeRoots: expandProfilePaths(`agentProfiles.${name}.writeRoots`, parsed.data.writeRoots, "warn"),
      denyPaths: expandProfilePaths(`agentProfiles.${name}.denyPaths`, parsed.data.denyPaths, "issue"),
      denyReadPaths: expandProfilePaths(`agentProfiles.${name}.denyReadPaths`, parsed.data.denyReadPaths, "issue"),
      bash: parsed.data.bash,
    };
    // `"foo": {}` is almost always a half-written entry, and it is the one
    // shape whose meaning is the OPPOSITE of the missing entry beside it: no
    // profile means unconstrained, an empty profile means no writes and no
    // shell. Too big a difference to infer from an empty object.
    if (profile.writeRoots.length === 0 && profile.denyPaths.length === 0
      && profile.denyReadPaths.length === 0 && profile.bash === "none") {
      issues.push(`agentProfiles.${name}: profile has no writeRoots and bash defaults to none, so this agent can neither write nor run commands — add fields or remove it`);
    }
    profiles[name] = profile;
  }
  return profiles;
}

/**
 * Reject a workspace path that could not be interpolated into a one-line
 * attachment marker safely.
 *
 * `formatFileMarker` in channels/fileStore.ts claims its output is a single
 * `[…]` line "by construction". Every sender-controlled part earns that:
 * filenames are reduced to `[A-Za-z0-9._-]`, MIMEs to an RFC 2045 token. The
 * saved path is the one field that is ours rather than the sender's — but
 * "ours" means "derived from `workspaceDir`", and `TOMO_WORKSPACE` is a string
 * an operator can put anything in, including a newline or a `]`.
 *
 * Validating here rather than neutralising in the notice is deliberate. The
 * notice's whole purpose is to hand the assistant a path it can open; running
 * it through `neutralizeMarkerDelimiters` would print a full-width `］` in a
 * path that then does not exist on disk, trading a cosmetic problem for a
 * broken one. There is no correct rendering of an unusable base dir, so the
 * right moment to complain is config load, once, with the offending value
 * named.
 *
 * Recorded as an issue rather than defaulted: every other path in the process
 * derives from this one, so there is no sane fallback to swap in. The daemon
 * refuses to start via `assertConfigValid()`, while `tomo init` / `tomo config`
 * keep working so the value can be repaired.
 */
function checkWorkspaceDirRenderable(workspaceDir: string): void {
  // eslint-disable-next-line no-control-regex
  const control = /[\u0000-\u001F\u007F-\u009F]/.exec(workspaceDir);
  if (control) {
    issues.push(
      `workspaceDir (TOMO_WORKSPACE): must not contain control characters `
      + `(found ${describeValue(control[0])} at index ${control.index} of ${describeValue(workspaceDir)}; `
      + `it would break the single-line inbound attachment notice). Move the workspace to a plainer path.`,
    );
    return;
  }
  const bracket = /[[\]]/.exec(workspaceDir);
  if (bracket) {
    issues.push(
      `workspaceDir (TOMO_WORKSPACE): must not contain '[' or ']' `
      + `(found at index ${bracket.index} of ${describeValue(workspaceDir)}; `
      + `those delimit the inbound attachment notice and a path containing one could truncate it). `
      + `Move the workspace to a plainer path.`,
    );
  }
}

function buildConfig(): TomoConfig {
  const file = loadConfigFile();
  const paths = defaultRuntimePaths;
  checkWorkspaceDirRenderable(paths.workspaceDir);
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
    envVar("CLAUDE_MODEL") ?? file.model,
    DEFAULT_MODEL,
  );

  // Hoisted out of the returned object because saveInboundFiles defaults to it.
  const saveInboundImages = validated("saveInboundImages", boolLike, file.saveInboundImages, true);

  const continuityIntervalMinutes = validated(
    "continuityIntervalMinutes (TOMO_CONTINUITY_INTERVAL_MINUTES)",
    positiveNumber,
    envVar("TOMO_CONTINUITY_INTERVAL_MINUTES") ?? file.continuityIntervalMinutes,
    DEFAULT_CONTINUITY_INTERVAL_MINUTES,
  );

  return {
    auth: parseAnthropicAuthConfig(file.auth),
    telegramToken: envVar("TELEGRAM_BOT_TOKEN") ?? channels.telegram?.token ?? "",
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
    city: validated("city (TOMO_CITY)", z.string().nullable(), envVar("TOMO_CITY") ?? file.city, null),
    identities: parseIdentities(file.identities),
    imessageProvider: validated(
      "channels.imessage.provider (IMESSAGE_PROVIDER)",
      imessageProviderSchema,
      envVar("IMESSAGE_PROVIDER") ?? channels.imessage?.provider,
      null,
    ),
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
    saveInboundImages,
    saveInboundFiles: validated(
      "saveInboundFiles (TOMO_SAVE_INBOUND_FILES)",
      boolLike,
      envVar("TOMO_SAVE_INBOUND_FILES") ?? file.saveInboundFiles,
      // Defaults to the image setting, not to `true`: an existing config with
      // saveInboundImages=false has already said "do not keep inbound
      // attachments", and a new key must not quietly re-enable that.
      saveInboundImages,
    ),
    maxTurns: validated("maxTurns (TOMO_MAX_TURNS)", positiveInt, envVar("TOMO_MAX_TURNS") ?? file.maxTurns, 50),
    steering: validated("steering (TOMO_STEERING)", boolLike, envVar("TOMO_STEERING") ?? file.steering, true),
    showThinking: validated("showThinking (TOMO_SHOW_THINKING)", boolLike, envVar("TOMO_SHOW_THINKING") ?? file.showThinking, false),
    liveSessionTimeoutMs: validated(
      "liveSessionTimeoutMs (TOMO_LIVE_SESSION_TIMEOUT_MS)",
      positiveInt,
      envVar("TOMO_LIVE_SESSION_TIMEOUT_MS") ?? file.liveSessionTimeoutMs,
      DEFAULT_LIVE_SESSION_TIMEOUT_MS,
    ),
    litellm: parseLiteLlmConfig(file.litellm, model),
    mcpServers,
    mcpAllowedTools,
    plugins: parsePlugins(file.plugins),
    agentProfiles: parseAgentProfiles(file.agentProfiles),
    groupShellAllowlist: validated("groupShellAllowlist", z.array(z.string()), file.groupShellAllowlist, []),
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
      "No channels configured. Run 'tomo init' or set TELEGRAM_BOT_TOKEN / IMESSAGE_PROVIDER.",
    );
  }
}

/**
 * Whether the iMessage channel is enabled. Selecting the provider is the whole
 * of it — the imsg CLI path defaults to "imsg" on PATH, so there is nothing
 * else to configure.
 */
export function imessageConfigured(cfg: Pick<TomoConfig, "imessageProvider"> = config): boolean {
  return cfg.imessageProvider === "imsg";
}
