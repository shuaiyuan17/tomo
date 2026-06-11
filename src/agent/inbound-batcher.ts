import type { Channel, IncomingMessage } from "../channels/types.js";
import { config } from "../config.js";
import { log } from "../logger.js";

export interface InboundItem {
  channel: Channel;
  message: IncomingMessage;
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

  constructor(private readonly host: InboundBatcherHost) {}

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
   */
  enqueue(sessionKey: string, channel: Channel, message: IncomingMessage, canCoalesce: boolean): void {
    const receivedAt = Date.now();

    if (!canCoalesce) {
      this.host.enqueueForSession(sessionKey, () => this.host.processInboundItems([{ channel, message }]))
        .catch((err) => log.error({ err, sessionKey }, "Unhandled error in message queue"));
      return;
    }

    const batch = this.pendingBatches.get(sessionKey) ?? [];
    batch.push({ channel, message });
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
      return;
    }

    const settleStartedAt = this.pendingBatchSettleStartedAt.get(sessionKey) ?? receivedAt;
    this.pendingBatchSettleStartedAt.set(sessionKey, settleStartedAt);
    const uncappedSettleUntil = receivedAt + settleMs;
    const cappedSettleUntil = maxSettleMs > 0
      ? Math.min(uncappedSettleUntil, settleStartedAt + maxSettleMs)
      : uncappedSettleUntil;
    this.pendingBatchSettleUntil.set(sessionKey, cappedSettleUntil);
    if (this.pendingBatchDrainScheduled.has(sessionKey)) return;

    this.pendingBatchDrainScheduled.add(sessionKey);
    dispatchDrain(async () => {
      await this.waitForBatchSettle(sessionKey);
      this.pendingBatchSettleUntil.delete(sessionKey);
      this.pendingBatchSettleStartedAt.delete(sessionKey);
      this.pendingBatchDrainScheduled.delete(sessionKey);
      await this.drainPendingBatch(sessionKey, steerable);
    });
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
