import type { ElicitationRequest, ElicitationResult, McpSdkServerConfigWithInstance, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { log } from "../logger.js";
import { buildSystemPrompt } from "../workspace/index.js";
import { isGroupSessionKey } from "../lcm/blocks.js";
import { TOMO_INTERNAL_MCP_NAME } from "../mcp/internal-server.js";
import { privateMemoryGuardHooks, skillsCanUseTool } from "./permissions.js";

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
        lines.push(`- Known participants: ${g.participants.join(", ")} (more may join later — you'll see new senders prefixed in incoming messages)`);
      }
      lines.push("- Messages from each sender are prefixed with their name (e.g. `Alice: ...`).");
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

  return {
    model: model ?? config.model,
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
      `mcp__${TOMO_INTERNAL_MCP_NAME}__react_to_latest_message`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_create`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_list`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_remove`,
      ...externalMcpAllowedTools,
    ],
    // SDK v0.2.133 deprecated passing "Skill" in allowedTools — the new path
    // is the top-level `skills` option. The SDK appends `"Skill"` (or
    // `"Skill(name)"` per entry) to the spawned CLI's --allowedTools only when
    // `skills` is defined, so we set it to "all" to keep every discovered
    // skill invocable (same surface as the old `"Skill"` allowedTools entry).
    skills: "all" as const,
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
    includePartialMessages: true,
    maxTurns: config.maxTurns,
    ...buildHooksOption({
      turnBudget,
      maxTurns: config.maxTurns,
      sessionKey: sessionContext?.sessionKey,
      guardPrivateMemory: isGroup,
    }),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    // Note: SDK `env` fully replaces the child's env (not merged despite the
    // d.ts claim), so we must spread process.env ourselves — otherwise the
    // child CLI spawns with an empty env and fails to locate its runtime.
    ...(sessionContext && usesLcmCompact(sessionContext.sessionKey)
      ? { env: { ...process.env, DISABLE_AUTO_COMPACT: "1" } }
      : {}),
  };
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
