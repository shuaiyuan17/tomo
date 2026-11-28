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
  {
    version: 2,
    up(db) {
      db.exec(`
        -- Scheduled tasks (src/cron/store.ts), one row per job, in creation order
        -- (seq). The record is the JSON the old data/cron/jobs.json held; the
        -- columns after it are read-only mirrors for tomo db dump and sqlite3.
        CREATE TABLE cron_jobs (
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          job TEXT NOT NULL CHECK (json_valid(job) AND json_extract(job, '$.id') = id),
          name ANY GENERATED ALWAYS AS (json_extract(job, '$.name')) VIRTUAL,
          session_key ANY GENERATED ALWAYS AS (json_extract(job, '$.sessionKey')) VIRTUAL,
          enabled ANY GENERATED ALWAYS AS (json_extract(job, '$.enabled')) VIRTUAL,
          next_run_at ANY GENERATED ALWAYS AS (json_extract(job, '$.nextRunAt')) VIRTUAL,
          last_status ANY GENERATED ALWAYS AS (json_extract(job, '$.lastStatus')) VIRTUAL
        ) STRICT;
      `);
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        -- Sub-session tasks (src/agent/subsessions/store.ts), one row per task,
        -- in creation order (seq). The record is the JSON one task had in the
        -- old data/subsessions.json; the columns after it are read-only
        -- mirrors for tomo db dump and sqlite3.
        CREATE TABLE subsessions (
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          record TEXT NOT NULL CHECK (json_valid(record) AND json_extract(record, '$.id') = id),
          session_key ANY GENERATED ALWAYS AS (json_extract(record, '$.sessionKey')) VIRTUAL,
          parent_key ANY GENERATED ALWAYS AS (json_extract(record, '$.parentKey')) VIRTUAL,
          title ANY GENERATED ALWAYS AS (json_extract(record, '$.title')) VIRTUAL,
          status ANY GENERATED ALWAYS AS (json_extract(record, '$.status')) VIRTUAL
        ) STRICT;

        -- The table-wide fields of the old file: one row, present once the
        -- table was written (or imported) at least once. No row: a table never
        -- written, which the service tells apart from an empty one ("missing").
        CREATE TABLE subsessions_state (
          one INTEGER PRIMARY KEY CHECK (one = 1),
          next_id INTEGER NOT NULL CHECK (next_id >= 1),
          untrusted TEXT CHECK (untrusted IS NULL OR json_valid(untrusted))
        ) STRICT;
      `);
    },
  },
];

/** Tables `tomo db dump` may print, with the column order rows are sorted by. */
export const DUMPABLE_TABLES: Readonly<Record<string, string>> = {
  meta: "key",
  pending_notes: "session_key, position",
  cron_jobs: "seq",
  subsessions: "seq",
  subsessions_state: "one",
};
