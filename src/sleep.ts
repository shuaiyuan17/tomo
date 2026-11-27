/** Resolve after `ms` milliseconds (the global timer, so fake timers apply). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block the calling thread for `ms` milliseconds, for sync code that has to
 * let wall time pass (lock polling, waiting out another process's append).
 * `Atomics.wait` on a private buffer nobody notifies, so it always runs to
 * the timeout; fake timers do not apply.
 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
