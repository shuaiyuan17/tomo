import { z } from "zod";
import type { SessionMessage, SessionStats } from "../sessions/types.js";

export const WEB_CHAT_ID = "owner";
export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_EVENT_BYTES = 256 * 1024;
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
export const WEB_REQUEST_HEADER = "x-tomo-request";
export const messageInputSchema = z.object({
  requestId: z.uuid(),
  targetId: z.string().max(128).optional(),
  text: z.string().trim().min(1).max(16_000),
}).strict();
export type MessageInput = z.infer<typeof messageInputSchema>;
export interface WebSession {
  id: string;
  title: string;
  kind: "dm" | "group";
  writable: boolean;
  stats: Pick<SessionStats, "contextUsed" | "contextMax" | "contextEstimated">;
  lastActiveAt: number | null;
}
export interface WebCatalog { sessions: WebSession[]; ownerId: string | null; setupRequired: boolean }
export type RequestState = "queued" | "running" | "completed" | "refused" | "failed" | "unknown";
export interface WebRequest { requestId: string; state: RequestState; sessionId?: string }
export interface HistoryMessage extends SessionMessage { id: string }
export interface HistoryPage { messages: HistoryMessage[]; nextCursor: string | null; revision?: string }
export type WebEvent =
  | { type: "block"; sessionId: string; requestId: string; id: string; text: string }
  | { type: "request"; request: WebRequest }
  | { type: "invalidate"; sessionId?: string }
  | { type: "tool"; sessionId: string; tool: string; state: "started" | "completed" | "failed" }
  | { type: "typing"; sessionId: string; active: boolean };
export interface EventEnvelope { id: string; event: WebEvent }
export interface WebBootstrap extends WebCatalog {
  epoch: string;
  csrfToken: string;
  cursor: string;
  requests: WebRequest[];
  blocks: Extract<WebEvent, { type: "block" }>[];
}
export class WebError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** This is a closed RPC protocol, never a generic method/file/command proxy. */
export const rpcSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("message"), epoch: z.uuid(), input: messageInputSchema }).strict(),
  z.object({ method: z.literal("request"), requestId: z.uuid() }).strict(),
  z.object({ method: z.literal("snapshot"), cursor: z.string().max(128).optional() }).strict(),
]);
export type Rpc = z.infer<typeof rpcSchema>;
export type WebSnapshot = Pick<WebBootstrap, "epoch" | "cursor" | "requests" | "blocks">;
export interface WebSync { snapshot: WebSnapshot; replay: EventEnvelope[] | null }
