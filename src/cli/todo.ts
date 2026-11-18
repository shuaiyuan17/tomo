import { Command } from "commander";
import { canSeeTodo, formatDue, formatTodoList } from "../todos/format.js";
import { TodoStore, TodoStoreError } from "../todos/store.js";
import { TOMO_SESSION_KEY_ENV } from "../restart-reason.js";

/**
 * `tomo todo`: the shell's read-only view of the todo store, for scripts
 * (a heartbeat script can print `tomo todo due`) and audits. Writes go
 * through the agent's todo tools or `/todo`.
 */
export const todoCommand = new Command("todo")
  .description("Read the todo list (writes go through the agent's todo tools or /todo)");

function withStore(fn: (store: TodoStore) => void): void {
  try {
    fn(new TodoStore());
  } catch (err) {
    if (err instanceof TodoStoreError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * What this invocation may see. Run from an agent's shell, the CLI inherits
 * the session key tomo stamps into every session's env ($TOMO_SESSION_KEY)
 * and is held to that session's scope: a group's shell sees only the group's
 * items, so an unsandboxed group shell (`groupShellAllowlist`) cannot read the
 * owner's through it. `--session` can only narrow that, never widen it. With
 * no key in the env (a person at a terminal) everything is visible.
 */
function scope(session: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  const inherited = env[TOMO_SESSION_KEY_ENV]?.trim() || undefined;
  return (item: { session: string }) =>
    (inherited === undefined || canSeeTodo(item, inherited))
    && (session === undefined || canSeeTodo(item, session));
}

todoCommand
  .command("due")
  .description("Print todos whose review date has passed (longest overdue first). Prints nothing when none are due.")
  .option("--max <n>", "How many to print (default: todos.dueMax, 3)")
  .option("--session <key>", "Only items this session key may see (narrows $TOMO_SESSION_KEY, never widens it)")
  .action((opts: { max?: string; session?: string }) => withStore((store) => {
    const max = opts.max === undefined ? store.limits.dueMax : Number(opts.max);
    if (!Number.isInteger(max) || max < 1) {
      console.error(`Invalid --max "${opts.max}": expected a positive integer.`);
      process.exit(1);
    }
    const now = Date.now();
    const text = formatDue(store.due(now, scope(opts.session)), { now, max, maxSnoozes: store.limits.maxSnoozes });
    if (text) console.log(text);
  }));

todoCommand
  .command("list")
  .description("Print every open todo this caller may see")
  .option("--session <key>", "Only items this session key may see (narrows $TOMO_SESSION_KEY, never widens it)")
  .action((opts: { session?: string }) => withStore((store) => {
    const visible = scope(opts.session);
    console.log(formatTodoList(store.list().filter(visible), { now: Date.now(), all: true, maxSnoozes: store.limits.maxSnoozes, hints: false }));
  }));
