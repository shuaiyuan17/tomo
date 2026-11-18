// No imports: config.ts and the todo store both read this, and tests can load it without a config.
/**
 * Limits of the todo primitive (`src/todos/`). Every number the tools enforce
 * lives here so an install can tune them; the defaults are starting values.
 */
export interface TodoConfig {
  /** Open items at which `todo_add` refuses (owner-added items are never refused but count). */
  maxOpen: number;
  /** Times one item may be snoozed before only done / drop / handoff remain. */
  maxSnoozes: number;
  /** Hard limit on a title, in characters. */
  titleMaxChars: number;
  /** Hard limit on the next step, in characters. */
  nextMaxChars: number;
  /** Default days to the next review for an item waiting on Tomo. */
  reviewDaysSelf: number;
  /** Default days to the next review for an item waiting on the owner or someone else. */
  reviewDaysWaiting: number;
  /** Furthest a review date may be set, in days from now. */
  maxReviewDays: number;
  /** Items `tomo todo due` prints by default. */
  dueMax: number;
}

export const DEFAULT_TODOS: TodoConfig = {
  maxOpen: 30,
  maxSnoozes: 3,
  titleMaxChars: 120,
  nextMaxChars: 200,
  reviewDaysSelf: 3,
  reviewDaysWaiting: 7,
  maxReviewDays: 90,
  dueMax: 3,
};
