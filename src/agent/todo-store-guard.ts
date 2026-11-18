// PreToolUse guard: the todo store is written by the todo tools only.
import { isAbsolute, resolve as pathResolve } from "node:path";
import { log } from "../logger.js";
import { bashTokens } from "./permission-paths.js";
import { landsInPrivate } from "./private-memory-reach.js";
import { HOME_WRITE_TOOLS } from "./private-memory-access.js";
import { commandSegments, expandTilde, landsIn, redirectTargets, writeTargets, writeVerbIn } from "./bash-write-targets.js";

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
 * - Bash WRITES only: a redirection, `tee`, `cp`/`mv`/`rm`/`ln`, `sed -i`,
 *   `perl -i`, `truncate` or `dd of=` whose target is in the store (or, for
 *   `rm`/`mv`, an ancestor of it: `rm -rf ~/.tomo/data`). Reads and quoted
 *   text are not judged. `cd` between segments is followed.
 *
 * The Bash arm is a text filter on an unsandboxed shell and cannot be complete
 * (an interpreter can assemble a path the text never spells). It is a guard
 * against habit, not against an adversary: the owner's DM is trusted, and the
 * adversarial case (a group steering the model) is the kernel sandbox's.
 * When the check itself throws, only a call whose input names the store is
 * denied (see {@link todoGuardDecision}); the hook is also registered with
 * `onFailure: "block"` for anything that escapes.
 */

export const TODO_STORE_WRITE_DENIAL =
  "Tomo's todo store (`~/.tomo/data/todos/`) is written only through the todo tools, so their rules hold. Use todo_add, todo_list and todo_resolve (done, drop, snooze, handoff). Reading it (cat, `tomo todo list`) is fine.";

/** Shell writers judged by their targets. Anything else is let through. */
const WRITE_VERBS: ReadonlySet<string> = new Set(["tee", "cp", "mv", "rm", "rmdir", "unlink", "ln", "sed -i", "perl -i", "truncate", "dd"]);
/** Writers that destroy what they name, so an ancestor of the store counts (`rm -rf ~/.tomo/data`). */
const DESTRUCTIVE: ReadonlySet<string> = new Set(["rm", "rmdir", "mv"]);

/**
 * Would this tool call write the todo store directly?
 * Exported for tests. An input this cannot read is not a store write (the
 * tool will reject it on its own); only a call that hits the store is denied.
 */
export function isTodoStoreWrite(toolName: string, toolInput: unknown, ctx: { cwd: string; todosDir: string }): boolean {
  if (!toolInput || typeof toolInput !== "object") return false;
  const ti = toolInput as Record<string, unknown>;
  if (HOME_WRITE_TOOLS.has(toolName)) {
    const p = toolName === "NotebookEdit" ? ti.notebook_path : ti.file_path;
    if (typeof p !== "string") return false;
    return landsInPrivate(expandTilde(p), { cwd: ctx.cwd, memoryDir: ctx.todosDir, privateDir: ctx.todosDir });
  }
  if (toolName !== "Bash" || typeof ti.command !== "string") return false;
  return bashWritesInto(ti.command, ctx);
}

/**
 * Only WRITES: a `>`/`>>` redirection, or one of {@link WRITE_VERBS}, whose
 * target lands in the store. Quoted text (a grep pattern, a commit message)
 * and read-only commands pass. `cd` between segments is followed.
 */
function bashWritesInto(command: string, ctx: { cwd: string; todosDir: string }): boolean {
  let cwd = ctx.cwd;
  for (const segment of commandSegments(command)) {
    const tokens = bashTokens(segment);
    if (tokens[0] === "cd") {
      const target = tokens[1];
      if (target === undefined || target === "~") cwd = expandTilde("~");
      else if (target !== "-") cwd = isAbsolute(expandTilde(target)) ? expandTilde(target) : pathResolve(cwd, target);
      continue;
    }
    const redirects = redirectTargets(segment);
    if (redirects.some((t) => landsIn(t, [ctx.todosDir], cwd, false))) return true;
    const verb = writeVerbIn(segment);
    if (!verb || !WRITE_VERBS.has(verb)) continue;
    const paths = destinationsOf(verb, tokens) ?? writeTargets(segment, verb, [], cwd).map((t) => t.path);
    if (paths.some((p) => landsIn(p, [ctx.todosDir], cwd, DESTRUCTIVE.has(verb)))) return true;
  }
  return false;
}

/**
 * For writers whose SOURCE is only read, just the destination: `cp`/`ln`
 * write their last operand (or `-t <dir>`), `dd` its `of=`. Undefined for the
 * rest, whose every operand is written (`rm`, `tee`, `sed -i`, ... and `mv`,
 * which also removes its source).
 */
function destinationsOf(verb: string, tokens: string[]): string[] | undefined {
  if (verb === "dd") return tokens.filter((t) => t.startsWith("of=")).map((t) => t.slice(3));
  if (verb !== "cp" && verb !== "ln") return undefined;
  const at = tokens.indexOf(verb);
  const args = tokens.slice(at + 1);
  const t = args.indexOf("-t");
  if (t !== -1 && args[t + 1] !== undefined) return [args[t + 1]];
  const operands = args.filter((a) => !a.startsWith("-"));
  return operands.length ? [operands[operands.length - 1]] : [];
}

/**
 * Decide one call. When the judgement itself throws, the call is denied only
 * if its input names the store; everything else goes through, so a bug here
 * cannot shut down every tool.
 */
export function todoGuardDecision(
  toolName: string,
  toolInput: unknown,
  ctx: { cwd: string; todosDir: string },
  judge: typeof isTodoStoreWrite = isTodoStoreWrite,
): "deny" | "allow" {
  try {
    return judge(toolName, toolInput, ctx) ? "deny" : "allow";
  } catch (err) {
    let text: string;
    try { text = JSON.stringify(toolInput) ?? ""; } catch { text = String(toolInput); }
    const hits = text.includes(ctx.todosDir) || /data\/todos(?![\w-])/.test(text);
    log.warn({ err, tool: toolName, denied: hits }, "Todo-store guard failed to judge a tool call");
    return hits ? "deny" : "allow";
  }
}

/** The PreToolUse hook. `todosDir` is resolved per call. */
export function todoStoreGuardHooks(sessionKey: string | undefined, cwd: string, todosDir: () => string) {
  return {
    PreToolUse: [{
      // Errors inside the decision are handled there; anything that still
      // escapes (todosDir() throwing) denies rather than lets the call through.
      onFailure: "block" as const,
      hooks: [async (input: { tool_name: string; tool_input: unknown }) => {
        if (todoGuardDecision(input.tool_name, input.tool_input, { cwd, todosDir: todosDir() }) === "allow") return {};
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
