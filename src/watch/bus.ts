import type { WatchEvent, WatchIssue } from "./protocol.js";

/**
 * In-process pub/sub bus for daemon observability events. Emit points across
 * the daemon (session store, live session, turn runner, cron, continuity,
 * logger) publish here; the watch socket server subscribes and relays to
 * attached `tomo watch` clients.
 *
 * Module-level singleton, like `log` — emitters shouldn't need constructor
 * plumbing to report what they're doing. Publishing with no subscribers is a
 * cheap no-op (plus a ring-buffer push), so CLI processes that share these
 * modules pay nothing.
 *
 * IMPORTANT: this module must not import the logger — the logger publishes
 * `issue` events here, and subscriber errors are swallowed rather than logged
 * to avoid recursion.
 */

export type WatchEventInput = WatchEvent extends infer E
  ? E extends WatchEvent
    ? Omit<E, "ts"> & { ts?: number }
    : never
  : never;

type Subscriber = (event: WatchEvent) => void;

const RING_LIMIT = 500;

export class WatchBus {
  private subscribers = new Set<Subscriber>();
  private ring: WatchEvent[] = [];
  private latestIssue: WatchIssue | null = null;

  publish(input: WatchEventInput): void {
    const event = { ts: Date.now(), ...input } as WatchEvent;
    if (event.type === "issue") this.latestIssue = event;
    this.ring.push(event);
    if (this.ring.length > RING_LIMIT * 2) {
      this.ring.splice(0, this.ring.length - RING_LIMIT);
    }
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // Never let a broken subscriber take down an emit site (or recurse
        // through the logger's issue tap).
      }
    }
  }

  /** Subscribe to live events; returns an unsubscribe function. */
  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** Most recent events, oldest first (bounded by the ring buffer). */
  recent(limit = RING_LIMIT): WatchEvent[] {
    return this.ring.slice(-limit);
  }

  lastIssue(): WatchIssue | null {
    return this.latestIssue;
  }

  /** Test helper: drop buffered events and subscribers. */
  reset(): void {
    this.subscribers.clear();
    this.ring = [];
    this.latestIssue = null;
  }
}

export const watchBus = new WatchBus();
