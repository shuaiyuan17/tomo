import type { TomoDb } from "./index.js";

/** One forward-only schema step; runs inside its own transaction. */
export interface Migration {
  version: number;
  up(db: TomoDb): void;
}

/**
 * Tomo's schema, oldest first. Append only: a step that has shipped is never
 * edited, because a database that already ran it will not run it again.
 */
export const TOMO_DB_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;

        -- Prompt notes waiting for a session's next turn (src/agent/pending-notes-queue.ts),
        -- one row per note, in queue order. Was sessions/_pending_notes.json.
        CREATE TABLE pending_notes (
          session_key TEXT NOT NULL,
          position INTEGER NOT NULL,
          note TEXT NOT NULL,
          PRIMARY KEY (session_key, position)
        ) STRICT;
      `);
    },
  },
];

/** Tables `tomo db dump` may print, with the column order rows are sorted by. */
export const DUMPABLE_TABLES: Readonly<Record<string, string>> = {
  meta: "key",
  pending_notes: "session_key, position",
};
