/**
 * "Read" receipts: which of the user messages we handed the SDK it has
 * actually consumed.
 *
 * Every message we push carries a client uuid (LiveSession.pushInput). The
 * CLI stamps the uuids a turn has consumed so far on its top-level assistant
 * frames (`user_message_uuids`, in consumption order): every member of a
 * batch it merged into one turn, and any message folded in mid-turn at a
 * tool boundary. A message queued behind the turn shows up in the NEXT
 * turn's frames. Older producers send only `user_message_uuid` (the last
 * one), or nothing — then there is simply nothing to report.
 *
 * Observability only: nothing here touches turn state, delivery or queueing.
 */

/** uuids an assistant frame says its turn has consumed; [] when the producer stamps none. */
export function consumedUuidsOf(event: unknown): string[] {
  const e = event as { user_message_uuids?: unknown; user_message_uuid?: unknown } | null;
  if (!e) return [];
  if (Array.isArray(e.user_message_uuids)) return e.user_message_uuids.filter((id): id is string => typeof id === "string");
  return typeof e.user_message_uuid === "string" ? [e.user_message_uuid] : [];
}

export interface ReadBatch {
  /** Our client uuids seen consumed for the first time, in consumption order. */
  uuids: string[];
  /** The web request ids among them (messages sent from the browser). */
  requestIds: string[];
}

/** Sent-but-unread messages remembered at most; the oldest is forgotten first. */
export const MAX_TRACKED_UNREAD = 512;

export class ReadReceiptTracker {
  // uuid → the web request id it carries, if any. A uuid leaves the map the
  // first time it is reported, which is what makes each report happen once.
  private unread = new Map<string, string | undefined>();

  constructor(private readonly cap = MAX_TRACKED_UNREAD) {}

  track(uuid: string, requestId?: string): void {
    this.unread.set(uuid, requestId);
    while (this.unread.size > this.cap) this.unread.delete(this.unread.keys().next().value!);
  }

  /** The newly consumed messages this frame names, or null when there are none. */
  consume(event: unknown): ReadBatch | null {
    const uuids: string[] = [];
    const requestIds: string[] = [];
    for (const uuid of consumedUuidsOf(event)) {
      if (!this.unread.has(uuid)) continue; // already reported, or not one of ours
      const requestId = this.unread.get(uuid);
      this.unread.delete(uuid);
      uuids.push(uuid);
      if (requestId) requestIds.push(requestId);
    }
    return uuids.length ? { uuids, requestIds } : null;
  }
}
