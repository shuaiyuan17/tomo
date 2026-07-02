import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Session, SessionMessage, SessionEntry, SessionRegistry, ReplyTarget } from "./types.js";
import { log } from "../logger.js";
import { readJsonlFileSync, readJsonlTailSync, readFirstJsonlRecordSync, iterateJsonlBackwardsSync } from "../jsonl.js";
import { writeJsonAtomicSync } from "../fs-utils.js";

const UNLINKED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Floor for the in-memory transcript tail: enough to cover historyLimit user
// turns with generous margin (a turn is typically 2-3 messages) while keeping
// months of history out of daemon memory.
const TRANSCRIPT_TAIL_MIN = 200;
// Rotate the active transcript once it outgrows this; prior months move to
// _archive_<key>_<YYYY-MM>.jsonl siblings.
const TRANSCRIPT_ROTATE_BYTES = 2 * 1024 * 1024;

function monthOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

/** Ordering guard for rotation crash recovery: prefer the monotonic seq,
 *  fall back to timestamps for legacy messages without one. */
function isAfterMessage(msg: SessionMessage, last: SessionMessage): boolean {
  if (msg.seq != null && last.seq != null) return msg.seq > last.seq;
  return msg.timestamp > last.timestamp;
}

interface PendingNotesFile {
  version: 1;
  notes: Record<string, string[]>;
}

/** Get the full path to an SDK session JSONL file */
export function getSdkSessionPath(
  sessionId: string,
  sdkSessionsDir: string,
): string {
  return join(sdkSessionsDir, `${sessionId}.jsonl`);
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private registry: SessionEntry[] = [];
  // Stat of the registry file as of the last read/write. loadRegistry() is
  // called on nearly every store operation to pick up external changes
  // (e.g. `tomo sessions clear`); the stat check lets those calls skip the
  // full read+parse when the file hasn't changed since we last touched it.
  private registryStat: { mtimeMs: number; size: number } | null = null;
  private dir: string;
  private sdkSessionsDir: string;
  private tailLimit: number;
  private rotateBytes: number;
  // Month for which rotation already ran and found nothing to roll — skip
  // re-reading an all-current-month file until the month turns over.
  private rotateSkipMonth = new Map<string, string>();

  constructor(
    dir: string,
    historyLimit: number,
    sdkSessionsDir: string,
    opts?: { tailMessages?: number; rotateBytes?: number },
  ) {
    if (!sdkSessionsDir) {
      throw new Error("SessionStore requires an explicit SDK sessions directory");
    }
    this.dir = dir;
    this.sdkSessionsDir = sdkSessionsDir;
    this.tailLimit = opts?.tailMessages ?? Math.max(TRANSCRIPT_TAIL_MIN, historyLimit * 10);
    this.rotateBytes = opts?.rotateBytes ?? TRANSCRIPT_ROTATE_BYTES;
    mkdirSync(dir, { recursive: true });
    this.loadRegistry();
    this.cleanupExpired();
  }

  /** Get or create a session, loading only the transcript tail from disk on
   *  first access. Older messages stay on disk (see searchTranscript). */
  get(key: string): Session {
    let session = this.sessions.get(key);
    if (session) return session;

    this.maybeRotateTranscript(key);
    const messages = this.loadTranscript(key);
    session = {
      key,
      messages,
      createdAt: this.transcriptCreatedAt(key) ?? (messages.length > 0 ? messages[0].timestamp : Date.now()),
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

    // Long-running daemon: keep the in-memory cache bounded to the tail and
    // take the (amortized) chance to roll old months out of the active file.
    if (session.messages.length > this.tailLimit * 2) {
      session.messages.splice(0, session.messages.length - this.tailLimit);
      this.maybeRotateTranscript(key);
    }
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

  /**
   * Search the transcript by text query, optionally filtered by seq/time
   * range. Returns the most recent `limit` matches in chronological order —
   * an assistant recalling things almost always wants the latest mentions,
   * not the oldest.
   *
   * Streams newest-first from disk with early exit, so the full transcript
   * is never materialized; continues into monthly rotation archives when the
   * active file doesn't fill the limit.
   */
  searchTranscript(key: string, opts: {
    query?: string;
    fromSeq?: number;
    toSeq?: number;
    fromTime?: number;
    toTime?: number;
    limit?: number;
  }): SessionMessage[] {
    const limit = opts.limit ?? 50;
    const results: SessionMessage[] = [];
    const queryLower = opts.query?.toLowerCase();
    const files = [this.transcriptPath(key), ...this.listTranscriptArchives(key)];

    outer: for (const file of files) {
      for (const msg of iterateJsonlBackwardsSync<SessionMessage>(file)) {
        // Scanning newest→oldest: once past the window's lower bound,
        // nothing older can match.
        if (opts.fromSeq != null && (msg.seq ?? 0) < opts.fromSeq) break outer;
        if (opts.fromTime != null && msg.timestamp < opts.fromTime) break outer;
        if (opts.toSeq != null && (msg.seq ?? 0) > opts.toSeq) continue;
        if (opts.toTime != null && msg.timestamp > opts.toTime) continue;
        // Legacy/hand-edited records may lack a string content — skip rather
        // than throw out of the whole search (this backs an agent tool call).
        if (typeof msg.content !== "string") continue;
        if (queryLower && !msg.content.toLowerCase().includes(queryLower)) continue;

        results.push(msg);
        if (results.length >= limit) break outer;
      }
    }

    return results.reverse();
  }

  /** Search archive files (compacted SDK events) for a given session ID */
  searchArchive(sdkSessionId: string, opts: {
    query?: string;
    limit?: number;
  }): SessionMessage[] {
    const archivePath = join(this.dir, `_archive_${sdkSessionId}.jsonl`);
    if (!existsSync(archivePath)) return [];

    const limit = opts.limit ?? 50;
    const results: SessionMessage[] = [];
    const queryLower = opts.query?.toLowerCase();

    for (const event of readJsonlFileSync<Record<string, any>>(archivePath)) {
      try {
        if (event.type !== "user" && event.type !== "assistant") continue;

        // Extract text from SDK event format
        const msg = event.message;
        if (!msg) continue;

        let text = "";
        const content = msg.content;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text") text += (block.text ?? "") + " ";
          }
        }
        text = text.trim();
        if (!text) continue;

        if (queryLower && !text.toLowerCase().includes(queryLower)) continue;

        const ts = event.timestamp ? new Date(event.timestamp).getTime() : 0;
        results.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: text,
          channel: "archive",
          timestamp: ts,
        });

        if (results.length >= limit) break;
      } catch {
        // Skip malformed lines
      }
    }

    return results;
  }

  /** Get the highest seq number in a session */
  private getLastSeq(session: Session): number {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].seq != null) return session.messages[i].seq!;
    }
    // No seq in the tail — rotation may have moved every active message into
    // monthly archives (e.g. a session idle across a month boundary).
    // Continue the sequence from the newest archived record so seq stays
    // monotonic across the whole transcript history.
    for (const file of this.listTranscriptArchives(session.key)) {
      for (const record of iterateJsonlBackwardsSync<SessionMessage>(file)) {
        if (record.seq != null) return record.seq;
      }
    }
    return 0;
  }

  /** Load prompt notes that must survive daemon restarts until the session's
   *  next turn drains them. Returns a defensive copy. */
  getPendingNotes(key: string): string[] {
    return [...(this.loadPendingNotes()[key] ?? [])];
  }

  /** Replace the durable prompt-note queue for one session. An empty list
   *  removes the key and deletes the sidecar when no queues remain. */
  setPendingNotes(key: string, notes: string[]): void {
    const data = this.loadPendingNotes();
    if (notes.length > 0) {
      data[key] = [...notes];
    } else {
      delete data[key];
    }

    if (Object.keys(data).length === 0) {
      if (existsSync(this.pendingNotesPath)) unlinkSync(this.pendingNotesPath);
      return;
    }

    const file: PendingNotesFile = { version: 1, notes: data };
    writeJsonAtomicSync(this.pendingNotesPath, file);
  }

  // --- SDK Session Registry ---

  /** Get the active SDK session ID for a channel key */
  getSdkSessionId(key: string): string | undefined {
    // Re-read from disk to pick up external changes (e.g. `tomo sessions clear`)
    this.loadRegistry();
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    return entry?.sdkSessionId || undefined;
  }

  /** Get the active registry entry for a channel key */
  getEntry(key: string): SessionEntry | undefined {
    this.loadRegistry();
    return this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
  }

  /** Link a new SDK session to a channel key */
  setSdkSessionId(key: string, sessionId: string): void {
    this.loadRegistry();

    // A metadata-only stub (created by setChatTitle/addParticipant before any
    // SDK session existed — e.g. a freshly summoned group) is upgraded in
    // place so its title/participants survive the first real session.
    const stub = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null && !e.sdkSessionId);
    if (stub) {
      stub.sdkSessionId = sessionId;
      stub.lastActiveAt = Date.now();
      this.saveRegistry();
      return;
    }

    // Unlink any existing session for this key (reloads the registry first)
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
    contextBreakdown?: { name: string; tokens: number }[];
  }): void {
    // Reload before mutating: other processes (tomo sessions clear, tomo
    // config) rewrite the registry; saving a stale in-memory copy would
    // silently revert their changes.
    this.loadRegistry();
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
    if (update.contextBreakdown) {
      entry.stats.contextBreakdown = update.contextBreakdown;
    }
    entry.lastActiveAt = Date.now();
    this.saveRegistry();
  }

  /** Touch the active session (update lastActiveAt) */
  touchSession(key: string): void {
    this.loadRegistry();
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    if (entry) {
      entry.lastActiveAt = Date.now();
      this.saveRegistry();
    }
  }

  /** List all SDK session entries */
  listSdkSessionIds(): [string, string][] {
    // Reload so long-lived daemon paths (continuity, notifications, session
    // catalog, router DM lookup) see external changes like `tomo sessions clear`.
    // Metadata-only stubs (no SDK session yet) are excluded — consumers treat
    // these pairs as resumable sessions.
    this.loadRegistry();
    return this.registry
      .filter((e) => e.unlinkedAt === null && e.sdkSessionId)
      .map((e) => [e.channelKey, e.sdkSessionId]);
  }

  /** Active registry entries (linked sessions AND metadata-only stubs). */
  listActiveEntries(): SessionEntry[] {
    this.loadRegistry();
    return this.registry.filter((e) => e.unlinkedAt === null);
  }

  /** List all sessions including unlinked */
  listAllSessions(): SessionEntry[] {
    this.loadRegistry();
    return [...this.registry];
  }

  /** Unlink a session (marks for deletion after TTL). Metadata-only stubs
   *  have no SDK file to TTL — they are removed outright. */
  clearSdkSessionId(key: string): void {
    this.loadRegistry();
    const now = Date.now();
    this.registry = this.registry.filter((entry) => {
      if (entry.channelKey === key && entry.unlinkedAt === null && !entry.sdkSessionId) {
        log.info({ key }, "Metadata-only session entry removed");
        return false;
      }
      return true;
    });
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

  /**
   * Retire a poisoned SDK resume chain while preserving active routing/group
   * metadata. Use this when the SDK JSONL likely ended mid-turn (for example a
   * local query timeout): resuming that file can continue stale tool work, but
   * the chat title, participants, and reply target are still valid.
   */
  retireSdkSessionId(key: string): string | undefined {
    this.loadRegistry();
    const now = Date.now();
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null && e.sdkSessionId);
    if (!entry) return undefined;

    const retiredSessionId = entry.sdkSessionId;
    entry.unlinkedAt = now;
    entry.expiresAt = now + UNLINKED_TTL_MS;

    this.registry.push({
      sdkSessionId: "",
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
      ...(entry.replyTarget ? { replyTarget: entry.replyTarget } : {}),
      ...(entry.chatTitle ? { chatTitle: entry.chatTitle } : {}),
      ...(entry.participants ? { participants: [...entry.participants] } : {}),
    });

    this.saveRegistry();
    log.warn(
      { key, sessionId: retiredSessionId, expiresAt: new Date(entry.expiresAt).toISOString() },
      "SDK session retired, metadata preserved",
    );
    return retiredSessionId;
  }

  /** Delete expired unlinked sessions and their SDK JSONL files */
  private cleanupExpired(): void {
    const now = Date.now();
    const sdkDir = this.sdkSessionsDir;
    const expired = this.registry.filter((e) => e.expiresAt !== null && e.expiresAt <= now);
    const deletedFiles = new Set<string>();

    for (const entry of expired) {
      // Metadata-only stubs have no SDK file (and an empty id would alias
      // every other stub in the stillReferenced check below)
      if (!entry.sdkSessionId) continue;

      // Skip deletion if any surviving entry still references this sdkSessionId
      // (e.g. shared after migrateSessionKey, or unlinked but not yet expired)
      const stillReferenced = this.registry.some(
        (e) => e.sdkSessionId === entry.sdkSessionId && (e.expiresAt === null || e.expiresAt > now),
      );
      if (stillReferenced) {
        log.info(
          { sessionId: entry.sdkSessionId, channelKey: entry.channelKey },
          "Expired entry removed, SDK file preserved: sdkSessionId still referenced by another entry",
        );
        continue;
      }

      if (deletedFiles.has(entry.sdkSessionId)) continue;
      deletedFiles.add(entry.sdkSessionId);

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

  // --- Reply target for unified sessions ---

  /** Get the persisted reply target for a session key */
  getReplyTarget(key: string): ReplyTarget | undefined {
    this.loadRegistry();
    const entry = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    return entry?.replyTarget;
  }

  /** Set and persist the reply target for a session key. No-op if unchanged. */
  setReplyTarget(key: string, target: ReplyTarget): void {
    const entry = this.ensureActiveEntry(key);
    const prev = entry.replyTarget;
    if (prev && prev.channelName === target.channelName && prev.chatId === target.chatId) return;
    entry.replyTarget = target;
    this.saveRegistry();
  }

  /** Persist a friendly chat title for a session (mainly groups). No-op if unchanged. */
  setChatTitle(key: string, title: string): void {
    const entry = this.ensureActiveEntry(key);
    if (entry.chatTitle !== title) {
      entry.chatTitle = title;
      this.saveRegistry();
    }
  }

  /** Add a participant name to a session. No-op if already present. */
  addParticipant(key: string, name: string): void {
    const entry = this.ensureActiveEntry(key);
    const list = entry.participants ?? [];
    if (list.includes(name)) return;
    entry.participants = [...list, name];
    this.saveRegistry();
  }

  /** Active entry for a key, creating a metadata-only stub (empty sdkSessionId)
   *  when none exists — so group title/participants persist for sessions that
   *  haven't run a turn yet (e.g. a group summoned before it ever had its own
   *  session). setSdkSessionId upgrades the stub in place later. */
  private ensureActiveEntry(key: string): SessionEntry {
    this.loadRegistry();
    const existing = this.registry.find((e) => e.channelKey === key && e.unlinkedAt === null);
    if (existing) return existing;

    const now = Date.now();
    const entry: SessionEntry = {
      sdkSessionId: "",
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
    };
    this.registry.push(entry);
    return entry;
  }

  /** Migrate a session from one key to another (for identity-based session unification) */
  migrateSessionKey(oldKey: string, newKey: string): void {
    this.loadRegistry();
    const idx = this.registry.findIndex((e) => e.channelKey === oldKey && e.unlinkedAt === null);
    if (idx === -1) return;
    const entry = this.registry[idx];

    // Re-key the entry in place: the data lives on under newKey, so there's no
    // need to keep a phantom unlinked entry that would confuse `sessions list`
    // and (pre-fix) trick cleanupExpired into deleting the shared SDK file.
    const now = Date.now();
    this.registry[idx] = {
      ...entry,
      channelKey: newKey,
      lastActiveAt: now,
    };

    // Rename transcript file
    const oldPath = this.transcriptPath(oldKey);
    const newPath = this.transcriptPath(newKey);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      renameSync(oldPath, newPath);
    }

    // Bring monthly rotation archives along so search and createdAt keep
    // covering the pre-migration history.
    for (const archive of this.listTranscriptArchives(oldKey)) {
      const month = /_(\d{4}-\d{2})\.jsonl$/.exec(archive)?.[1];
      if (!month) continue;
      const target = this.transcriptArchivePath(newKey, month);
      if (!existsSync(target)) renameSync(archive, target);
    }

    const pendingNotes = this.loadPendingNotes();
    const oldNotes = pendingNotes[oldKey];
    if (oldNotes) {
      pendingNotes[newKey] = [...(pendingNotes[newKey] ?? []), ...oldNotes];
      delete pendingNotes[oldKey];
      writeJsonAtomicSync(this.pendingNotesPath, {
        version: 1,
        notes: pendingNotes,
      } satisfies PendingNotesFile);
    }

    // Clear in-memory session cache for old key
    this.sessions.delete(oldKey);

    this.saveRegistry();
    log.info({ oldKey, newKey, sdkSessionId: entry.sdkSessionId }, "Session migrated to unified key");
  }

  // --- Registry persistence ---

  private get registryPath(): string {
    return join(this.dir, "_sessions.json");
  }

  private get pendingNotesPath(): string {
    return join(this.dir, "_pending_notes.json");
  }

  private loadPendingNotes(): Record<string, string[]> {
    if (!existsSync(this.pendingNotesPath)) return {};
    try {
      const data = JSON.parse(readFileSync(this.pendingNotesPath, "utf-8")) as Partial<PendingNotesFile>;
      if (!data.notes || typeof data.notes !== "object") return {};
      return Object.fromEntries(
        Object.entries(data.notes)
          .filter((entry): entry is [string, string[]] =>
            Array.isArray(entry[1]) && entry[1].every((note) => typeof note === "string")),
      );
    } catch (err) {
      log.warn({ err, file: this.pendingNotesPath }, "Could not load pending notes");
      return {};
    }
  }

  private loadRegistry(): void {
    const file = this.registryPath;
    const stat = this.statRegistry();
    if (!stat) {
      this.registryStat = null;
      // Migrate from old _sdk_sessions.json if it exists
      this.migrateOldFormat();
      return;
    }
    if (this.registryStat
      && this.registryStat.mtimeMs === stat.mtimeMs
      && this.registryStat.size === stat.size) {
      return;
    }
    try {
      const data: SessionRegistry = JSON.parse(readFileSync(file, "utf-8"));
      this.registry = data.sessions ?? [];
      this.registryStat = stat;
    } catch {
      this.registry = [];
      this.registryStat = null;
    }
  }

  private saveRegistry(): void {
    const data: SessionRegistry = { version: 1, sessions: this.registry };
    writeJsonAtomicSync(this.registryPath, data);
    // Record our own write's stat so the next loadRegistry() doesn't re-read
    // what we just wrote. An external writer landing in the stat window would
    // be missed until its next write — the same read-modify-write race the
    // uncached path had, so no new hazard.
    this.registryStat = this.statRegistry();
  }

  private statRegistry(): { mtimeMs: number; size: number } | null {
    try {
      const s = statSync(this.registryPath);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
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

  private safeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private transcriptPath(key: string): string {
    return join(this.dir, `${this.safeKey(key)}.jsonl`);
  }

  private transcriptArchivePath(key: string, month: string): string {
    return join(this.dir, `_archive_${this.safeKey(key)}_${month}.jsonl`);
  }

  /** Monthly rotation archives for a key, newest month first. */
  private listTranscriptArchives(key: string): string[] {
    const prefix = `_archive_${this.safeKey(key)}_`;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.startsWith(prefix) && /^\d{4}-\d{2}\.jsonl$/.test(n.slice(prefix.length)))
      .sort()
      .reverse()
      .map((n) => join(this.dir, n));
  }

  /** Load only the last tailLimit messages of the active transcript. */
  private loadTranscript(key: string): SessionMessage[] {
    const file = this.transcriptPath(key);
    if (!existsSync(file)) return [];

    return readJsonlTailSync<SessionMessage>(file, this.tailLimit);
  }

  /** Timestamp of the oldest surviving message across archives + active file. */
  private transcriptCreatedAt(key: string): number | undefined {
    const archives = this.listTranscriptArchives(key);
    const oldestFile = archives.length > 0 ? archives[archives.length - 1] : this.transcriptPath(key);
    return readFirstJsonlRecordSync<SessionMessage>(oldestFile)?.timestamp;
  }

  /** Count user messages in the active transcript without retaining them.
   *  Bounded by rotation; archived months are not counted. */
  countRecentUserMessages(key: string): number {
    let count = 0;
    for (const msg of iterateJsonlBackwardsSync<SessionMessage>(this.transcriptPath(key))) {
      if (msg.role === "user") count++;
    }
    return count;
  }

  /**
   * Roll messages from prior months out of the active transcript into
   * _archive_<key>_<YYYY-MM>.jsonl siblings once the active file outgrows
   * rotateBytes. Keeps the active file — and everything priced by its size:
   * first-access load, search of recent history, /status counts — bounded
   * for a daemon that runs for months.
   *
   * Crash safety: archives are appended before the active file is rewritten
   * (atomically, via rename). If we die in between, the next rotation skips
   * already-archived messages via isAfterMessage instead of duplicating them.
   */
  private maybeRotateTranscript(key: string): void {
    const file = this.transcriptPath(key);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < this.rotateBytes) return;

    const currentMonth = monthOf(Date.now());
    if (this.rotateSkipMonth.get(key) === currentMonth) return;

    const all = readJsonlFileSync<SessionMessage>(file);
    const keep: SessionMessage[] = [];
    const byMonth = new Map<string, SessionMessage[]>();
    for (const msg of all) {
      const month = monthOf(msg.timestamp);
      if (month >= currentMonth) {
        keep.push(msg);
        continue;
      }
      let bucket = byMonth.get(month);
      if (!bucket) byMonth.set(month, bucket = []);
      bucket.push(msg);
    }
    if (byMonth.size === 0) {
      // Everything is current-month; nothing can roll until the month turns.
      this.rotateSkipMonth.set(key, currentMonth);
      return;
    }

    for (const [month, msgs] of byMonth) {
      const archivePath = this.transcriptArchivePath(key, month);
      let lastArchived: SessionMessage | undefined;
      for (const record of iterateJsonlBackwardsSync<SessionMessage>(archivePath)) {
        lastArchived = record;
        break;
      }
      const fresh = lastArchived ? msgs.filter((m) => isAfterMessage(m, lastArchived)) : msgs;
      if (fresh.length === 0) continue;
      appendFileSync(archivePath, fresh.map((m) => JSON.stringify(m)).join("\n") + "\n");
    }

    const tmp = `${file}.rotate-tmp`;
    writeFileSync(tmp, keep.length > 0 ? keep.map((m) => JSON.stringify(m)).join("\n") + "\n" : "");
    renameSync(tmp, file);
    log.info(
      { key, months: [...byMonth.keys()].sort(), archived: all.length - keep.length, kept: keep.length },
      "Transcript rotated: prior months moved to archive files",
    );
  }
}
