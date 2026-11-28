/**
 * One retry timer per key, with a delay that doubles per attempt up to a
 * cap and no attempt limit. In memory only: a restart starts every key from
 * the base again.
 */
export interface BackoffTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: BackoffTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The delay before retry `attempt` (1-based): base, doubled per attempt, at most cap. */
export function backoffDelay(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
}

export class KeyedBackoff {
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, unknown>();

  constructor(
    private readonly baseMs: number,
    private readonly capMs: number,
    private readonly fire: (key: string) => void,
    private readonly timerApi: BackoffTimers = realTimers,
  ) {}

  /** A retry timer is pending for this key. */
  isPending(key: string): boolean {
    return this.timers.has(key);
  }

  /**
   * Arm the next retry for the key; undefined (nothing armed) while one is
   * already pending. `capped` is true for the first attempt that waits the cap.
   */
  schedule(key: string): { attempt: number; delayMs: number; capped: boolean } | undefined {
    if (this.timers.has(key)) return undefined;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const delayMs = backoffDelay(attempt, this.baseMs, this.capMs);
    const capped = delayMs >= this.capMs && backoffDelay(attempt - 1, this.baseMs, this.capMs) < this.capMs;
    const handle = this.timerApi.set(() => {
      this.timers.delete(key);
      this.fire(key);
    }, delayMs);
    this.timers.set(key, handle);
    return { attempt, delayMs, capped };
  }

  /** Forget the key's attempts and drop its pending timer. */
  reset(key: string): void {
    this.attempts.delete(key);
    const handle = this.timers.get(key);
    if (handle !== undefined) this.timerApi.clear(handle);
    this.timers.delete(key);
  }

  /** Drop every pending timer and attempt count. */
  stop(): void {
    for (const handle of this.timers.values()) this.timerApi.clear(handle);
    this.timers.clear();
    this.attempts.clear();
  }
}
