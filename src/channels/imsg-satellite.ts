import { createRequire } from "node:module";
import { log } from "../logger.js";

/**
 * Resolves a message GUID to its chat.db `message.service` value.
 *
 * Why this exists: satellite messages (Apple's low-bandwidth emergency relay)
 * are identified by `service = "iMessageLite"` — see tomo#208. The BlueBubbles
 * backend (removed 2026-08-27) serialized that service into its webhook payload
 * and so could read it for free.
 * imsg's JSON (v0.12.3) exposes no service field on message rows, so the imsg
 * channel reads it straight from chat.db (Full Disk Access is already required
 * for imsg to function). Verified live 2026-07-07: `SELECT DISTINCT service
 * FROM message` returns `iMessage` and `iMessageLite`.
 */
export interface ServiceLookup {
  /** chat.db `message.service` for a GUID, or undefined when unknown/unavailable. */
  serviceForGuid(guid: string): string | undefined;
  close(): void;
}

/** No-op lookup: service is never resolved (satellite detection degrades off). */
export const NULL_SERVICE_LOOKUP: ServiceLookup = {
  serviceForGuid: () => undefined,
  close: () => {},
};

// Minimal shape of the node:sqlite surface we use, so this file type-checks
// without depending on @types for the experimental built-in.
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
export interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/**
 * chat.db-backed `ServiceLookup`. Opens the database read-only on first use
 * (lazy, so construction never throws), prepares one statement, and caches
 * results in a small LRU so a hot chat doesn't re-hit sqlite per message. Any
 * failure (no Full Disk Access, missing DB, schema drift) degrades to
 * `undefined` — satellite tagging is best-effort and must never block delivery.
 */
export class ChatDbServiceLookup implements ServiceLookup {
  private db: SqliteDatabase | null = null;
  private stmt: SqliteStatement | null = null;
  private failed = false;
  private readonly cache = new Map<string, string>();
  private readonly maxCache: number;
  private readonly loadSqlite: () => SqliteModule;

  constructor(
    private readonly dbPath: string,
    options: { maxCache?: number; loadSqlite?: () => SqliteModule } = {},
  ) {
    this.maxCache = options.maxCache ?? 512;
    // node:sqlite is a built-in (Node 22+), but experimental — load it via
    // createRequire so the ExperimentalWarning only fires when the imsg
    // channel actually runs, not on module import elsewhere. Injectable so
    // tests can supply a mock sqlite layer.
    this.loadSqlite = options.loadSqlite ?? (() => {
      const require = createRequire(import.meta.url);
      return require("node:sqlite") as SqliteModule;
    });
  }

  private ensureOpen(): void {
    if (this.db || this.failed) return;
    let db: SqliteDatabase | null = null;
    try {
      const { DatabaseSync } = this.loadSqlite();
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      // prepare() before publishing the handle: if it throws, close the db we
      // just opened so the file handle never leaks.
      this.stmt = db.prepare("SELECT service FROM message WHERE guid = ? LIMIT 1");
      this.db = db;
    } catch (err) {
      this.failed = true;
      this.stmt = null;
      this.db = null;
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
      log.warn({ err, dbPath: this.dbPath }, "imsg satellite service lookup unavailable (chat.db not readable)");
    }
  }

  serviceForGuid(guid: string): string | undefined {
    if (!guid) return undefined;

    const cached = this.cache.get(guid);
    if (cached !== undefined) {
      // Bump recency (Map preserves insertion order → re-insert = most recent).
      this.cache.delete(guid);
      this.cache.set(guid, cached);
      return cached || undefined;
    }

    this.ensureOpen();
    if (!this.stmt) return undefined;

    try {
      const row = this.stmt.get(guid);
      const service = typeof row?.service === "string" ? row.service : "";
      this.remember(guid, service);
      return service || undefined;
    } catch (err) {
      log.debug({ err, guid }, "imsg satellite service lookup query failed");
      return undefined;
    }
  }

  private remember(guid: string, service: string): void {
    this.cache.set(guid, service);
    if (this.cache.size > this.maxCache) {
      // Evict the least-recently-used (first inserted) entry.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
      this.stmt = null;
    }
    this.cache.clear();
  }
}
