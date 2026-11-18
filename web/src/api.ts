import type { EventEnvelope, MessageInput, WebBootstrap, WebCompactResult, WebCredentialResult, WebCredentialSubmit, WebEvent, WebRequest, TaskAction, WebSnapshot, WebStopResult, WebTaskActionResult } from "../../src/web/protocol.js";

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

let entryToken: string | null | undefined;
export async function readBootstrap(signal?: AbortSignal): Promise<WebBootstrap> {
  if (entryToken === undefined) {
    const url = new URL(window.location.href);
    entryToken = url.searchParams.get("t");
    url.searchParams.delete("t");
    window.history.replaceState(window.history.state, "", url);
  }
  const value = await api<WebBootstrap>(`/bootstrap${entryToken ? `?t=${encodeURIComponent(entryToken)}` : ""}`, { signal });
  entryToken = null; // Only the HttpOnly cookie persists the login.
  return value;
}

/** Only a definite, pre-admission CSRF rejection may be retried. Preserve the
 * request id and epoch; an uncertain transport failure must never resubmit. */
export async function mutate<T>(path: string, method: "POST" | "PATCH" | "DELETE", input: unknown,
  bootstrap: WebBootstrap, refresh: () => Promise<WebBootstrap>): Promise<T> {
  const send = (csrfToken: string) => api<T>(path, { method, headers: {
    "content-type": "application/json", "x-tomo-csrf": csrfToken, "x-tomo-epoch": bootstrap.epoch,
  }, body: JSON.stringify(input) });
  try { return await send(bootstrap.csrfToken); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 403 || error.code !== "invalid_csrf") throw error;
    const fresh = await refresh();
    if (fresh.epoch !== bootstrap.epoch) throw new ApiError(409, "epoch_changed");
    return send(fresh.csrfToken);
  }
}

export function sendMessage(input: MessageInput, bootstrap: WebBootstrap, refresh: () => Promise<WebBootstrap>): Promise<WebRequest> {
  return mutate<WebRequest>("/messages", "POST", input, bootstrap, refresh);
}

/** The owner dealt with an interrupted request: its bubble goes, the record stays. */
export function dismissRequest(requestId: string, bootstrap: WebBootstrap, refresh: () => Promise<WebBootstrap>): Promise<WebRequest> {
  return mutate<WebRequest>(`/messages/${requestId}/dismiss`, "POST", {}, bootstrap, refresh);
}

/** A picture of Tomo's home, answering a `home-look` (only ever then). Same CSRF/epoch rules as sending a message. */
export function postHomeSnapshot(input: { requestId?: string; revision: string; png: string }, bootstrap: WebBootstrap, refresh: () => Promise<WebBootstrap>): Promise<unknown> {
  return mutate<unknown>("/home/snapshot", "POST", input, bootstrap, refresh);
}

/** The credential card's answer: its own route (never /messages, so no bubble and no journal). Same CSRF/epoch rules. */
export function submitCredential(id: string, input: WebCredentialSubmit, bootstrap: WebBootstrap, refresh: () => Promise<WebBootstrap>): Promise<WebCredentialResult> {
  return mutate<WebCredentialResult>(`/credentials/${encodeURIComponent(id)}`, "POST", input, bootstrap, refresh);
}

/** Stop the owner conversation's running turn. Same CSRF/epoch rules as sending a message. */
export function stopTurn(bootstrap: WebBootstrap, refresh: () => Promise<WebBootstrap>): Promise<WebStopResult> {
  return mutate<WebStopResult>("/stop", "POST", {}, bootstrap, refresh);
}

/** Stop one running task of the owner conversation, or move a foreground one to the background. */
export function taskAction(sessionId: string, taskId: string, action: TaskAction, bootstrap: WebBootstrap, refresh: () => Promise<WebBootstrap>): Promise<WebTaskActionResult> {
  return mutate<WebTaskActionResult>(`/sessions/${sessionId}/tasks/${encodeURIComponent(taskId)}/${action}`, "POST", {}, bootstrap, refresh);
}

/** Ask Tomo to compact the owner's session. Same CSRF/epoch rules as sending a message. */
export async function requestCompact(bootstrap: WebBootstrap, refresh: () => Promise<WebBootstrap>): Promise<WebCompactResult> {
  const send = (csrfToken: string) => api<WebCompactResult>("/compact-request", { method: "POST", headers: {
    "content-type": "application/json", "x-tomo-csrf": csrfToken, "x-tomo-epoch": bootstrap.epoch,
  }, body: "{}" });
  try { return await send(bootstrap.csrfToken); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 403 || error.code !== "invalid_csrf") throw error;
    const fresh = await refresh();
    if (fresh.epoch !== bootstrap.epoch) throw new ApiError(409, "epoch_changed");
    return send(fresh.csrfToken);
  }
}

export interface StreamHandlers {
  snapshot(value: WebSnapshot): void;
  update(event: WebEvent): void;
  cursor(value: string): void;
}
/** Fetch SSE supports our same-origin header; EventSource cannot set one. */
/**
 * The daemon writes a heartbeat every 15 s. A stream silent for longer than
 * this is dead even if no error says so (iOS drops a suspended page's
 * sockets without telling the reader), and is given up for a reconnect.
 */
export const STREAM_IDLE_MS = 45_000;
export async function stream(cursor: string, signal: AbortSignal, handlers: StreamHandlers, idleMs = STREAM_IDLE_MS): Promise<void> {
  const response = await fetch(`/api/v1/events?cursor=${encodeURIComponent(cursor)}`, {
    signal, credentials: "same-origin", headers: { "x-tomo-request": "1" },
  });
  if (!response.ok || !response.body) throw new Error("Stream unavailable");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stale = false;
  const watch = () => { clearTimeout(idle); idle = setTimeout(() => { stale = true; void reader.cancel().catch(() => {}); }, idleMs); };
  try {
    for (;;) {
      watch();
      const { value, done } = await reader.read();
      if (stale) throw new Error("Stream went quiet");
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
  } finally { clearTimeout(idle); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export type { WebBootstrap };

/**
 * Upload one image or file for the next message (XHR, for upload progress). Same
 * gate as sending: CSRF, the daemon epoch, the owner's conversation. A
 * definite CSRF rejection is retried once with a fresh token, like `mutate`.
 */
export function uploadImage(file: Blob, targetId: string, bootstrap: WebBootstrap, refresh: () => Promise<WebBootstrap>,
  onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<{ uploadId: string; type: string; size: number; kind?: "image" | "file" }> {
  const send = (csrfToken: string) => new Promise<{ uploadId: string; type: string; size: number; kind?: "image" | "file" }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/v1/uploads?targetId=${encodeURIComponent(targetId)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-tomo-request", "1");
    xhr.setRequestHeader("x-tomo-csrf", csrfToken);
    xhr.setRequestHeader("x-tomo-epoch", bootstrap.epoch);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      let value: { error?: string } & Record<string, unknown> = {};
      try { value = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(value as unknown as { uploadId: string; type: string; size: number; kind?: "image" | "file" });
      else reject(new ApiError(xhr.status, value.error ?? "unavailable"));
    };
    xhr.onerror = () => reject(new ApiError(0, "network"));
    xhr.onabort = () => reject(new ApiError(0, "aborted"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
  return send(bootstrap.csrfToken).catch(async (error) => {
    if (!(error instanceof ApiError) || error.status !== 403 || error.code !== "invalid_csrf") throw error;
    const fresh = await refresh();
    if (fresh.epoch !== bootstrap.epoch) throw new ApiError(409, "epoch_changed");
    return send(fresh.csrfToken);
  });
}

/** Drop an upload the owner removed before sending (best effort: unsent uploads also expire). */
export function discardUpload(uploadId: string, bootstrap: WebBootstrap): void {
  void api(`/uploads/${uploadId}`, { method: "DELETE", headers: { "content-type": "application/json", "x-tomo-csrf": bootstrap.csrfToken, "x-tomo-epoch": bootstrap.epoch }, body: "{}" }).catch(() => {});
}
