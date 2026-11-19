// Group-session / summoned-turn guard for memory/private/ (moved from permissions.ts).
import { config } from "../config.js";
import { log } from "../logger.js";
import { HOME_SCENE_DIR, MEMORY_DIR, PRIVATE_MEMORY_DIR, PRIVATE_MEMORY_SUBDIR } from "../workspace/index.js";
import { sandboxedBashCommand } from "./bash-sandbox.js";
import { MIXED_AUDIENCE_KEY } from "./audience.js";
import { loadedSettingsFiles } from "./setting-sources.js";
import { barredSearch, isHarnessDataAccess, isHomeWrite, isPrivateMemoryAccess, SEARCH_TOOLS, SEND_MESSAGE_TOOL } from "./private-memory-access.js";
export { barredSearch, isHarnessDataAccess, isHomeWrite, isPrivateMemoryAccess, SEARCH_TOOLS, SEND_MESSAGE_TOOL };
import { join } from "node:path";
import { landsInPrivate } from "./private-memory-reach.js";
import { expandTilde } from "./bash-write-targets.js";
import { groupPathDenial, groupPathDenialReason, groupPathPolicy, permanentGrantDenial, type GroupPathPolicy, type GroupSandboxConfig, type GroupSandboxEntry } from "./group-fs-policy.js";
import type { PermissionAssessment } from "../permissions/broker.js";

// ---------------------------------------------------------------------------
// Group-session guard for memory/private/
// ---------------------------------------------------------------------------

/**
 * Why the turn in flight may not reach `memory/private/` — or `null` when it
 * may.
 *
 * Two bars, not one, because the session key is not the whole story. A GROUP
 * session is barred for its whole life. A `dm:` session is barred only for the
 * duration of a SUMMONED turn: `/summon` routes a group's messages onto the
 * owner's dm: session (router `summonGroup`), so `isGroupSessionKey("dm:x")`
 * is false for turns that any participant of that group can steer.
 */
export type PrivateMemoryBar = "group-session" | "summoned-turn";

/**
 * The ONE place the bar is decided, so every enforcement point agrees.
 *
 * Three enforcement points now read it: the PreToolUse hook (sdk-options.ts),
 * the reply-delivery attachment check (delivery-pipeline.ts) and — through the
 * hook — the `send_message` tool. A second, independently-written copy of this
 * rule is how one of them ends up open while the others are shut.
 *
 * `isGroup` rather than the session key, deliberately: this module has no
 * business parsing session keys (that is `sessions/keys.ts`), and taking the
 * answer as a parameter keeps its import graph small enough that the guard can
 * be unit-tested without booting the world.
 */
export function privateMemoryBarFor(
  isGroup: boolean,
  isOwnAudienceTurn?: () => boolean,
): PrivateMemoryBar | null {
  if (isGroup) return "group-session";
  if (isOwnAudienceTurn && !isOwnAudienceTurn()) return "summoned-turn";
  return null;
}

/** Denial text for a group session — the session is barred for its lifetime. */
export const PRIVATE_MEMORY_GROUP_DENIAL =
  `\`memory/${PRIVATE_MEMORY_SUBDIR}/\` is DM-only and not accessible from group sessions. Scans rooted at \`memory/\` are also blocked — use Read on a specific public memory file.`;

/**
 * Denial text for a summoned turn. Names the reason and the way round it, so
 * the model can say why rather than retrying with a different spelling of the
 * same path. Deliberately does NOT say the file exists.
 */
export const PRIVATE_MEMORY_SUMMONED_DENIAL =
  `\`memory/${PRIVATE_MEMORY_SUBDIR}/\` is unavailable during a summoned turn. This turn's messages come from a group summoned into this session (or span several audiences), so the owner's private memory is not readable from it — the session key says "private DM", but a group is steering. Scans rooted at \`memory/\` are blocked for the same reason: use Read on a specific public memory file, or ask again in the owner's own DM (\`/dismiss\` ends the summon).`;

/**
 * Tomo's own state directories, barred on a barred turn: `<tomoHome>/data/`
 * and the sessions dir (normally inside it, but relocatable). Everything the
 * harness keeps about every conversation lives there.
 */
export function harnessDataDirs(): string[] {
  const dirs = new Set<string>();
  if (config.tomoHome) dirs.add(join(config.tomoHome, "data"));
  if (config.sessionsDir) dirs.add(config.sessionsDir);
  return [...dirs];
}

/** Denial text for a search rooted at, inside or above a barred directory. */
export function barredSearchDenialReason(bar: PrivateMemoryBar): string {
  return `On this turn a search may not start at, inside or above \`memory/${PRIVATE_MEMORY_SUBDIR}/\` or Tomo's \`~/.tomo/data/\` (${bar === "group-session" ? "a group session" : "a group is steering this session"}). Point \`path\` at the specific subdirectory you mean, below them and not containing them — for example a folder in the workspace other than \`memory/\`.`;
}

/** Denial text for a file-tool call into Tomo's `data/` on a barred turn. */
export function harnessDataDenialReason(bar: PrivateMemoryBar): string {
  return `Tomo's own state directory (\`~/.tomo/data/\`: transcripts, the inbox, the usage ledger) is not readable or writable ${bar === "group-session"
    ? "from a group session"
    : "during a summoned turn (a group is steering this session)"}. It holds every conversation, the owner's DMs included; use the tools for what you need from it.`;
}

export function privateMemoryDenialReason(bar: PrivateMemoryBar): string {
  return bar === "group-session" ? PRIVATE_MEMORY_GROUP_DENIAL : PRIVATE_MEMORY_SUMMONED_DENIAL;
}

/**
 * Denial text for a write into Tomo's home on a barred turn. The home is the
 * owner conversation's alone (the design the owner approved): a group may
 * look at the scene, not change it.
 */
export function homeWriteDenialReason(bar: PrivateMemoryBar): string {
  return `\`home/\` (your home, the room the owner sees in the web UI) can only be changed from the owner's own conversation. ${bar === "group-session"
    ? "This is a group session: you may read the scene, not write it."
    : "This turn's messages come from a group summoned into this session, so the home is read-only for it; ask again in the owner's own DM."}`;
}

/**
 * Why the shell is withheld when it cannot be SANDBOXED — the fallback, no
 * longer the rule.
 *
 * Filtering the command TEXT was never the answer, and still isn't.
 * {@link bashTouchesMemory} is a token scan over what the model typed, and any
 * interpreter writes a path that text never spells:
 *
 *     node -e 'process.stdout.write(require("node:fs")
 *       .readFileSync("mem"+"ory/pri"+"vate/note.txt","utf8"))'
 *
 * — no `memory`, no `private`, no `$`, no backtick, no glob, nothing for a
 * regex to find. `python -c`, `perl -e`, `osascript -e`, `bash ./script.sh`,
 * and any script the agent wrote on an earlier turn are the same shape, and
 * they are not a list that can be completed: the argument to an interpreter is
 * a program, and deciding what a program reads is not a job for a regex.
 *
 * The text was the wrong LAYER, though, not the only one. A barred turn now gets
 * its shell, wrapped in a `sandbox-exec` profile that denies
 * `memory/private/` in the kernel — see `./bash-sandbox.ts`. The assembled path
 * above gets `EPERM` at `open(2)`, where the path is resolved and the spelling
 * has stopped mattering.
 *
 * This text is what remains for the case where that wrap is unavailable (no
 * `sandbox-exec`, an unwritable profile, a malformed tool input): the shell is
 * withheld, exactly as before. The fallback is WITHHOLD, never an unsandboxed
 * shell, so a host without the sandbox is no worse off than it was and a host
 * with it is not trusted to have it.
 */
export const PRIVATE_MEMORY_BASH_WITHHELD =
  `The Bash tool is not available on this turn. It normally runs inside a \`sandbox-exec\` profile that makes \`memory/${PRIVATE_MEMORY_SUBDIR}/\` unreadable at the kernel level, but that sandbox could not be set up on this host — and an unsandboxed shell is not offered as a substitute, because no filter over command text can scope a shell away from a directory (any interpreter can assemble a path the text never spells). Use Read on a named public file (MEMORY.md is already in your prompt), or Glob/Grep outside the memory tree.`;

/** The reason handed back for a denied Bash call: why the shell is gone, then
 *  why this turn is barred at all (and, for a summoned turn, the way round). */
export function privateMemoryBashDenial(bar: PrivateMemoryBar): string {
  return `${PRIVATE_MEMORY_BASH_WITHHELD}\n\n${privateMemoryDenialReason(bar)}`;
}

/** The SDK's `Monitor` tool: runs `command` in a shell (or opens a
 *  WebSocket) and streams each line back as an event, for as long as the
 *  watch lasts — past the end of the turn that started it. */
export const MONITOR_TOOL = "Monitor";

/**
 * Tools refused outright on a barred turn (audit P0-3).
 *
 * `Monitor` runs `command` in a shell and streams every stdout line back to
 * the model — a shell the Bash arm below never saw, unsandboxed. `Workflow`
 * runs a script of subagents. The schedulers (`CronCreate`, `ScheduleWakeup`,
 * `RemoteTrigger`) fire a fresh SDK-initiated turn later, with no inbound
 * audience attached, which on a `dm:` session resolves to the owner's scope.
 * None of them is needed in a group; tomo's own `schedule_create`, which
 * records the caller's scope, is the way to schedule from one.
 *
 * (Background subagents and background shells started by a summoned turn are
 * a separate, architectural problem — audit P0-4 — tracked in its own PR.)
 *
 * Returns the denial text, or null when the call may proceed.
 */
export function barredToolDenial(toolName: string, bar: PrivateMemoryBar): string | null {
  if (!BARRED_TURN_TOOLS.has(toolName)) return null;
  return `${toolName} is not available on this turn: it runs a shell or schedules work outside this turn's private-memory bar. Use Bash (sandboxed) for shell work, or schedule_create to schedule something.\n\n${privateMemoryDenialReason(bar)}`;
}

/** See {@link barredToolDenial}. */
export const BARRED_TURN_TOOLS: ReadonlySet<string> = new Set([
  MONITOR_TOOL, "Workflow", "CronCreate", "ScheduleWakeup", "RemoteTrigger",
]);

/** PreToolUse hook that denies tool calls that could surface DM-only memory
 *  in a session that is not entitled to it. Per SDK docs, PreToolUse denies
 *  bypass canUseTool, so this enforces even in bypassPermissions mode. See
 *  {@link isPrivateMemoryAccess} for per-tool rules — substring matching wasn't
 *  enough since parent-dir scans, alternate relative paths, and shell `cd`
 *  tricks reach private/ without spelling the full path.
 *
 *  `bar` is a GETTER, resolved on every tool call, not a boolean fixed when the
 *  hook is built. The hook is installed once per live session
 *  (live-session-manager.ts), but a dm: session's entitlement changes turn to
 *  turn while a group is summoned into it — a fixed boolean would either leave
 *  the summoned window open or lock the owner out of their own memory for the
 *  life of the session.
 *
 *  BASH IS REWRITTEN, NOT DENIED, while the bar is up. The command is wrapped in
 *  a `sandbox-exec` profile that denies `memory/private/` in the kernel
 *  (`./bash-sandbox.ts`) and handed back through the hook's `updatedInput`, so
 *  the turn keeps its shell and the directory stays unreachable however the path
 *  is spelled. `updatedInput` is the SDK's documented seam for this
 *  ("`updatedInput` - Modified tool input (PreToolUse only)") and is returned
 *  WITHOUT a `permissionDecision`: the CLI collects the rewritten input
 *  independently of the decision, so a bare rewrite neither approves the call
 *  nor suppresses the other PreToolUse guards — `deny` from any of them still
 *  wins. Only when the wrap is unavailable does the old outright deny stand;
 *  see {@link PRIVATE_MEMORY_BASH_WITHHELD}.
 *
 *  SUBAGENTS GO THROUGH HERE TOO. The SDK propagates the session's hooks into
 *  Agent-tool children, so a delegated `Bash` call on a barred turn reaches
 *  this same PreToolUse callback and is sandboxed by the same arm. That matters:
 *  `agentProfileGuardHooks` below fails OPEN for a subagent type with no
 *  profile, so a subagent is not a way round the bar only because this guard is
 *  not scoped to the main thread. */
export function privateMemoryGuardHooks(
  sessionKey: string | undefined,
  bar: () => PrivateMemoryBar | null,
  pluginDirs: () => readonly string[] = () => [],
  /**
   * The group config this call is judged by. `once`: may this call use the
   * session's Allow-once grants? Only a FOREGROUND call of the MAIN agent may
   * (see {@link mayUseOnceGrants}); a getter that has no such grants ignores it.
   */
  groupSandbox: (opts: { once: boolean }) => GroupSandboxConfig | undefined = () => undefined,
  scopedCallerKey: () => string | undefined = () => undefined,
  /** Told of each sandboxed Bash command and each file-tool call the group
   *  policy refuses: the card of a later `request_permission` shows it as the
   *  trigger. Observational only; it decides nothing. */
  noteCall: (text: string) => void = () => {},
) {
  const ctx = { cwd: config.workspaceDir, memoryDir: MEMORY_DIR, privateDir: PRIVATE_MEMORY_DIR };
  const homeCtx = { cwd: config.workspaceDir, homeDir: HOME_SCENE_DIR };
  const dataCtx = { cwd: config.workspaceDir, dataDirs: harnessDataDirs() };
  const searchCtx = { cwd: config.workspaceDir, barredDirs: [PRIVATE_MEMORY_DIR, ...dataCtx.dataDirs] };
  // The settings files the query actually loads, so the Bash arm can refuse when
  // one of them carries a PreToolUse hook that could undo the sandbox rewrite.
  // Derived from the same constant the query option uses (setting-sources.ts) —
  // the list must not be able to drift.
  const settingsFiles = loadedSettingsFiles(config.workspaceDir);
  return {
    PreToolUse: [{
      // Fail CLOSED: by default a callback that throws lets the tool call through
      // (and under bypassPermissions nothing else stops it). A security guard
      // must deny instead, so a crash here blocks the call.
      onFailure: "block" as const,
      hooks: [async (input: { tool_name: string; tool_input: unknown; agent_id?: string }) => {
        // Cheap check first: `bar()` is a map lookup, `isPrivateMemoryAccess`
        // can hit the filesystem. Order does not affect the outcome.
        const reason = bar();
        if (!reason) return {};
        const outlives = barredToolDenial(input.tool_name, reason);
        if (outlives) {
          log.warn(
            { key: sessionKey, tool: input.tool_name, bar: reason },
            "Blocked a tool that is unavailable on a private-memory-barred turn",
          );
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: outlives,
            },
          };
        }
        const isBash = input.tool_name === "Bash";
        const once = mayUseOnceGrants(input);
        const sandboxFor = () => groupSandbox({ once });
        if (isBash) {
          // A turn belonging to an allowlisted group runs Bash UNSANDBOXED.
          // That is full trust, not a narrower hole: the Read/Edit/Glob/Grep/
          // MEDIA denials below still fire, but an unsandboxed shell can read
          // the same paths, so allowlisting a group hands its participants the
          // owner's private memory through Bash.
          const group = groupEntryFor(reason, sessionKey, sandboxFor, scopedCallerKey);
          if (group?.entry.unsandboxed) {
            log.info(
              { key: sessionKey, tool: input.tool_name, allowlistedKey: group.key, bar: reason },
              "Bash allowed unsandboxed for allowlisted group",
            );
            return {};
          }
          const sandboxed = sandboxedBashInput(input.tool_input, {
            settingsFiles,
            pluginDirs: pluginDirs(),
          }, groupPolicy(group?.entry, dataCtx.dataDirs));
          if (sandboxed) {
            if (typeof (input.tool_input as { command?: unknown }).command === "string") {
              noteCall((input.tool_input as { command: string }).command);
            }
            log.info(
              { key: sessionKey, tool: input.tool_name, bar: reason },
              "Sandboxed Bash on a private-memory-barred turn",
            );
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                updatedInput: sandboxed,
              },
            };
          }
        } else if (!isPrivateMemoryAccess(input.tool_name, input.tool_input, ctx)) {
          // Searches, structurally: rooted at, inside or above any barred dir
          // is refused, whatever the pattern says (the predicates above judge
          // the pattern, which is the arm that kept leaking).
          if (SEARCH_TOOLS.has(input.tool_name) && barredSearch(input.tool_name, input.tool_input, searchCtx)) {
            log.warn({ key: sessionKey, tool: input.tool_name, bar: reason }, "Blocked a search over a barred directory");
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: barredSearchDenialReason(reason),
              },
            };
          }
          // The third barred directory, reads and writes: Tomo's own data/.
          if (isHarnessDataAccess(input.tool_name, input.tool_input, dataCtx)) {
            log.warn({ key: sessionKey, tool: input.tool_name, bar: reason }, "Blocked access to Tomo's data directory on a private-memory-barred turn");
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: harnessDataDenialReason(reason),
              },
            };
          }
          // The second barred directory, write-only: Tomo's home.
          if (isHomeWrite(input.tool_name, input.tool_input, homeCtx)) {
            log.warn({ key: sessionKey, tool: input.tool_name, bar: reason }, "Blocked a write to the home on a private-memory-barred turn");
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: homeWriteDenialReason(reason),
              },
            };
          }
          // Everything else: the group path policy the Bash sandbox enforces,
          // so the file tools cannot reach what the shell cannot (the config
          // file, secrets/, the keychains, anything outside the workspace).
          // An unsandboxed group keeps the guards above and nothing more.
          const group = groupEntryFor(reason, sessionKey, sandboxFor, scopedCallerKey);
          if (group?.entry.unsandboxed) return {};
          const denial = groupPathDenial(input.tool_name, input.tool_input, config.workspaceDir, groupPolicy(group?.entry, dataCtx.dataDirs));
          if (!denial) return {};
          noteCall(`${input.tool_name} ${toolPathOf(input.tool_input)}`.trim());
          log.warn({ key: sessionKey, tool: input.tool_name, bar: reason }, "Blocked a file-tool call outside the group path policy");
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: groupPathDenialReason(denial),
            },
          };
        }
        log.warn(
          { key: sessionKey, tool: input.tool_name, bar: reason },
          isBash ? "Blocked Bash on a private-memory-barred turn" : "Blocked access to private memory",
        );
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: isBash
              ? privateMemoryBashDenial(reason)
              : privateMemoryDenialReason(reason),
          },
        };
      }],
    }],
  };
}

/**
 * The group whose sandbox entry governs this barred turn, or `undefined` when
 * the turn gets the default policy (no extras, sandboxed).
 *
 * - `group-session`: the session IS the group, so its own key decides.
 * - `summoned-turn`: the session key is the owner's `dm:` key and says nothing
 *   about who is steering. The key comes from `scopedCallerKey`, the same
 *   resolution session-scoped MCP tools are judged by (`Agent.scopedCallerKey`
 *   over `scopedCallerKeyFor`), and counts only when it names exactly one
 *   group. {@link MIXED_AUDIENCE_KEY} (several groups, or a group plus the
 *   owner's DM), the session's own key (no group attributable at this instant)
 *   and no key at all fail closed: the default policy.
 *
 * Both getters are read per call. A missing config is no entry, never a
 * throw: a guard that throws on a barred turn is the wrong failure mode.
 */
function groupEntryFor(
  reason: PrivateMemoryBar,
  sessionKey: string | undefined,
  groupSandbox: () => GroupSandboxConfig | undefined,
  scopedCallerKey: () => string | undefined,
): { key: string; entry: GroupSandboxEntry } | undefined {
  const key = groupKeyFor(reason, sessionKey, scopedCallerKey);
  if (!key) return undefined;
  const entry = groupSandbox()?.groups?.[key];
  return entry ? { key, entry } : undefined;
}

/**
 * May this tool call use an Allow-once grant? Only the main agent's own,
 * foreground calls. A subagent (the hook input carries `agent_id`) is not the
 * turn the owner answered, and a background shell (`run_in_background`)
 * outlives the turn: the profile it starts with would keep the grant after
 * the turn has ended, where nothing can take it back. Always-allow grants are
 * config, and reach both.
 */
export function mayUseOnceGrants(input: { tool_name: string; tool_input: unknown; agent_id?: string }): boolean {
  if (input.agent_id) return false;
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as Record<string, unknown> : {};
  return !(input.tool_name === "Bash" && ti.run_in_background === true);
}

/**
 * The ONE group a barred turn is attributable to, or `undefined` (see
 * {@link groupEntryFor} for the rules). Exported for `request_permission`,
 * which must ask on behalf of exactly the group whose policy the guard will
 * then apply.
 */
export function groupKeyFor(
  reason: PrivateMemoryBar,
  sessionKey: string | undefined,
  scopedCallerKey: () => string | undefined,
): string | undefined {
  if (!sessionKey) return undefined;
  if (reason !== "summoned-turn") return sessionKey;
  const steering = scopedCallerKey();
  if (!steering || steering === sessionKey || steering === MIXED_AUDIENCE_KEY) return undefined;
  return steering;
}

/** The path a file tool was pointed at, for the trigger line on a permission card. */
function toolPathOf(toolInput: unknown): string {
  const ti = toolInput && typeof toolInput === "object" ? toolInput as Record<string, unknown> : {};
  const p = ti.file_path ?? ti.notebook_path ?? ti.path;
  return typeof p === "string" ? p : "";
}

/**
 * May this barred turn SHIP `path` as an attachment (`MEDIA:` / `STICKER:`)?
 * True when it must be dropped. The attachment is a read — the channel opens
 * the file and puts it in the chat — so a sandboxed group is held to the same
 * read policy as its file tools (allowed roots and extras, minus the permanent
 * denies); an unsandboxed group to the private-memory and permanent denies
 * alone. Used by reply delivery and by direct sends; the tool guard judges
 * `send_message` the same way.
 */
export function attachmentBarredFor(
  path: string,
  bar: PrivateMemoryBar,
  sessionKey: string,
  scopedCallerKey: () => string | undefined,
  groupSandbox: () => GroupSandboxConfig | undefined,
): boolean {
  if (isPrivateAttachmentPath(path)) return true;
  const group = groupEntryFor(bar, sessionKey, groupSandbox, scopedCallerKey);
  if (group?.entry.unsandboxed) return false;
  return groupPathDenial("Read", { file_path: expandTilde(path) }, config.workspaceDir, groupPolicy(group?.entry)) !== null;
}

/**
 * For `request_permission`: is the (resolved) `path` already within the
 * group's reach for `access`, never grantable to any group, or worth asking
 * the owner about? Judged by the same policy the guard applies, so "already
 * allowed" means the next call really succeeds and "ask" means it really
 * would not.
 */
export function assessGroupPermission(entry: GroupSandboxEntry | undefined, path: string, access: "read" | "write"): PermissionAssessment {
  if (entry?.unsandboxed) return { verdict: "allowed" };
  const policy = groupPolicy(entry);
  const never = permanentGrantDenial(path, access, policy, { workspaceDir: config.workspaceDir, tomoHome: config.tomoHome });
  if (never) return { verdict: "never", reason: never };
  const denial = groupPathDenial(access === "write" ? "Write" : "Read", { file_path: path }, config.workspaceDir, policy);
  return denial === null ? { verdict: "allowed" } : { verdict: "ask" };
}

/** The group path policy for this turn, from config and the group's entry. */
export function groupPolicy(entry: Pick<GroupSandboxEntry, "extraRead" | "extraWrite"> | undefined, dataDirs: readonly string[] = harnessDataDirs()): GroupPathPolicy {
  return groupPathPolicy({
    workspaceDir: config.workspaceDir,
    privateDir: PRIVATE_MEMORY_DIR,
    homeSceneDir: HOME_SCENE_DIR,
    tomoHome: config.tomoHome,
    dataDirs,
    entry,
  });
}

/**
 * A `Bash` tool input with its `command` rewritten to run sandboxed, or `null`
 * to fall back to withholding the shell.
 *
 * The rest of the input is carried through unchanged (`description`, `timeout`,
 * `run_in_background`): the CLI validates `updatedInput` against the tool's full
 * schema and drops a rewrite that fails it, so returning `{ command }` alone
 * would quietly lose whichever other fields the model set.
 *
 * A non-string `command` returns `null` rather than being coerced — a shape this
 * code does not recognise is a shape it cannot prove it has sandboxed.
 */
export function sandboxedBashInput(
  toolInput: unknown,
  // Required, not optional: this is the production entry point, and the
  // foreign-hook scan is a security check. An optional parameter would let a
  // refactor drop the scan and leave the suite green; a required one makes
  // that a type error.
  scan: { settingsFiles: readonly string[]; pluginDirs: readonly string[] },
  /** The group path policy the profile enforces. Required for the same reason. */
  policy: GroupPathPolicy,
): Record<string, unknown> | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const ti = toolInput as Record<string, unknown>;
  if (typeof ti.command !== "string") return null;
  const command = sandboxedBashCommand(ti.command, policy, scan);
  return command === null ? null : { ...ti, command };
}

/** Per-tool predicate for the private-memory guard. Exported for testing. The
 *  rules are intentionally conservative:
 *
 *  - File ops (Read/Edit/Write/MultiEdit/NotebookEdit): deny when the file_path
 *    lands at-or-inside the private dir — lexically, OR after symlinks are
 *    resolved, OR because it steers through a `..` segment anywhere in the
 *    memory tree. See {@link landsInPrivate}.
 *  - Glob: deny when the search root is at-or-inside MEMORY_DIR, or when the
 *    pattern could match any path at-or-inside private/. Wildcard segments
 *    like `pri*` are evaluated by minimatch against synthetic probe paths, so
 *    `memory/pri*\/*.md` is denied just like `memory/private/*.md`. The root
 *    is judged both as SPELLED and as it REALLY resolves — see
 *    {@link searchFrames}. Probes are
 *    spelled both relatively and ABSOLUTELY, because an absolute pattern
 *    anchors itself and is reachable from a root that is not private/'s
 *    ancestor; a pattern containing `..` under a memory-reachable root is
 *    refused outright rather than modelled.
 *  - Grep: same logic against the `glob` filter when present, plus a root
 *    check that mirrors ripgrep's default-recursive behaviour.
 *  - `send_message`: deny when a `MEDIA:` or `STICKER:` tag in the composed message names a
 *    path that lands in private/. THE ATTACHMENT IS THE READ — the file is
 *    opened by the channel and its contents go to the target chat, so a tool
 *    that never touches `file_path` was the way to ship `memory/private/x` into
 *    a group from a turn that could not Read it. Relative paths resolve against
 *    the workspace, the same cwd the agent runs in.
 *  - Bash: see {@link bashTouchesMemory}. NOT THE DECIDING ARM — the hook
 *    sandboxes every Bash call while the bar is up (`./bash-sandbox.ts`), and
 *    withholds the shell only if it cannot (see
 *    {@link PRIVATE_MEMORY_BASH_WITHHELD}). Shell expansion and, worse,
 *    interpreter arguments happen after the hook fires, so the tokens here are
 *    not the paths the command will touch; the kernel sees those. Kept as a
 *    described-shape predicate for callers that want to ask the narrower
 *    question.
 *
 *  Containment is case-folded throughout — see {@link isInside}. False
 *  positives are tolerable because the agent always has an alternative path
 *  through Read on a named public file. */


/**
 * Would attaching `p` surface private memory? For the outbound side, where the
 * caller has already decided the turn is barred.
 *
 * Shares {@link landsInPrivate} with the tool guard — lexical containment, the
 * `..`-anywhere-under-memory rule, AND the symlink-resolved comparison, so a
 * link parked under a public directory that points into private/ is caught by
 * the path it really opens rather than the one it is spelled with. The two
 * sides of the fence must answer the same question the same way, or the model
 * learns that what it cannot read it can still send.
 */
export function isPrivateAttachmentPath(p: string): boolean {
  // `~` expanded first: `path.resolve` does not, so `~/.tomo/workspace/memory/
  // private/x` resolved to `<ws>/~/.tomo/…` and passed — while the iMessage
  // sticker sender expands it and opens the real file.
  const path = expandTilde(p);
  if (landsInPrivate(path, { cwd: config.workspaceDir, memoryDir: MEMORY_DIR, privateDir: PRIVATE_MEMORY_DIR })) return true;
  // Tomo's data/ is barred the same way (transcripts, the usage ledger), and
  // so is every other permanent deny of the group path policy (secrets/, the
  // config file and the rest of Tomo's home, the keychains, ~/.ssh): what no
  // group turn may read, no group turn may ship as an attachment either.
  const policy = groupPolicy(undefined);
  const denies = [...harnessDataDirs(), ...policy.denyDirs];
  if (denies.some((dir) => landsInPrivate(path, { cwd: config.workspaceDir, memoryDir: dir, privateDir: dir }))) return true;
  return groupPathDenial("Read", { file_path: path }, config.workspaceDir, { ...policy, readDirs: ["/"], writeDirs: [], unresolvable: undefined }) !== null;
}
