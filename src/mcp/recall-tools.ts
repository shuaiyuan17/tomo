import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SessionMessage } from "../sessions/types.js";

/** Cap per-message excerpt length so one giant transcript entry can't blow
 *  the tool result (and the caller's context) up. */
const EXCERPT_CHARS = 400;
const MAX_RESULTS = 100;

export interface RecallSearchOpts {
  query?: string;
  fromTime?: number;
  toTime?: number;
  limit?: number;
}

/**
 * The recall tool's only dependency: a transcript search pre-bound to the
 * calling session's key. Binding happens in internal-server.ts — the tool
 * can only ever read its own session's history, so a group session cannot
 * recall DM conversations (and vice versa).
 */
export interface RecallToolDeps {
  search(opts: RecallSearchOpts): SessionMessage[];
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
  "recall is unavailable while a group is summoned into this session. This turn's messages come from a summoned group (or span several audiences), and the transcript here is the owner's private DM history — it is not readable from a group-steered turn. Ask again in the owner's own DM, or `/dismiss` the summon first.";

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

function formatMessage(msg: SessionMessage): string {
  // Transcript records are written by us, but be defensive about legacy or
  // hand-edited lines — a malformed record must not break recall.
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  const excerpt = content.length > EXCERPT_CHARS
    ? `${content.slice(0, EXCERPT_CHARS)}… [truncated]`
    : content;
  const who = msg.role === "user" && msg.senderName ? `user (${msg.senderName})` : msg.role;
  const seq = msg.seq != null ? ` #${msg.seq}` : "";
  return `[${formatTimestamp(msg.timestamp)}]${seq} ${who}: ${excerpt}`;
}

/** Exported for tests. */
export function formatRecallResults(messages: SessionMessage[], limit: number): string {
  if (messages.length === 0) {
    return "No matching messages found. Try a broader query, a wider time range, or different wording (the search is a case-insensitive substring match).";
  }
  const capNote = messages.length >= limit
    ? ` (hit the ${limit}-message limit — these are the most recent matches; narrow the time range with \`before\` to reach older ones)`
    : "";
  return [
    `${messages.length} message(s), oldest first${capNote}:`,
    "",
    ...messages.map(formatMessage),
  ].join("\n");
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
        "Search this conversation's full message history — including everything compacted out of your current context and months archived out of the active transcript.",
        "",
        "Use when the user references something you don't remember (\"like we discussed last month\", \"the restaurant I mentioned\"), when you need to check what was actually said or decided earlier, or to re-orient after a context compaction.",
        "",
        "Scope: ONLY this session's history. Other conversations (other identities, other groups) are not searchable from here.",
        "",
        "Matching is a case-insensitive substring over message text — prefer distinctive short terms (\"restaurant\", \"flight\") over full phrases. Results come back oldest-first with timestamps; when more messages match than the limit, you get the MOST RECENT matches, so use `before` to page further back.",
      ].join("\n"),
      {
        query: z.string().min(1).optional().describe(
          "Case-insensitive substring to search for. Omit to browse by time range only.",
        ),
        after: z.string().optional().describe(
          'Only messages at/after this time. ISO 8601, e.g. "2026-05-01" or "2026-05-01T09:00".',
        ),
        before: z.string().optional().describe(
          "Only messages at/before this time (ISO 8601). Also the paging knob: set it just below the oldest shown timestamp to reach older matches.",
        ),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(20).describe(
          `Max messages to return (default 20, max ${MAX_RESULTS}). The most recent matches win when more match.`,
        ),
      },
      async ({ query, after, before, limit }) => {
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
            content: [{ type: "text" as const, text: `recall_conversation failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
        if (fromTime !== undefined && toTime !== undefined && fromTime > toTime) {
          return {
            content: [{ type: "text" as const, text: `recall_conversation failed: \`after\` (${after}) is later than \`before\` (${before}).` }],
            isError: true,
          };
        }

        const messages = deps.search({ query, fromTime, toTime, limit });
        return {
          content: [{ type: "text" as const, text: formatRecallResults(messages, limit) }],
        };
      },
      {
        alwaysLoad: true,
        searchHint: "recall search conversation history transcript remember past earlier said discussed archive",
      },
    ),
  ];
}
