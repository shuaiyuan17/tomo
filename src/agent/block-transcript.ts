/**
 * Ordered transcript bookkeeping for per-block delivery.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE. Under per-block delivery a turn's blocks
 * are handed to a channel one at a time, and each one's transcript entry can
 * only be written once its send has settled — writing on intent made the
 * transcript claim deliveries that never happened. But "when it settles" is
 * not "in the order it was sent". A block whose send blows the delivery budget
 * is abandoned and the turn moves on; its promise keeps running and may settle
 * long after later blocks have already been recorded. Appending at settle time
 * therefore produced `B, A`, or `B, [delivery failed] A`, or — when the wedged
 * send never settled at all — no entry for A whatsoever.
 *
 * THE FIX: RESERVE THE SLOT AT DISPATCH, FILL IT AT SETTLE. A block takes its
 * place in the transcript the moment its send is ATTEMPTED, which is the one
 * instant that is guaranteed to be in model order (LiveSession serializes
 * delivery — it does not pull the next SDK event until the current block's
 * `onBlock` has returned or been abandoned). Entries are appended only as a
 * contiguous prefix of filled slots, so a slot that is still open holds back
 * the ones behind it rather than letting them overtake it.
 *
 * A slot is filled exactly once, by whichever of `settle` / `abandonOldest` /
 * `flushAll` reaches it first. That is what makes a late-settling abandoned
 * send a no-op for the transcript: its slot was already closed out with the
 * failure marker, in order, at the moment it was given up on. The send itself
 * may well still complete — there is no cancellation to hand a channel — but
 * it can no longer rewrite history.
 */

/**
 * Prefix for a transcript entry whose send threw or was abandoned. The block
 * was composed and attempted but is not known to have reached the owner, so
 * recall must not read it back as something he was told.
 */
export const DELIVERY_FAILED_MARKER = "[delivery failed] ";

/** One block's reserved place in the transcript. */
export interface BlockTranscriptSlot {
  /**
   * Record this block's outcome. Ignored if the slot was already closed out
   * (abandoned, or force-flushed when the turn died) — first writer wins.
   */
  settle(entry: string): void;
}

export interface OrderedBlockTranscript {
  /**
   * Take this block's place in the transcript. Called BEFORE the send, so the
   * order of entries is the order of dispatch and not the order of settlement.
   */
  reserve(block: string): BlockTranscriptSlot;
  /**
   * Give up on the oldest still-open slot, recording it with the failure
   * marker. Called when LiveSession abandons a block whose delivery blew its
   * budget; because delivery is serialized there is at most one open slot at
   * that instant, and it is this block's.
   */
  abandonOldest(): void;
  /**
   * Close out every still-open slot as abandoned and append everything held.
   * For the two paths on which the turn's own post-turn recording never runs —
   * the turn died, or shutdown converted its rejection into a bare NO_REPLY.
   * Either way the blocks reached the owner (or may have), and an unrecorded
   * delivery is invisible to recall.
   */
  flushAll(): void;
}

export interface OrderedBlockTranscriptOptions {
  /**
   * Hold every entry back until `flushAll()`. For `transcript: "always"` turns,
   * which record the turn's joined response once, after it succeeds — the
   * per-block entries are then only wanted on the path where that never
   * happens because the turn threw.
   */
  defer?: boolean;
}

export function createOrderedBlockTranscript(
  append: (entry: string) => void,
  options: OrderedBlockTranscriptOptions = {},
): OrderedBlockTranscript {
  interface Slot {
    /** The block's text, kept so an abandoned slot can still be marked. */
    block: string;
    /** null while the slot is still open. */
    entry: string | null;
  }

  const slots: Slot[] = [];
  /** Slots whose delivery has not settled, oldest first. */
  const open: Slot[] = [];
  /** How many slots have been appended. Only ever advances over a filled prefix. */
  let appended = 0;
  const defer = options.defer === true;

  const drain = (): void => {
    while (appended < slots.length) {
      const entry = slots[appended]!.entry;
      if (entry === null) return;
      append(entry);
      appended++;
    }
  };

  const close = (slot: Slot, entry: string): void => {
    if (slot.entry !== null) return;
    slot.entry = entry;
    const i = open.indexOf(slot);
    if (i !== -1) open.splice(i, 1);
  };

  return {
    reserve(block) {
      const slot: Slot = { block, entry: null };
      slots.push(slot);
      open.push(slot);
      return {
        settle(entry) {
          close(slot, entry);
          if (!defer) drain();
        },
      };
    },
    abandonOldest() {
      const slot = open[0];
      if (!slot) return;
      close(slot, `${DELIVERY_FAILED_MARKER}${slot.block}`);
      if (!defer) drain();
    },
    flushAll() {
      for (const slot of [...open]) close(slot, `${DELIVERY_FAILED_MARKER}${slot.block}`);
      drain();
    },
  };
}
