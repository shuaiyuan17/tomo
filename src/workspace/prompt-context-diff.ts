/**
 * What changed in MEMORY.md and the people roster since a live session's
 * system prompt was built, and whether that can be told as a note instead of
 * retiring the session (see `buildIdentityPrompt` in ./index.ts).
 *
 * A note is only ever a list of whole lines added or removed. That is exact
 * only for a SMALL change that leaves the structure alone: a line's meaning in
 * the index can depend on where it sits (the heading above it), and a note
 * does not carry position. So a change is noted only when every kept line
 * keeps its relative order and count, no heading line is added or removed,
 * and at most MAX_NOTED_LINES lines change in all. Anything else retires the
 * session as before, and the next one is built from the current files.
 *
 * Pure: no filesystem access, so it is safe to import where the workspace
 * module is mocked.
 */

export interface PromptContextLines {
  memory: string[];
  people: string[];
}

/** Most lines (added + removed, both sections together) a note may carry. */
export const MAX_NOTED_LINES = 10;

export type PromptContextChange =
  | { kind: "none" }
  | { kind: "note"; body: string }
  | { kind: "retire"; reason: "reordered" | "heading" | "too-many" };

interface LineDiff {
  added: string[];
  removed: string[];
  /** Lines in both, but not in the same order or number (an entry moved
   *  under another heading, a line duplicated): invisible to added/removed. */
  moved: boolean;
}

const isHeading = (line: string) => /^\s*#/.test(line);

function diffLines(before: string[], after: string[]): LineDiff {
  const clean = (lines: string[]) => lines.map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const b = clean(before);
  const a = clean(after);
  const bSet = new Set(b);
  const aSet = new Set(a);
  const keptBefore = b.filter((l) => aSet.has(l));
  const keptAfter = a.filter((l) => bSet.has(l));
  return {
    added: a.filter((l) => !bSet.has(l)),
    removed: b.filter((l) => !aSet.has(l)),
    moved: keptBefore.length !== keptAfter.length || keptBefore.some((l, i) => l !== keptAfter[i]),
  };
}

function renderSection(title: string, diff: LineDiff): string | undefined {
  if (diff.added.length + diff.removed.length === 0) return undefined;
  const lines = [...diff.added.map((l) => `+ ${l}`), ...diff.removed.map((l) => `- ${l}`)];
  return `${title} (+ added, - removed):\n${lines.join("\n")}`;
}

/** Whether a session built with `before` can be told about `after` as a note. */
export function classifyPromptContextChange(before: PromptContextLines, after: PromptContextLines): PromptContextChange {
  const memory = diffLines(before.memory, after.memory);
  const people = diffLines(before.people, after.people);
  const diffs = [memory, people];
  const count = diffs.reduce((n, d) => n + d.added.length + d.removed.length, 0);
  if (diffs.some((d) => d.moved)) return { kind: "retire", reason: "reordered" };
  if (count === 0) return { kind: "none" };
  if (diffs.some((d) => [...d.added, ...d.removed].some(isHeading))) return { kind: "retire", reason: "heading" };
  if (count > MAX_NOTED_LINES) return { kind: "retire", reason: "too-many" };
  const sections = [renderSection("MEMORY.md", memory), renderSection("People registry", people)]
    .filter((s): s is string => s !== undefined);
  return {
    kind: "note",
    body: [
      "Your memory index or people registry changed since this conversation's system prompt was built (possibly by you). The system prompt still shows the earlier text; these lines are current.",
      ...sections,
    ].join("\n\n"),
  };
}
