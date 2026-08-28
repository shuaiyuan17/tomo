export const DEFAULT_CONTINUITY_INTERVAL_MINUTES = 55;
export const MIN_CONTINUITY_INTERVAL_MINUTES = 1;
export const DEFAULT_CONTINUITY_INTERVAL_MS = DEFAULT_CONTINUITY_INTERVAL_MINUTES * 60 * 1000;

/**
 * Appended to every prompt that runs as a continuity turn (heartbeat and
 * post-restart notice alike).
 *
 * Those turns set `suppressDelivery` — their own text blocks never reach a
 * chat (owner decision 2026-08-28, option A). The model is told so plainly
 * here, in the event text itself rather than only in CONTINUITY.md, because a
 * model that believes its reply will be read writes a reply instead of calling
 * the tool that would actually deliver one.
 */
export const CONTINUITY_DELIVERY_NOTE =
  "Your reply text is not delivered to the user; to send a message, use send_message.";
