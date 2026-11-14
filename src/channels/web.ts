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
import { redactCommand } from "../web/redact-command.js";
import { selectOwnerSessionKey } from "../web/data.js";
import type { JournalEntry, Resolution, WebRequestJournal } from "../web/request-journal.js";
import { MAX_BUFFER_BYTES, messageInputSchema, WEB_CHAT_ID, WebError, type MessageInput, type TaskOutput, type WebCompaction, type WebEvent, type WebRequest, type WebTaskAccess } from "../web/protocol.js";

/** A shell task's full command is served up to this many characters. */
const COMMAND_LIMIT = 16_000;
/** Task types whose output tail the SDK serves (`get_task_output`). */
const OUTPUT_TASK_TYPES = new Set(["local_bash", "monitor"]);
/** A subagent whose transcript names no model yet is looked up again after these delays, then given up. */
export const MODEL_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
/** How often the owner-key rule is re-read while owner tasks are shown. */
export const OWNER_KEY_CHECK_MS = 1_000;
/** Interrupted requests the owner has not dealt with; past this, new browser
 *  messages are refused (503 interrupted_backlog) rather than dropping any. */
export const MAX_INTERRUPTED_BACKLOG = 64;
/** Snapshot bytes left for reply blocks and pending request text after the receipts envelope and the task panel. */
const SNAPSHOT_MAILBOX_BYTES = MAX_BUFFER_BYTES - 64 * 1024 - MAX_SNAPSHOT_TASK_BYTES;

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
  /** Recent compactions per browser session, for the Study's context view. */
  private compactions = new Map<string, WebCompaction[]>();
  private readonly taskModel: ((sessionKey: string, taskId: string) => Promise<string | undefined>) | undefined;
  /** Model lookups in progress (or given up), per key and task. */
  private modelLookups = new Map<string, { key: string; taskId: string; attempt: number; timer: ReturnType<typeof setTimeout> | undefined }>();
  private readonly now: () => number;
  private readonly toolCommand: ((sessionKey: string, toolUseId: string) => string | undefined) | undefined;
  private readonly taskOutput: ((sessionKey: string, taskId: string) => Promise<TaskOutput | undefined>) | undefined;
  /** Live and recently ended subagents/background tasks, per visible session. */
  readonly tasks: TaskBoard;

  /** The DM key the web catalog shows as the owner conversation (data.ts rule). */
  private readonly ownerKey: () => string | undefined;
  /** Re-checks the owner-key rule while the owner's board entry is filled. */
  private ownerKeyTimer: ReturnType<typeof setInterval> | undefined;
  /** Text of accepted requests not yet settled, and of interrupted ones the
   *  owner has not dealt with: shown as pending bubbles in the snapshot. */
  private pendingTextBytes = 0;
  private readonly journal: WebRequestJournal | undefined;
  /** Requests the previous run accepted and never settled (see request-journal.ts). */
  readonly interruptedAtStart: JournalEntry[] = [];
  /** Interrupted requests whose owner notice is not yet recorded as given (any earlier run). */
  readonly unnotifiedAtStart: JournalEntry[] = [];
  /** The journal could not be read: no new custody until it can (fail closed). */
  private journalUnavailable = false;

  constructor(owner: OwnerConfig | undefined, private readonly bus: WatchBus = watchBus,
    options: { now?: () => number; ownerKey?: () => string | undefined;
      /** Reads a shell/Monitor task's output tail from the live session of `sessionKey`. */
      taskOutput?: (sessionKey: string, taskId: string) => Promise<TaskOutput | undefined>;
      /** A Bash tool call's full command from the live session, by tool_use id. */
      toolCommand?: (sessionKey: string, toolUseId: string) => string | undefined;
      /** Reads a subagent's model from its transcript (the SDK's task events carry none). */
      taskModel?: (sessionKey: string, taskId: string) => Promise<string | undefined>;
      /** Durable receipts; loaded here, before any request is accepted. */
      journal?: WebRequestJournal } = {}) {
    this.taskOutput = options.taskOutput;
    this.toolCommand = options.toolCommand;
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
    this.journal = options.journal;
    if (this.journal) this.restore(this.journal);
  }
  /** Previous run's receipts: settled, deduplicated by id, never re-run. */
  private restore(journal: WebRequestJournal): void {
    let loaded;
    // Unreadable: refuse new requests rather than accept them over an empty
    // state (which could re-run a resent id, or later overwrite the file).
    try { loaded = journal.load(); } catch { this.journalUnavailable = true; return; }
    for (const entry of loaded.entries) {
      const request: WebRequest = { requestId: entry.requestId, state: entry.state, timestamp: entry.timestamp,
        ...(this.ownerId ? { sessionId: this.ownerId } : {}), ...(entry.text !== undefined ? { text: entry.text } : {}) };
      if (entry.text !== undefined) this.pendingTextBytes += Buffer.byteLength(JSON.stringify(entry.text));
      this.receipts.set(entry.requestId, { digest: entry.digest, request, settled: true });
    }
    this.interruptedAtStart.push(...loaded.interrupted);
    this.unnotifiedAtStart.push(...loaded.unnotified);
  }
  attach(lifecycle: WebLifecycle): void { this.lifecycle = lifecycle; }
  onMessage(handler: MessageHandler): void { this.handler = handler; }
  settleMessage(messageId: string, outcome: "refused" | "unknown"): void {
    const receipt = this.receipts.get(messageId);
    if (!receipt || receipt.settled) return;
    this.state(messageId, outcome);
    receipt.settled = true;
    this.clearRequestText(receipt);
  }
  onCommand(_handler: CommandHandler): void { /* No command endpoint; chat remains ordinary Agent input. */ }

  async receive(raw: MessageInput): Promise<WebRequest> {
    const parsed = messageInputSchema.safeParse(raw);
    if (!parsed.success) throw new WebError(400, "invalid_message");
    const input = parsed.data;
    if (this.closed || this.tornDown || !this.handler) throw new WebError(503, "ingress_closed");
    if (!this.ownerId || !this.owner) throw new WebError(409, "owner_setup_required");
    if (input.targetId !== undefined && input.targetId !== this.ownerId) throw new WebError(403, "owner_dm_only");
    if (this.journalUnavailable) throw new WebError(503, "journal_unavailable");
    const digest = createHash("sha256").update(input.text).digest("hex");
    const previous = this.receipts.get(input.requestId);
    if (previous) {
      if (previous.digest !== digest) throw new WebError(409, "request_id_conflict");
      return { ...previous.request };
    }
    const backlog = this.interruptedBacklog();
    if (backlog.count >= MAX_INTERRUPTED_BACKLOG || backlog.bytes > SNAPSHOT_MAILBOX_BYTES / 2) throw new WebError(503, "interrupted_backlog");
    const textBytes = Buffer.byteLength(JSON.stringify(input.text));
    if (this.pendingTextBytes + this.blockBytes + textBytes > SNAPSHOT_MAILBOX_BYTES) throw new WebError(429, "request_limit");
    if ([...this.receipts.values()].filter((r) => !r.settled).length >= 32) {
      throw new WebError(429, "request_limit");
    }
    if (this.receipts.size >= 4096) {
      const oldest = [...this.receipts].find(([, receipt]) => receipt.settled && !this.awaitingOwner(receipt));
      if (!oldest) throw new WebError(429, "request_limit");
      this.receipts.delete(oldest[0]);
    }
    const request: WebRequest = { requestId: input.requestId, state: "queued", sessionId: this.ownerId, text: input.text, timestamp: this.now(), responseTurnId: input.requestId };
    this.receipts.set(input.requestId, { digest, request, settled: false });
    this.pendingTextBytes += textBytes;
    // Durable before custody: a crash after the 202 must leave a record.
    try { this.journal?.recordReceived(input.requestId, digest, input.text, request.timestamp!); } catch {
      this.clearRequestText(this.receipts.get(input.requestId)!);
      this.receipts.delete(input.requestId);
      throw new WebError(503, "persist_failed");
    }
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
      this.clearRequestText(this.receipts.get(input.requestId)!);
      throw err instanceof WebError ? err : new WebError(503, "handoff_failed");
    } finally { this.handoffs.delete(handoff); }
  }

  request(id: string): WebRequest { return { ...(this.receipts.get(id)?.request ?? { requestId: id, state: "unknown" }) }; }
  snapshot() {
    // Unsettled requests and interrupted ones awaiting the owner always ship
    // (both bounded at admission). Then recent settled ones, so a reloaded
    // page can still label them, and interrupted ones from the last week, so
    // their history bubbles keep their badge.
    const now = this.now();
    const all = [...this.receipts.values()];
    const must = all.filter((r) => !r.settled || this.awaitingOwner(r));
    const recent = all.filter((r) => !must.includes(r) && ((r.request.timestamp ?? 0) > now - 15 * 60_000
      || (r.request.state === "interrupted" && (r.request.timestamp ?? 0) > now - 7 * 24 * 60 * 60_000)));
    const requests = [...must, ...recent.slice(-Math.max(0, 128 - must.length))]
      .sort((a, b) => (a.request.timestamp ?? 0) - (b.request.timestamp ?? 0)).map((r) => ({ ...r.request }));
    const blocks = [...this.blocks];
    const tasks = this.tasks.snapshot();
    return { epoch: this.events.epoch, cursor: this.events.cursor(), requests, blocks, tasks };
  }

  /**
   * Where the browser may read a task it was shown: only a task the panel's
   * send gate would show in `sessionId` right now. Shell and Monitor tasks
   * also return their output tail, read from the live SDK session.
   */
  async task(sessionId: string, taskId: string, output: boolean, command = false): Promise<WebTaskAccess> {
    const found = this.tasks.locate(sessionId, taskId);
    if (!found) throw new WebError(404, "task_not_found");
    const access: WebTaskAccess = { sessionKey: found.slot, taskType: found.task.taskType };
    if (command) {
      if (found.task.taskType !== "local_bash") throw new WebError(400, "no_task_command");
      // The full command, redacted on this side; the task's own description
      // (redacted, 200 characters) when the live session no longer has it.
      const toolUseId = this.tasks.toolUseOf(found.slot, taskId);
      const raw = (toolUseId && this.toolCommand?.(found.slot, toolUseId)) || undefined;
      const text = raw ? redactCommand(raw) : found.task.description;
      return { ...access, command: { text: text.slice(0, COMMAND_LIMIT), truncated: !raw || text.length > COMMAND_LIMIT } };
    }
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
    const block: Extract<WebEvent, { type: "block" }> = { type: "block", sessionId: this.ownerId,
      requestId, turnId: receipt.request.responseTurnId, id: `${requestId}:${this.blocks.length}`, text: message.text };
    const bytes = Buffer.byteLength(JSON.stringify(block));
    // The rest of the snapshot frame is reserved for receipts and the task
    // panel, whose worst case is fixed, so the snapshot never truncates it.
    if (this.blockBytes + bytes + this.pendingTextBytes > SNAPSHOT_MAILBOX_BYTES) {
      this.state(requestId, "failed");
      throw markDefiniteFailure(new Error("Web mailbox full"));
    }
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

  /** An interrupted request whose text the owner has not dealt with yet. */
  private awaitingOwner(receipt: Receipt): boolean {
    return receipt.request.state === "interrupted" && receipt.request.text !== undefined;
  }
  private interruptedBacklog(): { count: number; bytes: number } {
    let count = 0; let bytes = 0;
    for (const receipt of this.receipts.values()) {
      if (!this.awaitingOwner(receipt)) continue;
      count++; bytes += Buffer.byteLength(JSON.stringify(receipt.request.text));
    }
    return { count, bytes };
  }
  /**
   * The owner dealt with an interrupted request ("dismiss" in the browser), or
   * its message is in the transcript: its text can go. Persisted first; the
   * bubble disappears, the request still reads back as interrupted.
   */
  resolveInterrupted(requestId: string, how: Resolution): WebRequest {
    const receipt = this.receipts.get(requestId);
    if (!receipt || !this.awaitingOwner(receipt)) throw new WebError(404, "not_interrupted");
    try { this.journal?.resolve(requestId, how); } catch { throw new WebError(503, "persist_failed"); }
    this.clearRequestText(receipt);
    this.events.publish({ type: "request", request: { ...receipt.request } });
    return { ...receipt.request };
  }
  /**
   * Tell the owner's session about every interrupted request not yet
   * announced (this restart's or an earlier one's), THEN record that it was
   * told. A crash in between repeats the notice on the next start rather
   * than losing it: at least once, never silently zero.
   */
  announceInterrupted(note: (items: JournalEntry[]) => boolean): void {
    const items = this.unnotifiedAtStart.splice(0);
    if (items.length === 0) return;
    // Recorded as given only once the notice is durably queued (written and
    // fsynced). Not persisted → stays "interrupted, not notified": the next
    // start announces it again.
    if (!note(items)) return;
    try { this.journal?.markNotified(items.map((e) => e.requestId)); } catch { /* Not recorded: the next start repeats it. */ }
  }
  /** Interrupted requests (this run's restart or earlier ones) still awaiting the owner. */
  interruptedAwaiting(): string[] {
    return [...this.receipts.values()].filter((r) => this.awaitingOwner(r)).map((r) => r.request.requestId);
  }
  /** Interrupted requests whose message the transcript already has (checked at start). */
  markRecorded(requestIds: Iterable<string>): void {
    for (const id of requestIds) {
      try { this.resolveInterrupted(id, "recorded"); } catch { /* Kept: resolved later by the owner. */ }
    }
  }

  private clearRequestText(receipt: Receipt): void {
    if (receipt.request.text !== undefined) this.pendingTextBytes -= Buffer.byteLength(JSON.stringify(receipt.request.text));
    delete receipt.request.text;
  }

  private state(requestId: string, state: WebRequest["state"]): void {
    const receipt = this.receipts.get(requestId);
    if (!receipt) return;
    receipt.request.state = state;
    this.journal?.recordState(requestId, state);
    this.events.publish({ type: "request", request: { ...receipt.request } });
  }
  /** Compactions of `sessionId` seen since this daemon started, oldest first. */
  contextEvents(sessionId: string): WebCompaction[] { return [...(this.compactions.get(sessionId) ?? [])]; }
  /** The browser session id for a daemon session key, or undefined when the browser may not see it. */
  sessionIdFor(key: string): string | undefined { return this.sessionId(key); }
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
    // Session-less: a run changes the job's next / last run. Carries nothing.
    if (event.type === "cron.fired" || event.type === "cron.done") { this.events.publish({ type: "cron" }); return; }
    if (!("sessionKey" in event) || !event.sessionKey) return;
    const sessionId = this.sessionId(event.sessionKey);
    if (!sessionId) return;
    if (event.type === "turn.join") {
      const receipt = this.receipts.get(event.requestId);
      if (receipt) { receipt.request.responseTurnId = event.turnId; receipt.request.joined = true; this.state(event.requestId, "running"); }
    } else if (event.type === "turn.handoff") {
      const receipt = this.receipts.get(event.requestId);
      if (receipt && !receipt.settled) { receipt.request.handedOff = true; this.state(event.requestId, "running"); }
    } else if (event.type === "turn.requeue") {
      const receipt = this.receipts.get(event.requestId);
      if (receipt && !receipt.settled) this.state(event.requestId, "queued");
    } else if (event.type === "turn.start" && event.requestId && this.receipts.has(event.requestId)) {
      this.state(event.requestId, "running");
    } else if (event.type === "turn.end" && event.requestId) {
      // Handed to the SDK and then cut short: it may have run. Say so rather
      // than "failed", which invites a resend that could run it twice.
      if (event.uncertain) this.state(event.requestId, "unknown");
      else if (this.request(event.requestId).state !== "failed") this.state(event.requestId, event.ok ? "completed" : "failed");
      const receipt = this.receipts.get(event.requestId);
      if (receipt) { receipt.settled = true; this.clearRequestText(receipt); }
      this.blocks = this.blocks.filter((block) => block.requestId !== event.requestId);
      this.blockBytes = this.blocks.reduce((sum, block) => sum + Buffer.byteLength(JSON.stringify(block)), 0);
      this.events.publish({ type: "invalidate", sessionId });
    } else if (event.type === "compact") {
      const list = this.compactions.get(sessionId) ?? [];
      list.push({ timestamp: event.ts, ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
        ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}) });
      if (list.length > 50) list.shift();
      if (!this.compactions.has(sessionId) && this.compactions.size >= 256) this.compactions.delete(this.compactions.keys().next().value!);
      this.compactions.set(sessionId, list);
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
