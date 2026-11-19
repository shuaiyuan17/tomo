import { describe, expect, it } from "vitest";
import type { WebTodoItem } from "../src/web/protocol.js";
import { closedLabel, groupTodos, isDue, refTarget, reviewLabel, snoozeLabel, sortTodos, summarizeTodos } from "../web/src/todos.js";

const DAY = 86_400_000;
/** Local noon, so calendar-day labels do not depend on the machine's zone. */
const NOW = new Date(2026, 10, 18, 12).getTime();
const todo = (id: number, waitingOn: WebTodoItem["waitingOn"], reviewInDays: number, extra: Partial<WebTodoItem> = {}): WebTodoItem => ({
  id: `t-${id}`, title: `Item ${id}`, next: `Step ${id}`, waitingOn, reviewAt: NOW + reviewInDays * DAY,
  createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY, source: "self", snoozes: 0, ...extra,
});

describe("todo page: grouping and order", () => {
  const items = [
    todo(1, "me", 3), todo(2, "external", -1), todo(3, "me", -4), todo(4, "owner", 2),
    todo(5, "me", -1), todo(6, "owner", -2), todo(7, "me", 1), todo(10, "me", -1), todo(9, "me", -1),
  ];

  it("groups by who moves next: the owner's first, then the agent's, then others'", () => {
    const groups = groupTodos(items, NOW);
    expect(groups.map((g) => g.waitingOn)).toEqual(["owner", "me", "external"]);
    expect(groups.map((g) => g.items.length)).toEqual([2, 6, 1]);
    expect(groups.map((g) => g.due)).toEqual([1, 4, 1]);
  });

  it("pins due items to the top, longest overdue first, then the soonest review", () => {
    const mine = groupTodos(items, NOW).find((g) => g.waitingOn === "me")!;
    // t-3 is 4 days over; t-5, t-9, t-10 tie at 1 day and keep id order (numeric, not text); then upcoming.
    expect(mine.items.map((i) => i.id)).toEqual(["t-3", "t-5", "t-9", "t-10", "t-7", "t-1"]);
    const firstUpcoming = mine.items.findIndex((i) => !isDue(i, NOW));
    expect(mine.items.slice(firstUpcoming).some((i) => isDue(i, NOW))).toBe(false);
    expect(groupTodos(items, NOW)[0].items.map((i) => i.id)).toEqual(["t-6", "t-4"]);
  });

  it("leaves out empty groups and does not reorder its input", () => {
    const before = items.map((i) => i.id);
    expect(groupTodos(items.filter((i) => i.waitingOn !== "owner"), NOW).map((g) => g.waitingOn)).toEqual(["me", "external"]);
    expect(groupTodos([], NOW)).toEqual([]);
    sortTodos(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it("treats an item as due from the moment its review time passes", () => {
    expect(isDue({ reviewAt: NOW }, NOW)).toBe(true);
    expect(isDue({ reviewAt: NOW - 1 }, NOW)).toBe(true);
    expect(isDue({ reviewAt: NOW + 1 }, NOW)).toBe(false);
  });
});

describe("todo page: summary", () => {
  const limits = { maxOpen: 30, maxSnoozes: 3 };
  const many = (n: number) => Array.from({ length: n }, (_, i) => todo(i + 1, i % 3 === 0 ? "owner" : "me", i < 2 ? -1 : 2));

  it("counts open against the cap, what is due, and who is waited on", () => {
    expect(summarizeTodos({ items: many(6), openTotal: 6, limits }, NOW)).toEqual({
      open: 6, max: 30, percent: 20, cap: "ok", due: 2, waiting: { owner: 2, me: 4, external: 0 }, hidden: 0,
    });
  });

  it("warns from 80% of the cap and is full at it", () => {
    const cap = (n: number) => summarizeTodos({ items: many(n), openTotal: n, limits }, NOW).cap;
    expect([23, 24, 29, 30, 31].map(cap)).toEqual(["ok", "near", "near", "full", "full"]);
    // The owner's adds are never refused, so the list can exceed the cap: the bar stops at 100.
    expect(summarizeTodos({ items: many(31), openTotal: 31, limits }, NOW).percent).toBe(100);
  });

  it("counts open items that are not shown toward the cap", () => {
    expect(summarizeTodos({ items: many(3), openTotal: 29, limits }, NOW)).toMatchObject({ open: 29, cap: "near", hidden: 26, due: 2 });
  });
});

describe("todo page: labels", () => {
  it("says how long an item has been due, or when its review is", () => {
    expect(reviewLabel(NOW - 60_000, NOW)).toBe("Due today");
    expect(reviewLabel(NOW - DAY, NOW)).toBe("Due yesterday");
    expect(reviewLabel(NOW - 9 * DAY, NOW)).toBe("Due 9 days ago");
    expect(reviewLabel(NOW + 3_600_000, NOW)).toBe("Review today");
    expect(reviewLabel(NOW + DAY, NOW)).toBe("Review tomorrow");
    expect(reviewLabel(NOW + 5 * DAY, NOW)).toBe("Review in 5 days");
    expect(reviewLabel(new Date(2026, 11, 24, 9).getTime(), NOW)).toBe("Review Dec 24");
    expect(reviewLabel(new Date(2027, 0, 20, 9).getTime(), NOW)).toBe("Review Jan 20, 2027");
    // Calendar days, not 24-hour spans: 13 hours ago was yesterday.
    expect(reviewLabel(NOW - 13 * 3_600_000, NOW)).toBe("Due yesterday");
  });

  it("dates a closed item", () => {
    expect(closedLabel(NOW - 3_600_000, NOW)).toBe("today");
    expect(closedLabel(NOW - DAY, NOW)).toBe("yesterday");
    expect(closedLabel(new Date(2026, 10, 9, 9).getTime(), NOW)).toBe("Nov 9");
  });

  it("shows the snooze count against the limit and flags the last one", () => {
    expect(snoozeLabel(0, 3)).toBeNull();
    expect(snoozeLabel(1, 3)).toEqual({ text: "Snoozed 1 of 3", last: false });
    expect(snoozeLabel(3, 3)).toEqual({ text: "Snoozed 3 of 3", last: true });
  });
});

describe("todo page: ref links", () => {
  it("links a URL, and reads a GitHub pull request or issue as owner/repo#n", () => {
    expect(refTarget("https://github.com/example/garden/pull/41")).toEqual({ label: "example/garden#41", href: "https://github.com/example/garden/pull/41" });
    expect(refTarget("https://github.com/example/garden/issues/7#issuecomment-1")).toEqual({ label: "example/garden#7", href: "https://github.com/example/garden/issues/7#issuecomment-1" });
    expect(refTarget(" https://www.example.com/docs/setup/ ")).toEqual({ label: "example.com/docs/setup", href: "https://www.example.com/docs/setup/" });
    expect(refTarget("example/garden#44")).toEqual({ label: "example/garden#44", href: "https://github.com/example/garden/issues/44" });
  });

  it("never links anything that is not http(s) or a repo shorthand", () => {
    for (const ref of ["memory/projects/garden.md", "#558", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "//example.com/x", "see https://example.com", "a/b#1 and more"]) {
      expect(refTarget(ref), ref).toEqual({ label: ref });
    }
  });
});
