import type { EventEnvelope, WebBootstrap, WebEvent, WebSnapshot } from "../../src/web/protocol.js";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { ...init, credentials: "same-origin",
    headers: { "x-tomo-request": "1", ...init?.headers } });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new ApiError(response.status, value.error ?? "unavailable");
  }
  return response.json() as Promise<T>;
}

export interface StreamHandlers {
  snapshot(value: WebSnapshot): void;
  update(event: WebEvent): void;
  cursor(value: string): void;
}
/** Fetch SSE supports our same-origin header; EventSource cannot set one. */
export async function stream(cursor: string, signal: AbortSignal, handlers: StreamHandlers): Promise<void> {
  const response = await fetch(`/api/v1/events?cursor=${encodeURIComponent(cursor)}`, {
    signal, credentials: "same-origin", headers: { "x-tomo-request": "1" },
  });
  if (!response.ok || !response.body) throw new Error("Stream unavailable");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Stream disconnected");
      buffer += value;
      if (buffer.length > 2 * 1024 * 1024) throw new Error("Stream limit exceeded");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(frame.split("\n").map((line) => {
          const at = line.indexOf(":"); return [line.slice(0, at), line.slice(at + 1).trimStart()];
        }));
        if (fields.event === "snapshot") handlers.snapshot(JSON.parse(fields.data) as WebSnapshot);
        if (fields.event === "update") handlers.update(JSON.parse(fields.data) as EventEnvelope["event"]);
        if (fields.id) handlers.cursor(fields.id);
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export type { WebBootstrap };
