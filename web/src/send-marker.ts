import { i18n } from "./i18n/index.js";
/**
 * The marker the daemon puts in front of a message Tomo sent on its own
 * (src/agent/proactive-send.ts, `send_message` direct mode) when it records
 * it in the target conversation:
 *   [proactive] text                      — a direct send
 *   [via dm:<name> (summoned)] text       — sent by <name>'s main session while summoned into the group
 * The transcript keeps it (recall reads it); the chat shows it as a label, never as text.
 */
export type SendMarker = { kind: "proactive" } | { kind: "summoned"; from: string };

const PREFIX = /^\[(?:(proactive)|via (dm:[^\]\s]+) \(summoned\))\] ?/;

/** Pull the send marker off the front of an assistant message; anything else is left as it is. */
export function parseSendMarker(role: string, content: string): { sent?: SendMarker; body: string } {
  if (role !== "assistant") return { body: content };
  const match = PREFIX.exec(content);
  if (!match) return { body: content };
  return { sent: match[1] ? { kind: "proactive" } : { kind: "summoned", from: match[2] }, body: content.slice(match[0].length) };
}

/** The label a marked message carries in its header. */
export function sendMarkerLabel(sent: SendMarker): string {
  return sent.kind === "proactive" ? i18n.t("chat:message.proactive") : i18n.t("chat:message.sentFrom", { from: sent.from });
}
