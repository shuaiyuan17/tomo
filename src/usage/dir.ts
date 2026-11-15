import { join } from "node:path";

/**
 * `~/.tomo/data/usage/` — where the cost/usage history lives: the monthly
 * usage ledger (`YYYY-MM.ndjson`) and the quota samples (`limits.ndjson`).
 * One place for the path so every writer and reader agrees on it.
 */
export function usageDataDir(tomoHome: string): string {
  return join(tomoHome, "data", "usage");
}
