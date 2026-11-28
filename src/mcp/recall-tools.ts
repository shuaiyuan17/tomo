import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SessionMessage } from "../sessions/types.js";
import { RECALL_SCAN_BUDGET, type RecallScanBudget, type TranscriptRecall, type TranscriptRecallHit } from "../sessions/store.js";
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
  /** This conversation's slice of a `scope: "all"` search's budget. Absent:
   *  the store's own (`RECALL_SCAN_BUDGET`). */
  budget?: Pick<RecallScanBudget, "maxMs" | "maxBytes">;
}

/** One group chat a `scope: "all"` search reads. */
export interface RecallGroupSource {
  /** The group's session key. */
  key: string;
  /** The chat's title, when known. Shown to the model, so sanitised first. */
  title?: string;
  /** Size of its transcript files on disk: the order the budget is shared out in. */
  bytes: number;
}

/**
 * What `scope: "all"` needs: present only on the owner's DM session. Every
 * other session (a group's, another DM) has `scope` too, but "all" is refused
 * there, so the model is told rather than silently given the narrower search.
 */
export interface RecallScopeAllDeps {
  /**
   * Per call: may the turn in flight search the group chats? A getter for the
   * same reason as `canSearch`: the owner's DM session runs a summoned
   * group's turns, and the owner's own turns while a group is summoned in, on
   * the shared prompt, and group chat history must not be pulled into a
   * session a group can read.
   */
  allowed: () => boolean;
  /** The group chats, read per call (a group can be added at any time). */
  groups: () => RecallGroupSource[];
  /** Size of this conversation's own transcript, like `RecallGroupSource.bytes`. */
  ownBytes: () => number;
  /** Scored search of one group's transcript. */
  recallGroup: (key: string, opts: RecallScoredOpts) => TranscriptRecall;
  /** Monotonic millisecond clock for the shared budget. Defaults to `performance.now`. */
  clock?: () => number;
  /** The whole search's budget. Defaults to the store's `RECALL_SCAN_BUDGET`. */
  budget?: Pick<RecallScanBudget, "maxMs" | "maxBytes">;
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
 * session's key. Binding happens in internal-server.ts — `search` and
 * `recall` only ever read the session's own history. The one widening is
 * `scopeAll`, given to the owner's DM session alone, which adds the group
 * chats; nothing gives any other session a way into the DM (one way only).
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
  /** `scope: "all"`: see `RecallScopeAllDeps`. Absent: "all" is refused. */
  scopeAll?: RecallScopeAllDeps;
}

/**
 * Refusal text for a turn that may not read its session's transcript. Names
 * the reason and the way round it, so the model can tell the user rather than
 * retrying with a different query.
 */
export const RECALL_FOREIGN_AUDIENCE_REFUSAL =
  "recall is unavailable while a group is summoned into this session. This turn's messages come from a summoned group (or span several audiences), and the transcript here is the owner's private DM history — not something to surface into a group-steered turn. Ask again in the owner's own DM, or `/dismiss` the summon first.";

/** `scope: "all"` asked for on a session other than the owner's DM. */
export const RECALL_SCOPE_ALL_ELSEWHERE_REFUSAL =
  'scope "all" is only available in your private conversation with the owner. Here recall searches this conversation only: use scope "this".';

/** `scope: "all"` asked for on the owner's DM while a group can read the session. */
export const RECALL_SCOPE_ALL_SHARED_REFUSAL =
  'scope "all" is unavailable on this turn: a group is summoned into this conversation, so group chat history is not brought into it. Use scope "this", or ask again once the summon has ended.';

const SCOPE_ALL_BROWSE_REFUSAL =
  'scope "all" needs `query` or `queries`: browsing by time range covers this conversation only. Give a few distinctive words, or use scope "this".';

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

/** One conversation's part of a `scope: "all"` search. */
export interface RecallSourceResult {
  /** Null for this conversation; otherwise the group's label, e.g. `group "Book club"`. */
  label: string | null;
  /** Absent when the budget was spent before this conversation's turn came. */
  recall?: TranscriptRecall;
}

export interface RecallAcross {
  /** The best matches over every conversation, oldest first. */
  hits: Array<TranscriptRecallHit & { label: string | null }>;
  /** Records that passed the score filter, summed over the conversations. */
  matched: number;
  /** One entry per conversation: this one first, then the groups as given. */
  sources: RecallSourceResult[];
}

const MAX_GROUP_TITLE_CHARS = 60;

/** A chat title as it may appear inside `group "…"`: nothing that could end
 *  the quotes or the line, and not too long. Empty when nothing is left. */
function cleanGroupTitle(title: string | undefined): string {
  if (!title) return "";
  const flat = title.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\]/gu, " ").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, MAX_GROUP_TITLE_CHARS).join("").trim();
}

/**
 * How each group is named in results: `group "<title>"`, with the session key
 * added when two groups share a title, and the key alone when there is none.
 * Exported for tests.
 */
export function groupLabels(groups: readonly RecallGroupSource[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    const title = cleanGroupTitle(group.title).toLowerCase();
    if (title) counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const group of groups) {
    const title = cleanGroupTitle(group.title);
    if (!title) labels.set(group.key, `group ${group.key}`);
    else if (counts.get(title.toLowerCase()) === 1) labels.set(group.key, `group "${title}"`);
    else labels.set(group.key, `group "${title}" (${group.key})`);
  }
  return labels;
}

/** A record's time for ordering hits from different conversations. */
function hitTime(msg: SessionMessage): number {
  return typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp) ? msg.timestamp : 0;
}

/**
 * A scored search of this conversation and every group chat, under ONE budget
 * (`RecallScopeAllDeps.budget`, the store's 300 ms by default: the search is
 * synchronous on the daemon's event loop however many transcripts it reads).
 *
 * The budget is shared out smallest transcript first, each conversation
 * taking an equal part of what is left when its turn comes. What a small
 * transcript does not use passes on to the larger ones after it, so a few
 * small groups cost the owner's long DM history almost nothing, and one large
 * group cannot starve the others: each is searched, newest first, as far as
 * its part goes, and says where it stopped.
 *
 * Each conversation is scored on its own (word rarity is that conversation's),
 * keeps its own best `limit`, and the best `limit` of all of them are kept.
 * Exported for tests.
 */
export function recallAcross(
  own: (opts: RecallScoredOpts) => TranscriptRecall,
  deps: RecallScopeAllDeps,
  opts: RecallScoredOpts,
): RecallAcross {
  const clock = deps.clock ?? (() => performance.now());
  const budget = deps.budget ?? RECALL_SCAN_BUDGET;
  const startedAt = clock();
  const groups = deps.groups();
  const labels = groupLabels(groups);
  interface Source {
    label: string | null;
    bytes: number;
    order: number;
    run: (o: RecallScoredOpts) => TranscriptRecall;
    recall?: TranscriptRecall;
  }
  const sources: Source[] = [
    { label: null, bytes: deps.ownBytes(), order: 0, run: own },
    ...groups.map((group, index): Source => ({
      label: labels.get(group.key) ?? `group ${group.key}`,
      bytes: group.bytes,
      order: index + 1,
      run: (o) => deps.recallGroup(group.key, o),
    })),
  ];
  const queue = [...sources].sort((a, b) => a.bytes - b.bytes || a.order - b.order);
  let bytesLeft = budget.maxBytes;
  for (let i = 0; i < queue.length; i++) {
    const source = queue[i];
    const share = queue.length - i;
    const msLeft = budget.maxMs - (clock() - startedAt);
    if (msLeft <= 0 || bytesLeft <= 0) continue;
    const byteShare = Math.max(1, Math.floor(bytesLeft / share));
    source.recall = source.run({ ...opts, budget: { maxMs: msLeft / share, maxBytes: byteShare } });
    // What it could have read at most: a transcript smaller than its share
    // hands the rest on.
    bytesLeft -= Math.min(source.bytes, byteShare);
  }

  const all: RecallAcross["hits"] = [];
  let matched = 0;
  for (const source of sources) {
    if (!source.recall) continue;
    matched += source.recall.matched;
    for (const hit of source.recall.hits) all.push({ ...hit, label: source.label });
  }
  all.sort((a, b) => b.score - a.score || hitTime(b.msg) - hitTime(a.msg));
  const hits = all.slice(0, opts.limit ?? 20).sort((a, b) => hitTime(a.msg) - hitTime(b.msg));
  return {
    hits,
    matched,
    sources: sources.map((source) => ({ label: source.label, ...(source.recall ? { recall: source.recall } : {}) })),
  };
}

/** Result text for a `scope: "all"` search. Exported for tests. */
export function formatRecallAcross(across: RecallAcross, window: RecallWindow, toTime?: number): string {
  // Where each conversation got to. The default-window note is said once, in
  // the header, not once per conversation.
  const perSource: RecallWindow = { ...window, defaultWindow: false };
  let clipped = 0;
  const reach = across.sources.map((source) => {
    const name = source.label ?? "this conversation";
    if (!source.recall) {
      return `- ${name}: not searched; the search's time ran out before it got there. Narrow the time range with \`before\` / \`after\` to reach it.`;
    }
    clipped += source.recall.clipped ?? 0;
    const { short, note } = searchedBackTo(source.recall, perSource, toTime);
    return `- ${name}: ${short}.${note}`;
  });
  const groups = across.sources.length - 1;
  const notes = [
    window.defaultWindow ? `Without \`after\`, only the last ${RECALL_DEFAULT_WINDOW_DAYS} days are searched (back to ${formatDate(window.fromTime)}).` : "",
    clipped ? `${clipped} very long message(s) were searched only in their first ${RECALL_MAX_SCORED_CHARS.toLocaleString("en-US")} characters.` : "",
  ].filter((n) => n !== "").join(" ");
  const searched = ["Searched:", ...reach].join("\n");
  if (across.hits.length === 0) {
    return [
      `No matching messages found in this conversation or the ${groups} group chat(s).${notes ? ` ${notes}` : ""} Try other phrasings in queries, fewer or rarer words, or a wider time range.`,
      searched,
    ].join("\n");
  }
  const shown = across.hits.length;
  const more = across.matched > shown
    ? ` (the ${shown} best of ${across.matched} matches; raise \`limit\` or narrow the search to see the rest)`
    : "";
  return [
    `${shown} message(s), oldest first${more}. Messages marked [group "…"] were said in that group chat, not to you in private; the unmarked ones are from this conversation.${notes ? ` ${notes}` : ""}`,
    searched,
    "",
    ...across.hits.map((hit) => `${hit.label === null ? "" : `[${hit.label}] `}${formatMessage(hit.msg, hit)}`),
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
        'Scope: scope "this" (default) searches only this conversation. In your private conversation with the owner, scope "all" also searches group chats; those results are marked [group "X"] and are what group members said.',
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
        scope: z.enum(["this", "all"]).default("this").describe(
          '"this" (default): this conversation. "all": this conversation and every group chat, sharing one search budget; only in your private conversation with the owner, and only with `query` or `queries`.',
        ),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(20).describe(
          `Max messages (default 20, max ${MAX_RESULTS}). The highest-scoring matches win; when browsing by time range, the most recent.`,
        ),
      },
      async ({ queries, query, after, before, scope, limit }) => {
        // Checked FIRST, before any argument parsing: the refusal must not
        // depend on the caller's arguments, and must be the only observable
        // outcome for a turn that may not read this transcript.
        if (deps.canSearch && !deps.canSearch()) {
          return {
            content: [{ type: "text" as const, text: `recall_conversation failed: ${RECALL_FOREIGN_AUDIENCE_REFUSAL}` }],
            isError: true,
          };
        }
        // Next, and also before the arguments: whether this turn may read
        // other conversations at all.
        const scopeAll = scope === "all" ? deps.scopeAll : undefined;
        if (scope === "all" && (!scopeAll || !scopeAll.allowed())) {
          return {
            content: [{ type: "text" as const, text: `recall_conversation failed: ${scopeAll ? RECALL_SCOPE_ALL_SHARED_REFUSAL : RECALL_SCOPE_ALL_ELSEWHERE_REFUSAL}` }],
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

        if (scopeAll && phrasings.length === 0) {
          return {
            content: [{ type: "text" as const, text: `recall_conversation failed: ${SCOPE_ALL_BROWSE_REFUSAL}` }],
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
        if (scopeAll) {
          const across = recallAcross(deps.recall, scopeAll, { queries: phrasings, fromTime: window.fromTime, toTime, limit });
          deps.onSearch?.({
            matched: across.matched,
            stopped: across.sources.some((source) => !source.recall || source.recall.stopped !== undefined),
          });
          return {
            content: [{ type: "text" as const, text: formatRecallAcross(across, window, toTime) }],
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
