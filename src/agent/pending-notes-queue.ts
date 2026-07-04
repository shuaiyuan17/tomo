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

export class PendingNotesQueue {
  private notes = new Map<string, string[]>();
  private errorNotes = new Map<string, string[]>();

  constructor(private store: DurablePendingNotesStore) {}

  queueNote(sessionKey: string, note: string): void {
    let arr = this.notes.get(sessionKey);
    if (!arr) {
      try {
        arr = this.store.getPendingNotes(sessionKey);
      } catch (err) {
        log.warn({ err, sessionKey }, "Could not load durable pending notes");
        arr = [];
      }
    }
    arr.push(note);
    if (arr.length > MAX_PENDING_NOTES) {
      const dropped = arr.splice(0, arr.length - MAX_PENDING_NOTES).length;
      log.debug({ sessionKey, dropped }, "Pending notes capped at limit; dropped oldest");
    }
    this.notes.set(sessionKey, arr);
    try {
      this.store.setPendingNotes(sessionKey, arr);
    } catch (err) {
      log.warn({ err, sessionKey }, "Could not persist pending notes");
    }
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

  /** Drain notes queued for this session and return them as a prompt prefix. */
  drain(sessionKey: string): string {
    const drained: string[] = [];
    let notes = this.notes.get(sessionKey);
    if (!notes) {
      try {
        notes = this.store.getPendingNotes(sessionKey);
      } catch (err) {
        log.warn({ err, sessionKey }, "Could not load durable pending notes");
        notes = [];
      }
    }
    if (notes && notes.length > 0) {
      drained.push(...notes);
      try {
        this.store.setPendingNotes(sessionKey, []);
        this.notes.delete(sessionKey);
      } catch (err) {
        // Avoid replaying the same note repeatedly in this process. If the
        // durable clear failed, a restart may replay it, which is safer than
        // silently losing context.
        this.notes.set(sessionKey, []);
        log.warn({ err, sessionKey }, "Could not clear durable pending notes");
      }
    }

    const errorNotes = this.errorNotes.get(sessionKey);
    if (errorNotes && errorNotes.length > 0) {
      this.errorNotes.delete(sessionKey);
      drained.push(formatTomoEvent("errors", [
        "Recent Tomo errors before this turn (newest last, capped):",
        ...errorNotes.map((note) => `- ${note}`),
        "Use this as operational context; do not repeat the raw error unless it helps the user.",
      ].join("\n")));
    }

    return drained.map((n) => `${n}\n\n`).join("");
  }

  /** Test/support helper for observing queued durable notes without draining. */
  peekNotes(sessionKey: string): string[] {
    return [...(this.notes.get(sessionKey) ?? this.store.getPendingNotes(sessionKey))];
  }
}
