import { createHash } from "node:crypto";
import { ownerBindings, ownerSessionKey, OWNER_CHANNELS, type OwnerConfig } from "../owner.js";
import type { Channel, CommandHandler, IncomingMessage, MessageHandler, OutgoingMessage } from "./types.js";
import { markDefiniteFailure } from "./types.js";
import { watchBus, type WatchBus } from "../watch/bus.js";
import type { WatchEvent, WatchTask } from "../watch/protocol.js";
import { isGroupSessionKey, legacySessionKeysForBinding } from "../sessions/keys.js";
import { webSessionId } from "../web/owner.js";
import { WebEvents } from "../web/events.js";
import { MAX_SNAPSHOT_TASK_BYTES, TaskBoard } from "../web/tasks.js";
import { selectOwnerSessionKey } from "../web/data.js";
import { MAX_BUFFER_BYTES, messageInputSchema, WEB_CHAT_ID, WebError, type MessageInput, type TaskOutput, type WebEvent, type WebRequest, type WebTaskAccess } from "../web/protocol.js";

/** Task types whose output tail the SDK serves (`get_task_output`). */
const OUTPUT_TASK_TYPES = new Set(["local_bash", "monitor"]);
/** A subagent whose transcript names no model yet is looked up again after these delays, then given up. */
export const MODEL_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
/** How often the owner-key rule is re-read while owner tasks are shown. */
export const OWNER_KEY_CHECK_MS = 1_000;

export interface WebLifecycle { start(): Promise<void>; stop(): Promise<void> }
interface Receipt { digest: string; request: WebRequest; settled: boolean }

/** A real channel: only Agent's registered MessageHandler accepts input, and
 * only the existing delivery pipeline calls send. HTTP is an optional peer. */
export class WebChannel implements Channel {
  readonly name = "web";
  readonly events = new WebEvents();
  readonly ownerId: string | null;
  private owner: OwnerConfig | undefined;
  private handler: MessageHandler | undefined;
  private lifecycle: WebLifecycle | undefined;
  private closed = false;
  private tornDown = false;
  private unsubscribe: (() => void) | undefined;
  private handoffs = new Set<Promise<boolean>>();
  private receipts = new Map<string, Receipt>();
  private blocks: Extract<WebEvent, { type: "block" }>[] = [];
  private blockBytes = 0;
  private readonly taskModel: ((sessionKey: string, taskId: string) => Promise<string | undefined>) | undefined;
  /** Model lookups in progress (or given up), per key and task. */
  private modelLookups = new Map<string, { key: string; taskId: string; attempt: number; timer: ReturnType<typeof setTimeout> | undefined }>();
  private readonly now: () => number;
  private readonly taskOutput: ((sessionKey: string, taskId: string) => Promise<TaskOutput | undefined>) | undefined;
  /** Live and recently ended subagents/background tasks, per visible session. */
  readonly tasks: TaskBoard;

  /** The DM key the web catalog shows as the owner conversation (data.ts rule). */
  private readonly ownerKey: () => string | undefined;
  /** Re-checks the owner-key rule while the owner's board entry is filled. */
  private ownerKeyTimer: ReturnType<typeof setInterval> | undefined;

  constructor(owner: OwnerConfig | undefined, private readonly bus: WatchBus = watchBus,
    options: { now?: () => number; ownerKey?: () => string | undefined;
      /** Reads a shell/Monitor task's output tail from the live session of `sessionKey`. */
      taskOutput?: (sessionKey: string, taskId: string) => Promise<TaskOutput | undefined>;
      /** Reads a subagent's model from its transcript (the SDK's task events carry none). */
      taskModel?: (sessionKey: string, taskId: string) => Promise<string | undefined> } = {}) {
    this.taskOutput = options.taskOutput;
    this.taskModel = options.taskModel;
    const now = options.now ?? Date.now;
    this.now = now;
    // Without registry access the catalog would pick the canonical key.
    this.ownerKey = options.ownerKey ?? (() => selectOwnerSessionKey(owner, []));
    this.tasks = new TaskBoard((sessionId, tasks) => {
      try { this.events.publish({ type: "tasks", sessionId, tasks }); } catch { /* An oversized panel update never fails the Agent. */ }
    }, { now, router: () => this.taskRouter() });
    this.owner = owner;
    this.ownerId = this.owner ? webSessionId(ownerSessionKey(this.owner)) : null;
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
    if ([...this.receipts.values()].filter((r) => !r.settled).length >= 32) {
      throw new WebError(429, "request_limit");
    }
    if (this.receipts.size >= 4096) {
      const oldest = [...this.receipts].find(([, receipt]) => receipt.settled);
      if (!oldest) throw new WebError(429, "request_limit");
      this.receipts.delete(oldest[0]);
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
      this.receipts.get(input.requestId)!.settled = true;
      throw err instanceof WebError ? err : new WebError(503, "handoff_failed");
    } finally { this.handoffs.delete(handoff); }
  }

  request(id: string): WebRequest { return { ...(this.receipts.get(id)?.request ?? { requestId: id, state: "unknown" }) }; }
  snapshot() {
    const requests = [...this.receipts.values()].slice(-128).map((r) => ({ ...r.request }));
    const blocks = [...this.blocks];
    const tasks = this.tasks.snapshot();
    return { epoch: this.events.epoch, cursor: this.events.cursor(), requests, blocks, tasks };
  }

  /**
   * Where the browser may read a task it was shown: only a task the panel's
   * send gate would show in `sessionId` right now. Shell and Monitor tasks
   * also return their output tail, read from the live SDK session.
   */
  async task(sessionId: string, taskId: string, output: boolean): Promise<WebTaskAccess> {
    const found = this.tasks.locate(sessionId, taskId);
    if (!found) throw new WebError(404, "task_not_found");
    const access: WebTaskAccess = { sessionKey: found.slot, taskType: found.task.taskType };
    if (!output) return access;
    if (!OUTPUT_TASK_TYPES.has(found.task.taskType)) throw new WebError(400, "no_task_output");
    const value = await this.taskOutput?.(found.slot, taskId).catch(() => undefined);
    if (!value) throw new WebError(503, "task_output_unavailable");
    return { ...access, output: { output: value.output.slice(-16 * 1024), size: value.size } };
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
    // The rest of the snapshot frame is reserved for receipts and the task
    // panel, whose worst case is fixed, so the snapshot never truncates it.
    if (this.blockBytes + bytes > MAX_BUFFER_BYTES - 64 * 1024 - MAX_SNAPSHOT_TASK_BYTES) {
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
    this.tasks.dispose();
    for (const lookup of this.modelLookups.values()) clearTimeout(lookup.timer);
    this.modelLookups.clear();
    clearInterval(this.ownerKeyTimer);
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
    const owner = this.owner;
    if (key === ownerSessionKey(owner) || OWNER_CHANNELS.some((ch) =>
      ownerBindings(owner, ch).some((id) => legacySessionKeysForBinding([key], ch, id).length > 0))) return this.ownerId;
  }
  /**
   * Task text reaches the browser only for sessions its catalog shows: any
   * group, and for DMs exactly the key `selectOwnerSessionKey` picks — not
   * every legacy key bound to the owner, which the catalog may be hiding.
   */
  /**
   * The board's send gate calls this once per send: one fresh read of the
   * owner-key rule, then a router for every key in that send. Groups always
   * show (they are readable in the browser); a DM only when it is the key the
   * catalog rule picks as the owner conversation in this snapshot.
   */
  private taskRouter(): (key: string) => string | undefined {
    const ownerKey = this.ownerKey();
    const ownerId = this.ownerId;
    return (key) => {
      if (isGroupSessionKey(key)) return webSessionId(key);
      return ownerKey !== undefined && key === ownerKey && ownerId ? ownerId : undefined;
    };
  }
  /**
   * Subagents (local_agent) get their model from the first assistant entry of
   * their transcript. Looked up when the task first appears; if that entry is
   * not written yet, retried after MODEL_RETRY_DELAYS_MS (1 s, 3 s, 10 s) and
   * then given up. A task that ended keeps being looked up while the panel
   * still holds it; once it has left the panel, its retries are dropped.
   * Other task types have no model and are never looked up.
   */
  private lookUpModels(key: string, tasks: WatchTask[]): void {
    if (!this.taskModel) return;
    // Drop lookups for tasks the board no longer holds (left the panel).
    for (const [id, lookup] of this.modelLookups) {
      if (!this.tasks.holds(lookup.key, lookup.taskId)) { clearTimeout(lookup.timer); this.modelLookups.delete(id); }
    }
    for (const task of tasks) {
      if (task.taskType !== "local_agent" || this.tasks.hasModel(key, task.taskId)) continue;
      const id = `${key}\0${task.taskId}`;
      if (this.modelLookups.has(id)) continue;
      const lookup = { key, taskId: task.taskId, attempt: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      this.modelLookups.set(id, lookup);
      const attempt = () => {
        lookup.timer = undefined;
        void this.taskModel!(key, task.taskId).then((model) => {
          if (this.modelLookups.get(id) !== lookup || this.tornDown) return;
          // A short task may have ended meanwhile; it still gets its badge
          // while the panel keeps it. Once it left the panel, stop.
          if (!this.tasks.holds(key, task.taskId)) { this.modelLookups.delete(id); return; }
          if (model) { this.tasks.setModel(key, task.taskId, model); return; }
          const delay = MODEL_RETRY_DELAYS_MS[lookup.attempt++];
          if (delay !== undefined) { lookup.timer = setTimeout(attempt, delay); lookup.timer.unref?.(); }
        }, () => {});
      };
      attempt();
    }
  }

  /** Every owner-bound or group key is recorded; the gate decides what is shown. */
  private observeTasks(key: string, event: Extract<WatchEvent, { type: "tasks" }>): void {
    this.tasks.apply(key, event.tasks, event.ended);
    this.lookUpModels(key, event.tasks);
    // The owner rule can change with no task event at all; re-run the gate so
    // a DM that stops being the owner conversation is withdrawn promptly.
    if (!isGroupSessionKey(key) && !this.ownerKeyTimer) {
      this.ownerKeyTimer = setInterval(() => this.tasks.publish(), OWNER_KEY_CHECK_MS);
      this.ownerKeyTimer.unref?.();
    }
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
    } else if (event.type === "tasks") {
      this.observeTasks(event.sessionKey, event);
    } else if (event.type === "tool.start" || event.type === "tool.end") {
      this.events.publish({ type: "tool", sessionId, tool: event.tool.slice(0, 128),
        state: event.type === "tool.start" ? "started" : event.ok ? "completed" : "failed" });
    }
  }
}
