import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Session, SessionMessage, SessionEntry, SessionRegistry } from "./types.js";
import { log } from "../logger.js";

const UNLINKED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Where the SDK stores its JSONL session files */
export function getSdkSessionDir(): string {
  const home = homedir();
  const workspacePath = join(home, ".tomo", "workspace");
  // SDK encodes: replace / and . with -
  const encoded = workspacePath.replace(/[/.]/g, "-");
  return join(home, ".claude", "projects", encoded);
}

/** Get the full path to an SDK session JSONL file */
export function getSdkSessionPath(sessionId: string): string {
  return join(getSdkSessionDir(), `${sessionId}.jsonl`);
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private registry: SessionEntry[] = [];
  private dir: string;
  private historyLimit: number;

  constructor(dir: string, historyLimit: number) {
    this.dir = dir;
    this.historyLimit = historyLimit;
    mkdirSync(dir, { recursive: true });
    this.loadRegistry();
    this.cleanupExpired();
  }

  /** Get or create a session, loading from disk on first access */
  get(key: string): Session {
    let session = this.sessions.get(key);
    if (session) return session;

    const messages = this.loadTranscript(key);
    session = {
      key,
      messages,
      createdAt: messages.length > 0 ? messages[0].timestamp : Date.now(),
      updatedAt: messages.length > 0 ? messages[messages.length - 1].timestamp : Date.now(),
    };
    this.sessions.set(key, session);
    return session;
  }

  /** Append a message to the session and persist to disk */
  append(key: string, message: SessionMessage): void {
    const session = this.get(key);

    // Auto-assign seq number if not present
    if (message.seq == null) {
      const lastSeq = this.getLastSeq(session);
      message.seq = lastSeq + 1;
    }

    session.messages.push(message);
    session.updatedAt = message.timestamp;

    const file = this.transcriptPath(key);
    appendFileSync(file, JSON.stringify(message) + "\n");
  }

  /** Append a tool summary entry for a completed tool chain */
  appendToolSummary(key: string, opts: {
    toolsUsed: string[];
    toolCallCount: number;
    content: string;
    timestamp: number;
    sdkMessageUuid?: string;
  }): void {
    this.append(key, {
      role: "tool_summary",
      content: opts.content,
      channel: "sdk",
      timestamp: opts.timestamp,
      toolsUsed: opts.toolsUsed,
      toolCallCount: opts.toolCallCount,
      sdkMessageUuid: opts.sdkMessageUuid,
    });
  }

  /** Search transcript by text query, optionally filtered by time range */
  searchTranscript(key: string, opts: {
    query?: string;
    fromSeq?: number;
    toSeq?: number;
    fromTime?: number;
    toTime?: number;
    limit?: number;
  }): SessionMessage[] {
    const session = this.get(key);
    const limit = opts.limit ?? 50;
    const results: SessionMessage[] = [];

    const queryLower = opts.query?.toLowerCase();

    for (const msg of session.messages) {
      if (opts.fromSeq != null && (msg.seq ?? 0) < opts.fromSeq) continue;
      if (opts.toSeq != null && (msg.seq ?? 0) > opts.toSeq) continue;
      if (opts.fromTime != null && msg.timestamp < opts.fromTime) continue;
      if (opts.toTime != null && msg.timestamp > opts.toTime) continue;
      if (queryLower && !msg.content.toLowerCase().includes(queryLower)) continue;

      results.push(msg);
      if (results.length >= limit) break;
    }

    return results;
  }

  /** Get the highest seq number in a session */
  private getLastSeq(session: Session): number {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].seq != null) return session.messages[i].seq!;
    }
    return 0;
  }

  /** Get the last N turns of conversation for LLM context */
  getHistory(key: string): SessionMessage[] {
    const session = this.get(key);
    const messages = session.messages;

    if (this.historyLimit <= 0) return messages;

    let userTurns = 0;
    let cutoff = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userTurns++;
        if (userTurns > this.historyLimit) break;
      }
      cutoff = i;
    }

    return messages.slice(cutoff);
  }

  // --- SDK Session Registry ---

  /** Get the active SDK session ID for a channel key */
  getSdkSessionId(key: string): string | undefined {
    // Re-read from disk to pick up external changes (e.g. `tomo sessions clear`)
    this.loadRegistry();
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    return entry?.sdkSessionId;
  }

  /** Link a new SDK session to a channel key */
  setSdkSessionId(key: string, sessionId: string): void {
    // Unlink any existing session for this key
    this.clearSdkSessionId(key);

    const now = Date.now();
    this.registry.push({
      sdkSessionId: sessionId,
      channelKey: key,
      createdAt: now,
      lastActiveAt: now,
      unlinkedAt: null,
      expiresAt: null,
      stats: {
        totalQueries: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        contextUsed: 0,
        contextMax: 0,
      },
    });
    this.saveRegistry();
  }

  /** Update session stats after a query */
  updateStats(key: string, update: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextUsed: number;
    contextMax: number;
  }): void {
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    if (!entry) return;

    // Initialize stats if missing (migration from old format)
    if (!entry.stats) {
      entry.stats = {
        totalQueries: 0, totalCostUsd: 0,
        totalInputTokens: 0, totalOutputTokens: 0,
        totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
        contextUsed: 0, contextMax: 0,
      };
    }

    entry.stats.totalQueries++;
    entry.stats.totalCostUsd += update.costUsd;
    entry.stats.totalInputTokens += update.inputTokens;
    entry.stats.totalOutputTokens += update.outputTokens;
    entry.stats.totalCacheReadTokens += update.cacheReadTokens;
    entry.stats.totalCacheCreationTokens += update.cacheCreationTokens;
    entry.stats.contextUsed = update.contextUsed;
    entry.stats.contextMax = update.contextMax;
    entry.lastActiveAt = Date.now();
    this.saveRegistry();
  }

  /** Touch the active session (update lastActiveAt) */
  touchSession(key: string): void {
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    if (entry) {
      entry.lastActiveAt = Date.now();
      this.saveRegistry();
    }
  }

  /** List all SDK session entries */
  listSdkSessionIds(): [string, string][] {
    return this.registry
      .filter((e) => e.unlinkedAt === null)
      .map((e) => [e.channelKey, e.sdkSessionId]);
  }

  /** List all sessions including unlinked */
  listAllSessions(): SessionEntry[] {
    return [...this.registry];
  }

  /** Unlink a session (marks for deletion after TTL) */
  clearSdkSessionId(key: string): void {
    const now = Date.now();
    for (const entry of this.registry) {
      if (entry.channelKey === key && entry.unlinkedAt === null) {
        entry.unlinkedAt = now;
        entry.expiresAt = now + UNLINKED_TTL_MS;
        log.info(
          { key, sessionId: entry.sdkSessionId, expiresAt: new Date(entry.expiresAt).toISOString() },
          "Session unlinked, will be deleted in 30 days",
        );
      }
    }
    this.saveRegistry();
  }

  /** Delete expired unlinked sessions and their SDK JSONL files */
  private cleanupExpired(): void {
    const now = Date.now();
    const sdkDir = getSdkSessionDir();
    const expired = this.registry.filter((e) => e.expiresAt !== null && e.expiresAt <= now);

    for (const entry of expired) {
      // Delete the SDK JSONL file
      const sdkFile = join(sdkDir, `${entry.sdkSessionId}.jsonl`);
      if (existsSync(sdkFile)) {
        try {
          unlinkSync(sdkFile);
          log.info({ sessionId: entry.sdkSessionId }, "Deleted expired SDK session file");
        } catch {
          log.warn({ sessionId: entry.sdkSessionId }, "Failed to delete expired SDK session file");
        }
      }
    }

    if (expired.length > 0) {
      this.registry = this.registry.filter((e) => e.expiresAt === null || e.expiresAt > now);
      this.saveRegistry();
      log.info({ count: expired.length }, "Cleaned up expired sessions");
    }
  }

  // --- Registry persistence ---

  private get registryPath(): string {
    return join(this.dir, "_sessions.json");
  }

  private loadRegistry(): void {
    const file = this.registryPath;
    if (!existsSync(file)) {
      // Migrate from old _sdk_sessions.json if it exists
      this.migrateOldFormat();
      return;
    }
    try {
      const data: SessionRegistry = JSON.parse(readFileSync(file, "utf-8"));
      this.registry = data.sessions ?? [];
    } catch {
      this.registry = [];
    }
  }

  private saveRegistry(): void {
    const data: SessionRegistry = { version: 1, sessions: this.registry };
    writeFileSync(this.registryPath, JSON.stringify(data, null, 2) + "\n");
  }

  /** Migrate from the old simple key→value format */
  private migrateOldFormat(): void {
    const oldFile = join(this.dir, "_sdk_sessions.json");
    if (!existsSync(oldFile)) return;

    try {
      const data = JSON.parse(readFileSync(oldFile, "utf-8"));
      const now = Date.now();
      for (const [key, sessionId] of Object.entries(data)) {
        this.registry.push({
          sdkSessionId: sessionId as string,
          channelKey: key,
          createdAt: now,
          lastActiveAt: now,
          unlinkedAt: null,
          expiresAt: null,
          stats: {
            totalQueries: 0, totalCostUsd: 0,
            totalInputTokens: 0, totalOutputTokens: 0,
            totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
            contextUsed: 0, contextMax: 0,
          },
        });
      }
      this.saveRegistry();
      unlinkSync(oldFile);
      log.info({ count: this.registry.length }, "Migrated old session format");
    } catch {
      // Ignore migration errors
    }
  }

  // --- Transcripts ---

  private transcriptPath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.jsonl`);
  }

  private loadTranscript(key: string): SessionMessage[] {
    const file = this.transcriptPath(key);
    if (!existsSync(file)) return [];

    const lines = readFileSync(file, "utf-8").trim().split("\n");
    const messages: SessionMessage[] = [];

    for (const line of lines) {
      if (!line) continue;
      try {
        messages.push(JSON.parse(line) as SessionMessage);
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  }
}
