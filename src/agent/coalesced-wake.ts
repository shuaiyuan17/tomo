/**
 * One queued wake turn per session key: a wake asked for while one is
 * already queued merges into it. The key is freed when the queued turn
 * starts (so a wake asked for during the turn queues the next one) or when
 * the queue rejects. Only a dedup guard: the turn itself checks whether
 * there is still anything to do.
 */
export class CoalescedWake {
  private readonly queued = new Set<string>();

  constructor(private readonly enqueue: (key: string, task: () => Promise<void>) => Promise<unknown>) {}

  /** A wake for this key is queued and has not started yet. */
  isQueued(key: string): boolean {
    return this.queued.has(key);
  }

  /**
   * Queue `run` on the key's session queue unless a wake is already queued
   * there (then false, and `run` is dropped). `onError` gets a rejection of
   * the queued task, after the key is freed.
   */
  schedule(key: string, run: () => Promise<void>, onError: (err: unknown) => void): boolean {
    if (this.queued.has(key)) return false;
    this.queued.add(key);
    this.enqueue(key, async () => {
      this.queued.delete(key);
      await run();
    }).catch((err: unknown) => {
      this.queued.delete(key);
      onError(err);
    });
    return true;
  }
}
