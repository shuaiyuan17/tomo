/**
 * What changed in MEMORY.md and the people roster since a live session's
 * system prompt was built — told to that session as a short note instead of
 * retiring it (see `buildIdentityPrompt` in ./index.ts).
 *
 * Pure: no filesystem access, so it is safe to import where the workspace
 * module is mocked.
 */

export interface PromptContextLines {
  memory: string[];
  people: string[];
}

/** Past this many changed lines (or characters) in one section, the note says
 *  where to look instead of listing them. */
export const MAX_CONTEXT_DIFF_LINES = 40;
export const MAX_CONTEXT_DIFF_CHARS = 3_000;

interface LineDiff {
  added: string[];
  removed: string[];
  /** Lines in both, but not in the same order or number (an entry moved
   *  under another heading, a line duplicated): invisible to added/removed. */
  moved: boolean;
}

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

function renderSection(title: string, diff: LineDiff, whereToLook: string): string | undefined {
  const count = diff.added.length + diff.removed.length;
  if (count === 0 && !diff.moved) return undefined;
  if (count === 0) return `${title}: existing lines were reordered (an entry may now sit under a different heading). ${whereToLook}`;
  const lines = [...diff.added.map((l) => `+ ${l}`), ...diff.removed.map((l) => `- ${l}`)];
  const body = lines.join("\n");
  if (count > MAX_CONTEXT_DIFF_LINES || body.length > MAX_CONTEXT_DIFF_CHARS) {
    return `${title}: changed substantially (${diff.added.length} line(s) added, ${diff.removed.length} removed). ${whereToLook}`;
  }
  const movedNote = diff.moved ? `\nExisting lines were also reordered. ${whereToLook}` : "";
  return `${title} (+ added, - removed):\n${body}${movedNote}`;
}

/**
 * The note body for a session built with `before`, or undefined when nothing
 * it can see has changed.
 */
export function describePromptContextChange(before: PromptContextLines, after: PromptContextLines): string | undefined {
  const sections = [
    renderSection("MEMORY.md", diffLines(before.memory, after.memory), "Read memory/MEMORY.md for the current index."),
    renderSection("People registry", diffLines(before.people, after.people), "Use list_people for the current records."),
  ].filter((s): s is string => s !== undefined);
  if (sections.length === 0) return undefined;
  return [
    "Your memory index or people registry changed since this conversation's system prompt was built (possibly by you). The system prompt still shows the earlier text; these lines are current.",
    ...sections,
  ].join("\n\n");
}
