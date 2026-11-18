import { Command } from "commander";
import { canSeeTodo, formatDue, formatTodoList } from "../todos/format.js";
import { TodoStore, TodoStoreReadError } from "../todos/store.js";

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
    if (err instanceof TodoStoreReadError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/** A --session filter: the items that session may see, or every item. */
function scope(session: string | undefined) {
  return session === undefined ? () => true : (item: { session: string }) => canSeeTodo(item, session);
}

todoCommand
  .command("due")
  .description("Print todos whose review date has passed (longest overdue first). Prints nothing when none are due.")
  .option("--max <n>", "How many to print (default: todos.dueMax, 3)")
  .option("--session <key>", "Only items this session key may see")
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
  .description("Print every open todo")
  .option("--session <key>", "Only items this session key may see")
  .action((opts: { session?: string }) => withStore((store) => {
    const visible = scope(opts.session);
    console.log(formatTodoList(store.list().filter(visible), { now: Date.now(), all: true, maxSnoozes: store.limits.maxSnoozes, hints: false }));
  }));
