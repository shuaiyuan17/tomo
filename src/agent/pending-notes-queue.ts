import { randomUUID } from "node:crypto";
import { log } from "../logger.js";
import type { PendingNote } from "../sessions/store.js";
import { formatTomoEvent, isOwnerAudienceNote } from "../tomo-event.js";

export interface DurablePendingNotesStore {
  getPendingNotes(key: string): PendingNote[];
  setPendingNotes(key: string, notes: PendingNote[]): void;
}

/** What `queueNote` gives a note queued without an id. */
const RANDOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
 * once the note is on disk.
 */
function isPinnedNote(note: string): boolean {
  // Pinned or not is read off the text; identity is the id (see PendingNote).
  // `includes`, not `startsWith`: an interrupted note carries the marker first.
  return note.includes('<tomo-event type="inbox"')
    || note.includes('<tomo-event type="interrupted-agents"')
    || note.includes('<tomo-event type="subsession-report"')
    // A failed task's unanswered messages: the record is forgotten once this is on disk.
    || note.includes('<tomo-event type="subsession-handback"');
}

/** Drop oldest unpinned notes until `arr` fits the cap (pinned ones always stay). */
function capNotes(arr: PendingNote[]): number {
  let dropped = 0;
  for (let i = 0; i < arr.length && arr.length > MAX_PENDING_NOTES;) {
    if (isPinnedNote(arr[i].text)) { i++; continue; }
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

/** The same note (same id), marked as possibly partly answered. */
function markInterrupted(note: PendingNote): PendingNote {
  return note.text.startsWith(INTERRUPTED_NOTE_MARKER) ? note : { id: note.id, text: `${INTERRUPTED_NOTE_MARKER}\n${note.text}` };
}

interface InFlightBatch {
  prefix: string;
  /** Durable notes in this prefix, in order. Persisted while in flight. */
  notes: PendingNote[];
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
  private notes = new Map<string, PendingNote[]>();
  private inflight = new Map<string, InFlightBatch[]>();
  private errorNotes = new Map<string, ErrorNote[]>();
  private errorSeq = 0;
  /** Sessions whose stored notes could not be read (the file could neither
   *  be read nor moved aside, see SessionStore.loadPendingNotes): held in
   *  memory only, never written, until a read succeeds (see `retryLoad`). */
  private unloaded = new Set<string>();
  /** Ids of notes a turn carried to its end this process, other than random
   *  ones: a retry under the same stable id is that same note, already
   *  delivered (see `queueNote`). */
  private settledIds = new Map<string, Set<string>>();

  constructor(private store: DurablePendingNotesStore) {}

  private queued(sessionKey: string): PendingNote[] {
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
    } else if (this.unloaded.has(sessionKey)) {
      this.retryLoad(sessionKey);
    }
    return arr;
  }

  /**
   * Read a session's stored notes again after a failed load, and put them
   * ahead of the ones queued in memory since (they are older). True once
   * they are loaded. Until then the session is never written: its stored
   * row is unknown, and writing the memory-only list would replace it.
   */
  private retryLoad(sessionKey: string): boolean {
    if (!this.unloaded.has(sessionKey)) return true;
    let stored: PendingNote[];
    try {
      stored = this.store.getPendingNotes(sessionKey);
    } catch {
      return false;
    }
    this.unloaded.delete(sessionKey);
    const arr = this.notes.get(sessionKey);
    if (!arr) {
      this.notes.set(sessionKey, stored);
      return true;
    }
    // Matched by id only, never by text: a stored note whose id is already
    // here (queued again under its stable id, or in flight — settling would
    // then remove it undelivered if it were queued too) is that same note.
    // Two notes that merely read the same are two notes.
    const here = new Set([...arr, ...(this.inflight.get(sessionKey) ?? []).flatMap((b) => b.notes)].map((n) => n.id));
    // Nor one a turn already carried to its end while the file would not read.
    const settled = this.settledIds.get(sessionKey);
    arr.unshift(...stored.filter((n) => !here.has(n.id) && !settled?.has(n.id)));
    return true;
  }

  /** Write in-flight + queued notes for this session. Returns false on failure. */
  private persist(sessionKey: string): boolean {
    if (!this.retryLoad(sessionKey)) {
      log.warn({ sessionKey }, "Pending notes not persisted: the stored ones could not be read");
      return false;
    }
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

  /**
   * Queue a note for the session's next turn. Returns false when it could
   * not be persisted (it is still held in memory for this process).
   *
   * `id` names the event the note is about, where it has a stable identity
   * (a task's report): a note with that id already queued or in flight (or
   * stored, found once the stored notes read) is not added again. Without
   * one, every call is a new note, even with the same text.
   */
  queueNote(sessionKey: string, note: string, id?: string): boolean {
    // Delivered already: a turn carried it to its end. Nothing to write.
    if (id !== undefined && this.settledIds.get(sessionKey)?.has(id)) return true;
    const arr = this.queued(sessionKey);
    const known = id !== undefined
      && (arr.some((n) => n.id === id) || (this.inflight.get(sessionKey) ?? []).some((b) => b.notes.some((n) => n.id === id)));
    if (known) return this.persist(sessionKey);
    arr.push({ id: id ?? randomUUID(), text: note });
    const dropped = capNotes(arr);
    if (dropped > 0) log.debug({ sessionKey, dropped }, "Pending notes capped at limit; dropped oldest");
    return this.persist(sessionKey);
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
    const held = opts.holdOwnerAudience ? notes.filter((n) => isOwnerAudienceNote(n.text)) : [];
    const drained = held.length > 0 ? notes.filter((n) => !isOwnerAudienceNote(n.text)) : [...notes];
    this.notes.set(sessionKey, held);

    const errorNotes = this.errorNotes.get(sessionKey) ?? [];
    const parts = drained.map((n) => n.text);
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
    // Reload first, while this batch still counts as in flight, so the stored
    // copy of one of its notes (same id) is recognised as delivered.
    this.retryLoad(sessionKey);
    const batch = this.takeInFlight(sessionKey, prefix);
    if (!batch || batch.notes.length === 0) return;
    const stable = batch.notes.filter((n) => !RANDOM_ID.test(n.id));
    if (stable.length > 0) {
      const ids = this.settledIds.get(sessionKey) ?? new Set<string>();
      for (const n of stable) ids.add(n.id);
      this.settledIds.set(sessionKey, ids);
    }
    this.persist(sessionKey);
  }

  /**
   * Write every session loaded this process again: after the file was moved
   * aside (see SessionStore.loadPendingNotes), the fresh one holds only what
   * has been written since, and these sessions' notes, queued and in flight,
   * would otherwise be in memory only until each one happens to be written.
   */
  persistLoaded(): void {
    for (const key of this.notes.keys()) {
      if (this.unloaded.has(key)) continue;
      this.persist(key);
    }
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
    this.retryLoad(sessionKey); // as in settle: before the batch leaves the in-flight list
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

  /**
   * Is a note matching `predicate` queued or in flight for the session?
   * While the session's stored notes cannot be read the answer is unknown:
   * `whenUnreadable` is returned unless one is found in memory. A caller
   * about to throw something away passes true; one about to write a copy
   * passes false, and queues the copy under the event's stable id (see
   * `queueNote`), so a copy already stored is not kept twice once it reads.
   */
  hasNote(sessionKey: string, predicate: (note: string) => boolean, whenUnreadable = false): boolean {
    if (this.queued(sessionKey).some((n) => predicate(n.text))) return true;
    if ((this.inflight.get(sessionKey) ?? []).some((b) => b.notes.some((n) => predicate(n.text)))) return true;
    return this.unloaded.has(sessionKey) ? whenUnreadable : false;
  }

  /** Can the session's stored notes be read (tried again now if they could
   *  not)? While false, what this queue says about them covers memory only. */
  storedReadable(sessionKey: string): boolean {
    this.queued(sessionKey);
    return !this.unloaded.has(sessionKey);
  }

  /** Queued durable notes, without draining. Only the ones in memory while
   *  the session's stored notes cannot be read. */
  peekNotes(sessionKey: string): string[] {
    return this.queued(sessionKey).map((n) => n.text);
  }
}
