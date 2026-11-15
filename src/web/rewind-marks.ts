import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomicSync } from "../fs-utils.js";
import type { WebRewindMark } from "./protocol.js";

/**
 * Where the owner rewound the conversation from the browser. A rewind forks
 * the SDK session and leaves Tomo's transcript untouched (CLAUDE.md, /rewind),
 * so the history the page shows still contains the messages the model no
 * longer has. These marks are what lets the page say so: everything between a
 * mark's `from` and `at` is shown as rewound.
 *
 * Presentation only. Losing the file loses the dimming, never a message; an
 * unreadable file reads as no marks and is replaced on the next rewind.
 */
export const MAX_REWIND_MARKS = 50;

/** Does the SDK's preview of the message it would rewind to line up with the one the owner clicked? */
export function rewindTargetMatches(preview: string, text: string): boolean {
  const flat = (value: string) => value.replace(/\s+/g, " ").trim();
  // The model's copy starts with the harness stamp (`[web · Wed 11/15 04:20 UTC]`); the transcript's does not.
  const seen = flat(preview).replace(/…$/, "").replace(/^\[[^\]]*\d{2}\/\d{2} \d{2}:\d{2}[^\]]*\]\s*/, "").trim();
  const clicked = flat(text);
  if (!seen || !clicked) return false;
  return clicked.startsWith(seen) || seen.startsWith(clicked);
}

function isMark(value: unknown): value is WebRewindMark {
  const mark = value as WebRewindMark | null;
  return !!mark && typeof mark === "object" && typeof mark.sessionId === "string" && Number.isFinite(mark.from) && Number.isFinite(mark.at)
    && Number.isInteger(mark.count) && mark.count > 0 && mark.from <= mark.at;
}

export class RewindMarks {
  private marks: WebRewindMark[] = [];
  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) this.marks = parsed.filter(isMark).slice(-MAX_REWIND_MARKS);
    } catch { /* missing or unreadable: no marks */ }
  }
  list(): WebRewindMark[] { return this.marks.map((mark) => ({ ...mark })); }
  add(mark: WebRewindMark): void {
    this.marks = [...this.marks, mark].slice(-MAX_REWIND_MARKS);
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeJsonAtomicSync(this.path, this.marks, { mode: 0o600 });
    } catch { /* presentation only: the rewind itself already happened */ }
  }
}
