// PreToolUse guard: the todo store is written by the todo tools only.
import { isAbsolute, resolve as pathResolve } from "node:path";
import { log } from "../logger.js";
import { bashTokens } from "./permission-paths.js";
import { landsInPrivate } from "./private-memory-reach.js";
import { HOME_WRITE_TOOLS } from "./private-memory-access.js";
import { commandSegments, expandTilde, landsIn, pathishTokens, redirectTargets, writeTargets, writeVerbIn } from "./bash-write-targets.js";

/**
 * Why the todo store has a guard of its own, on EVERY session (the owner's
 * DM included): the todo rules — required fields, length limits, the open
 * cap, the snooze cap, four actions and no annotations — are only worth
 * anything if nothing else writes the file. An agent with Edit will fix a
 * JSON file by hand the moment a tool says no, and that is the failure the
 * primitive exists to stop (see `src/todos/store.ts`).
 *
 * Groups and summoned turns are already kept out of all of `data/` by the
 * private-memory guard (file tools denied, Bash in a kernel sandbox that
 * denies `data/` to reads and writes). This guard adds the owner's own,
 * unsandboxed turns, for writes:
 *
 * - Write / Edit / MultiEdit / NotebookEdit at or inside the store directory
 *   (lexical, symlink-resolved, and any `..` under it — the same
 *   `landsInPrivate` rules as the home guard);
 * - Bash, judged on its text: any path that names or resolves into the store
 *   (reads included — `tomo todo list` is the shell's way in), or a write (redirection or write verb) whose target is the store, one of
 *   its files, or an ancestor of it (`rm -rf ~/.tomo/data`). `cd` between
 *   segments is followed.
 *
 * The Bash arm is a text filter on an unsandboxed shell and cannot be complete
 * (an interpreter can assemble a path the text never spells). It is a guard
 * against habit, not against an adversary: the owner's DM is trusted, and the
 * adversarial case (a group steering the model) is the kernel sandbox's.
 * It fails closed: a tool input it cannot read is denied, and the hook is
 * registered with `onFailure: "block"`.
 */

export const TODO_STORE_WRITE_DENIAL =
  "Tomo's todo store (`~/.tomo/data/todos/`) is written only through the todo tools, so their rules hold. Use todo_add, todo_list and todo_resolve (done, drop, snooze, handoff), or `tomo todo list` / `tomo todo due` to read it from a shell.";

/**
 * Text that names the store's directory or files as a path. Path-shaped on
 * purpose: a commit message that mentions `todos.json` in prose is not a
 * write, and refusing it would make working on Tomo itself impossible.
 */
const STORE_MENTION = /\.tomo\/data\/todos(?![\w-])|(^|[\s'"=])data\/todos(?![\w-])|todos\/(todos\.json|done\.ndjson)/i;

/**
 * Would this tool call write the todo store directly?
 * Exported for tests.
 */
export function isTodoStoreWrite(toolName: string, toolInput: unknown, ctx: { cwd: string; todosDir: string }): boolean {
  if (HOME_WRITE_TOOLS.has(toolName)) {
    if (!toolInput || typeof toolInput !== "object") return true;
    const ti = toolInput as Record<string, unknown>;
    const p = toolName === "NotebookEdit" ? ti.notebook_path : ti.file_path;
    if (typeof p !== "string") return true;
    return landsInPrivate(expandTilde(p), { cwd: ctx.cwd, memoryDir: ctx.todosDir, privateDir: ctx.todosDir });
  }
  if (toolName !== "Bash") return false;
  if (!toolInput || typeof toolInput !== "object") return true;
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== "string") return true;
  if (STORE_MENTION.test(command)) return true;
  // Any path token that resolves into the store (a relocated tomoHome, a symlink).
  if (pathishTokens(command).some((t) => landsIn(t, [ctx.todosDir], ctx.cwd, false))) return true;
  return bashWritesInto(command, ctx);
}

function bashWritesInto(command: string, ctx: { cwd: string; todosDir: string }): boolean {
  let cwd = ctx.cwd;
  for (const segment of commandSegments(command)) {
    const tokens = bashTokens(segment);
    if (tokens[0] === "cd") {
      const target = tokens[1];
      if (target === undefined || target === "~") cwd = expandTilde("~");
      else if (target !== "-") cwd = isAbsolute(expandTilde(target)) ? expandTilde(target) : pathResolve(cwd, target);
      // A `cd` that lands in the store is itself the warning sign.
      if (landsIn(cwd, [ctx.todosDir], ctx.cwd, false)) return true;
      continue;
    }
    const targets = writeTargets(segment, writeVerbIn(segment), redirectTargets(segment), cwd);
    if (targets.some((t) => landsIn(t.path, [ctx.todosDir], cwd, true))) return true;
  }
  return false;
}

/** The PreToolUse hook. `todosDir` is resolved per call. */
export function todoStoreGuardHooks(sessionKey: string | undefined, cwd: string, todosDir: () => string) {
  return {
    PreToolUse: [{
      // A guard that throws must deny, not let the call through.
      onFailure: "block" as const,
      hooks: [async (input: { tool_name: string; tool_input: unknown }) => {
        if (!isTodoStoreWrite(input.tool_name, input.tool_input, { cwd, todosDir: todosDir() })) return {};
        log.warn({ key: sessionKey, tool: input.tool_name }, "Blocked a direct write to the todo store");
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: TODO_STORE_WRITE_DENIAL,
          },
        };
      }],
    }],
  };
}
