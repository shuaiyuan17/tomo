/** Resolve after `ms` milliseconds (the global timer, so fake timers apply). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
