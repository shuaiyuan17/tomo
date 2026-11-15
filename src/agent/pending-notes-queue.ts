import { log } from "../logger.js";
import { formatTomoEvent } from "../tomo-event.js";

export interface DurablePendingNotesStore {
  getPendingNotes(key: string): string[];
  setPendingNotes(key: string, notes: string[]): void;
}

/** Cap on queued pending notes per session. */
const MAX_PENDING_NOTES = 15;
const MAX_PENDING_ERROR_NOTES = 3;
const MAX_PENDING_ERROR_CHARS = 1200;
const MAX_SINGLE_PENDING_ERROR_CHARS = 600;

function truncateForPendingError(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

function pendingErrorChars(notes: string[]): number {
  return notes.reduce((sum, note) => sum + note.length, 0);
}

/**
 * Notes the cap never drops: a durable-inbox `replay`/`interrupted` note is
 * the only remaining copy of a message (its inbox record is already done), so
 * losing it to the cap would lose the message.
 */
function isPinnedNote(note: string): boolean {
  // `includes`, not `startsWith`: a restored prefix bundles several notes.
  return note.includes('<tomo-event type="inbox"');
}

/** Drop oldest unpinned notes until `arr` fits the cap (pinned ones always stay). */
function capNotes(arr: string[]): number {
  let dropped = 0;
  for (let i = 0; i < arr.length && arr.length > MAX_PENDING_NOTES;) {
    if (isPinnedNote(arr[i])) { i++; continue; }
    arr.splice(i, 1);
    dropped++;
  }
  return dropped;
}

interface InFlightBatch {
  prefix: string;
  notes: string[];
}

/**
 * Per-session prompt notes, durable until the turn that carries them ENDS.
 *
 * TWO-PHASE. `drain` hands the notes to a turn but keeps them in the durable
 * store as "in flight"; `settle` (the turn finished, same moment the durable
 * inbox marks its messages done) removes them; `restore` (the turn never
 * reached the model) puts them back in the queue. A crash in between leaves
 * them in the store, so the next process delivers them again — at least once,
 * never zero times. The store always holds in-flight notes (oldest batch
 * first) followed by queued ones.
 */
export class PendingNotesQueue {
  /** Queued, not yet drained. Absent: not loaded from the store this process. */
  private notes = new Map<string, string[]>();
  private inflight = new Map<string, InFlightBatch[]>();
  private errorNotes = new Map<string, string[]>();

  constructor(private store: DurablePendingNotesStore) {}

  private queued(sessionKey: string): string[] {
    let arr = this.notes.get(sessionKey);
    if (!arr) {
      try {
        arr = this.store.getPendingNotes(sessionKey);
      } catch (err) {
        log.warn({ err, sessionKey }, "Could not load durable pending notes");
        arr = [];
      }
      this.notes.set(sessionKey, arr);
    }
    return arr;
  }

  /** Write in-flight + queued notes for this session. Returns false on failure. */
  private persist(sessionKey: string): boolean {
    const all = [
      ...(this.inflight.get(sessionKey) ?? []).flatMap((b) => b.notes),
      ...(this.notes.get(sessionKey) ?? []),
    ];
    try {
      this.store.setPendingNotes(sessionKey, all);
      return true;
    } catch (err) {
      log.warn({ err, sessionKey }, "Could not persist pending notes");
      return false;
    }
  }

  /** Queue a note for the session's next turn. Returns false when it could
   *  not be persisted (it is still held in memory for this process). */
  queueNote(sessionKey: string, note: string): boolean {
    const arr = this.queued(sessionKey);
    arr.push(note);
    const dropped = capNotes(arr);
    if (dropped > 0) log.debug({ sessionKey, dropped }, "Pending notes capped at limit; dropped oldest");
    return this.persist(sessionKey);
  }

  queueError(sessionKey: string, visibleError: string): void {
    const normalized = visibleError.replace(/\s+/g, " ").trim();
    const clipped = truncateForPendingError(normalized, MAX_SINGLE_PENDING_ERROR_CHARS);
    const notes = [...(this.errorNotes.get(sessionKey) ?? []), clipped].slice(-MAX_PENDING_ERROR_NOTES);

    while (notes.length > 1 && pendingErrorChars(notes) > MAX_PENDING_ERROR_CHARS) {
      notes.shift();
    }
    this.errorNotes.set(sessionKey, notes);
  }

  /**
   * Hand the session's queued notes to a turn, as a prompt prefix. They stay
   * in the durable store until {@link settle} (or {@link restore}) is called
   * with the same prefix.
   */
  drain(sessionKey: string): string {
    const notes = this.queued(sessionKey);
    const drained = [...notes];
    this.notes.set(sessionKey, []);

    const errorNotes = this.errorNotes.get(sessionKey);
    const parts = [...drained];
    if (errorNotes && errorNotes.length > 0) {
      this.errorNotes.delete(sessionKey);
      parts.push(formatTomoEvent("errors", [
        "Recent Tomo errors before this turn (newest last, capped):",
        ...errorNotes.map((note) => `- ${note}`),
        "Use this as operational context; do not repeat the raw error unless it helps the user.",
      ].join("\n")));
    }

    const prefix = parts.map((n) => `${n}\n\n`).join("");
    // Error notes are memory-only to begin with; only durable notes ride in flight.
    if (drained.length > 0) {
      const batches = this.inflight.get(sessionKey) ?? [];
      batches.push({ prefix, notes: drained });
      this.inflight.set(sessionKey, batches);
    }
    return prefix;
  }

  /** Take the in-flight batch drained as `prefix` off the session's list. */
  private takeInFlight(sessionKey: string, prefix: string): InFlightBatch | undefined {
    const batches = this.inflight.get(sessionKey);
    if (!batches) return undefined;
    const idx = batches.findIndex((b) => b.prefix === prefix);
    if (idx < 0) return undefined;
    const [batch] = batches.splice(idx, 1);
    if (batches.length === 0) this.inflight.delete(sessionKey);
    return batch;
  }

  /**
   * The turn that drained `prefix` has ended: its notes are consumed. Until
   * this runs they are still in the durable store, so a crash re-delivers them.
   */
  settle(sessionKey: string, prefix: string): void {
    if (!prefix || !this.takeInFlight(sessionKey, prefix)) return;
    this.persist(sessionKey);
  }

  /**
   * Put a drained prefix back at the FRONT of the queue: the turn it was
   * drained for never reached the model (a declined steer). Kept as one note,
   * so its notes stay together and ahead of anything queued since.
   */
  restore(sessionKey: string, drainedPrefix: string): void {
    this.takeInFlight(sessionKey, drainedPrefix);
    const note = drainedPrefix.trim();
    if (!note) return;
    const arr = this.queued(sessionKey);
    arr.unshift(note);
    if (!this.persist(sessionKey)) log.warn({ sessionKey }, "Could not persist restored pending notes");
  }

  /** Test/support helper for observing queued durable notes without draining. */
  peekNotes(sessionKey: string): string[] {
    return [...(this.notes.get(sessionKey) ?? this.store.getPendingNotes(sessionKey))];
  }
}
