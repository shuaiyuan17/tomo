export const DEFAULT_CONTINUITY_INTERVAL_MINUTES = 55;
export const MIN_CONTINUITY_INTERVAL_MINUTES = 1;
export const DEFAULT_CONTINUITY_INTERVAL_MS = DEFAULT_CONTINUITY_INTERVAL_MINUTES * 60 * 1000;

/**
 * Appended to every prompt whose turn runs with `suppressDelivery`: the
 * continuity turns (heartbeat and post-restart notice) and the silent cron
 * turns (LCM rollup nudges, context nudges — see Agent.processCronMessage).
 *
 * Those turns' own text blocks never reach a chat (owner decision 2026-08-28,
 * option A). The model is told so plainly
 * here, in the event text itself rather than only in CONTINUITY.md, because a
 * model that believes its reply will be read writes a reply instead of calling
 * the tool that would actually deliver one.
 */
export const CONTINUITY_DELIVERY_NOTE =
  "Your reply text is not delivered to the user; to send a message, use send_message.";

/**
 * Appended to a user message that the CLI steers into a turn whose own output
 * is suppressed (`suppressDelivery`).
 *
 * A steered message joins the in-flight turn, so the model answers it in that
 * turn's reply text — and a silent turn's reply text is dropped before it
 * reaches the chat. The owner asks a question mid-heartbeat and never hears
 * back. The turn's own prompt already carries CONTINUITY_DELIVERY_NOTE, but
 * that sentence sits far above a message that arrived minutes later; the
 * reminder has to travel with the message it applies to.
 *
 * `audiences` is where each message must be ANSWERED, which is not necessarily
 * the session running the turn: a summoned-group message runs on the owner's
 * `dm:` session but belongs to the group, and this note is appended LAST —
 * after the summon reminder that says so — so naming the session key here
 * would override it and answer the group's question privately to the owner.
 * The caller resolves it (Agent.handleMessage / handleBatchedMessages, using
 * the same derivation as summonReminder).
 *
 * ONE ENTRY PER MESSAGE, IN THE PROMPT'S OWN NUMBERING ORDER. A coalesced
 * batch is one steered message that can mix the owner's DM with a summoned
 * group's, so a single target for the whole steer would post the owner's
 * private question to the group (or leave it unanswered). When the audiences
 * differ, the note pairs each target with the batch's ORDINAL for that
 * message — `handleBatchedMessages` numbers the messages `1.`, `2.`, … in the
 * same order, and that numbering is composed by the harness.
 *
 * NOTHING SENDER-CONTROLLED IS QUOTED HERE, deliberately. An earlier version
 * embedded a sanitised excerpt of each message; sanitising is the wrong shape
 * of defence for a trusted marker whose text drives a routing decision — a
 * curly or fullwidth quote, a `;`, an `→` or a literal `target:` survives any
 * delimiter swap, and truncation can make two different messages render the
 * same excerpt while pointing at different targets. An ordinal cannot be
 * forged by a sender because the sender does not choose it.
 */
export function silentTurnSteerNote(audiences: string[]): string {
  const targets = [...new Set(audiences)];
  const preamble = "your reply text will NOT be delivered.";
  if (targets.length <= 1) {
    return `[harness: this message arrived during a silent turn — ${preamble} `
      + `Answer it with send_message (target: ${targets[0] ?? ""}, mode: direct).]`;
  }
  const pairs = audiences.map((target, i) => `message ${i + 1} → target: ${target}`).join("; ");
  return `[harness: these messages arrived during a silent turn — ${preamble} `
    + "They came from DIFFERENT audiences; answer each with its own send_message (mode: direct), "
    + `to the audience it came from, by the number it has in this batch — ${pairs}. `
    + "Never answer one audience's message to another.]";
}
