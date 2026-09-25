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
}

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
  SELECT a.filename AS filename, a.transfer_name AS transfer_name, a.mime_type AS mime_type
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
 * chat.db-backed {@link AttachmentLookup}. Opens lazily and read-only; any
 * failure degrades to "no rows" (the watch then times out and warns) — this is
 * a best-effort recovery path and must never break inbound delivery. No cache:
 * the whole point is to see the row change.
 */
export class ChatDbAttachmentLookup implements AttachmentLookup {
  private db: SqliteDatabase | null = null;
  private stmt: SqliteStatement | null = null;
  private failed = false;

  constructor(private readonly dbPath: string, private readonly loadSqlite: () => SqliteModule = () => {
    const require = createRequire(import.meta.url);
    return require("node:sqlite") as SqliteModule;
  }) {}

  private ensureOpen(): void {
    if (this.db || this.failed) return;
    let db: SqliteDatabase | null = null;
    try {
      const { DatabaseSync } = this.loadSqlite();
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      this.stmt = db.prepare(ATTACHMENTS_SQL);
      this.db = db;
    } catch (err) {
      this.failed = true;
      this.stmt = null;
      this.db = null;
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
      log.warn({ err, dbPath: this.dbPath }, "imsg attachment lookup unavailable (chat.db not readable)");
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
      }));
    } catch (err) {
      log.debug({ err, messageGuid }, "imsg attachment lookup query failed");
      return [];
    }
  }

  close(): void {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
    }
    this.db = null;
    this.stmt = null;
  }
}
