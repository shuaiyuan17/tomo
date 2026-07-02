import { log } from "../logger.js";

/**
 * Per-session FIFO used by all ingress paths that may call LiveSession.send().
 * Steering is the explicit bypass; everything else for a key is serialized here.
 */
export class SessionQueue {
  private queues = new Map<string, Promise<void>>();

  enqueue<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionKey) ?? Promise.resolve();
    const result = prev.then(() => task());

    const tail = result.then(
      () => {},
      (err) => {
        log.error({ err, sessionKey }, "Unhandled error in session queue");
      },
    );
    this.queues.set(sessionKey, tail);

    void tail.then(() => {
      if (this.queues.get(sessionKey) === tail) {
        this.queues.delete(sessionKey);
      }
    });

    return result;
  }

  /** Test/support helper: wait for currently queued work to settle. */
  async drain(maxPasses = 5): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      const pending = Array.from(this.queues.values());
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }
}
