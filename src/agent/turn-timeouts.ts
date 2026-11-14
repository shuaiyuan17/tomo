/** Inactivity and per-block delivery timeouts for LiveSession turns. */

import { QUERY_TIMEOUT_ERROR_PREFIX } from "./sdk-result.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minute timeout per send()/steer()

/**
 * How long ONE block's delivery may take before we give up on it.
 *
 * Separate from the inactivity timeout on purpose, and much shorter. The
 * inactivity timeout asks "is the MODEL still working?" and kills the session
 * when the answer is no. This one asks "is the CHANNEL still taking bytes?"
 * and answers only for this block — a wedged iMessage send loses its own
 * message and nothing else. Sixty seconds is far beyond a healthy send (tens
 * of milliseconds) and far below the ten-minute inactivity window, so it fires
 * only on a genuine hang.
 */
export const DELIVERY_TIMEOUT_MS = 60 * 1000;

/** Reject after `ms` unless `work` settles first. Always clears its timer. */
export async function withDeliveryTimeout(work: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_TIMEOUT_MS;
}

export function formatTimeout(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (timeoutMs % 1000 === 0) {
    const seconds = timeoutMs / 1000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${timeoutMs}ms`;
}

export function queryTimeoutError(timeoutMs: number): string {
  return `${QUERY_TIMEOUT_ERROR_PREFIX} ${formatTimeout(timeoutMs)}`;
}
