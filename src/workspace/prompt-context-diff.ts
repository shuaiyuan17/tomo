/**
 * What changed in MEMORY.md and the people roster since a live session's
 * system prompt was built, and whether that can be told as a note instead of
 * retiring the session (see `buildIdentityPrompt` in ./index.ts).
 *
 * A note is only ever a list of whole lines added or removed. That is exact
 * only for a SMALL change that leaves the structure alone: a line's meaning in
 * the index can depend on where it sits (the headings above it), so each
 * noted line carries the full heading path it sits under. A change is noted only when
 * every kept line keeps its relative order and count, no heading line is
 * added or removed, and at most MAX_NOTED_LINES lines (MAX_NOTED_CHARS
 * characters) change in all. Anything else retires the session as before,
 * and the next one is built from the current files.
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
/** Most characters of changed lines, as rendered (heading paths included), a
 *  note may carry: it is prefixed whole to the next turn, and must not crowd
 *  the conversation out. */
export const MAX_NOTED_CHARS = 2_000;

export type PromptContextChange =
  | { kind: "none" }
  | { kind: "note"; body: string }
  | { kind: "retire"; reason: "reordered" | "heading" | "too-many" | "too-large" };

interface LineDiff {
  /** Each with the heading it sits under (in the new / old text), if any:
   *  the same entry means something else under `## Work` than `## Home`. */
  added: Array<{ line: string; under?: string }>;
  removed: Array<{ line: string; under?: string }>;
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
  const notIn = (lines: string[], other: Set<string>) => {
    const out: LineDiff["added"] = [];
    // The full heading path ("## Work > ### Contacts"): the leaf alone can
    // repeat under different parents.
    const path: Array<{ level: number; text: string }> = [];
    for (const line of lines) {
      if (isHeading(line)) {
        const text = line.trim();
        const level = /^#+/.exec(text)![0].length;
        while (path.length > 0 && path[path.length - 1].level >= level) path.pop();
        path.push({ level, text });
      } else if (!other.has(line)) {
        out.push(path.length > 0 ? { line, under: path.map((h) => h.text).join(" > ") } : { line });
      }
    }
    // A heading itself never goes into a note (it retires), but count it.
    return [...out, ...lines.filter((l) => isHeading(l) && !other.has(l)).map((line) => ({ line }))];
  };
  return {
    added: notIn(a, bSet),
    removed: notIn(b, aSet),
    moved: keptBefore.length !== keptAfter.length || keptBefore.some((l, i) => l !== keptAfter[i]),
  };
}

/** The section's changed lines as the note shows them (heading path included). */
function renderedLines(diff: LineDiff): string[] {
  const render = (sign: string) => (e: { line: string; under?: string }) =>
    e.under ? `${sign} ${e.line}   (under "${e.under}")` : `${sign} ${e.line}`;
  return [...diff.added.map(render("+")), ...diff.removed.map(render("-"))];
}

function renderSection(title: string, lines: string[]): string | undefined {
  if (lines.length === 0) return undefined;
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
  if (diffs.some((d) => [...d.added, ...d.removed].some((e) => isHeading(e.line)))) return { kind: "retire", reason: "heading" };
  if (count > MAX_NOTED_LINES) return { kind: "retire", reason: "too-many" };
  const memoryLines = renderedLines(memory);
  const peopleLines = renderedLines(people);
  // Measured as rendered: the heading path repeats on every line.
  const chars = [...memoryLines, ...peopleLines].reduce((n, l) => n + l.length, 0);
  if (chars > MAX_NOTED_CHARS) return { kind: "retire", reason: "too-large" };
  const sections = [renderSection("MEMORY.md", memoryLines), renderSection("People registry", peopleLines)]
    .filter((s): s is string => s !== undefined);
  return {
    kind: "note",
    body: [
      "Your memory index or people registry changed since this conversation's system prompt was built (possibly by you). The system prompt still shows the earlier text; these lines are current.",
      ...sections,
    ].join("\n\n"),
  };
}
