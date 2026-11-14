// Per-agent permission scoping, config `agentProfiles` (moved from permissions.ts).
import { config, RESERVED_AGENT_TYPE, type AgentProfile } from "../config.js";
import { log } from "../logger.js";
import { pathCandidates, bashTokens } from "./permission-paths.js";
import { writeVerbIn, writeTargets, commandSegments, segmentCwd, HARMLESS_REDIRECT_TARGET, redirectTargets, isAbsoluteish, pathishTokens, landsIn, landsInWriteRoot } from "./bash-write-targets.js";
import { MONITOR_TOOL } from "./private-memory-guard.js";

// ---------------------------------------------------------------------------
// Per-agent permission scoping (config `agentProfiles`)
// ---------------------------------------------------------------------------

/**
 * POLICY, NOT A SANDBOX. Read this before trusting anything below.
 *
 * Every session runs `permissionMode: "bypassPermissions"` (sdk-options.ts) and
 * the SDK propagates that mode into subagents, so a subagent inherits the
 * daemon owner's entire machine. `AgentDefinition` scopes TOOLS but has no
 * notion of a path, so `tools: Read, Grep, Glob, Bash` on a "read-only
 * reviewer" is a full shell.
 *
 * These hooks close the accident-shaped part of that hole. They do NOT close
 * the adversarial-shaped part. The checks run in the daemon and the thing they
 * constrain is a CLI child process, which is the wrong side of a trust boundary
 * for a real sandbox — and by deliberate decision `readonly` allows `$(…)`,
 * backticks and pipes, any of which can assemble a command no token scan here
 * can see. An agent that wants out gets out.
 *
 * THREE LIMITS WORTH KNOWING BEFORE YOU RELY ON THIS.
 *
 *  1. THE DAEMON DOES NOT KNOW A SUBAGENT'S CWD. The Agent tool's
 *     `isolation: "worktree"` never reports the worktree path back, so a
 *     RELATIVE token is a path whose destination is unknowable here. It is
 *     therefore never judged on the ALLOW side — `mkdir -p Sources/New` and
 *     `rm -rf build/Old` pass in `worktree` mode, which is the point of that
 *     mode — and on the DENY side it is resolved against the WORKSPACE, which
 *     is the cwd a subagent inherits when it has no worktree of its own. That
 *     is what catches `rm -rf memory`, `rm -rf *` and `git clean -fdx`. What
 *     it does not catch, and cannot, is an agent destroying its own worktree.
 *  2. `denyPaths` IS A WRITE FENCE, NOT A READ FENCE. A reviewer's job is to
 *     read the checkouts it must never modify. `denyReadPaths` is the separate,
 *     blunter list for the paths where reading is itself the harm.
 *  3. THE VERB LIST IS A LIST. It is long and it will still be incomplete;
 *     every entry is a command someone noticed. Treat a gap as a bug report,
 *     not as a security boundary that failed.
 *  4. A REDIRECTION INSIDE A QUOTED SUB-SHELL IS INVISIBLE.
 *     `sh -c 'cat x > /etc/passwd'` and `bash -c "… >> …"` put the whole
 *     command inside one quoted run, and {@link maskQuotedOperators} blanks
 *     shell operators inside quotes — which is exactly what it must do for
 *     `awk '$1 > 5' f`, and exactly wrong here. The two are the same bytes;
 *     telling them apart means knowing that `sh -c` re-parses its argument as
 *     a command, i.e. writing the shell parser this file has declined to
 *     write. `sh`/`bash`/`zsh` are not on the verb list either, so this is a
 *     hole, and it is the same hole as `$(…)`: an agent that reaches for
 *     `sh -c` to get a redirection past the guard is jailbreaking, which is
 *     v2's problem (a real sandbox), not a token scan's.
 *
 * Why PreToolUse and not `canUseTool`: `canUseTool` is handed an opaque
 * `agentID` with no `agent_type` (sdk.d.ts), so it cannot tell WHICH profile
 * applies — and a PreToolUse denial bypasses `canUseTool` anyway, the same
 * property the private-memory bar above relies on.
 */

/** Tools whose whole job is to write one named file. */
const AGENT_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Tool-input fields that can name a path. `content` is deliberately absent:
 *  prose that happens to quote a protected path is not an access. */
const PATH_BEARING_INPUTS = ["file_path", "notebook_path", "path", "pattern", "glob", "command"] as const;

/** How much of a subagent's Bash command goes into the audit line. Enough to
 *  identify the command, short enough that a log shipper is not carrying whole
 *  heredocs. */
const BASH_AUDIT_CHARS = 120;

/** The shape of the PreToolUse payload this guard reads. `agent_id` is the
 *  documented way to tell a subagent call from a main-thread one — it is
 *  ABSENT on the main thread even in `--agent` sessions, while `agent_type` is
 *  present in both — so the main-thread test keys off `agent_id` alone. */
interface AgentHookInput {
  tool_name: string;
  tool_input: unknown;
  agent_id?: string;
  agent_type?: string;
}

/**
 * PreToolUse hook that applies the calling subagent's `agentProfiles` entry.
 *
 * Three populations, three outcomes:
 *  - MAIN THREAD (no `agent_id`) — returns `{}` before anything else runs. The
 *    owner's own turn is not scoped by this and never has been.
 *  - A SUBAGENT WITH NO PROFILE — fail-OPEN, plus one `log.warn` per
 *    (session, agent_type) naming the tool. The set lives in this closure and
 *    the closure is built once per live session, so "once per session per type"
 *    is structural rather than a counter someone has to maintain. The point of
 *    the warning is measurement: nobody knows the real tool surface of
 *    `general-purpose` / `Explore` / ad-hoc delegations, and fail-closed would
 *    break all of them on turn one. Flip the default once the logs say what it
 *    would cost.
 *  - A SUBAGENT WITH A PROFILE — {@link agentProfileDenial} decides.
 *
 * Every subagent Bash call is logged at info regardless of the decision, so the
 * audit trail covers the fail-open population too — that is where the surface
 * being measured actually lives.
 *
 * `lookup` is a FUNCTION, not the map: it is resolved per tool call, so a
 * profile change does not have to wait for every live session to be recycled.
 */
export function agentProfileGuardHooks(
  sessionKey: string | undefined,
  lookup: (agentType: string) => AgentProfile | undefined,
) {
  const cwd = config.workspaceDir;
  const warnedTypes = new Set<string>();
  return {
    PreToolUse: [{
      hooks: [async (input: AgentHookInput) => {
        if (!input.agent_id) return {};
        const agentType = input.agent_type ?? RESERVED_AGENT_TYPE;

        if (input.tool_name === "Bash" || input.tool_name === MONITOR_TOOL) {
          const command = (input.tool_input as { command?: unknown } | null | undefined)?.command;
          log.info(
            {
              key: sessionKey,
              agentType,
              agentId: input.agent_id,
              command: typeof command === "string" ? command.slice(0, BASH_AUDIT_CHARS) : undefined,
            },
            "Subagent Bash call",
          );
        }

        const profile = lookup(agentType);
        if (!profile) {
          if (!warnedTypes.has(agentType)) {
            warnedTypes.add(agentType);
            log.warn(
              { key: sessionKey, agentType, tool: input.tool_name },
              "Subagent has no agentProfiles entry — allowing unscoped (fail-open)",
            );
          }
          return {};
        }

        const reason = agentProfileDenial(profile, input.tool_name, input.tool_input, cwd);
        if (!reason) return {};
        log.warn(
          { key: sessionKey, agentType, tool: input.tool_name, reason },
          "Blocked by agent permission profile",
        );
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason:
              `Blocked by the "${agentType}" agent permission profile: ${reason}`,
          },
        };
      }],
    }],
  };
}

/**
 * Why this tool call is refused under `profile` — or null when it is allowed.
 * Exported for testing.
 *
 * `denyReadPaths` is checked for EVERY tool, including Read/Grep/Glob.
 * Everything else is a write rule and only the write tools and Bash reach it.
 */
export function agentProfileDenial(
  profile: AgentProfile,
  toolName: string,
  toolInput: unknown,
  cwd: string,
): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const ti = toolInput as Record<string, unknown>;

  const secret = secretMentionDenial(profile, toolName, ti, cwd);
  if (secret) return secret;

  if (AGENT_WRITE_TOOLS.has(toolName)) {
    const p = toolName === "NotebookEdit" ? ti.notebook_path : ti.file_path;
    if (typeof p !== "string") return null;
    return writeDenial(profile, p, cwd, toolName);
  }
  // Monitor's `command` is a shell command like Bash's: a `readonly` profile
  // that refused `Bash { command: "rm …" }` must refuse the same command
  // handed to Monitor.
  if (toolName === "Bash" || toolName === MONITOR_TOOL) {
    const cmd = ti.command;
    if (typeof cmd !== "string") return null;
    return bashDenial(profile, cmd, cwd);
  }
  return null;
}

/**
 * `denyReadPaths` — the secrets list. ANY mention by ANY tool.
 *
 * Two passes, because each catches what the other misses. The RAW SUBSTRING
 * pass sees a path named somewhere the tokenizer does not look (inside a
 * heredoc body, inside a `--flag=…` cluster split some other way). The
 * RESOLUTION pass sees a path the raw text does not spell: `~/.ssh/id_rsa`,
 * a symlink into the private memory tree, `memory/private/x` relative to the
 * workspace the subagent inherited its cwd from.
 */
function secretMentionDenial(
  profile: AgentProfile,
  toolName: string,
  ti: Record<string, unknown>,
  cwd: string,
): string | null {
  if (profile.denyReadPaths.length === 0) return null;
  for (const field of PATH_BEARING_INPUTS) {
    const value = ti[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const spelled = profile.denyReadPaths.find((deny) => value.includes(deny));
    if (spelled) {
      return `\`${spelled}\` is on this agent's denyReadPaths, and ${toolName}'s \`${field}\` names it.`;
    }
    const candidates = field === "command" ? pathishTokens(value) : [value];
    const hit = candidates.find((c) => landsIn(c, profile.denyReadPaths, cwd, false));
    if (hit !== undefined) return `\`${hit}\` is on this agent's denyReadPaths (not readable by this agent).`;
  }
  return null;
}

/**
 * A write tool's target.
 *
 * `denyPaths` first, so a path inside both a denyPath and a writeRoot reports
 * the rule that decided it. Then `writeRoots` — UNLESS the mode is `full`,
 * which switches writeRoots off for the file tools exactly as it does for Bash:
 * a profile that says "this agent may run any command anywhere except these
 * paths" and then refuses its `Write` calls is incoherent, and the incoherence
 * was invisible because the two halves lived in different functions.
 */
function writeDenial(profile: AgentProfile, p: string, cwd: string, toolName: string): string | null {
  if (landsIn(p, profile.denyPaths, cwd, false)) {
    return `\`${p}\` is on this agent's denyPaths (readable, but not writable by this agent).`;
  }
  if (profile.bash === "full") return null;
  if (!landsInWriteRoot(p, profile, cwd)) {
    return profile.writeRoots.length === 0
      ? `this agent has no writeRoots, so ${toolName} is denied everywhere.`
      : `\`${p}\` is outside this agent's writeRoots (${profile.writeRoots.join(", ")}).`;
  }
  return null;
}

/**
 * Bash, by mode. NOT A SHELL PARSER — see the header above.
 *
 * The order matters and is not arbitrary:
 *
 *  1. `none` refuses everything, before any parsing.
 *  2. `denyPaths` bind WRITES ONLY, so they are consulted only for a command
 *     that names a write verb or carries a redirection. `cat`, `git log` and
 *     `git -C <denyPath> worktree list` are reads and are allowed. (The read
 *     fence is `denyReadPaths`, applied to every tool one level up.)
 *  3. `full` stops here — the deny lists are its whole policy.
 *  4. Redirections are the write no verb scan can see (`echo x > y` names no
 *     write command at all), so they are checked against `writeRoots`.
 *  5. A write VERB is held to the writeRoots by the same test in both surviving
 *     modes, differing in one clause. See {@link writeVerbTargetDenial}.
 *
 * READONLY USED TO REFUSE THE VERB OUTRIGHT, AND CONTRADICTED ITSELF DOING IT.
 * A `readonly` profile with `/tmp` in its writeRoots allowed
 * `Write /tmp/ok` and `echo hi > /tmp/ok`, and refused `touch /tmp/marker`,
 * `mkdir -p /tmp/dd`, `cp /tmp/a /tmp/b` and `rm -rf /tmp/scratch` — the same
 * write, to the same permitted directory, decided three different ways
 * depending on which surface expressed it. The bar was not even a bar: `cat a >
 * b` walked round it, because a redirection names no verb. `readonly` now means
 * what its writeRoots say it means.
 */
function bashDenial(profile: AgentProfile, cmd: string, cwd: string): string | null {
  if (profile.bash === "none") {
    return "the Bash tool is not available to this agent type (bash: \"none\").";
  }

  const verb = writeVerbIn(cmd);
  const redirects = redirectTargets(cmd);

  const blocked = writeTargets(cmd, verb, redirects, cwd)
    .find((target) => landsIn(target.path, profile.denyPaths, cwd, true));
  if (blocked) {
    return `${blocked.why} \`${blocked.path}\`, which is on this agent's denyPaths (readable, but not writable by this agent).`;
  }

  if (profile.bash === "full") return null;

  for (const target of redirects) {
    if (HARMLESS_REDIRECT_TARGET.test(target)) continue;
    // A relative target lands somewhere this code cannot know — not judged on
    // the allow side. It was already judged on the deny side above.
    if (!isAbsoluteish(target)) continue;
    if (!landsInWriteRoot(target, profile, cwd)) {
      return `the redirection target \`${target}\` is outside this agent's writeRoots.`;
    }
  }

  return verb ? writeVerbTargetDenial(profile, cmd, verb, cwd) : null;
}

/**
 * Hold a write verb's targets to the writeRoots. ONE TEST, TWO MODES, ONE
 * CLAUSE OF DIFFERENCE.
 *
 * Both modes require every ABSOLUTE path token to land inside a writeRoot;
 * relative tokens are not judged, because the daemon does not know the cwd they
 * resolve against (limit 1 in the header).
 *
 * `readonly` adds the clause: at least one absolute token must be PRESENT. That
 * is the whole of the distinction between the two modes, and it is the right
 * shape for it. A `readonly` agent may write only where it can name the place
 * out loud — `touch /tmp/marker` is a write to a directory its profile grants,
 * while `rm -rf x` and `rm -rf *` name a destination nobody in this process can
 * locate, so they stay refused. A `worktree` agent is trusted with its own
 * unnamed cwd and keeps `rm -rf build/Old`.
 */
function writeVerbTargetDenial(
  profile: AgentProfile,
  cmd: string,
  verb: string,
  cwd: string,
): string | null {
  for (const segment of commandSegments(cmd)) {
    const segVerb = writeVerbIn(segment);
    if (!segVerb) continue;
    const tokens = bashTokens(segment);
    const segCwd = segmentCwd(tokens, cwd);
    // `/dev/null` and friends are sinks, not places: `… > /dev/null` in the
    // same segment as `rm -rf /tmp/scratch` must not hold `rm` to `/dev/null`.
    const absolute = tokens
      .flatMap(pathCandidates)
      .filter(isAbsoluteish)
      .filter((token) => !HARMLESS_REDIRECT_TARGET.test(token));
    // A git segment repointed at an absolute worktree names its place out loud
    // even when its pathspecs are relative — that is what `-C` is for.
    if (profile.bash === "readonly" && absolute.length === 0 && segCwd === cwd) {
      return `\`${segVerb}\` writes, and in "readonly" mode a write has to name an absolute path inside this agent's writeRoots (${profile.writeRoots.join(", ") || "none configured"}).`;
    }
    const outside = absolute.find((token) => !landsInWriteRoot(token, profile, segCwd));
    if (outside !== undefined) {
      return `\`${segVerb}\` writes and \`${outside}\` is outside this agent's writeRoots.`;
    }
    if (segCwd !== cwd && !landsInWriteRoot(segCwd, profile, cwd)) {
      return `\`${segVerb}\` writes under \`${segCwd}\` (git -C / --work-tree), which is outside this agent's writeRoots.`;
    }
  }
  void verb;
  return null;
}
