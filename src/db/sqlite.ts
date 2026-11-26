import { createRequire } from "node:module";

/**
 * The slice of `node:sqlite` Tomo uses, typed here rather than through
 * `@types/node`: the pinned types predate the `timeout` option (22.16), and the
 * class is renamed in Node 26 (`Database`, with `DatabaseSync` a deprecated
 * alias). Everything in Tomo reaches SQLite through this file.
 */
export interface SqliteStatement {
  run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqliteValue[]): Record<string, unknown> | undefined;
  all(...params: SqliteValue[]): Record<string, unknown>[];
}

export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  readonly isOpen?: boolean;
}

export interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number; open?: boolean }) => SqliteDatabase;
}

let cached: SqliteModule | null = null;

/**
 * Load `node:sqlite` without printing its ExperimentalWarning.
 *
 * Node 22 marks the module experimental and prints a warning the first time it
 * is loaded. Tomo loads it in the daemon, the web child and every CLI command
 * that touches the database, so left alone the warning lands in the daemon log
 * on every start and on stderr of commands whose output people read. Only that
 * one warning is swallowed, and only while the module loads; every other
 * warning goes through as before.
 */
export function loadNodeSqlite(): SqliteModule {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
    const first = rest[0];
    const type = typeof first === "string" ? first : (first as { type?: string } | undefined)?.type;
    const text = typeof warning === "string" ? warning : warning?.message;
    if ((type === "ExperimentalWarning" || (warning as Error)?.name === "ExperimentalWarning") && /sqlite/i.test(text ?? "")) return;
    return (original as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    cached = require("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return cached;
}
