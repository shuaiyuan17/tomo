import { useEffect, useState } from "react";
import type { WebRequest } from "../../src/web/protocol.js";

/** How long "Completed" stays before it fades out (plus the fade itself). */
export const COMPLETED_VISIBLE_MS = 2000;
export const COMPLETED_FADE_MS = 200;

/** The request states as the status line words them, naming the agent (see agent-name.ts). */
export function requestLabels(agent = "Tomo"): Record<WebRequest["state"], string> {
  return { queued: "Queued", running: `${agent} is working…`, completed: "Completed",
    failed: "Delivery failed — check the conversation before sending again", refused: "Message was not accepted",
    unknown: `Outcome unknown — ${agent} may already have acted on it. Check the conversation before sending again`,
    interrupted: `Interrupted by a restart and not answered — ${agent} may have started on it. Check before sending again` };
}
export const REQUEST_LABELS = requestLabels();
/** The typing indicator's activity value; the status line words it with the agent's name. */
export const TYPING_ACTIVITY = "typing";

/** Where the latest request stands: a note is tied to this and lapses when it moves. */
export function requestStamp(latest: WebRequest | undefined): string {
  return latest ? `${latest.requestId}:${latest.state}` : "";
}

/** A one-off note from the page (sending, a refusal, a failed check), and the request stamp it was written at. */
export interface ComposerNote { text: string; at: string }

/**
 * The composer's ONE status line. Live tool/typing activity first; then a
 * note the page produced, but only while the latest request is still where
 * it was when the note was written (any change of request or state retires
 * it, so a note can never hold back "Running" or "Completed"); then the
 * latest web request's state, read live from the request stream. A
 * completed request shows "Completed" until `settled` names it.
 */
export function composerStatus(input: {
  activity: string | undefined;
  note: ComposerNote;
  latest: WebRequest | undefined;
  settled: string | null;
  /** The agent's name (default "Tomo"). */
  agent?: string;
}): string {
  const labels = requestLabels(input.agent);
  if (input.activity === TYPING_ACTIVITY) return labels.running;
  if (input.activity) return input.activity;
  const { latest } = input;
  if (input.note.text && input.note.at === requestStamp(latest)) return input.note.text;
  if (!latest) return "";
  if (latest.state === "completed" && input.settled === latest.requestId) return "";
  return labels[latest.state];
}

/**
 * When the latest request completes: "fading" after COMPLETED_VISIBLE_MS,
 * then its id as `settled` (the line clears) once the fade is over.
 */
export function useCompletedSettle(latest: WebRequest | undefined): { settled: string | null; fading: boolean } {
  const [settled, setSettled] = useState<string | null>(null);
  const [fading, setFading] = useState<string | null>(null);
  const id = latest?.state === "completed" ? latest.requestId : null;
  useEffect(() => {
    if (!id) return;
    const fade = setTimeout(() => setFading(id), COMPLETED_VISIBLE_MS);
    const clear = setTimeout(() => setSettled(id), COMPLETED_VISIBLE_MS + COMPLETED_FADE_MS);
    return () => { clearTimeout(fade); clearTimeout(clear); };
  }, [id]);
  return { settled, fading: !!id && fading === id && settled !== id };
}
