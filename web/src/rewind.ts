import type { HistoryMessage, WebRewindMark } from "../../src/web/protocol.js";

/** Pure helpers for "rewind to here" and for showing what a rewind left behind. */

/**
 * How many of the conversation's latest user messages a rewind to `index`
 * goes back: that message and every user message after it THAT THE MODEL
 * STILL HAS. Messages an earlier rewind already removed stay in the history
 * (the transcript is never rewritten) but are no longer on the SDK's branch,
 * so counting them would send the fork further back than the message
 * pointed at. Null when the message is not the owner's own, or is itself
 * already rewound.
 */
export function rewindCount(messages: readonly Pick<HistoryMessage, "role" | "timestamp">[], index: number,
  rewound: (timestamp: number) => boolean = () => false): number | null {
  const target = messages[index];
  if (target?.role !== "user" || rewound(target.timestamp)) return null;
  return messages.slice(index).filter((message) => message.role === "user" && !rewound(message.timestamp)).length;
}

/** The rewind that removed this message from the model's context, if any. */
export function rewoundBy(marks: readonly WebRewindMark[], sessionId: string, timestamp: number): WebRewindMark | undefined {
  return marks.find((mark) => mark.sessionId === sessionId && mark.from <= timestamp && timestamp <= mark.at);
}

/** Is this the first message a rewind removed (where its marker line goes)? */
export function startsRewind(marks: readonly WebRewindMark[], sessionId: string, messages: readonly Pick<HistoryMessage, "timestamp">[], index: number): boolean {
  const mark = rewoundBy(marks, sessionId, messages[index].timestamp);
  if (!mark) return false;
  const previous = messages[index - 1];
  return !previous || rewoundBy(marks, sessionId, previous.timestamp) !== mark;
}

const REFUSALS: Record<string, string> = {
  turn_in_flight: "Not rewound: a turn is running. Stop it or wait for it, then try again.",
  rewind_mismatch: "Not rewound: this message does not line up with a clean point in the model's context (it may have been sent together with another one). Try the message before it, or send /rewind from a messaging channel.",
  nothing_to_rewind: "Not rewound: this message is older than what the model still has (compacted, or from before a new session).",
  epoch_changed: "Tomo restarted since this page loaded. Reload, then try again.",
  owner_setup_required: "Rewind is not available: no owner conversation is set up.",
};
/** What the status line says when a rewind was refused; nothing was changed in any of these. */
export function rewindRefusal(code: string | undefined): string {
  return (code && REFUSALS[code]) || "Could not rewind. Nothing was changed; try again.";
}
