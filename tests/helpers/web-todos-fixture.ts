import { TodoStore } from "../../src/todos/store.js";
import { DEFAULT_TODOS } from "../../src/todos/limits.js";

/** The todo store the Study's Todos tests read: shared by the view (web-todos-view) and the route (web-study). */
export const DAY = 86_400_000;
/** The fixture's clock: every add and resolve is stamped relative to it, so the response is exact. */
export const NOW = Date.UTC(2026, 10, 18, 12);
/** Three visible open items (one per waiting_on, one of a group), one of another DM, two closed. */
export function seedTodos(dir: string): void {
  const store = new TodoStore(dir, DEFAULT_TODOS);
  const add = (daysAgo: number, input: Record<string, unknown>) => store.add({ session: "dm:owner", source: "self", ...input } as Parameters<TodoStore["add"]>[0], NOW - daysAgo * DAY);
  const first = add(20, { title: "Fix the flaky test", next: "Reproduce it", waiting_on: "me", review_in: "3d" });
  const second = add(15, { title: "Compare two barrels", next: "Read reviews", waiting_on: "me", review_in: "3d" });
  add(9, { title: "Review the release", next: "Read the diff", waiting_on: "owner", review_in: "7d", ref: "https://example.com/pull/41" });
  const plumber = add(5, { title: "Call the plumber", next: "Phone before noon", waiting_on: "me", review_in: "2d", source: "owner" });
  add(1, { title: "Pick the next book", next: "Post the poll", waiting_on: "external", review_in: "7d", session: "telegram:-2" });
  add(1, { title: "OTHER-DM-NEEDLE", next: "OTHER-DM-NEEDLE step", waiting_on: "me", review_in: "3d", session: "dm:someone-else" });
  store.resolve(first.id, { action: "done", by: "self", evidence: "https://example.com/pull/37" }, NOW - 8 * DAY);
  store.resolve(second.id, { action: "drop", by: "owner", reason: "No longer needed." }, NOW - 3 * DAY);
  store.resolve(plumber.id, { action: "snooze", by: "self", until: "3d", reason: "Line was busy." }, NOW - DAY);
}
