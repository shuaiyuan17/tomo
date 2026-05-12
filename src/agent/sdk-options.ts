import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { isAbsolute, relative, resolve as pathResolve } from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";
import { buildSystemPrompt, MEMORY_DIR, PRIVATE_MEMORY_DIR, PRIVATE_MEMORY_SUBDIR } from "../workspace/index.js";
import { isGroupSessionKey } from "../lcm/blocks.js";
import { TOMO_INTERNAL_MCP_NAME } from "../mcp/internal-server.js";

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

const SKILLS_DIR = `${config.workspaceDir}/.claude/skills/`;

async function skillsCanUseTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  const filePath = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  if (filePath && filePath.startsWith(SKILLS_DIR)) {
    return { behavior: "allow", updatedInput: input };
  }
  // Bash mkdir / touch / etc. — allow if command targets the skills dir.
  if (toolName === "Bash" && typeof input.command === "string" && input.command.includes(SKILLS_DIR)) {
    return { behavior: "allow", updatedInput: input };
  }
  return {
    behavior: "deny",
    message: `Permission required for ${toolName}${filePath ? ` on ${filePath}` : ""} — only ${SKILLS_DIR}** is auto-approved at this step.`,
  };
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
}

export function sdkOptions(
  internalMcpServer: McpSdkServerConfigWithInstance,
  resumeSessionId?: string,
  model?: string,
  sessionContext?: SessionContext,
  turnBudget?: TurnBudget,
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

  return {
    model: model ?? config.model,
    cwd: config.workspaceDir,
    systemPrompt,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    allowedTools: [
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "WebSearch", "WebFetch", "Agent", "NotebookEdit", "TodoWrite",
      `mcp__${TOMO_INTERNAL_MCP_NAME}__send_message`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__list_sessions`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__rename_group_chat`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__react_to_latest_message`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_create`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_list`,
      `mcp__${TOMO_INTERNAL_MCP_NAME}__schedule_remove`,
    ],
    // SDK v0.2.133 deprecated passing "Skill" in allowedTools — the new path
    // is the top-level `skills` option. The SDK appends `"Skill"` (or
    // `"Skill(name)"` per entry) to the spawned CLI's --allowedTools only when
    // `skills` is defined, so we set it to "all" to keep every discovered
    // skill invocable (same surface as the old `"Skill"` allowedTools entry).
    skills: "all" as const,
    mcpServers: { [TOMO_INTERNAL_MCP_NAME]: internalMcpServer },
    settingSources: ["project"] as ("project")[],
    settings: {
      attribution: {
        commit: "Made by [Tomo](https://github.com/shuaiyuan17/tomo)",
        pr: "Made by [Tomo](https://github.com/shuaiyuan17/tomo)",
      },
    },
    // bypassPermissions auto-approves most tools at step 3 of the permission
    // flow, but writes to `.claude/`, `.git/`, etc. are protected and fall
    // through to step 5 (canUseTool). We narrowly re-allow `.claude/skills/`
    // here so tomo can manage its own skill library, while leaving every
    // other protected path on its default (deny). See:
    // https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes
    canUseTool: skillsCanUseTool,
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

/** PreToolUse hook that denies tool calls that could surface DM-only memory
 *  in a group session. Per SDK docs, PreToolUse denies bypass canUseTool, so
 *  this enforces even in bypassPermissions mode. See {@link isPrivateMemoryAccess}
 *  for per-tool rules — substring matching wasn't enough since parent-dir
 *  scans, alternate relative paths, and shell `cd` tricks reach private/
 *  without spelling the full path. */
function privateMemoryGuardHooks(sessionKey?: string) {
  const ctx = { cwd: config.workspaceDir, memoryDir: MEMORY_DIR, privateDir: PRIVATE_MEMORY_DIR };
  return {
    PreToolUse: [{
      hooks: [async (input: { tool_name: string; tool_input: unknown }) => {
        if (!isPrivateMemoryAccess(input.tool_name, input.tool_input, ctx)) return {};
        log.warn({ key: sessionKey, tool: input.tool_name }, "Blocked group-session access to private memory");
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `\`memory/${PRIVATE_MEMORY_SUBDIR}/\` is DM-only and not accessible from group sessions. Scans rooted at \`memory/\` are also blocked — use Read on a specific public memory file.`,
          },
        };
      }],
    }],
  };
}

/** Resolve `p` to an absolute, normalized path against `cwd` if relative. */
function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? pathResolve(p) : pathResolve(cwd, p);
}

/** True when `child` equals `parent` or sits inside it. Both must be absolute. */
function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Per-tool predicate for the group-session private-memory guard. Exported for
 *  testing. The rules are intentionally conservative:
 *
 *  - File ops (Read/Edit/Write/MultiEdit/NotebookEdit): deny when the resolved
 *    path is at or inside the private dir.
 *  - Glob: deny when the search root is at-or-inside MEMORY_DIR (any glob over
 *    the memory tree is blocked — the agent has MEMORY.md in its prompt and
 *    can Read public files by name). Also deny when the root is an ancestor of
 *    PRIVATE_MEMORY_DIR and the pattern starts with an unanchored `**`, since
 *    that recursion will descend into private/.
 *  - Grep: deny when the search root is at-or-inside MEMORY_DIR. ripgrep
 *    recurses by default, so any grep rooted in memory/ surfaces private
 *    content.
 *  - Bash: deny when any whitespace-separated token resolves into the private
 *    dir, or when the command contains `private` as a path-like segment (since
 *    `cd memory && cat private/x.md` and similar can't be tracked through
 *    shell state). Group sessions don't need bash for memory ops.
 *
 *  False positives in groups are tolerable — the agent can Read public memory
 *  files by name (MEMORY.md is in its prompt) instead of scanning. */
export function isPrivateMemoryAccess(
  toolName: string,
  toolInput: unknown,
  ctx: { cwd: string; memoryDir: string; privateDir: string },
): boolean {
  if (!toolInput || typeof toolInput !== "object") return false;
  const ti = toolInput as Record<string, unknown>;

  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit": {
      const p = ti.file_path;
      if (typeof p !== "string") return false;
      return isInside(abs(p, ctx.cwd), ctx.privateDir);
    }
    case "NotebookEdit": {
      const p = ti.notebook_path;
      if (typeof p !== "string") return false;
      return isInside(abs(p, ctx.cwd), ctx.privateDir);
    }
    case "Glob": {
      const rootRaw = typeof ti.path === "string" ? ti.path : ctx.cwd;
      const root = abs(rootRaw, ctx.cwd);
      const pattern = typeof ti.pattern === "string" ? ti.pattern : "";
      return globOrGrepReachesPrivate(root, pattern, ctx);
    }
    case "Grep": {
      const rootRaw = typeof ti.path === "string" ? ti.path : ctx.cwd;
      const root = abs(rootRaw, ctx.cwd);
      // ripgrep recurses by default. The agent can narrow with `glob` (a path
      // pattern filter); if provided, the same reachability logic applies.
      // If absent, we treat the search as fully recursive and require the root
      // itself to be outside the memory tree.
      const glob = typeof ti.glob === "string" ? ti.glob : "";
      if (glob) return globOrGrepReachesPrivate(root, glob, ctx);
      // Recursive grep with no filter — deny if root is at-or-inside memory/
      // or if it's an ancestor of private/ (would descend into it).
      if (isInside(root, ctx.memoryDir)) return true;
      if (isInside(ctx.privateDir, root)) return true;
      return false;
    }
    case "Bash": {
      const cmd = ti.command;
      if (typeof cmd !== "string") return false;
      return bashTouchesPrivate(cmd, ctx);
    }
    default:
      return false;
  }
}

/** Decide whether a glob/grep operation rooted at `root` with file pattern
 *  `pattern` could surface anything inside the private memory dir.
 *
 *  The effective scan base is `root` joined with the pattern's literal prefix
 *  (the segments before the first wildcard). The operation can reach private/
 *  when:
 *   - the effective base sits at-or-inside private/, OR
 *   - the pattern uses `**` recursion AND the base is an ancestor of private/.
 *
 *  Anchored patterns like `skills/**` from cwd are safe because the base
 *  `cwd/skills` is neither inside nor an ancestor of `cwd/memory/private`. */
function globOrGrepReachesPrivate(
  root: string,
  pattern: string,
  ctx: { cwd: string; memoryDir: string; privateDir: string },
): boolean {
  if (isInside(root, ctx.memoryDir)) return true;
  const segments = pattern.split("/");
  const literalPrefix: string[] = [];
  for (const seg of segments) {
    if (seg.includes("*") || seg.includes("?") || seg.includes("[")) break;
    literalPrefix.push(seg);
  }
  const base = literalPrefix.length === 0 ? root : pathResolve(root, ...literalPrefix);
  if (isInside(base, ctx.privateDir)) return true;
  if (pattern.includes("**") && isInside(ctx.privateDir, base)) return true;
  return false;
}

/** Heuristic check for shell commands. We resolve every whitespace-separated
 *  token as a candidate path; if any token lands inside the private dir, deny.
 *  We also flag the literal segment `private` appearing in a path-like context
 *  (preceded/followed by `/`, quotes, whitespace, or shell separators), since
 *  `cd memory && cat private/x.md` reaches the private dir without spelling
 *  the full relative path, and we can't track shell state across `cd`. */
function bashTouchesPrivate(cmd: string, ctx: { cwd: string; privateDir: string }): boolean {
  if (cmd.includes(ctx.privateDir)) return true;
  // `private` as a path segment: bordered by /, quote, whitespace, shell op, or string boundary.
  const segment = /(^|[\s'"`=()|&;></])private(\/|$|[\s'"`=()|&;><])/;
  if (segment.test(cmd)) return true;
  // Catch tokens that resolve inside private/ (covers absolute paths,
  // `./memory/private`, `../workspace/memory/private`, etc.). Skip the flag
  // strings and anything that looks like a regex/option.
  const tokens = cmd.split(/[\s'"`|&;()<>]+/).filter((t) => t.length > 0 && !t.startsWith("-"));
  for (const t of tokens) {
    // Only treat as path if it has separators or looks like a relative/abs path.
    if (!t.includes("/") && !isAbsolute(t)) continue;
    try {
      if (isInside(abs(t, ctx.cwd), ctx.privateDir)) return true;
    } catch {
      // Malformed token — ignore.
    }
  }
  return false;
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
