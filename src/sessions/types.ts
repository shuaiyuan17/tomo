export interface SessionMessage {
  /** Web ingress correlation; absent in older/provider transcript records. */
  requestId?: string;
  /** Canonical reply shared by web messages that joined the same SDK turn. */
  turnId?: string;
  role: "user" | "assistant" | "tool_summary";
  content: string;
  channel: string;
  senderName?: string;
  timestamp: number;
  /** Monotonic sequence number within this transcript */
  seq?: number;
  /** UUID of the corresponding SDK session event */
  sdkMessageUuid?: string;
  /** For tool_summary: names of tools used in this segment */
  toolsUsed?: string[];
  /** For tool_summary: number of tool calls summarized */
  toolCallCount?: number;
}

export interface Session {
  key: string;
  messages: SessionMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ContextCategory {
  name: string;
  tokens: number;
}

export interface SessionStats {
  /** Total number of queries in this session */
  totalQueries: number;
  /** Cumulative cost in USD */
  totalCostUsd: number;
  /** Cumulative input tokens */
  totalInputTokens: number;
  /** Cumulative output tokens */
  totalOutputTokens: number;
  /** Cumulative cache read tokens */
  totalCacheReadTokens: number;
  /** Cumulative cache creation tokens */
  totalCacheCreationTokens: number;
  /** Current context window usage */
  contextUsed: number;
  /** Context window max */
  contextMax: number;
  contextEstimated?: boolean;
  /** Context window breakdown by category */
  contextBreakdown?: ContextCategory[];
}

/**
 * The SDK's cumulative usage counters as of the last result tomo recorded for
 * one SDK session — the baseline per-turn deltas are computed from.
 *
 * WHY IT IS PERSISTED. `result.total_cost_usd` and `result.modelUsage` are
 * cumulative per query(), and a RESUMED session continues from the totals its
 * transcript saved, so the first result after a resume already carries every
 * earlier turn. A new LiveSession (process restart, /model switch, prompt-stale
 * retirement, compact reload) resumes the same SDK session id; without this
 * baseline its first turn was charged the session's whole lifetime.
 *
 * Tied to `sdkSessionId` so a baseline can never be applied to a different SDK
 * session than the one it was measured on.
 */
export interface UsageBaseline {
  sdkSessionId: string;
  /** Last cumulative `total_cost_usd`. */
  totalCostUsd: number;
  /** Last cumulative `modelUsage` token totals, summed across models. */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreated: number;
  };
}

export interface ReplyTarget {
  channelName: string;
  chatId: string;
}

export interface SessionEntry {
  /** SDK session ID (UUID) */
  sdkSessionId: string;
  /** Channel session key (e.g. "telegram:12345" or "dm:shuai") */
  channelKey: string;
  /** When this session was created */
  createdAt: number;
  /** When this session was last used */
  lastActiveAt: number;
  /** If unlinked, when it was unlinked. Null if active. */
  unlinkedAt: number | null;
  /** When this session should be deleted (unlinkedAt + TTL). Null if active. */
  expiresAt: number | null;
  /** Cumulative session statistics */
  stats: SessionStats;
  /**
   * SDK cumulative-usage baseline for `sdkSessionId` (see UsageBaseline).
   * Absent on entries written before it existed, after a result that reset
   * the SDK's totals, and on fresh/cleared/retired links.
   */
  usageBaseline?: UsageBaseline;
  /** Reply routing target for unified multi-channel sessions */
  replyTarget?: ReplyTarget;
  /**
   * The raw `<channel>:<chatId>` key this entry lived under before it was
   * re-keyed to a `dm:` identity key (kept across chained migrations). The
   * identity's removal hands cron jobs back to this key — for iMessage it is
   * the GUID-shaped key inbound traffic uses, which cannot be rebuilt from
   * the configured handle.
   */
  migratedFrom?: string;
  /** Display title for groups (or any session that has a friendly name). */
  chatTitle?: string;
  /** Known participants (sender names seen) — used to disambiguate groups. */
  participants?: string[];
  /**
   * Stable sender id → display names seen for that id (oldest first). Joins
   * a renamed profile back to the same human and keys people-registry
   * resolution. Names arriving without a sender id only appear in
   * `participants`.
   */
  participantIds?: Record<string, string[]>;
}

export interface SessionRegistry {
  version: number;
  sessions: SessionEntry[];
}
