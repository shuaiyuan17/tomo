import { log } from "../logger.js";
import { formatTomoEvent, isOwnerAudienceNote } from "../tomo-event.js";

export interface DurablePendingNotesStore {
  getPendingNotes(key: string): string[];
  setPendingNotes(key: string, notes: string[]): void;
  /** setPendingNotes with `also` in the same transaction: both commit, or neither. */
  setPendingNotesWith?(key: string, notes: string[], also: () => void): void;
}

/** Cap on queued pending notes per session. */
const MAX_PENDING_NOTES = 15;
const MAX_PENDING_ERROR_NOTES = 3;
const MAX_PENDING_ERROR_CHARS = 1200;
const MAX_SINGLE_PENDING_ERROR_CHARS = 600;

function truncateForPendingError(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

/** An error note, with the order it was queued in (a put-back can come out of order). */
interface ErrorNote {
  seq: number;
  text: string;
}

function pendingErrorChars(notes: ErrorNote[]): number {
  return notes.reduce((sum, note) => sum + note.text.length, 0);
}

/** Keep the newest error notes (by queue order) within the count and character caps. */
function capErrorNotes(notes: ErrorNote[]): ErrorNote[] {
  const capped = [...notes].sort((a, b) => a.seq - b.seq).slice(-MAX_PENDING_ERROR_NOTES);
  while (capped.length > 1 && pendingErrorChars(capped) > MAX_PENDING_ERROR_CHARS) {
    capped.shift();
  }
  return capped;
}

/**
 * Notes the cap never drops: a durable-inbox `replay`/`interrupted` note is
 * the only remaining copy of a message (its inbox record is already done), so
 * losing it to the cap would lose the message. Same for an
 * `interrupted-agents` note: its ledger entry is already gone. And a
 * `subsession-report` note: the task record says the report was delivered
 * once the note is on disk. And a `subsession-message` note: the task was
 * told its message was handed to the owning session once the note is on disk.
 */
function isPinnedNote(note: string): boolean {
  // `includes`, not `startsWith`: an interrupted note carries the marker first.
  return note.includes('<tomo-event type="inbox"')
    || note.includes('<tomo-event type="interrupted-agents"')
    || note.includes('<tomo-event type="subsession-report"')
    || note.includes('<tomo-event type="subsession-message"')
    // A failed task's unanswered messages: the record is forgotten once this is on disk.
    || note.includes('<tomo-event type="subsession-handback"')
    // A group's turn refused for the shared prompt: its inbox record is closed once this is on disk.
    || note.includes('<tomo-event type="summon-busy"');
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

/**
 * Prepended to a note whose turn took it but did not finish (crash, graceful
 * shutdown, abort): the model may already have acted on it, partly or fully.
 */
export const INTERRUPTED_NOTE_MARKER =
  "[The previous attempt to handle the note below was interrupted (Tomo restarted, or the turn was cut short) — you may already have partly answered it. Check the conversation and do not repeat what was already said.]";

function markInterrupted(note: string): string {
  return note.startsWith(INTERRUPTED_NOTE_MARKER) ? note : `${INTERRUPTED_NOTE_MARKER}\n${note}`;
}

interface InFlightBatch {
  prefix: string;
  /** Durable notes in this prefix, in order. Persisted while in flight. */
  notes: string[];
  /** Error notes rendered into this prefix. Memory-only, like the queue they came from. */
  errors: ErrorNote[];
}

/**
 * Per-session prompt notes, durable until the turn that carries them ENDS.
 *
 * TWO-PHASE. `drain` hands the notes to a turn but keeps them in the durable
 * store as "in flight"; `settle` (the turn finished, same moment the durable
 * inbox marks its messages done) removes them; `restore` (the turn never
 * reached the model) puts them back in the queue, `restoreInterrupted` (it
 * reached the model but the turn did not finish) puts them back marked as
 * possibly partly answered. While in flight they are stored already marked,
 * so a crash in between leaves them in the store in that form, and the next
 * process delivers them again — at least once, never zero times. The store
 * always holds in-flight notes (oldest batch first) followed by queued ones.
 */
export class PendingNotesQueue {
  /** Queued, not yet drained. Absent: not loaded from the store this process. */
  private notes = new Map<string, string[]>();
  private inflight = new Map<string, InFlightBatch[]>();
  private errorNotes = new Map<string, ErrorNote[]>();
  private errorSeq = 0;
  /** Sessions whose stored notes could not be read when first needed: merged in at the next write, never written over. */
  private unloaded = new Set<string>();

  constructor(private store: DurablePendingNotesStore) {}

  private queued(sessionKey: string): string[] {
    if (this.unloaded.has(sessionKey)) this.retryLoad(sessionKey);
    let arr = this.notes.get(sessionKey);
    if (!arr) {
      try {
        arr = this.store.getPendingNotes(sessionKey);
      } catch (err) {
        log.warn({ err, sessionKey }, "Could not load durable pending notes");
        arr = [];
        this.unloaded.add(sessionKey);
      }
      this.notes.set(sessionKey, arr);
    }
    return arr;
  }

  /** Read the stored notes that could not be read before, ahead of the ones
   *  held in memory since. Returns false while they still cannot be read. */
  private retryLoad(sessionKey: string): boolean {
    try {
      this.notes.set(sessionKey, [...this.store.getPendingNotes(sessionKey), ...(this.notes.get(sessionKey) ?? [])]);
      this.unloaded.delete(sessionKey);
      return true;
    } catch (err) {
      log.warn({ err, sessionKey }, "Stored pending notes still cannot be read");
      return false;
    }
  }

  /** Write in-flight + queued notes for this session. Returns false on failure. */
  private persist(sessionKey: string): boolean {
    if (this.unloaded.has(sessionKey) && !this.retryLoad(sessionKey)) return false;
    const all = [
      ...(this.inflight.get(sessionKey) ?? []).flatMap((b) => b.notes.map(markInterrupted)),
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

  /** Write the session's notes to disk again (after a failed write left
   *  them in memory only). Returns false when the write fails. */
  persistNow(sessionKey: string): boolean {
    this.queued(sessionKey);
    return this.persist(sessionKey);
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

  /**
   * Queue a note and run `also` in the same write: the note is on disk
   * together with what `also` writes (a sub-session's report marked
   * delivered), or neither is, and then the note is not held in memory
   * either (the caller tries the whole thing again). Returns whether it
   * committed. Without a store that can do that, false.
   */
  queueNoteWith(sessionKey: string, note: string, also: () => void): boolean {
    if (!this.store.setPendingNotesWith) return false;
    const arr = this.queued(sessionKey);
    if (this.unloaded.has(sessionKey) && !this.retryLoad(sessionKey)) return false;
    const next = [...(this.notes.get(sessionKey) ?? arr), note];
    const dropped = capNotes(next);
    const all = [
      ...(this.inflight.get(sessionKey) ?? []).flatMap((b) => b.notes.map(markInterrupted)),
      ...next,
    ];
    try {
      this.store.setPendingNotesWith(sessionKey, all, also);
    } catch (err) {
      log.warn({ err, sessionKey }, "Could not persist a pending note with its companion write; nothing was kept");
      return false;
    }
    if (dropped > 0) log.debug({ sessionKey, dropped }, "Pending notes capped at limit; dropped oldest");
    this.notes.set(sessionKey, next);
    return true;
  }

  /**
   * Take back the newest queued (not drained) note that matches, e.g. one
   * whose write just failed and whose sender is told it was not handed over:
   * it must not reach a turn from memory after that. True when one was
   * found queued; one already drained into a turn is not touched.
   */
  withdrawNote(sessionKey: string, match: (note: string) => boolean): boolean {
    const arr = this.queued(sessionKey);
    let idx = arr.length - 1;
    while (idx >= 0 && !match(arr[idx])) idx -= 1;
    if (idx < 0) return false;
    arr.splice(idx, 1);
    // Best effort: the disk never had it if its own write failed.
    this.persist(sessionKey);
    return true;
  }

  queueError(sessionKey: string, visibleError: string): void {
    const normalized = visibleError.replace(/\s+/g, " ").trim();
    const clipped = truncateForPendingError(normalized, MAX_SINGLE_PENDING_ERROR_CHARS);
    this.errorNotes.set(sessionKey, capErrorNotes([...(this.errorNotes.get(sessionKey) ?? []), { seq: this.errorSeq++, text: clipped }]));
  }

  /**
   * Hand the session's queued notes to a turn, as a prompt prefix. They stay
   * in the durable store until {@link settle} (or {@link restore}) is called
   * with the same prefix.
   */
  drain(sessionKey: string, opts: { holdOwnerAudience?: boolean } = {}): string {
    const notes = this.queued(sessionKey);
    // A turn that is not the owner's own (a summoned group on the owner's
    // session) gets no owner-only note: those stay queued for the next one.
    const held = opts.holdOwnerAudience ? notes.filter(isOwnerAudienceNote) : [];
    const drained = held.length > 0 ? notes.filter((n) => !isOwnerAudienceNote(n)) : [...notes];
    this.notes.set(sessionKey, held);

    const errorNotes = this.errorNotes.get(sessionKey) ?? [];
    const parts = [...drained];
    if (errorNotes.length > 0) {
      this.errorNotes.delete(sessionKey);
      parts.push(formatTomoEvent("errors", [
        "Recent Tomo errors before this turn (newest last, capped):",
        ...errorNotes.map((note) => `- ${note.text}`),
        "Use this as operational context; do not repeat the raw error unless it helps the user.",
      ].join("\n")));
    }

    const prefix = parts.map((n) => `${n}\n\n`).join("");
    if (!prefix) return prefix;
    // Every non-empty prefix is tracked, so a put-back can split it into its
    // parts again. Only the durable notes reach the store (error notes are
    // memory-only to begin with).
    const batches = this.inflight.get(sessionKey) ?? [];
    batches.push({ prefix, notes: drained, errors: errorNotes });
    this.inflight.set(sessionKey, batches);
    // On disk they now read as interrupted: true from here unless settle runs.
    if (drained.length > 0) this.persist(sessionKey);
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
    if (!prefix) return;
    const batch = this.takeInFlight(sessionKey, prefix);
    if (batch && batch.notes.length > 0) this.persist(sessionKey);
  }

  /**
   * Put a drained prefix back: the turn it was drained for never reached the
   * model (a declined steer). Its durable notes go back at the FRONT of the
   * queue, in order, ahead of anything queued since; its error notes go back
   * to the error queue.
   */
  restore(sessionKey: string, drainedPrefix: string): void {
    this.putBack(sessionKey, drainedPrefix, false);
  }

  /**
   * The turn that drained `drainedPrefix` took it but did not run to a
   * normal end (cut short by shutdown, aborted, failed): back at the front of
   * the queue, marked as possibly partly answered.
   */
  restoreInterrupted(sessionKey: string, drainedPrefix: string): void {
    this.putBack(sessionKey, drainedPrefix, true);
  }

  /**
   * Split the batch drained as `drainedPrefix` back into its parts: durable
   * notes one by one at the front of the queue, error notes back under the
   * error caps. Never the rendered prefix as one note — that would turn the
   * memory-only error block into a durable, uncapped note that grows with
   * every failed turn (and that the pin rule could keep forever).
   */
  private putBack(sessionKey: string, drainedPrefix: string, interrupted: boolean): void {
    if (!drainedPrefix) return;
    const batch = this.takeInFlight(sessionKey, drainedPrefix);
    if (!batch) {
      // Already settled or put back (or never drained here): nothing to return.
      log.debug({ sessionKey }, "Put-back of a pending-notes prefix that is not in flight; ignored");
      return;
    }

    if (batch.errors.length > 0) {
      // Merged by queue order, not prepended: another batch drained later may
      // already be back, and the caps must still drop the oldest errors.
      this.errorNotes.set(sessionKey, capErrorNotes([...batch.errors, ...(this.errorNotes.get(sessionKey) ?? [])]));
    }

    if (batch.notes.length === 0) return;
    const arr = this.queued(sessionKey);
    arr.unshift(...(interrupted ? batch.notes.map(markInterrupted) : batch.notes));
    // No cap here: these notes were already admitted, and the store kept them
    // while in flight. Capping now would drop exactly them (they are the
    // oldest) in favour of notes queued during the turn.
    if (!this.persist(sessionKey)) log.warn({ sessionKey }, "Could not persist restored pending notes");
  }

  /** Is a note matching `predicate` queued or in flight for the session? */
  hasNote(sessionKey: string, predicate: (note: string) => boolean): boolean {
    if (this.queued(sessionKey).some(predicate)) return true;
    return (this.inflight.get(sessionKey) ?? []).some((b) => b.notes.some(predicate));
  }

  /** Test/support helper for observing queued durable notes without draining. */
  peekNotes(sessionKey: string): string[] {
    const held = this.notes.get(sessionKey);
    if (held) return [...held];
    try {
      return this.store.getPendingNotes(sessionKey);
    } catch (err) {
      log.warn({ err, sessionKey }, "Could not read durable pending notes");
      return [];
    }
  }
}
