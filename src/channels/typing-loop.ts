/**
 * The repeating "typing…" indicator shared by the chat channels.
 *
 * Providers expire a typing indicator after a few seconds (or document no
 * decay at all), so a channel re-sends it on a timer for as long as a turn
 * runs. The state machine is the same everywhere:
 *
 * - tick once immediately, then every `intervalMs`;
 * - never let two ticks overlap — a tick that is still in flight when the
 *   next interval fires makes that interval a no-op, so a slow provider call
 *   cannot pile up requests or race the error counter;
 * - give up after `maxErrors` consecutive failed ticks (checked at the next
 *   interval, so the last failure is not retried);
 * - stop on its own after `ttlMs`, so a turn that never calls stop cannot
 *   leave the indicator running forever;
 * - stop is idempotent. When an `onStop` hook is given (e.g. to turn the
 *   indicator off explicitly), stop first waits for any in-flight tick, so the
 *   "off" call can never land before a late "on".
 */

export interface TypingLoopOptions {
  /** One indicator refresh. A rejection counts as a failed tick. */
  tick: () => Promise<unknown>;
  /** Delay between ticks. */
  intervalMs: number;
  /** Hard cap on how long the loop runs without being stopped. */
  ttlMs: number;
  /** Consecutive failed ticks after which the loop stops itself. */
  maxErrors: number;
  /**
   * Runs once, after the loop has stopped and any in-flight tick settled.
   * Errors are swallowed — stopping the indicator is best-effort.
   */
  onStop?: () => Promise<unknown> | void;
  /** Called (before stopping) when the loop gives up after `maxErrors`. */
  onGiveUp?: () => void;
}

export interface TypingLoop {
  /** Stop the loop. Resolves once `onStop` (if any) has run. Idempotent. */
  stop: () => Promise<void>;
}

export function startTypingLoop(options: TypingLoopOptions): TypingLoop {
  const { tick, intervalMs, ttlMs, maxErrors, onStop, onGiveUp } = options;

  let stopped = false;
  let tickInFlight: Promise<void> | null = null;
  let consecutiveErrors = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let ttl: ReturnType<typeof setTimeout> | null = null;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (interval) clearInterval(interval);
    if (ttl) clearTimeout(ttl);
    if (!onStop) return;
    if (tickInFlight) await tickInFlight;
    try {
      await onStop();
    } catch {
      // best-effort
    }
  };

  const runTick = () => {
    if (stopped || tickInFlight) return;
    if (consecutiveErrors >= maxErrors) {
      onGiveUp?.();
      void stop();
      return;
    }
    tickInFlight = (async () => {
      try {
        await tick();
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors++;
      } finally {
        tickInFlight = null;
      }
    })();
  };

  runTick();
  interval = setInterval(runTick, intervalMs);
  ttl = setTimeout(() => void stop(), ttlMs);

  return { stop };
}
