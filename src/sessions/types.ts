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
}

export interface SessionRegistry {
  version: number;
  sessions: SessionEntry[];
}
