import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SessionMessage } from "../sessions/types.js";
import type { TranscriptRecall, TranscriptRecallHit } from "../sessions/store.js";
import { RECALL_MAX_SCORED_CHARS } from "../sessions/recall-score.js";
import { shortErrorMessage } from "../error-text.js";

/** Cap per-message excerpt length so one giant transcript entry can't blow
 *  the tool result (and the caller's context) up. */
const EXCERPT_CHARS = 400;
/** How much of an excerpt comes before the match: enough to read what the
 *  matched words belong to, with most of the room left for what follows. */
const EXCERPT_LEAD_CHARS = 100;
const MAX_RESULTS = 100;
const MAX_QUERIES = 3;
/** Without `after`, a search looks this far back. */
export const RECALL_DEFAULT_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecallSearchOpts {
  query?: string;
  fromTime?: number;
  toTime?: number;
  limit?: number;
}

export interface RecallScoredOpts {
  queries: string[];
  fromTime?: number;
  toTime?: number;
  limit?: number;
}

/** What one scored search came to, for the caller's counters. Never the query. */
export interface RecallSearchOutcome {
  /** Messages that passed the score filter. Zero is the case being counted. */
  matched: number;
  /** The scan ran out of budget before the end of the time range. */
  stopped: boolean;
}

/**
 * The recall tool's dependencies: transcript reads pre-bound to the calling
 * session's key. Binding happens in internal-server.ts — the tool can only
 * ever read its own session's history, so a group session cannot recall DM
 * conversations (and vice versa).
 */
export interface RecallToolDeps {
  /** Browse by time range: the most recent messages in the window. */
  search(opts: RecallSearchOpts): SessionMessage[];
  /** Scored search: the best matches for the phrasings in `queries`. */
  recall(opts: RecallScoredOpts): TranscriptRecall;
  /** Called once per scored search that ran, with how it came out. */
  onSearch?: (outcome: RecallSearchOutcome) => void;
  /** Millisecond wall clock, for the default window. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Per-call gate: may this turn read the bound session's transcript?
   *
   * A GETTER, resolved when the tool runs, because a session's audience is
   * not fixed for its lifetime. A summoned group's messages run on the
   * OWNER's `dm:` session (router `summonGroup`), so the transcript bound
   * above is the owner's private DM history while the turn is being steered
   * by a group chat — and a coalesced batch can mix both. Left undefined,
   * recall is always allowed (tests, and any caller with no audience notion).
   */
  canSearch?: () => boolean;
}

/**
 * Refusal text for a turn that may not read its session's transcript. Names
 * the reason and the way round it, so the model can tell the user rather than
 * retrying with a different query.
 */
export const RECALL_FOREIGN_AUDIENCE_REFUSAL =
  "recall is unavailable while a group is summoned into this session. This turn's messages come from a summoned group (or span several audiences), and the transcript here is the owner's private DM history — not something to surface into a group-steered turn. Ask again in the owner's own DM, or `/dismiss` the summon first.";

function parseTimeBound(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ${label} time "${value}" — use ISO 8601, e.g. "2026-05-01" or "2026-05-01T09:00".`);
  }
  return ms;
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "unknown-time" : date.toISOString();
}

function formatDate(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "unknown-date" : date.toISOString().slice(0, 10);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * At most `EXCERPT_CHARS` of `content`, placed so that `matchIndex` (where the
 * first matched word starts) is inside it. A match deep in a long message used
 * to be cut off: the excerpt was always the message's first 400 characters.
 */
function excerptAround(content: string, matchIndex: number): string {
  if (content.length <= EXCERPT_CHARS) return content;
  const latestStart = content.length - EXCERPT_CHARS;
  let start = Math.min(Math.max(matchIndex - EXCERPT_LEAD_CHARS, 0), latestStart);
  let end = start + EXCERPT_CHARS;
  // Never cut a surrogate pair in half.
  if (start > 0 && isLowSurrogate(content.charCodeAt(start))) start++;
  if (end < content.length && isLowSurrogate(content.charCodeAt(end))) end--;
  return `${start > 0 ? "… " : ""}${content.slice(start, end)}${end < content.length ? "… [truncated]" : ""}`;
}

function formatMessage(msg: SessionMessage, hit?: { score: number; matchIndex: number }): string {
  // Transcript records are written by us, but be defensive about legacy or
  // hand-edited lines — a malformed record must not break recall.
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  const who = msg.role === "user" && msg.senderName ? `user (${msg.senderName})` : msg.role;
  const seq = msg.seq != null ? ` #${msg.seq}` : "";
  const score = hit ? ` (score ${hit.score.toFixed(2)})` : "";
  return `[${formatTimestamp(msg.timestamp)}]${seq} ${who}${score}: ${excerptAround(content, hit?.matchIndex ?? 0)}`;
}

/** The time range one call covered, for the result text. */
export interface RecallWindow {
  /** Lower bound of the search, in milliseconds. */
  fromTime: number;
  /** True when the caller gave no `after` and the default window applied. */
  defaultWindow: boolean;
}

const DEFAULT_WINDOW_NOTE = ` (the last ${RECALL_DEFAULT_WINDOW_DAYS} days; use after to go further)`;

/**
 * How far back a scored search looked. When the scan ran out of budget this
 * is where it stopped, and how to pick up from there; otherwise the window's
 * lower bound, with the default window named so a miss is not read as "never
 * said".
 */
function searchedBackTo(recall: TranscriptRecall, window: RecallWindow, toTime?: number): { short: string; note: string } {
  if (!recall.stopped) {
    const reach = `${formatDate(window.fromTime)}${window.defaultWindow ? DEFAULT_WINDOW_NOTE : ""}`;
    return { short: `searched back to ${reach}`, note: "" };
  }
  const reachedBackTo = recall.stopped.reachedBackTo;
  if (reachedBackTo === null) {
    return {
      short: "the search stopped before reading the whole time range",
      note: " One search scans a bounded slice of history; narrow the time range with `before` / `after` to cover the rest.",
    };
  }
  const reached = formatTimestamp(reachedBackTo);
  if (toTime !== undefined && reachedBackTo >= toTime) {
    // The scan ran out on its way down to `before`: a retry from here would
    // stop in the same place, so none is suggested.
    return {
      short: `the search got back to ${reached} only, without getting past \`before\``,
      note: " One search scans a bounded slice of history, newest first, and there is more than that between here and `before`: what is older cannot be reached by this search. Say so rather than concluding it was never said.",
    };
  }
  return {
    short: `searched back to ${reached} only`,
    note: ` One search scans a bounded slice of history, newest first, and this one stopped at ${reached}; set \`before\` to that time to search what is older.`,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Result text for a scored search. Exported for tests. */
export function formatRecallHits(recall: TranscriptRecall, window: RecallWindow, toTime?: number): string {
  const reach = searchedBackTo(recall, window, toTime);
  const short = reach.short;
  // A very long message (a pasted log or file) is searched in its beginning
  // only. Said, so that a miss is not read as "not in there".
  const note = recall.clipped
    ? `${reach.note} ${recall.clipped} very long message(s) in that range were searched only in their first ${RECALL_MAX_SCORED_CHARS.toLocaleString("en-US")} characters.`
    : reach.note;
  if (recall.hits.length === 0) {
    return `No matching messages found (${short}).${note} Try other phrasings in queries, fewer or rarer words, or a wider time range.`;
  }
  const shown = recall.hits.length;
  const more = recall.matched > shown
    ? ` (the ${shown} best of ${recall.matched} matches; raise \`limit\` or narrow the search to see the rest)`
    : "";
  return [
    `${shown} message(s), oldest first${more}. ${capitalize(short)}.${note}`,
    "",
    ...recall.hits.map((hit: TranscriptRecallHit) => formatMessage(hit.msg, hit)),
  ].join("\n");
}

/** Result text for browsing by time range (no query). Exported for tests. */
export function formatRecallResults(messages: SessionMessage[], limit: number, window?: RecallWindow): string {
  const windowNote = window?.defaultWindow
    ? ` Without \`after\`, only the last ${RECALL_DEFAULT_WINDOW_DAYS} days are shown (back to ${formatDate(window.fromTime)}).`
    : "";
  if (messages.length === 0) {
    return `No messages in that time range.${windowNote}`;
  }
  const capNote = messages.length >= limit
    ? ` (hit the ${limit}-message limit — these are the most recent; narrow the time range with \`before\` to reach older ones)`
    : "";
  return [
    `${messages.length} message(s), oldest first${capNote}.${windowNote}`,
    "",
    ...messages.map((msg) => formatMessage(msg)),
  ].join("\n");
}

/** The phrasings of one call: `queries` then `query`, trimmed, without blanks or repeats. */
function phrasingsOf(queries: string[] | undefined, query: string | undefined): string[] {
  const all = [...(queries ?? []), ...(query === undefined ? [] : [query])].map((q) => q.trim()).filter((q) => q !== "");
  return [...new Set(all)];
}

/**
 * MCP tool factory for transcript recall, registered onto the `tomo-internal`
 * server. The session transcript is Tomo's own durable record — it survives
 * SDK context compaction and daemon restarts, and spans monthly rotation
 * archives — so this is how the agent reaches conversation history that is
 * no longer in its context window.
 */
export function buildRecallTools(deps: RecallToolDeps) {
  return [
    tool(
      "recall_conversation",
      [
        "Search this conversation's full message history, including what was compacted out of your context and months archived out of the active transcript.",
        "",
        "Use it when someone refers to something you can't see, to check what was actually said or decided, or to recover details after a compaction.",
        "",
        "Scope: only this conversation.",
        "",
        `Each message is scored by which of the query's words it contains, rare words counting more (Chinese by two-character pieces), so word order and spacing don't matter and partial matches count. Use 2–4 distinctive words per phrasing, not a whole sentence. Give two or three phrasings in \`queries\`: one close to the owner's wording, the others for related names, projects or decisions. The best matches are kept and shown oldest first, each with its score and an excerpt around the match. Without \`after\`, only the last ${RECALL_DEFAULT_WINDOW_DAYS} days are searched. One search scans a bounded slice of history, newest first, and says where it stopped; use \`before\` / \`after\` to reach further.`,
      ].join("\n"),
      {
        queries: z.array(z.string().min(1)).min(1).max(MAX_QUERIES).optional().describe(
          `Up to ${MAX_QUERIES} phrasings. A message's score is its best over them.`,
        ),
        query: z.string().min(1).optional().describe(
          "One phrasing; same as `queries` with one entry. Omit both to browse by time range only.",
        ),
        after: z.string().optional().describe(
          'Only messages at/after this time. ISO 8601, e.g. "2026-05-01" or "2026-05-01T09:00".',
        ),
        before: z.string().optional().describe(
          "Only messages at/before this time (ISO 8601). Also the paging knob: set it just below the oldest shown timestamp to reach older messages.",
        ),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(20).describe(
          `Max messages (default 20, max ${MAX_RESULTS}). The highest-scoring matches win; when browsing by time range, the most recent.`,
        ),
      },
      async ({ queries, query, after, before, limit }) => {
        // Checked FIRST, before any argument parsing: the refusal must not
        // depend on the caller's arguments, and must be the only observable
        // outcome for a turn that may not read this transcript.
        if (deps.canSearch && !deps.canSearch()) {
          return {
            content: [{ type: "text" as const, text: `recall_conversation failed: ${RECALL_FOREIGN_AUDIENCE_REFUSAL}` }],
            isError: true,
          };
        }
        let fromTime: number | undefined;
        let toTime: number | undefined;
        try {
          fromTime = parseTimeBound(after, "after");
          toTime = parseTimeBound(before, "before");
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `recall_conversation failed: ${shortErrorMessage(err)}` }],
            isError: true,
          };
        }
        if (fromTime !== undefined && toTime !== undefined && fromTime > toTime) {
          return {
            content: [{ type: "text" as const, text: `recall_conversation failed: \`after\` (${after}) is later than \`before\` (${before}).` }],
            isError: true,
          };
        }

        const phrasings = phrasingsOf(queries, query);
        if (phrasings.length === 0 && (queries !== undefined || query !== undefined)) {
          return {
            content: [{ type: "text" as const, text: "recall_conversation failed: the query is blank. Give a few distinctive words, or omit `query` and `queries` to browse by time range." }],
            isError: true,
          };
        }

        const defaultWindow = fromTime === undefined;
        const window: RecallWindow = {
          fromTime: fromTime ?? (deps.now ?? Date.now)() - RECALL_DEFAULT_WINDOW_DAYS * DAY_MS,
          defaultWindow,
        };
        if (toTime !== undefined && toTime < window.fromTime) {
          // Only reachable through the default window: an explicit inverted
          // range was refused above. Said plainly, and not counted as a search
          // that found nothing, because nothing was searched.
          return {
            content: [{ type: "text" as const, text: `No messages searched: \`before\` (${before}) is more than ${RECALL_DEFAULT_WINDOW_DAYS} days ago, and without \`after\` only the last ${RECALL_DEFAULT_WINDOW_DAYS} days are searched. Add \`after\` to reach that far back.` }],
          };
        }

        if (phrasings.length === 0) {
          const messages = deps.search({ fromTime: window.fromTime, toTime, limit });
          return {
            content: [{ type: "text" as const, text: formatRecallResults(messages, limit, window) }],
          };
        }
        const recall = deps.recall({ queries: phrasings, fromTime: window.fromTime, toTime, limit });
        deps.onSearch?.({ matched: recall.matched, stopped: recall.stopped !== undefined });
        return {
          content: [{ type: "text" as const, text: formatRecallHits(recall, window, toTime) }],
        };
      },
      {
        alwaysLoad: true,
        searchHint: "recall search conversation history transcript remember past earlier said discussed archive",
      },
    ),
  ];
}
