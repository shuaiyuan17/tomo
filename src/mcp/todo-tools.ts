import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MIXED_AUDIENCE_KEY } from "../agent/audience.js";
import { isStorableSessionKey } from "../cron/scope.js";
import { canSeeTodo, formatTodoLine } from "../todos/format.js";
import { compareByReview, TodoRuleError, TodoStore, TodoStoreError, type TodoItem } from "../todos/store.js";

export const TODO_TOOL_NAMES = ["todo_add", "todo_list", "todo_resolve"] as const;

/**
 * The todo primitive's three agent tools, on the `tomo-internal` server.
 *
 * Scoped like the cron tools: `caller` is resolved per call
 * (`Agent.scopedCallerKey`), because a summoned group's turn runs on the
 * owner's `dm:` session and must get the group's scope, not the owner's. A
 * group sees and resolves only its own items; the owner's DM sees all.
 * Unscoped (`caller` undefined) is for tests.
 *
 * The rules (required fields, limits, the open cap, the snooze cap, four
 * actions) are enforced by `TodoStore`; these handlers only translate.
 */
export function buildTodoTools(deps: { store?: () => TodoStore; caller?: () => string | undefined } = {}) {
  const store = deps.store ?? (() => new TodoStore());
  const callerKey = (): string | undefined => deps.caller?.();
  const visible = (item: TodoItem): boolean => canSeeTodo(item, callerKey());
  const fail = (name: string, err: unknown) => {
    if (err instanceof TodoRuleError || err instanceof TodoStoreError) {
      return { content: [{ type: "text" as const, text: `${name} failed: ${err.message}` }], isError: true };
    }
    throw err;
  };
  const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

  return [
    tool(
      "todo_add",
      [
        "Record a commitment that must outlive this conversation: one thing that can be finished, whose next step is known, and whose next mover is known.",
        "",
        "Not TodoWrite / TaskCreate (those are this turn's plan). Not for ideas, reference material, reminders at a time (use schedule_create) or recurring work (cron).",
        "",
        "Rules, enforced: `title` is one line; `next` (verb first) and `waiting_on` are required. Details go in the file or issue `ref` points to — there are no notes. The number of open todos is capped; at the cap this fails and lists the least recently touched ones, resolve one first.",
        "",
        "Each todo gets a review date (default: 3 days when waiting on you, 7 otherwise). It stays silent until then.",
      ].join("\n"),
      {
        title: z.string().min(1).describe("One line naming the thing to finish."),
        next: z.string().min(1).describe("The next concrete step, verb first."),
        waiting_on: z.enum(["me", "owner", "external"]).describe("Who makes the next move: me (Tomo), owner, or external (someone else)."),
        review_in: z.string().optional().describe('When to look at it again: "3d", "2w" or "YYYY-MM-DD". Default by waiting_on.'),
        ref: z.string().optional().describe("Where the details live: a project file path, PR or issue URL."),
      },
      async ({ title, next, waiting_on, review_in, ref }) => {
        const session = callerKey();
        if (session === undefined || session === MIXED_AUDIENCE_KEY || !isStorableSessionKey(session)) {
          return { content: [{ type: "text" as const, text: "todo_add failed: this turn has no single conversation to file the todo under; add it from that conversation." }], isError: true };
        }
        try {
          const store_ = store();
          const item = store_.add({ title, next, waiting_on, review_in, ref, session, source: "self" }, Date.now(), visible);
          return ok(`Added ${formatTodoLine(item, Date.now(), store_.limits.maxSnoozes)}`);
        } catch (err) {
          return fail("todo_add", err);
        }
      },
      { searchHint: "todo add commitment follow up later track task waiting on owner" },
    ),
    tool(
      "todo_list",
      [
        "List open todos visible from this conversation, one line each.",
        "",
        "filter: `due` (review date passed — resolve these), `mine` (waiting on me), `owner` (waiting on the owner), `all` (default).",
      ].join("\n"),
      {
        filter: z.enum(["due", "mine", "owner", "all"]).default("all").describe("Which todos to list."),
      },
      async ({ filter }) => {
        try {
          const store_ = store();
          const now = Date.now();
          const items = store_.list().filter(visible).filter((item) => {
            if (filter === "due") return Date.parse(item.review_at) <= now;
            if (filter === "mine") return item.waiting_on === "me";
            if (filter === "owner") return item.waiting_on === "owner";
            return true;
          }).sort(compareByReview);
          if (!items.length) return ok(filter === "all" ? "No open todos." : `No ${filter} todos.`);
          return ok(items.map((item) => formatTodoLine(item, now, store_.limits.maxSnoozes)).join("\n"));
        } catch (err) {
          return fail("todo_list", err);
        }
      },
      { searchHint: "todo list due open commitments waiting on owner" },
    ),
    tool(
      "todo_resolve",
      [
        "Decide what happens to a todo. Exactly one of four actions; there is no way to annotate.",
        "",
        "- `done`: finished. Optional `evidence` (PR, commit).",
        "- `drop`: not doing it. `reason` required, one sentence.",
        "- `snooze`: look again later. `until` (\"3d\", \"2w\", \"YYYY-MM-DD\") and `reason` required; optional new `next`. Capped: after the limit only done, drop or handoff remain.",
        "- `handoff`: the next move is the owner's (waiting_on becomes owner). Optional new `next`, phrased as the question for them.",
      ].join("\n"),
      {
        id: z.string().min(1).describe("The todo id, e.g. t-12."),
        action: z.enum(["done", "drop", "snooze", "handoff"]).describe("done | drop | snooze | handoff"),
        until: z.string().optional().describe("snooze only: \"3d\", \"2w\" or \"YYYY-MM-DD\"."),
        reason: z.string().optional().describe("drop and snooze: one sentence."),
        evidence: z.string().optional().describe("done only: a PR, commit or link."),
        next: z.string().optional().describe("snooze or handoff: replace the next step."),
      },
      async ({ id, action, until, reason, evidence, next }) => {
        try {
          const store_ = store();
          const now = Date.now();
          const result = store_.resolve(id, { action, until, reason, evidence, next, by: "self" }, now, visible);
          const verb = { done: "Done", drop: "Dropped", snooze: "Snoozed", handoff: "Handed to the owner" }[result.action];
          return ok(`${verb}: ${formatTodoLine(result.item, now, store_.limits.maxSnoozes)}`);
        } catch (err) {
          return fail("todo_resolve", err);
        }
      },
      { searchHint: "todo resolve done drop snooze handoff finish close" },
    ),
  ];
}
