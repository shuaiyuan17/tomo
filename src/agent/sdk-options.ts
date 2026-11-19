import type { ElicitationRequest, ElicitationResult, McpSdkServerConfigWithInstance, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { backgroundLaunchGuardHooks } from "./compact-reservations.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { buildSystemPrompt } from "../workspace/index.js";
import { assembleSystemPrompt, renderRuntimeSection, renderSessionSection } from "../workspace/system-prompt-blocks.js";
import { isDmSessionKey, isGroupSessionKey } from "../sessions/keys.js";
import { TOMO_INTERNAL_MCP_NAME } from "../mcp/internal-server.js";
import { isLiteLlmProviderModel, resolveModelName, modelLabel } from "../models.js";
import { litellmRoutesModel } from "../litellm.js";
import { effectiveGroupSandbox, type GroupSandboxConfig } from "./group-fs-policy.js";
import { agentProfileGuardHooks, privateMemoryBarFor, privateMemoryGuardHooks, skillsCanUseTool, todoStoreGuardHooks, type PrivateMemoryBar } from "./permissions.js";
import { TODO_TOOL_NAMES } from "../mcp/todo-tools.js";
import { todosDir } from "../todos/store.js";
import type { AgentProfile } from "../config.js";
import { resolvePlugins } from "./plugins.js";
import { SDK_SETTING_SOURCES } from "./setting-sources.js";
import { TOMO_DAEMON_PID_ENV, TOMO_SESSION_KEY_ENV } from "../restart-reason.js";
import { CREDENTIAL_TOOL_NAMES, KEYCHAIN_SERVICE } from "../credentials/names.js";
import { ensureRedactionReady, redactionReady, scrubDeep, withholdDeep } from "../credentials/redactor.js";

// DM sessions run our custom hierarchical LCM (daily/weekly/monthly/yearly
// rollups via skill), so SDK auto-compact is disabled for them via the
// DISABLE_AUTO_COMPACT env var — we don't want the SDK to collapse our
// rollup structure behind our back. Group sessions default to the same
// hierarchical LCM flow (config.lcm.groupCompactStyle="lcm"); set it to "sdk"
// to fall back to SDK auto-compact for groups.

/** True when the session uses our custom LCM compaction (DMs always; groups
 *  unless config.lcm.groupCompactStyle="sdk"). When false, SDK auto-compact is
 *  in charge and the harness skips its compaction nudges. */
export function usesLcmCompact(sessionKey: string): boolean {
  if (!isGroupSessionKey(sessionKey)) return true;
  return config.lcm.groupCompactStyle !== "sdk";
}

/** Mutable per-send counter for the SDK's maxTurns budget. The SDK enforces
 *  maxTurns silently and only surfaces it as an error after the fact, so we
 *  count tool rounds via a PostToolBatch hook and inject a system reminder at
 *  75% / 90% so the agent can wrap up before hitting the ceiling. Reset by
 *  LiveSession.send() at the start of each user-message → response cycle. */
export interface TurnBudget {
  count: number;
  fired75: boolean;
  fired90: boolean;
}

export function makeTurnBudget(): TurnBudget {
  return { count: 0, fired75: false, fired90: false };
}

export function resetTurnBudget(b: TurnBudget): void {
  b.count = 0;
  b.fired75 = false;
  b.fired90 = false;
}

export interface SessionContext {
  sessionKey: string;
  sdkSessionId?: string;
  /** Group metadata snapshot — present only for group sessions. */
  group?: {
    chatTitle?: string;
    participants?: string[];
    /** True for iMessage groups (always) and Telegram groups in
     *  config.passiveGroups. Drives the "stay silent unless useful" rule. */
    isPassive: boolean;
  };
  onMcpElicitation?: (request: ElicitationRequest) => Promise<ElicitationResult>;
  /**
   * Does the turn in flight belong to this session? (`Agent.isOwnAudienceTurn`)
   *
   * A GETTER: the SDK options — and the hooks built from them — are assembled
   * once when the live session is created, but a dm: session's audience
   * changes turn to turn while a group is summoned into it. Left undefined
   * (tests, callers with no audience notion), every turn counts as the
   * session's own.
   */
  isOwnAudienceTurn?: () => boolean;
  /**
   * The key the turn in flight is scoped to (`Agent.scopedCallerKey`): the
   * session key for its own turns, the steering group's key on a summoned
   * turn, `MIXED_AUDIENCE_KEY` for a mixed batch. A getter for the same reason
   * as `isOwnAudienceTurn`. Read by the private-memory guard so a summoned turn
   * inherits its group's `groupSandbox` entry; undefined means it never
   * does.
   */
  scopedCallerKey?: () => string;
  /**
   * Read-and-clear: did the model's last message land in a thinking block and
   * get dropped (see LiveSession.takeUndeliveredReply)? Consulted after every
   * tool batch so the model can be told before its next step.
   */
  undeliveredReply?: () => boolean;
  /**
   * Per call: why a background launch must be refused right now (a compact is
   * pending and its reload would kill the task), or null. Undefined ⇒ the
   * guard is not installed. See compact-reservations.ts.
   */
  backgroundLaunchDenial?: () => string | null;
}

export function sdkOptions(
  internalMcpServer: McpSdkServerConfigWithInstance,
  resumeSessionId?: string,
  model?: string,
  sessionContext?: SessionContext,
  turnBudget?: TurnBudget,
  externalMcpServersOverride?: Record<string, McpServerConfig>,
) {
  const isGroup = sessionContext ? isGroupSessionKey(sessionContext.sessionKey) : false;
  const staticPrompt = buildSystemPrompt({ isGroup });

  // Why `memory/private/` is closed for the turn in flight — or null when it is
  // open. INSTALLED FOR EVERY SESSION, and resolved per tool call rather than
  // here: these options, and the hooks built from them, are assembled once when
  // the live session is created (live-session-manager.ts), while a dm:
  // session's entitlement changes turn to turn. The old
  // `guardPrivateMemory: isGroup` decided it once, at creation, from the
  // session key alone — and `isGroupSessionKey("dm:owner")` is false for
  // exactly the turns a SUMMONED group is steering, so the guard was not
  // installed at all for them.
  //
  // The rule itself lives in `privateMemoryBarFor` so the outbound side
  // (delivery-pipeline.ts, which drops private MEDIA: attachments on a barred
  // turn) decides it from the same function rather than a second copy.
  const ownAudienceTurn = sessionContext?.isOwnAudienceTurn;
  const privateMemoryBar = (): PrivateMemoryBar | null => privateMemoryBarFor(isGroup, ownAudienceTurn);

  // Per-subagent-type permission scoping. Read from config PER TOOL CALL, not
  // snapshotted here, for the same reason `privateMemoryBar` is a getter: these
  // options are assembled once when the live session is created and live as
  // long as the session does. The main thread is unaffected — the guard returns
  // early when the SDK reports no `agent_id`.
  const agentProfile = (agentType: string): AgentProfile | undefined => config.agentProfiles[agentType];

  // The small amount of runtime context that cannot live in the user-editable
  // workspace prompt. It goes AFTER the cache boundary (see
  // workspace/system-prompt-blocks.ts): it names this one session, so before
  // the marker it would stop every other session sharing the prefix.
  const dynamicSections: string[] = [];
  if (sessionContext) dynamicSections.push(renderSessionSection(sessionContext));

  const configuredMcpServers = Object.fromEntries(
    Object.entries(config.mcpServers ?? {}).map(([name, entry]) => [name, entry.server]),
  ) as Record<string, McpServerConfig>;
  const externalMcpServers = Object.fromEntries(
    Object.entries(externalMcpServersOverride ?? configuredMcpServers)
      .filter(([name]) => name !== TOMO_INTERNAL_MCP_NAME),
  );
  const externalMcpAllowedTools = Array.isArray(config.mcpAllowedTools) ? config.mcpAllowedTools : [];
  const shouldDisableAutoCompact = Boolean(sessionContext && usesLcmCompact(sessionContext.sessionKey));
  const effectiveModel = model ?? config.model;

  // Tell the agent which model is actually serving this session. A model can't
  // reliably introspect its own identity, so surface it as a fact in the prompt
  // rather than leaving the agent to guess. Reassembled every turn, so a /model
  // switch (or a gateway re-route) is reflected on the next turn.
  const resolvedModel = resolveModelName(effectiveModel) ?? effectiveModel;
  const resolvedLabel = modelLabel(resolvedModel);
  const modelDisplay = resolvedLabel === resolvedModel ? resolvedModel : `${resolvedModel} — ${resolvedLabel}`;
  dynamicSections.push(renderRuntimeSection(modelDisplay));
  const systemPrompt = assembleSystemPrompt(staticPrompt, dynamicSections);

  const sdkEnv = buildSdkEnv({
    disableAutoCompact: shouldDisableAutoCompact,
    model: effectiveModel,
    sessionKey: sessionContext?.sessionKey,
  });
  // Thinking DISPLAY is the model-side half of config.showThinking: with
  // `display: "omitted"` the SDK strips the *reasoning* out of `thinking` blocks
  // (they arrive with empty text and a signature). With the flag off LiveSession
  // drops every thinking block, and flags a non-empty one so the model is told
  // its reply was not delivered (see renderBlock). Resolved at session spawn — a
  // mid-session config change only takes effect on the next session (restart).
  const thinking = adaptiveThinkingForModel(effectiveModel, config.showThinking);

  // Resolved at session spawn, not config load: CLI-installed plugin paths are
  // version-pinned and change on `claude plugin update` (old dirs are GC'd),
  // so a long-running daemon must re-resolve rather than cache paths.
  const plugins = resolvePlugins(config.plugins ?? [], undefined, config.tomoHome || undefined);

  return {
    model: effectiveModel,
    cwd: config.workspaceDir,
    systemPrompt,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebSearch", "WebFetch", "Agent", "NotebookEdit",
      "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
      `mcp__${TOMO_INTERNAL_MCP_NAME}__send_message`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__list_sessions`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__rename_group_chat`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__react_to_message`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__edit_message`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__unsend_message`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_create`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_list`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_enable`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_remove`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__pet_status`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__pet_hatch`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__pet_feed`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__pet_play`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__pet_sleep`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__recall_conversation`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__list_people`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__upsert_person`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__lcm_rollup`,
      ...TODO_TOOL_NAMES.map((name) => `mcp__${TOMO_INTERNAL_MCP_NAME}__${name}`),
      // Registered only on the owner's DM session (internal-server.ts).
      `mcp__${TOMO_INTERNAL_MCP_NAME}__home_check`,
      ...(config.credentialBroker?.enabled ? CREDENTIAL_TOOL_NAMES.map((name) => `mcp__${TOMO_INTERNAL_MCP_NAME}__${name}`) : []),
      ...externalMcpAllowedTools,
    ],
    // SDK v0.2.133 deprecated passing "Skill" in allowedTools — the new path
    // is the top-level `skills` option. The SDK appends `"Skill"` (or
    // `"Skill(name)"` per entry) to the spawned CLI's --allowedTools only when
    // `skills` is defined, so we set it to "all" to keep every discovered
    // skill invocable (same surface as the old `"Skill"` allowedTools entry).
    skills: "all" as const,
    ...(plugins.length > 0 ? { plugins } : {}),
    mcpServers: { ...externalMcpServers, [TOMO_INTERNAL_MCP_NAME]: internalMcpServer },
    // External entries never reach the CLI's argv: LiveSession sends them
    // over stdin in the initialize request (mcpServersDelivery: "initialize"),
    // because an OAuth server's entry carries its bearer token.
    settingSources: [...SDK_SETTING_SOURCES],
    settings: {
      // Tomo keeps its own memory (workspace/memory, written into the system
      // prompt with private/ lines stripped for groups). The SDK's auto memory
      // is a second, separate store under ~/.claude/projects/<cwd>/memory: it
      // was injecting stale notes every turn (one of them wrong), would inject
      // an unstripped index into group sessions if pointed at ours, and its
      // extract/dream passes are gated by server flags we cannot see.
      autoMemoryEnabled: false,
      // claude.ai connectors (Gmail, Calendar, Drive, Claude Docs, ...) ride
      // the CLI's claude.ai login, not our mcpServers — `mcpServers: {}`
      // would not drop them. They reach the owner's private accounts, so a
      // group's own session never loads them. Session-level: a group
      // summoned into the owner's DM keeps them on purpose (owner present).
      ...(isGroup ? { disableClaudeAiConnectors: true } : {}),
      attribution: {
        commit: "Made by [Tomo](https://github.com/shuaiyuan17/tomo)",
        pr: "Made by [Tomo](https://github.com/shuaiyuan17/tomo)",
      },
    },
    // See ./permissions.ts — canUseTool re-allows `.claude/skills/` writes
    // that bypassPermissions otherwise routes here as denials.
    canUseTool: skillsCanUseTool,
    ...(sessionContext?.onMcpElicitation ? { onElicitation: sessionContext.onMcpElicitation } : {}),
    // Token-level partials are disabled. Completed content blocks still arrive
    // on assistant events and are delivered immediately (delivery-pipeline.ts).
    includePartialMessages: false,
    // A one-line, model-written status for each running subagent (about every
    // 30 s, forked off the subagent's own warm prompt cache). The web Tasks
    // panel shows it as "Working · <summary>"; without it a subagent's card
    // only ever names its last tool.
    agentProgressSummaries: true,
    // A predicted next owner message after each turn (`prompt_suggestion`,
    // riding the turn's prompt cache). Only the web composer offers it, so
    // only the owner's DM session asks for it, and only with the web UI on.
    ...(sessionContext && isDmSessionKey(sessionContext.sessionKey) && config.web?.enabled ? { promptSuggestions: true } : {}),
    // The web task view can stop one task, so the owner's Stop (interrupt) ends only the turn and
    // spares background agents. Without this declaration the CLI kills them on every interrupt.
    ...(sessionContext && isDmSessionKey(sessionContext.sessionKey) && config.web?.enabled ? { perTaskStopAffordance: true } : {}),
    ...(thinking ? { thinking } : {}),
    // 0 = no limit: leave maxTurns out so the CLI gets no --max-turns at all.
    ...(config.maxTurns > 0 ? { maxTurns: config.maxTurns } : {}),
    ...buildHooksOption({
      turnBudget,
      maxTurns: config.maxTurns,
      sessionKey: sessionContext?.sessionKey,
      privateMemoryBar,
      agentProfile,
      undeliveredReply: sessionContext?.undeliveredReply,
      backgroundLaunchDenial: sessionContext?.backgroundLaunchDenial,
      // Resolved at spawn (above) and handed to the guard as a getter, so the
      // barred-turn Bash arm can spot a plugin that ships PreToolUse hooks
      // without re-resolving install paths on every tool call.
      pluginDirs: () => plugins.map((entry) => entry.path),
      // Read from config per call, not snapshotted: a config reload mid-session
      // takes effect on the next tool call rather than the next session.
      // The legacy `groupShellAllowlist` is folded in on read (unsandboxed).
      groupSandbox: () => effectiveGroupSandbox(config.groupSandbox, config.groupShellAllowlist),
      // Which group is steering a summoned turn, so the group's entry is judged
      // against that group's key rather than the owner's dm: key.
      scopedCallerKey: sessionContext?.scopedCallerKey,
      credentialBroker: config.credentialBroker?.enabled === true,
      todosDir: () => todosDir(),
    }),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    env: sdkEnv,
    // Steering needs the CLI to re-emit consumed user messages as
    // isReplay events — that's how LiveSession detects whether a steered
    // message merged into the in-flight turn or spilled to a follow-up
    // turn. The CLI flag defaults to off and the SDK has no typed option
    // for it, so pass it through extraArgs when steering is enabled.
    ...(config.steering ? { extraArgs: { "replay-user-messages": null } } : {}),
  };
}

/**
 * Adaptive-thinking config for models that support it (Sonnet/Opus 4.6+).
 *
 * `display` is the only knob the SDK exposes (`ThinkingAdaptive` in
 * @anthropic-ai/claude-agent-sdk `sdk.d.ts` — `display?: 'summarized' |
 * 'omitted'`; there is no `'full'`). `"omitted"` empties the reasoning out of
 * `thinking` blocks (signature only), so it is the mechanism that hides
 * reasoning by default; `"summarized"` is what makes the SDK emit readable
 * summaries, which is what `showThinking` needs before LiveSession has
 * anything to mark with 💭. With the flag off LiveSession drops thinking
 * blocks whatever they contain — see renderBlock.
 */
function adaptiveThinkingForModel(
  model: string,
  showThinking: boolean,
): { type: "adaptive"; display: "summarized" | "omitted" } | undefined {
  const resolved = resolveModelName(model) ?? model;
  if (isLiteLlmProviderModel(resolved)) return undefined;

  const base = resolved.replace(/\[[^\]]+\]$/, "");
  const adaptiveThinkingModel =
    /^claude-sonnet-(?:4-(?:[6-9]|\d{2,})|[5-9](?:-\d+)?|\d{2,}(?:-\d+)?)$/.test(base) ||
    /^claude-opus-(?:4-(?:[6-9]|\d{2,})|[5-9](?:-\d+)?|\d{2,}(?:-\d+)?)$/.test(base);

  return adaptiveThinkingModel
    ? { type: "adaptive", display: showThinking ? "summarized" : "omitted" }
    : undefined;
}

/** Env vars set on EVERY SDK child, whatever the auth/routing branch.
 *
 *  CLAUDE_CODE_DISABLE_FILE_MENTIONS: `@path` mentions in a prompt are expanded
 *  by the CLI straight into context, with no tool call — so the PreToolUse
 *  private-memory guard never sees them, and a group member typing
 *  `@memory/private/...` would get the file inlined (verified against the SDK).
 *  With this set the CLI only passes the path on and the model has to read it
 *  with a tool, which the guard does gate. Tomo never relies on @-mentions. */
export const ALWAYS_ON_SDK_ENV = {
  CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1",
} as const;

export function buildSdkEnv(args: {
  disableAutoCompact: boolean;
  model: string;
  sessionKey?: string;
}): NodeJS.ProcessEnv {
  // Decide whether this session routes through the LiteLLM proxy. A generic
  // anthropic-compatible proxy forwards every model (that's its purpose), so it
  // routes all sessions. A chatgpt-subscription proxy only serves its LiteLLM
  // provider/model (e.g. chatgpt/gpt-5.5), so a Claude-model session — such as a
  // leftover per-session "opus" override — must bypass it and hit Anthropic
  // directly rather than be sent to a proxy that can't serve Claude.
  const litellm = config.litellm;
  const useGateway = litellmRoutesModel(litellm, args.model);
  const useDirectApiKey = !useGateway && config.auth.method === "api-key";

  // Nothing session-specific to wire: pass the daemon's env through unchanged
  // (credentials included, as before), plus the always-on flags.
  if (!args.disableAutoCompact && !useGateway && !useDirectApiKey && !args.sessionKey) {
    return { ...process.env, ...ALWAYS_ON_SDK_ENV };
  }

  // Note: SDK `env` fully replaces the child's env (not merged despite the
  // d.ts claim), so we must spread process.env ourselves — otherwise the
  // child CLI spawns with an empty env and fails to locate its runtime.
  const env: NodeJS.ProcessEnv = { ...process.env };
  Object.assign(env, ALWAYS_ON_SDK_ENV);
  if (useGateway && litellm) {
    env.ANTHROPIC_BASE_URL = litellm.baseUrl;
    // Never forward a direct Anthropic credential inherited by the daemon to
    // a gateway. Only the gateway's explicitly configured key belongs here.
    delete env.ANTHROPIC_API_KEY;
    if (litellm.apiKey) {
      env.ANTHROPIC_API_KEY = litellm.apiKey;
    }
  } else {
    // If the parent daemon was started with ANTHROPIC_BASE_URL pointing at
    // LiteLLM, a deliberate chatgpt-subscription bypass must scrub it so Claude
    // models really go to Anthropic direct.
    delete env.ANTHROPIC_BASE_URL;
    if (useDirectApiKey && config.auth.apiKey) {
      env.ANTHROPIC_API_KEY = config.auth.apiKey;
    } else {
      delete env.ANTHROPIC_API_KEY;
    }
  }
  if (args.disableAutoCompact) {
    env.DISABLE_AUTO_COMPACT = "1";
  }
  // Stamp the session's own key into its SDK child env. The Bash tool
  // inherits it, so CLI commands a session runs (`tomo restart --reason ...`)
  // can attribute their initiator — that's how a restart reason finds its way
  // back to the session that asked for the restart instead of a blessed
  // default session. See src/restart-reason.ts.
  if (args.sessionKey) {
    env[TOMO_SESSION_KEY_ENV] = args.sessionKey;
    // Pair it with our own PID so a `tomo restart` run from this session can
    // prove the daemon that stamped it is the one still running, rather than
    // trusting an env var that any descendant shell inherits forever.
    env[TOMO_DAEMON_PID_ENV] = String(process.pid);
  }
  // Preserve the 1-hour prompt-cache TTL under api-key/gateway auth — without
  // this flag it silently drops to the 5-minute default, so idle-but-alive
  // sessions re-pay full cache writes on their large system-prompt prefixes.
  // No-op on subscription auth. Respect an explicit user override.
  // See https://code.claude.com/docs/en/agent-sdk/cost-tracking
  if (env.ENABLE_PROMPT_CACHING_1H === undefined) {
    env.ENABLE_PROMPT_CACHING_1H = "1";
  }
  return env;
}

/** Combine the turn-budget PostToolBatch hook and the two PreToolUse guards
 *  (private memory, per-agent profiles) into a single SDK `hooks` option.
 *  Returns an empty object when no hook is needed so spread {} stays a no-op.
 *
 *  BOTH PreToolUse producers land in the same event array, which is exactly the
 *  case `mergeHooks` exists for — the old `Object.assign` would have dropped
 *  the private-memory bar the moment this second one was added. Exported so a
 *  test can assert both entries are present, and that the private-memory guard
 *  is the LAST of them (see the comment at its registration). */
export function buildHooksOption(args: {
  turnBudget?: TurnBudget;
  maxTurns: number;
  sessionKey?: string;
  /** Per-call reason this session may not reach `memory/private/`, or null
   *  when it may. Undefined ⇒ the guard is not installed. */
  privateMemoryBar?: () => PrivateMemoryBar | null;
  /** Per-call profile lookup by SDK `agent_type`. Undefined ⇒ the guard is not
   *  installed. */
  agentProfile?: (agentType: string) => AgentProfile | undefined;
  /** Directories of the plugins mounted on this session. The private-memory
   *  guard scans them for PreToolUse hooks that could overwrite its Bash
   *  rewrite. */
  pluginDirs?: () => readonly string[];
  /** Per-group path policy (extra dirs, or unsandboxed). Read per call; a
   *  missing config means every group gets the default policy. */
  groupSandbox?: () => GroupSandboxConfig | undefined;
  /** The key the turn in flight is scoped to (see SessionContext). Lets a
   *  summoned turn inherit its steering group's allowlist entry. */
  scopedCallerKey?: () => string;
  /** Read-and-clear "the model's last message was dropped" flag. Undefined ⇒
   *  the nudge is not installed. */
  undeliveredReply?: () => boolean;
  /** Install the global PostToolUse redactor for known credential values. */
  credentialBroker?: boolean;
  /** The todo store directory; when set, direct writes into it are denied on
   *  every session (todo-store-guard.ts). */
  todosDir?: () => string;
  /** Per-call reason to deny a background launch (pending compact), or null. */
  backgroundLaunchDenial?: () => string | null;
}) {
  const hooks: Record<string, unknown[]> = {};
  if (args.credentialBroker) {
    mergeHooks(hooks, credentialRedactionHooks());
  }
  // The reminders count toward a wall; with no limit (0) there is none to warn about.
  if (args.turnBudget && args.maxTurns > 0) {
    mergeHooks(hooks, turnBudgetHooks(args.turnBudget, args.maxTurns, args.sessionKey));
  }
  if (args.undeliveredReply) {
    mergeHooks(hooks, undeliveredReplyHooks(args.undeliveredReply, args.sessionKey));
  }
  if (args.agentProfile) {
    mergeHooks(hooks, agentProfileGuardHooks(args.sessionKey, args.agentProfile));
  }
  // Deny-only, like the todo guard below.
  if (args.backgroundLaunchDenial) {
    mergeHooks(hooks, backgroundLaunchGuardHooks(args.sessionKey, args.backgroundLaunchDenial));
  }
  // Deny-only, so its place before the private-memory guard costs nothing.
  if (args.todosDir) {
    mergeHooks(hooks, todoStoreGuardHooks(args.sessionKey, config.workspaceDir, args.todosDir));
  }
  // THE PRIVATE-MEMORY GUARD GOES LAST, and the order is load-bearing now that it
  // returns `updatedInput` (the `sandbox-exec` rewrite, see permissions.ts).
  // When two PreToolUse hooks both return `updatedInput` the CLI takes the LAST
  // one and says nothing — verified against the SDK. Deny precedence is
  // unaffected either way (a `deny` from any hook wins, whatever the order), so
  // this costs nothing today: `agentProfileGuardHooks` only ever denies. It is
  // insurance against the day a hook registered after it starts rewriting input
  // and silently drops the sandbox wrap, which fails OPEN.
  if (args.privateMemoryBar) {
    mergeHooks(hooks, privateMemoryGuardHooks(
      args.sessionKey,
      args.privateMemoryBar,
      args.pluginDirs,
      args.groupSandbox,
      args.scopedCallerKey,
    ));
  }
  return Object.keys(hooks).length > 0 ? { hooks } : {};
}

/** Merge one producer's hooks into the accumulator PER EVENT, concatenating
 *  the matcher arrays. A plain `Object.assign` would replace a whole event key,
 *  so two producers registering the same event (e.g. two PreToolUse guards)
 *  would silently drop the first one — and with it the private-memory bar.
 *  Exported for tests. */
export function mergeHooks(
  into: Record<string, unknown[]>,
  from: Record<string, unknown>,
): Record<string, unknown[]> {
  for (const [event, entries] of Object.entries(from)) {
    if (!Array.isArray(entries)) continue;
    into[event] = [...(into[event] ?? []), ...entries];
  }
  return into;
}

/**
 * The global literal-value redactor: replaces ANY tool's output (Bash, Read,
 * MCP, subagent results alike) when it contains a credential the broker
 * stored, before the model or the session file gets it. It is what keeps a
 * value the agent reads with `$(security find-generic-password … -w)` from
 * reaching the transcript when a command echoes it. Literal only, and
 * successful calls only: the CLI cannot rewrite a failed tool's output, so a
 * Bash command that prints a value and then exits non-zero is not scrubbed
 * (pinned in tests/e2e/credential-hooks.e2e.ts). No matcher, so every tool.
 */
export function credentialRedactionHooks() {
  return {
    PostToolUse: [{
      hooks: [async (input: { tool_input?: unknown; tool_response?: unknown }) => {
        // Not ready (a restart could not load the stored values): retry, with
        // backoff; still not ready, fail closed on output that went near the
        // keychain, the one way a value is meant to enter a command.
        const ready = redactionReady() || await ensureRedactionReady();
        let rewritten = scrubDeep(input.tool_response);
        if (!ready && JSON.stringify(input.tool_input ?? "").includes(KEYCHAIN_SERVICE)) {
          log.warn("Withheld a tool result that read the keychain: credential redaction is not ready");
          rewritten = withholdDeep(input.tool_response);
        }
        if (rewritten === input.tool_response) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse" as const,
            updatedToolOutput: rewritten,
          },
        };
      }],
    }],
  };
}

/**
 * What the model is told when its previous message was dropped. Reaches it
 * with the next request, after the tool batch that followed the dropped block.
 */
export const UNDELIVERED_REPLY_NOTICE =
  "Your previous message was written in a thinking block and was NOT delivered to the user. " +
  "If it was meant for them, say it again now as plain text, verbatim. " +
  "If it was internal narration, do not repeat it.";

/**
 * A PostToolBatch hook that fires only when the session reports a dropped
 * reply. Why this event: with `showThinking` off a non-empty thinking block is
 * dropped rather than delivered (live-session.ts header), and every such block
 * seen so far sat directly before a tool call — so the batch that follows it
 * is the earliest point at which the model can be told, and the next request
 * is the one that can repair it. `read()` is read-and-clear on the session
 * side, so the notice goes out once per episode. A block dropped with no tool
 * call after it is not reached here; that is the turn-end path's problem.
 */
function undeliveredReplyHooks(read: () => boolean, sessionKey?: string) {
  return {
    PostToolBatch: [{
      hooks: [async () => {
        if (!read()) return {};
        log.info({ key: sessionKey }, "undelivered reply: nudging the model to restate as text");
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolBatch" as const,
            additionalContext: UNDELIVERED_REPLY_NOTICE,
          },
        };
      }],
    }],
  };
}

/** Build a PostToolBatch hook that increments `budget.count` once per tool
 *  round and injects an `additionalContext` system reminder at 75% and 90% of
 *  maxTurns. PostToolBatch is the right granularity: it fires exactly once per
 *  model→tools→model round, which approximates a turn. */
function turnBudgetHooks(budget: TurnBudget, max: number, sessionKey?: string) {
  const threshold75 = Math.floor(max * 0.75);
  const threshold90 = Math.floor(max * 0.9);
  return {
    PostToolBatch: [{
      hooks: [async () => {
        budget.count++;
        if (budget.count >= threshold90 && !budget.fired90) {
          budget.fired90 = true;
          log.warn({ key: sessionKey, used: budget.count, max }, "Turn budget at 90%");
          return {
            hookSpecificOutput: {
              hookEventName: "PostToolBatch" as const,
              additionalContext: `Turn budget critical: ${budget.count}/${max} turns used (≥90%). The SDK will abort at ${max}. Stop kicking off new tool chains — finish what you have and reply now.`,
            },
          };
        }
        if (budget.count >= threshold75 && !budget.fired75) {
          budget.fired75 = true;
          log.info({ key: sessionKey, used: budget.count, max }, "Turn budget at 75%");
          return {
            hookSpecificOutput: {
              hookEventName: "PostToolBatch" as const,
              additionalContext: `Turn budget notice: ${budget.count}/${max} turns used (≥75%). Start wrapping up — prefer concise next steps over exploratory tool chains.`,
            },
          };
        }
        return {};
      }],
    }],
  };
}
