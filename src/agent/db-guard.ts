// PreToolUse guard: Tomo's database is written by Tomo only.
import { isAbsolute, resolve as pathResolve } from "node:path";
import { dbFamily } from "../db/index.js";
import { log } from "../logger.js";
import { bashTokens, pathCandidates } from "./permission-paths.js";
import { commandSegments, expandTilde, landsIn } from "./bash-write-targets.js";
import { commandWordIndex, isTodoStoreWrite } from "./todo-store-guard.js";

/**
 * The same guard as the todo store's (todo-store-guard.ts), for
 * `~/.tomo/data/tomo.db` and its `-wal`/`-shm`/`-journal` files, on every
 * session: file tools and Bash writers (redirections, `cp`/`mv`/`rm`/...,
 * `sed -i`) aimed at them are denied, and so is `sqlite3` opening the database
 * without `-readonly` — `sqlite3 tomo.db 'delete from …'` is the habit this
 * exists to stop. Deleting the -wal of a live database loses committed data.
 *
 * Groups and summoned turns never reach the file anyway: their Bash runs in
 * the kernel sandbox, which denies all of `data/` (group-fs-policy.ts), the
 * sidecars included. Like the todo guard this is a text filter on an
 * unsandboxed shell, a guard against habit rather than an adversary.
 */
export const DB_WRITE_DENIAL =
  "Tomo's database (`~/.tomo/data/tomo.db`, with its -wal/-shm files) is written only by Tomo itself. Read it with `tomo db dump <table>`, `tomo db check` or `sqlite3 -readonly`; change state through Tomo's tools.";

/** Would this call write the database (or open it writable with sqlite3)? Exported for tests. */
export function isDbWrite(toolName: string, toolInput: unknown, ctx: { cwd: string; dbPath: string }): boolean {
  const family = dbFamily(ctx.dbPath);
  if (family.some((file) => isTodoStoreWrite(toolName, toolInput, { cwd: ctx.cwd, todosDir: file }))) return true;
  if (toolName !== "Bash" || !toolInput || typeof toolInput !== "object") return false;
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === "string" && sqliteOpensWritable(command, family, ctx.cwd);
}

/** A `sqlite3` (or `sqlite3`-like CLI) whose arguments name the database, without `-readonly`. */
function sqliteOpensWritable(command: string, family: string[], startCwd: string): boolean {
  let cwd = startCwd;
  for (const segment of commandSegments(command.replace(/\$\(|`/g, "\n"))) {
    const tokens = bashTokens(segment);
    if (tokens[0] === "cd") {
      const target = tokens[1];
      if (target === undefined || target === "~") cwd = expandTilde("~");
      else if (target !== "-") cwd = isAbsolute(expandTilde(target)) ? expandTilde(target) : pathResolve(cwd, target);
      continue;
    }
    const at = commandWordIndex(tokens);
    if (at === -1) continue;
    const word = tokens[at].split("/").pop() ?? "";
    if (!/^sqlite3?$|^litecli$|^sqlite-utils$/.test(word)) continue;
    const args = tokens.slice(at + 1);
    if (args.some((a) => a === "-readonly" || a === "--readonly")) continue;
    if (args.flatMap((a) => pathCandidates(a)).some((p) => landsIn(p, family, cwd, false))) return true;
  }
  return false;
}

/** The PreToolUse hook. `dbPath` is resolved per call. */
export function dbGuardHooks(sessionKey: string | undefined, cwd: string, dbPath: () => string) {
  return {
    PreToolUse: [{
      onFailure: "block" as const,
      hooks: [async (input: { tool_name: string; tool_input: unknown }) => {
        let denied: boolean;
        const path = dbPath();
        try {
          denied = isDbWrite(input.tool_name, input.tool_input, { cwd, dbPath: path });
        } catch (err) {
          // Same fallback as the todo guard: deny only a call that names the database.
          let text: string;
          try { text = JSON.stringify(input.tool_input) ?? ""; } catch { text = String(input.tool_input); }
          denied = text.includes(path) || /tomo\.db/.test(text);
          log.warn({ err, tool: input.tool_name, denied }, "Database guard failed to judge a tool call");
        }
        if (!denied) return {};
        log.warn({ key: sessionKey, tool: input.tool_name }, "Blocked a direct write to Tomo's database");
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: DB_WRITE_DENIAL,
          },
        };
      }],
    }],
  };
}
