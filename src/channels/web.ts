import { createHash } from "node:crypto";
import type { IdentityConfig } from "../config.js";
import type { Channel, CommandHandler, IncomingMessage, MessageHandler, OutgoingMessage } from "./types.js";
import { markDefiniteFailure } from "./types.js";
import { watchBus, type WatchBus } from "../watch/bus.js";
import type { WatchEvent } from "../watch/protocol.js";
import { isGroupSessionKey, legacySessionKeysForBinding } from "../sessions/keys.js";
import { selectWebOwner, webSessionId } from "../web/owner.js";
import { WebEvents } from "../web/events.js";
import { MAX_BUFFER_BYTES, messageInputSchema, WEB_CHAT_ID, WebError, type MessageInput, type WebEvent, type WebRequest } from "../web/protocol.js";

export interface WebLifecycle { start(): Promise<void>; stop(): Promise<void> }
interface Receipt { digest: string; request: WebRequest; settled: boolean }

/** A real channel: only Agent's registered MessageHandler accepts input, and
 * only the existing delivery pipeline calls send. HTTP is an optional peer. */
export class WebChannel implements Channel {
  readonly name = "web";
  readonly events = new WebEvents();
  readonly ownerId: string | null;
  private owner: IdentityConfig | undefined;
  private handler: MessageHandler | undefined;
  private lifecycle: WebLifecycle | undefined;
  private closed = false;
  private tornDown = false;
  private unsubscribe: (() => void) | undefined;
  private handoffs = new Set<Promise<boolean>>();
  private receipts = new Map<string, Receipt>();
  private blocks: Extract<WebEvent, { type: "block" }>[] = [];
  private blockBytes = 0;

  constructor(identities: IdentityConfig[], ownerIdentity?: string, private readonly bus: WatchBus = watchBus) {
    this.owner = selectWebOwner(identities, ownerIdentity);
    this.ownerId = this.owner ? webSessionId(`dm:${this.owner.name.toLowerCase()}`) : null;
    this.unsubscribe = this.bus.subscribe((event) => this.observe(event));
  }
  attach(lifecycle: WebLifecycle): void { this.lifecycle = lifecycle; }
  onMessage(handler: MessageHandler): void { this.handler = handler; }
  settleMessage(messageId: string, outcome: "refused" | "unknown"): void {
    const receipt = this.receipts.get(messageId);
    if (!receipt || receipt.settled) return;
    this.state(messageId, outcome);
    receipt.settled = true;
  }
  onCommand(_handler: CommandHandler): void { /* No command endpoint; chat remains ordinary Agent input. */ }

  async receive(raw: MessageInput): Promise<WebRequest> {
    const parsed = messageInputSchema.safeParse(raw);
    if (!parsed.success) throw new WebError(400, "invalid_message");
    const input = parsed.data;
    if (this.closed || this.tornDown || !this.handler) throw new WebError(503, "ingress_closed");
    if (!this.ownerId || !this.owner) throw new WebError(409, "owner_setup_required");
    if (input.targetId !== undefined && input.targetId !== this.ownerId) throw new WebError(403, "owner_dm_only");
    const digest = createHash("sha256").update(input.text).digest("hex");
    const previous = this.receipts.get(input.requestId);
    if (previous) {
      if (previous.digest !== digest) throw new WebError(409, "request_id_conflict");
      return { ...previous.request };
    }
    if (this.receipts.size >= 4096 || [...this.receipts.values()].filter((r) => ["queued", "running"].includes(r.request.state)).length >= 32) {
      throw new WebError(429, "request_limit");
    }
    const request: WebRequest = { requestId: input.requestId, state: "queued", sessionId: this.ownerId };
    this.receipts.set(input.requestId, { digest, request, settled: false });
    const message: IncomingMessage = { id: input.requestId, chatId: WEB_CHAT_ID, senderName: "Owner",
      text: input.text, timestamp: Date.now(), isGroup: false };
    const handoff = Promise.resolve().then(() => this.handler!(message));
    this.handoffs.add(handoff);
    try {
      const accepted = await handoff;
      if (!accepted) { this.state(input.requestId, "refused"); throw new WebError(503, "ingress_refused"); }
      this.events.publish({ type: "request", request: { ...request } });
      return { ...request };
    } catch (err) {
      if (request.state !== "refused") this.state(input.requestId, "unknown");
      throw err instanceof WebError ? err : new WebError(503, "handoff_failed");
    } finally { this.handoffs.delete(handoff); }
  }

  request(id: string): WebRequest { return { ...(this.receipts.get(id)?.request ?? { requestId: id, state: "unknown" }) }; }
  snapshot() {
    return { epoch: this.events.epoch, cursor: this.events.cursor(),
      requests: [...this.receipts.values()].slice(-128).map((r) => ({ ...r.request })), blocks: [...this.blocks] };
  }

  async send(message: OutgoingMessage): Promise<void> {
    const requestId = message.chatId;
    const receipt = this.receipts.get(requestId);
    if (this.tornDown || !this.ownerId || !receipt || receipt.settled || !["queued", "running", "failed"].includes(receipt.request.state)) {
      throw markDefiniteFailure(new Error("Web outlet unavailable"));
    }
    if (message.photo || message.sticker) {
      this.state(requestId, "failed");
      throw markDefiniteFailure(new Error("Web attachments are not supported"));
    }
    const bytes = Buffer.byteLength(message.text);
    if (this.blockBytes + bytes > MAX_BUFFER_BYTES - 64 * 1024) {
      this.state(requestId, "failed");
      throw markDefiniteFailure(new Error("Web mailbox full"));
    }
    const block: Extract<WebEvent, { type: "block" }> = { type: "block", sessionId: this.ownerId,
      requestId, id: `${requestId}:${this.blocks.length}`, text: message.text };
    try { this.events.publish(block); } catch (err) {
      this.state(requestId, "failed");
      throw markDefiniteFailure(err);
    }
    this.blocks.push(block);
    this.blockBytes += bytes;
  }

  startTyping(_chatId: string) {
    if (this.ownerId) this.events.publish({ type: "typing", sessionId: this.ownerId, active: true });
    return () => { if (this.ownerId) this.events.publish({ type: "typing", sessionId: this.ownerId, active: false }); };
  }
  async start(): Promise<void> { try { await this.lifecycle?.start(); } catch { /* Optional UI cannot fail Agent.start. */ } }
  closeIngestion(): void { this.closed = true; }
  async quiesce(): Promise<void> { await Promise.allSettled(this.handoffs); }
  async teardown(): Promise<void> {
    this.tornDown = true;
    this.unsubscribe?.();
    try { await this.lifecycle?.stop(); } catch { /* Optional process cleanup cannot prevent daemon shutdown. */ }
  }
  async stop(): Promise<void> { this.closeIngestion(); await this.quiesce(); await this.teardown(); }

  private state(requestId: string, state: WebRequest["state"]): void {
    const receipt = this.receipts.get(requestId);
    if (!receipt) return;
    receipt.request.state = state;
    this.events.publish({ type: "request", request: { ...receipt.request } });
  }
  private sessionId(key: string): string | undefined {
    if (isGroupSessionKey(key)) return webSessionId(key);
    if (!this.owner || !this.ownerId) return;
    if (key === `dm:${this.owner.name.toLowerCase()}` || Object.entries(this.owner.channels).some(([ch, id]) =>
      legacySessionKeysForBinding([key], ch, id).length > 0)) return this.ownerId;
  }
  private observe(event: WatchEvent): void {
    if (!("sessionKey" in event) || !event.sessionKey) return;
    const sessionId = this.sessionId(event.sessionKey);
    if (!sessionId) return;
    if (event.type === "turn.start" && event.requestId && this.receipts.has(event.requestId)) {
      this.state(event.requestId, "running");
    } else if (event.type === "turn.end" && event.requestId) {
      if (this.request(event.requestId).state !== "failed") this.state(event.requestId, event.ok ? "completed" : "failed");
      const receipt = this.receipts.get(event.requestId);
      if (receipt) receipt.settled = true;
      this.blocks = this.blocks.filter((block) => block.requestId !== event.requestId);
      this.blockBytes = this.blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);
      this.events.publish({ type: "invalidate", sessionId });
    } else if (event.type === "transcript" || event.type === "turn.stats") {
      this.events.publish({ type: "invalidate", sessionId });
    } else if (event.type === "tool.start" || event.type === "tool.end") {
      this.events.publish({ type: "tool", sessionId, tool: event.tool.slice(0, 128),
        state: event.type === "tool.start" ? "started" : event.ok ? "completed" : "failed" });
    }
  }
}
