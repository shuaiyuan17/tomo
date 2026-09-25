import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";

/**
 * Re-reads a message's attachment rows straight from chat.db.
 *
 * Why this exists: an attachment still downloading can arrive on the imsg
 * watch stream with no local path at all (chat.db's `attachment.filename` is
 * not filled in yet), and imsg has no RPC that re-fetches one message's
 * attachments. Without a fresh read, the deferred-attachment watch would poll
 * nothing for its whole timeout. Same read-only chat.db access as the
 * satellite lookup (imsg-satellite.ts); Full Disk Access is already required
 * for imsg to work at all.
 */
export interface AttachmentRow {
  /** Absolute path (chat.db's `~/…` expanded), or "" while still unset. */
  path: string;
  transferName: string;
  mimeType: string;
  /** chat.db `attachment.transfer_state`, or null when absent. See {@link TRANSFER_STATE_COMPLETE}. */
  transferState: number | null;
}

/**
 * `attachment.transfer_state` values. Verified read-only against a live
 * macOS 27 chat.db: every row with 5 had its file on disk, every row with 0
 * had none (0 = not downloaded). 6 is the error state of IMCore's
 * IMFileTransferState enum; it was not observed locally, so it is the only
 * value treated as failed — anything else means "not finished yet".
 */
export const TRANSFER_STATE_COMPLETE = 5;
export const TRANSFER_STATE_FAILED = 6;

export interface AttachmentLookup {
  /** Attachment rows for a message GUID, in chat.db order. Empty when unknown/unavailable. */
  attachmentsForMessage(messageGuid: string): AttachmentRow[];
  close(): void;
}

export const NULL_ATTACHMENT_LOOKUP: AttachmentLookup = {
  attachmentsForMessage: () => [],
  close: () => {},
};

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

const ATTACHMENTS_SQL = `
  SELECT a.filename AS filename, a.transfer_name AS transfer_name, a.mime_type AS mime_type,
         a.transfer_state AS transfer_state
  FROM message m
  JOIN message_attachment_join j ON j.message_id = m.ROWID
  JOIN attachment a ON a.ROWID = j.attachment_id
  WHERE m.guid = ?
  ORDER BY a.ROWID`;

/** Expand chat.db's `~/Library/…` form. */
export function expandChatDbPath(filename: string): string {
  if (filename === "~") return homedir();
  if (filename.startsWith("~/")) return join(homedir(), filename.slice(2));
  return filename;
}

/**
 * SQLite result codes that mean "try again later": the database is busy or
 * locked (a writer holds it, WAL checkpoint in progress). Messages writes
 * chat.db constantly, so one such failure must not disable the lookup.
 */
const TRANSIENT_SQLITE_CODES = new Set([5 /* SQLITE_BUSY */, 6 /* SQLITE_LOCKED */]);

export function isTransientSqliteError(err: unknown): boolean {
  const e = err as { errcode?: unknown; message?: unknown } | null;
  if (typeof e?.errcode === "number" && TRANSIENT_SQLITE_CODES.has(e.errcode & 0xff)) return true;
  return typeof e?.message === "string" && /database is (locked|busy)|SQLITE_(BUSY|LOCKED)/i.test(e.message);
}

/**
 * chat.db-backed {@link AttachmentLookup}. Opens lazily and read-only; any
 * failure degrades to "no rows" for that call (the caller falls back or times
 * out) — this is a best-effort path and must never break inbound delivery.
 * A busy/locked database is retried on the next call; anything else (no file,
 * no Full Disk Access, no node:sqlite) disables the lookup, logged once. Once
 * closed it stays closed: a straggling caller must not reopen the handle
 * after channel teardown. No cache — the whole point is to see the row change.
 */
export class ChatDbAttachmentLookup implements AttachmentLookup {
  private db: SqliteDatabase | null = null;
  private stmt: SqliteStatement | null = null;
  private failed = false;
  private closed = false;

  constructor(private readonly dbPath: string, private readonly loadSqlite: () => SqliteModule = () => {
    const require = createRequire(import.meta.url);
    return require("node:sqlite") as SqliteModule;
  }) {}

  private ensureOpen(): void {
    if (this.db || this.failed || this.closed) return;
    let db: SqliteDatabase | null = null;
    try {
      const { DatabaseSync } = this.loadSqlite();
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      this.stmt = db.prepare(ATTACHMENTS_SQL);
      this.db = db;
    } catch (err) {
      this.stmt = null;
      this.db = null;
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
      if (isTransientSqliteError(err)) {
        log.debug({ err, dbPath: this.dbPath }, "imsg attachment lookup: chat.db busy, will retry on the next call");
        return;
      }
      this.failed = true;
      log.warn({ err, dbPath: this.dbPath }, "imsg attachment lookup unavailable (chat.db not readable); falling back to file-size checks");
    }
  }

  attachmentsForMessage(messageGuid: string): AttachmentRow[] {
    if (!messageGuid) return [];
    this.ensureOpen();
    if (!this.stmt) return [];
    try {
      return this.stmt.all(messageGuid).map((row) => ({
        path: typeof row.filename === "string" && row.filename ? expandChatDbPath(row.filename) : "",
        transferName: typeof row.transfer_name === "string" ? row.transfer_name : "",
        mimeType: typeof row.mime_type === "string" ? row.mime_type : "",
        transferState: typeof row.transfer_state === "number" ? row.transfer_state
          : typeof row.transfer_state === "bigint" ? Number(row.transfer_state) : null,
      }));
    } catch (err) {
      log.debug({ err, messageGuid }, "imsg attachment lookup query failed");
      return [];
    }
  }

  close(): void {
    this.closed = true;
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
    }
    this.db = null;
    this.stmt = null;
  }
}
