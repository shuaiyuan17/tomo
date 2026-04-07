import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Session, SessionMessage, SessionEntry, SessionRegistry } from "./types.js";
import { log } from "../logger.js";

const UNLINKED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Where the SDK stores its JSONL session files */
function getSdkSessionDir(): string {
  const home = homedir();
  const workspacePath = join(home, ".tomo", "workspace");
  const encoded = workspacePath.replace(/\//g, "-");
  return join(home, ".claude", "projects", encoded);
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
    session.messages.push(message);
    session.updatedAt = message.timestamp;

    const file = this.transcriptPath(key);
    appendFileSync(file, JSON.stringify(message) + "\n");
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
    });
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
