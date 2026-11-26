import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore, transcriptFileStem } from "../../src/sessions/store.js";

/**
 * Fixtures for the SessionStore tests (src/sessions/store.ts).
 */

type StoreOptions = NonNullable<ConstructorParameters<typeof SessionStore>[3]>;

/**
 * A store over `dir`, with the SDK sessions directory defaulted to
 * `<dir>/sdk-sessions` and its database to `<dir>/tomo.db` (the store insists on an explicit one, so that nothing
 * a test does can reach the developer's real ~/.claude).
 */
export function makeSessionStore(
  dir: string,
  opts: StoreOptions & { historyLimit?: number; sdkSessionsDir?: string } = {},
): SessionStore {
  const { historyLimit = 20, sdkSessionsDir = join(dir, "sdk-sessions"), dbPath = join(dir, "tomo.db"), ...rest } = opts;
  return new SessionStore(dir, historyLimit, sdkSessionsDir, { dbPath, ...rest });
}

/**
 * The active transcript path for `key` under `dir`. Always through
 * `transcriptFileStem`: a path built by hand reads the wrong file for any key
 * outside `[a-z0-9:-]` (see CLAUDE.md, "Transcript filenames").
 */
export function transcriptPath(dir: string, key: string): string {
  return join(dir, `${transcriptFileStem(key)}.jsonl`);
}

/** Write `records` as `key`'s active transcript, one JSON line each. */
export function writeTranscript(dir: string, key: string, records: unknown[]): void {
  writeFileSync(transcriptPath(dir, key), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
