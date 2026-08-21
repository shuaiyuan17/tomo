import type { ElicitationRequest, ElicitationResult, McpSdkServerConfigWithInstance, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { log } from "../logger.js";
import { buildSystemPrompt } from "../workspace/index.js";
import { isGroupSessionKey } from "../sessions/keys.js";
import { TOMO_INTERNAL_MCP_NAME } from "../mcp/internal-server.js";
import { isLiteLlmProviderModel, resolveModelName, modelLabel } from "../models.js";
import { litellmRoutesModel } from "../litellm.js";
import { privateMemoryGuardHooks, skillsCanUseTool } from "./permissions.js";
import { resolvePlugins } from "./plugins.js";
import { TOMO_SESSION_KEY_ENV } from "../restart-reason.js";

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
  let systemPrompt = buildSystemPrompt({ isGroup });

  // Inject session context so the agent can use LCM tools
  if (sessionContext) {
    const lines = [
      "\n\n# SESSION — Current Session Info",
      `- Session key: ${sessionContext.sessionKey}`,
    ];
    if (sessionContext.sdkSessionId) {
      lines.push(`- SDK session ID: ${sessionContext.sdkSessionId}`);
    }
    if (sessionContext.group) {
      const g = sessionContext.group;
      lines.push("");
      lines.push("## Group Chat Context");
      if (g.chatTitle) lines.push(`- Group title: "${g.chatTitle}"`);
      if (g.participants && g.participants.length > 0) {
        lines.push("- Known participants (more may join later — you'll see new senders prefixed in incoming messages):");
        for (const p of g.participants) {
          lines.push(`  - ${p}`);
        }
      }
      lines.push("- Messages from each sender are prefixed with their name (e.g. `Alice: ...`). When a sender is matched to a person in your PEOPLE registry, the canonical name is appended in parentheses (e.g. `kw 🚀 (Kevin Wang): ...`) — treat them as the same person.");
      if (g.isPassive) {
        lines.push("- **Listen mode: passive.** You see every message in this group; no @mention is required to address you. Reply only when you have something genuinely useful to add — reply `NO_REPLY` to stay silent. Do not respond to casual chatter, greetings, or messages not directed at you.");
      } else {
        lines.push("- **Listen mode: mention-required.** You only receive messages that explicitly tag you; respond as you would in a DM.");
      }
    }
    systemPrompt += lines.join("\n");
  }

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
  systemPrompt += `\n\n# RUNTIME — Current Model\nYou are currently running on: ${modelDisplay}. This is the real model serving this session right now — trust it over any introspective guess about which model you are.`;

  const sdkEnv = buildSdkEnv({
    disableAutoCompact: shouldDisableAutoCompact,
    model: effectiveModel,
    sessionKey: sessionContext?.sessionKey,
  });
  const thinking = omittedAdaptiveThinkingForModel(effectiveModel);

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
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_remove`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__recall_conversation`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__list_people`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__upsert_person`,
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
    settingSources: ["project"] as ("project")[],
    settings: {
      attribution: {
        commit: "Made by [Tomo](https://github.com/shuaiyuan17/tomo)",
        pr: "Made by [Tomo](https://github.com/shuaiyuan17/tomo)",
      },
    },
    // See ./permissions.ts — canUseTool re-allows `.claude/skills/` writes
    // that bypassPermissions otherwise routes here as denials.
    canUseTool: skillsCanUseTool,
    ...(sessionContext?.onMcpElicitation ? { onElicitation: sessionContext.onMcpElicitation } : {}),
    // Off makes each assistant text block ship whole rather than growing in
    // place; LiveSession's no-deltas path already handles that, so mid-turn
    // messages between tool calls are unaffected. See config.streaming.
    includePartialMessages: config.streaming,
    ...(thinking ? { thinking } : {}),
    maxTurns: config.maxTurns,
    ...buildHooksOption({
      turnBudget,
      maxTurns: config.maxTurns,
      sessionKey: sessionContext?.sessionKey,
      guardPrivateMemory: isGroup,
    }),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    ...(sdkEnv ? { env: sdkEnv } : {}),
    // Steering needs the CLI to re-emit consumed user messages as
    // isReplay events — that's how LiveSession detects whether a steered
    // message merged into the in-flight turn or spilled to a follow-up
    // turn. The CLI flag defaults to off and the SDK has no typed option
    // for it, so pass it through extraArgs when steering is enabled.
    ...(config.steering ? { extraArgs: { "replay-user-messages": null } } : {}),
  };
}

function omittedAdaptiveThinkingForModel(model: string): { type: "adaptive"; display: "omitted" } | undefined {
  const resolved = resolveModelName(model) ?? model;
  if (isLiteLlmProviderModel(resolved)) return undefined;

  const base = resolved.replace(/\[[^\]]+\]$/, "");
  const adaptiveThinkingModel =
    /^claude-sonnet-(?:4-(?:[6-9]|\d{2,})|[5-9](?:-\d+)?|\d{2,}(?:-\d+)?)$/.test(base) ||
    /^claude-opus-(?:4-(?:[6-9]|\d{2,})|[5-9](?:-\d+)?|\d{2,}(?:-\d+)?)$/.test(base);

  return adaptiveThinkingModel
    ? { type: "adaptive", display: "omitted" }
    : undefined;
}

function buildSdkEnv(args: {
  disableAutoCompact: boolean;
  model: string;
  sessionKey?: string;
}): NodeJS.ProcessEnv | null {
  // Decide whether this session routes through the LiteLLM proxy. A generic
  // anthropic-compatible proxy forwards every model (that's its purpose), so it
  // routes all sessions. A chatgpt-subscription proxy only serves its LiteLLM
  // provider/model (e.g. chatgpt/gpt-5.5), so a Claude-model session — such as a
  // leftover per-session "opus" override — must bypass it and hit Anthropic
  // directly rather than be sent to a proxy that can't serve Claude.
  const litellm = config.litellm;
  const useGateway = litellmRoutesModel(litellm, args.model);
  const useDirectApiKey = !useGateway && config.auth.method === "api-key";
  if (!args.disableAutoCompact && !useGateway && !useDirectApiKey && !args.sessionKey) return null;

  // Note: SDK `env` fully replaces the child's env (not merged despite the
  // d.ts claim), so we must spread process.env ourselves — otherwise the
  // child CLI spawns with an empty env and fails to locate its runtime.
  const env: NodeJS.ProcessEnv = { ...process.env };
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

/** Combine the turn-budget PostToolBatch hook and the group-session
 *  private-memory PreToolUse guard into a single SDK `hooks` option. Returns
 *  an empty object when neither hook is needed so spread {} stays a no-op. */
function buildHooksOption(args: {
  turnBudget?: TurnBudget;
  maxTurns: number;
  sessionKey?: string;
  guardPrivateMemory: boolean;
}) {
  const hooks: Record<string, unknown> = {};
  if (args.turnBudget) {
    Object.assign(hooks, turnBudgetHooks(args.turnBudget, args.maxTurns, args.sessionKey));
  }
  if (args.guardPrivateMemory) {
    Object.assign(hooks, privateMemoryGuardHooks(args.sessionKey));
  }
  return Object.keys(hooks).length > 0 ? { hooks } : {};
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
