import { renameSync, statSync, unlinkSync } from "node:fs";
import type { SessionEntry } from "./types.js";

/**
 * Shared private types and small filesystem helpers for SessionStore (store.ts).
 */

/** Rename `from` onto `to`, treating "it is already gone" as done: another
 *  process running the same migration is the expected reason. */
export function renameIfPresent(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export interface PendingNotesFile {
  version: 1;
  notes: Record<string, string[]>;
}

/**
 * `_legacy_stems.json`: legacy transcript filename stem → every session key
 * ever seen to own it.
 *
 * WHY A FILE AND NOT A DERIVATION. Deciding whether a legacy-named transcript
 * belongs to one key or several is a question about the PAST, and the registry
 * is a record of the present: `cleanupExpiredLocked` drops an unlinked entry
 * 30 days on (the transcript file outlives it), `clearSdkSessionId` removes a
 * metadata-only stub outright, and `migrateSessionKeyLocked` re-keys an entry
 * in place, keeping `migratedFrom` only for a non-DM→DM unification. Every one
 * of those erases the evidence that a second key ever shared the file, so an
 * inference from the live registry alone answers "only this key" for a file
 * that holds two people's messages — and `store.get()` then serves one
 * person's history to the other with no warning at all. So each of those
 * paths writes the key down here BEFORE forgetting it, and
 * `otherKeysSharingLegacyStem` reads this as well as the registry.
 */
export interface LegacyStemLedgerFile {
  version: 1;
  /** Legacy stem → session keys, sorted, deduplicated. */
  stems: Record<string, string[]>;
}

/**
 * What `probeLegacyStemOwnership` concluded.
 *
 * `unknown` is the whole reason this is a union rather than a `string[]`: an
 * empty answer and an unanswerable one are different states, and conflating
 * them is what adopts a shared transcript off an unreadable registry.
 */
export type OwnershipProbe =
  | { kind: "sole" }
  | { kind: "shared"; others: string[] }
  | { kind: "unknown"; source: string };

/**
 * What the `_legacy_stems.json.corrupt-*` copies in the sessions directory
 * still hold hostage.
 *
 * A QUARANTINE IS NOT A RESOLUTION, AND IT OUTLIVES THE PROCESS THAT MADE ONE.
 * Healing a malformed row moves it into a `.corrupt-` copy and rewrites the
 * ledger without it, so from then on the LEDGER looks clean while the fact that
 * some stem's owners were once unreadable lives only in that copy — and a stem
 * whose partner was named in the moved row would otherwise read as
 * single-owner to the next process, which adopts the shared file. So the copies
 * are part of the read path: `stems` maps every case-folded stem a copy still
 * names to the copy naming it, and `unparseable` is a copy that could not be
 * read row-wise at all (a crash mid-write, a mangled repair), which may name
 * ANY stem and therefore holds every stem the healed ledger has no row for.
 */
export type CorruptLedgerHold = { stems: Map<string, string>; unparseable: string | null };

/** No `.corrupt-` copy on disk — the steady state, and the one the scan must
 *  reach with a readdir and no file read. */
export const NO_CORRUPT_LEDGER_HOLD: CorruptLedgerHold = { stems: new Map(), unparseable: null };

/** What one pass of `carryLegacyTranscriptFamily` did, with the lock held. */
export type CarryOutcome =
  /** `carried` files moved; `sidecars` of them became read-only sidecars. */
  | { kind: "done"; carried: number; sidecars: string[] }
  /** The in-lock ownership re-check found another owner; nothing was moved. */
  | { kind: "ambiguous"; others: string[] }
  /** An ownership source became unreadable; nothing was moved, retry later. */
  | { kind: "deferred" };

/** The routing metadata a metadata-only stub carries into an adopted entry. */
export function stubMetadata(stub: SessionEntry): Partial<SessionEntry> {
  return {
    ...(stub.replyTarget ? { replyTarget: stub.replyTarget } : {}),
    ...(stub.chatTitle ? { chatTitle: stub.chatTitle } : {}),
  };
}

/**
 * Are these two names the SAME FILE — same device, same inode?
 *
 * This is what tells "the destination is another key's live transcript" from
 * "the destination is the hard link this very migration created before it was
 * interrupted" (see `moveWithoutClobber`).
 */
export function sameFileOnDisk(from: string, to: string): "same" | "different" | "missing-source" {
  let source: ReturnType<typeof statSync>;
  try {
    source = statSync(from);
  } catch {
    return "missing-source";
  }
  try {
    const target = statSync(to);
    return source.dev === target.dev && source.ino === target.ino ? "same" : "different";
  } catch {
    return "different";
  }
}

/** Unlink `path`, treating "it is already gone" as success — the second half of
 *  a link+unlink move is idempotent by construction. */
export function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * One file in a key's read set, and whether it is a READ-ONLY LEGACY SIDECAR —
 * a different seq run that no writer will touch again, and one whose position
 * in time cannot be read off its filename.
 */
export interface TranscriptReadFile {
  path: string;
  sidecar: boolean;
}
