import type { Channel, IncomingMessage } from "../channels/types.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { SessionResolution } from "../router.js";

export interface InboundItem {
  channel: Channel;
  message: IncomingMessage;
  /** Resolution captured at receipt time so delayed batches cannot re-route. */
  resolution: SessionResolution;
}

/**
 * The narrow surface the batcher needs from the Agent. Kept minimal so the
 * settle/coalesce state machine can be unit-tested without a full Agent.
 */
export interface InboundBatcherHost {
  /** Serialize a task on the session's FIFO queue (all ingress paths share it). */
  enqueueForSession(sessionKey: string, task: () => Promise<void>): Promise<unknown>;
  /** Hand a drained batch (1+ messages) to the turn pipeline. */
  processInboundItems(items: InboundItem[], steer?: boolean): Promise<void>;
  /** Is a live turn currently in flight on this session? (steering target check) */
  hasBusyLiveSession(sessionKey: string): boolean;
}

/**
 * Per-session inbound message batching. Messages that pile up behind an
 * in-flight turn are merged into a single follow-up turn so the agent sees
 * them together (e.g. "do X" → "wait" → "nevermind" all become one prompt).
 * iMessage additionally gets a settle window so provider-side fragments
 * coalesce before they reach the model.
 */
export class InboundBatcher {
  // Messages waiting to be coalesced into one user turn, keyed by sessionKey.
  // Drained by the next queued task; later tasks find nothing and no-op.
  private pendingBatches = new Map<string, InboundItem[]>();
  private pendingBatchSettleUntil = new Map<string, number>();
  private pendingBatchSettleStartedAt = new Map<string, number>();
  private pendingBatchDrainScheduled = new Set<string>();
  private lastImessageReceiptAt = new Map<string, number>();
  private stopping = false;

  constructor(private readonly host: InboundBatcherHost) {}

  /**
   * Shutdown: close admission and surrender everything still parked here.
   *
   * The batcher is pure memory — `pendingBatches` is a Map and nothing about
   * it is persisted — while the channel that fed it has usually already
   * acknowledged the message (imsg commits its rowid cursor the moment the
   * enqueue returns). So an item still sitting here when the process exits is
   * gone in both directions at once: never processed, and never replayed.
   * Handing it back to the caller is what lets it reach the transcript
   * instead.
   *
   * Synchronous, and it sets `stopping` before it yields anything, so the
   * sweep is one-time: a late `enqueue` is refused rather than landing in a
   * Map nobody will look at again. Clearing the settle bookkeeping also
   * releases any parked drain — `waitForBatchSettle` sees no deadline and
   * returns, and `drainPendingBatch` then finds its batch already taken.
   */
  drainForShutdown(): Map<string, InboundItem[]> {
    this.stopping = true;
    const pending = new Map<string, InboundItem[]>();
    for (const [key, items] of this.pendingBatches) {
      if (items.length > 0) pending.set(key, items);
    }
    this.pendingBatches.clear();
    this.pendingBatchSettleUntil.clear();
    this.pendingBatchSettleStartedAt.clear();
    this.pendingBatchDrainScheduled.clear();
    return pending;
  }

  /**
   * Queue a message for its session. For DMs and passive groups
   * (`canCoalesce`), messages that arrive in quick succession are coalesced
   * into one turn. Mention-required groups bypass coalescing because
   * per-message mention filtering would be lost.
   *
   * Fire-and-forget: returns as soon as the message is queued, NOT when the
   * SDK turn completes. If a caller (e.g. a channel adapter) awaits this,
   * that's fine — they don't block the next ingress on an in-flight turn,
   * which is what lets rapid messages pile up for the queue to coalesce.
   *
   * Returns whether the message was TAKEN. `false` (only past
   * `drainForShutdown`) means nothing here will ever look at it again, and the
   * answer has to travel back to the channel: a channel that reads a refusal
   * as success records its dedupe GUID and commits its cursor for a message
   * that no longer exists anywhere — acknowledged and gone at once, which is
   * the precise failure this class was changed to stop.
   */
  enqueue(
    sessionKey: string,
    channel: Channel,
    message: IncomingMessage,
    canCoalesce: boolean,
    resolution: SessionResolution,
  ): boolean {
    // Past drainForShutdown nothing here will ever run again, so accepting an
    // item would be the same silent drop this class just closed. Ingestion is
    // closed and the channels are quiesced before the drain, so reaching this
    // is already the exception — log it, and tell the caller.
    if (this.stopping) {
      log.warn(
        { sessionKey, messageId: message.id, channel: channel.name },
        "Inbound message refused: shutting down",
      );
      return false;
    }

    const receivedAt = Date.now();
    const item: InboundItem = { channel, message, resolution };

    if (!canCoalesce) {
      this.host.enqueueForSession(sessionKey, () => this.host.processInboundItems([item]))
        .catch((err) => log.error({ err, sessionKey }, "Unhandled error in message queue"));
      return true;
    }

    const batch = this.pendingBatches.get(sessionKey) ?? [];
    batch.push(item);
    this.pendingBatches.set(sessionKey, batch);

    // With steering on, the drain runs OUTSIDE the per-session queue so it
    // can inject into an in-flight turn instead of waiting behind it. The
    // settle window still applies either way (iMessage fragments must
    // coalesce before they reach the model). Without steering, queueing the
    // drain behind the in-flight turn is what coalesces rapid messages into
    // one follow-up turn.
    const steerable = config.steering;
    const dispatchDrain = (task: () => Promise<void>): void => {
      if (steerable) {
        task().catch((err) => log.error({ err, sessionKey }, "Unhandled error in message queue"));
      } else {
        this.host.enqueueForSession(sessionKey, task)
          .catch((err) => log.error({ err, sessionKey }, "Unhandled error in message queue"));
      }
    };

    const settleMs = this.settleMs(channel.name);
    const maxSettleMs = this.maxSettleMs(channel.name);
    if (channel.name === "imessage") {
      this.logImessageReceipt(sessionKey, message, receivedAt, batch.length, settleMs, maxSettleMs);
    }
    if (settleMs <= 0) {
      dispatchDrain(() => this.drainPendingBatch(sessionKey, steerable));
      return true;
    }

    const settleStartedAt = this.pendingBatchSettleStartedAt.get(sessionKey) ?? receivedAt;
    this.pendingBatchSettleStartedAt.set(sessionKey, settleStartedAt);
    const uncappedSettleUntil = receivedAt + settleMs;
    const cappedSettleUntil = maxSettleMs > 0
      ? Math.min(uncappedSettleUntil, settleStartedAt + maxSettleMs)
      : uncappedSettleUntil;
    this.pendingBatchSettleUntil.set(sessionKey, cappedSettleUntil);
    if (this.pendingBatchDrainScheduled.has(sessionKey)) return true;

    this.pendingBatchDrainScheduled.add(sessionKey);
    dispatchDrain(async () => {
      await this.waitForBatchSettle(sessionKey);
      this.pendingBatchSettleUntil.delete(sessionKey);
      this.pendingBatchSettleStartedAt.delete(sessionKey);
      this.pendingBatchDrainScheduled.delete(sessionKey);
      await this.drainPendingBatch(sessionKey, steerable);
    });
    return true;
  }

  private settleMs(channelName: string): number {
    if (channelName !== "imessage") return 0;
    const ms = config.imessageInboundSettleMs;
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  private maxSettleMs(channelName: string): number {
    if (channelName !== "imessage") return 0;
    const ms = config.imessageInboundMaxSettleMs;
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  private logImessageReceipt(
    sessionKey: string,
    message: IncomingMessage,
    receivedAt: number,
    batchSize: number,
    settleMs: number,
    maxSettleMs: number,
  ): void {
    const previousReceivedAt = this.lastImessageReceiptAt.get(sessionKey);
    this.lastImessageReceiptAt.set(sessionKey, receivedAt);

    const providerLagMs = Number.isFinite(message.timestamp) ? receivedAt - message.timestamp : undefined;
    log.debug({
      sessionKey,
      messageId: message.id,
      receivedAt,
      receivedAtIso: new Date(receivedAt).toISOString(),
      providerTimestamp: message.timestamp,
      providerLagMs,
      interReceiptMs: previousReceivedAt === undefined ? undefined : receivedAt - previousReceivedAt,
      batchSize,
      settleMs,
      maxSettleMs: maxSettleMs > 0 ? maxSettleMs : undefined,
    }, "iMessage inbound fragment received");
  }

  private async waitForBatchSettle(sessionKey: string): Promise<void> {
    while (true) {
      const settleUntil = this.pendingBatchSettleUntil.get(sessionKey);
      if (!settleUntil) return;

      const delay = settleUntil - Date.now();
      if (delay <= 0) return;

      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  private async drainPendingBatch(sessionKey: string, steerable = false): Promise<void> {
    const items = this.pendingBatches.get(sessionKey);
    if (!items || items.length === 0) return;
    this.pendingBatches.delete(sessionKey);

    if (items.length > 1) {
      log.info(
        { sessionKey, count: items.length },
        `Coalescing ${items.length} queued messages into one turn`,
      );
    }

    if (steerable) {
      if (this.host.hasBusyLiveSession(sessionKey)) {
        await this.host.processInboundItems(items, true);
        return;
      }
      // No turn in flight — process through the ordinary per-session queue.
      this.host.enqueueForSession(sessionKey, () => this.host.processInboundItems(items))
        .catch((err) => log.error({ err, sessionKey }, "Unhandled error in message queue"));
      return;
    }

    await this.host.processInboundItems(items);
  }
}
