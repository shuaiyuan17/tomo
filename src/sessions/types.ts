export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  channel: string;
  senderName?: string;
  timestamp: number;
}

export interface Session {
  key: string;
  messages: SessionMessage[];
  createdAt: number;
  updatedAt: number;
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
}

export interface SessionEntry {
  /** SDK session ID (UUID) */
  sdkSessionId: string;
  /** Channel session key (e.g. "telegram:12345") */
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
}

export interface SessionRegistry {
  version: number;
  sessions: SessionEntry[];
}
