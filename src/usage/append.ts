import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const chains = new Map<string, Promise<unknown>>();

/**
 * Append to an ndjson file with every write to the same path run one after
 * another, in call order, so lines land in the order they were asked for even
 * when callers do not await. `line` is evaluated when the write's turn comes —
 * a deduplicating caller decides there, against what has actually been
 * written — and returns the text to append (without the newline), or
 * undefined to skip. `onWritten` runs right after a successful write, still
 * inside the chain (before the next write's `line`), so state it updates is
 * always what the file says. Resolves true once written, false when skipped;
 * rejects on a failed write (the chain itself carries on).
 */
export function appendLineSerial(path: string, line: () => string | undefined, onWritten?: () => void): Promise<boolean> {
  const run = (chains.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const text = line();
    if (text === undefined) return false;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${text}\n`, "utf8");
    onWritten?.();
    return true;
  });
  chains.set(path, run);
  // Drop the entry once idle, so the map does not hold every path forever.
  void run.catch(() => undefined).finally(() => { if (chains.get(path) === run) chains.delete(path); });
  return run;
}
