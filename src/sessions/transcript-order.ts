import type { SessionMessage } from "./types.js";

/**
 * Ordering helpers for transcript records whose seq/timestamp may be unusable.
 */

/**
 * The oldest timestamp a real transcript record can carry. Tomo did not exist
 * before this, so anything below it is corrupt rather than ancient: a
 * `timestamp: 0` legacy record, a negative value, or a seconds-precision epoch
 * written where milliseconds were expected (1_700_000_000 is 1970-01-20).
 *
 * This matters because searchTranscript's lower bounds END the scan, so
 * reading such a value as "older than everything" truncates an entire recall.
 */
const MIN_PLAUSIBLE_TIMESTAMP_MS = Date.UTC(2000, 0, 1);

/**
 * A record's seq, or null when it has none we can order by.
 *
 * Stricter than `isAfterMessage`, which accepts any non-null value: a
 * hand-edited `seq: "12"` is invisible to a search bound here but would still
 * be compared as a string there. Nothing that has to ORDER by seq may accept a
 * string (`"12" + 1` is `"121"`), so both places where the next seq to hand out
 * is decided — `getLastSeq`'s scan of the tail AND its archive fallback — use
 * this; the remaining leniency in `isAfterMessage` is pre-existing and left
 * alone.
 */
export function usableSeq(msg: SessionMessage): number | null {
  return typeof msg.seq === "number" && Number.isFinite(msg.seq) ? msg.seq : null;
}

/** A record's timestamp, or null when it has none we can order by. */
export function usableTimestamp(msg: SessionMessage): number | null {
  return typeof msg.timestamp === "number"
    && Number.isFinite(msg.timestamp)
    && msg.timestamp >= MIN_PLAUSIBLE_TIMESTAMP_MS
    ? msg.timestamp
    : null;
}

/**
 * The instant a record is ORDERED BY when a read set mixes files whose relative
 * order cannot be inferred from their names (see `transcriptReadSet`).
 *
 * A record with no usable timestamp sorts as older than every placeable one: it
 * cannot be interleaved honestly, and the only alternative — dropping it —
 * loses history. Ties (including a whole run of undated records) are broken by
 * file order, so the result is deterministic.
 */
export function orderTimestamp(msg: SessionMessage): number {
  return usableTimestamp(msg) ?? -Infinity;
}

/**
 * Sort records oldest-first by their own timestamps, ties by their position in
 * the input.
 *
 * Index-tiebroken rather than trusting `Array.sort` to be stable, and it never
 * SUBTRACTS the two keys: `-Infinity - -Infinity` is `NaN`, which makes a
 * comparator inconsistent and the result unspecified.
 */
export function sortByRecordTime(messages: readonly SessionMessage[]): SessionMessage[] {
  return messages
    .map((msg, index) => ({ msg, index }))
    .sort((a, b) => {
      const ta = orderTimestamp(a.msg);
      const tb = orderTimestamp(b.msg);
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.msg);
}
