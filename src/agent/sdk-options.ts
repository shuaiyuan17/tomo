import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { isAbsolute, relative, resolve as pathResolve } from "node:path";
import { minimatch } from "minimatch";
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
 *    file_path lands at-or-inside the private dir.
 *  - Glob: deny when the search root is at-or-inside MEMORY_DIR, or when the
 *    pattern joined to the root could match any path at-or-inside private/.
 *    Wildcard segments like `pri*` are evaluated by minimatch against synthetic
 *    probe paths under private/, so `memory/pri*\/*.md` is denied just like
 *    `memory/private/*.md`.
 *  - Grep: same logic against the `glob` filter when present, plus a root
 *    check that mirrors ripgrep's default-recursive behaviour.
 *  - Bash: deny any command that names `memory` as a path segment. The Bash
 *    surface area is too wide to reason about — shell expansion happens after
 *    the hook fires, `cd` rewrites the working dir, and command substitution
 *    can hide paths. Group sessions don't need Bash for memory ops; the agent
 *    can Read public memory files by name (MEMORY.md is in its prompt).
 *
 *  False positives in groups are tolerable for the same reason — the agent
 *  always has an alternative path through Read on a named public file. */
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
      return globReachesPrivate(root, pattern, ctx);
    }
    case "Grep": {
      const rootRaw = typeof ti.path === "string" ? ti.path : ctx.cwd;
      const root = abs(rootRaw, ctx.cwd);
      const glob = typeof ti.glob === "string" ? ti.glob : "";
      return grepReachesPrivate(root, glob, ctx);
    }
    case "Bash": {
      const cmd = ti.command;
      if (typeof cmd !== "string") return false;
      return bashTouchesMemory(cmd, ctx);
    }
    default:
      return false;
  }
}

/** Decide whether a Glob call rooted at `root` with pattern `pattern` could
 *  surface anything at-or-inside the private memory dir.
 *
 *  Earlier versions split the pattern at its first wildcard and compared the
 *  literal prefix only — that missed `memory/pri*\/*.md`, which expands into
 *  `memory/private/...` at match time. We test the pattern against three
 *  synthetic probe paths anchored under private/ using minimatch. */
function globReachesPrivate(
  root: string,
  pattern: string,
  ctx: { cwd: string; memoryDir: string; privateDir: string },
): boolean {
  if (isInside(root, ctx.memoryDir)) return true;
  const relPrivate = relative(root, ctx.privateDir);
  if (!isRelativeDescendant(relPrivate)) return false;
  const probes = [relPrivate, `${relPrivate}/probe.md`, `${relPrivate}/sub/probe.md`];
  // `nocase: true` covers case-insensitive filesystems (macOS, Windows).
  // `dot: true` so leading-dot files inside private/ aren't given a free pass.
  const opts = { dot: true, nocase: true } as const;
  return probes.some((probe) => minimatch(probe, pattern, opts));
}

/** Decide whether a Grep call rooted at `root` with optional `glob` filter
 *  could surface anything inside the private memory dir.
 *
 *  ripgrep recurses by default. The `glob` filter narrows the file set, but
 *  its semantics differ from a typical glob library:
 *  - If the glob has no `/`, it's a basename filter that matches files at any
 *    depth (e.g. `-g '*.md'` matches `memory/private/x.md`). Path-style
 *    matching would miss this — we deny outright when the root could reach
 *    private/.
 *  - If the glob has `/`, it's a path-style pattern; use minimatch probes.
 *  Without a glob filter, treat the search as fully recursive. */
function grepReachesPrivate(
  root: string,
  glob: string,
  ctx: { cwd: string; memoryDir: string; privateDir: string },
): boolean {
  if (isInside(root, ctx.memoryDir)) return true;
  const relPrivate = relative(root, ctx.privateDir);
  if (!isRelativeDescendant(relPrivate)) return false;
  // No glob filter ⇒ unrestricted recursion ⇒ reaches private/.
  if (!glob) return true;
  // Basename glob (no `/`) is anchored only by file basename; if private/ is
  // reachable from root, ripgrep will scan it and apply the filter there too.
  if (!glob.includes("/")) return true;
  // Path-style glob: probe like Glob does.
  const probes = [relPrivate, `${relPrivate}/probe.md`, `${relPrivate}/sub/probe.md`];
  const opts = { dot: true, nocase: true } as const;
  return probes.some((probe) => minimatch(probe, glob, opts));
}

/** True when `rel` represents a non-empty path that doesn't escape upward —
 *  i.e. it points to a descendant of the reference dir. Used to short-circuit
 *  glob/grep checks when private/ isn't reachable from the search root. */
function isRelativeDescendant(rel: string): boolean {
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Bash guard for group sessions. Shell expansion happens after the hook
 *  fires, so we can't reliably predict which paths a command will actually
 *  touch — `cat memory/pri*\/*.md`, `$(echo memory/private/x)`, and
 *  `cd memory && cat private/x.md` all reach private/ without spelling it
 *  literally. Rather than chase every shell construct, we deny anything that
 *  names `memory` (or `private`) as a path segment, plus any absolute path
 *  that lands inside the memory tree.
 *
 *  Group sessions don't need Bash for memory ops — Read works on named public
 *  files, and the MEMORY.md index is already in the system prompt. */
function bashTouchesMemory(cmd: string, ctx: { cwd: string; memoryDir: string; privateDir: string }): boolean {
  if (cmd.includes(ctx.memoryDir) || cmd.includes(ctx.privateDir)) return true;
  // `memory` or `private` as a path segment: bordered by /, quote, whitespace,
  // shell operator, or string boundary. Catches `memory/x`, `./memory`,
  // `cd memory`, `ls memory/private`, `cat private/foo`, etc.
  const memorySegment = /(^|[\s'"`=()|&;></])(memory|private)(\/|$|[\s'"`=()|&;><])/i;
  return memorySegment.test(cmd);
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
