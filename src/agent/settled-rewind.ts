import { statSync } from "node:fs";
import { getSdkSessionPath } from "../sessions/index.js";
import { log } from "../logger.js";
import { prepareSessionRewind, SessionHistoryChangedError, type PreparedRewind } from "./session-rewind.js";

export interface SettleOptions {
  /** The transcript must be unchanged for this long before it is read. */
  quietMs?: number;
  /** Give up waiting for quiet after this long and let the snapshot guard decide. */
  maxWaitMs?: number;
  pollMs?: number;
  /** Total prepare attempts when the snapshot guard trips (1 + retries). */
  attempts?: number;
}

const DEFAULTS: Required<SettleOptions> = { quietMs: 500, maxWaitMs: 5_000, pollMs: 50, attempts: 3 };

export const HISTORY_KEPT_CHANGING = "Session history kept changing during rewind. Try again in a moment.";

function fileVersion(path: string): { version: string; mtimeMs: number } {
  try {
    const { dev, ino, size, mtimeNs, ctimeNs, mtimeMs } = statSync(path, { bigint: true });
    return { version: [dev, ino, size, mtimeNs, ctimeNs].join(":"), mtimeMs: Number(mtimeMs) };
  } catch {
    // Missing or unreadable: nothing is being appended to it; prepare reports it.
    return { version: "unavailable", mtimeMs: 0 };
  }
}

/**
 * Wait until the file has not changed for `quietMs`, measured from its last
 * modification — so a transcript that went quiet long ago costs no wait.
 * Resolves false if it was still changing at `maxWaitMs`.
 */
export async function waitForQuietFile(path: string, quietMs: number, maxWaitMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  const initial = fileVersion(path);
  let version = initial.version;
  let quietSince = Math.min(Date.now(), initial.mtimeMs);
  while (Date.now() - quietSince < quietMs) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const next = fileVersion(path).version;
    if (next !== version) {
      version = next;
      quietSince = Date.now();
    }
  }
  return true;
}

/**
 * prepareSessionRewind, made robust to the writer /rewind itself just stopped.
 *
 * Closing a live session ends the SDK's event stream at once, but the CLI
 * child is still exiting and appends its exit-time records (last-prompt,
 * cost-state, …) to the transcript afterwards. A snapshot taken in that window
 * trips the guard. So: wait for the transcript to go quiet, prepare, and
 * publish; if the guard still trips — during prepare or at `publish` — discard
 * the fork and try again, up to `attempts` times in all. Any other failure is
 * final. `publish` must be synchronous (the guard must not yield before the
 * link swap); a throw from it discards the fork.
 */
export async function prepareSettledSessionRewind(
  sessionId: string,
  count: number,
  workspaceDir: string,
  sdkSessionsDir: string,
  publish: (prepared: PreparedRewind) => void,
  options: SettleOptions = {},
): Promise<PreparedRewind> {
  const { quietMs, maxWaitMs, pollMs, attempts } = { ...DEFAULTS, ...options };
  const path = getSdkSessionPath(sessionId, sdkSessionsDir);
  for (let attempt = 1; ; attempt++) {
    if (!await waitForQuietFile(path, quietMs, maxWaitMs, pollMs)) {
      log.warn({ sessionId, attempt, maxWaitMs }, "Rewind: transcript still changing; trying anyway");
    }
    try {
      const prepared = await prepareSessionRewind(sessionId, count, workspaceDir, sdkSessionsDir);
      try {
        publish(prepared);
      } catch (err) {
        await prepared.discard();
        throw err;
      }
      return prepared;
    } catch (err) {
      if (!(err instanceof SessionHistoryChangedError)) throw err;
      if (attempt >= attempts) {
        log.warn({ sessionId, attempts }, "Rewind: transcript kept changing; giving up");
        throw new SessionHistoryChangedError(HISTORY_KEPT_CHANGING);
      }
      log.info({ sessionId, attempt }, "Rewind: transcript changed while preparing; retrying");
    }
  }
}
