import { useEffect, useState } from "react";
import type { WebRequest } from "../../src/web/protocol.js";

/** How long "Completed" stays before it fades out (plus the fade itself). */
export const COMPLETED_VISIBLE_MS = 2000;
export const COMPLETED_FADE_MS = 200;

export const REQUEST_LABELS: Record<WebRequest["state"], string> = { queued: "Queued", running: "Tomo is working…", completed: "Completed",
  failed: "Delivery failed — check the conversation before sending again", refused: "Message was not accepted",
  unknown: "Outcome unknown — Tomo may already have acted on it. Check the conversation before sending again",
  interrupted: "Interrupted by a restart and not answered — Tomo may have started on it. Check before sending again" };

/**
 * The composer's ONE status line. Live tool/typing activity first, then a
 * note the page just produced (sending, a refusal), then the state of the
 * conversation's latest web request, read live from the request stream.
 * A completed request shows "Completed" until `settled` names it.
 */
export function composerStatus(input: {
  activity: string | undefined;
  feedback: string;
  latest: WebRequest | undefined;
  settled: string | null;
}): string {
  if (input.activity) return input.activity;
  if (input.feedback) return input.feedback;
  const { latest } = input;
  if (!latest) return "";
  if (latest.state === "completed" && input.settled === latest.requestId) return "";
  return REQUEST_LABELS[latest.state];
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
