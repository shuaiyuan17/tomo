import { randomUUID } from "node:crypto";
import { MAX_BUFFER_BYTES, MAX_EVENT_BYTES, WebError, type EventEnvelope, type WebEvent } from "./protocol.js";

/** Bounded replay belongs to the daemon, so UI child restarts do not lose it. */
export class WebEvents {
  readonly epoch = randomUUID();
  private sequence = 0;
  private ring: { envelope: EventEnvelope; bytes: number }[] = [];
  private bytes = 0;
  private subscribers = new Set<(value: EventEnvelope) => void>();
  cursor(): string { return `${this.epoch}:${this.sequence}`; }
  publish(event: WebEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > MAX_EVENT_BYTES) throw new WebError(413, "event_too_large");
    const envelope = { id: `${this.epoch}:${++this.sequence}`, event };
    this.ring.push({ envelope, bytes });
    this.bytes += bytes;
    while (this.bytes > MAX_BUFFER_BYTES || this.ring.length > 1000) this.bytes -= this.ring.shift()!.bytes;
    for (const subscriber of this.subscribers) {
      try { subscriber(envelope); } catch { /* UI observers never fail a send. */ }
    }
  }
  subscribe(fn: (value: EventEnvelope) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
  after(cursor: string): EventEnvelope[] | null {
    if (cursor === this.cursor()) return [];
    const index = this.ring.findIndex(({ envelope }) => envelope.id === cursor);
    return index < 0 ? null : this.ring.slice(index + 1).map(({ envelope }) => envelope);
  }
}
