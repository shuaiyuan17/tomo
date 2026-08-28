import type { Channel, IncomingMessage, StopTyping } from "../channels/types.js";
import { log } from "../logger.js";
import { watchBus } from "../watch/bus.js";
import type { TurnSource } from "../watch/protocol.js";
import { STEER_MERGED } from "./live-session.js";
import { endsWithTrailingNoReply, isSilentReply, stripTrailingNoReply } from "./text-utils.js";
import { type BlockSender, DeliveryPipeline, isAgentErrorResponse } from "./delivery-pipeline.js";

/** Request shape for the host's runWithRetry (LiveSession send/steer + retry). */
export interface RunWithRetryRequest {
  key: string;
  prompt: string;
  images?: Array<{ data: string; mediaType: string }>;
  documents?: Array<{ data: string; mediaType: string; filename?: string }>;
  steer?: boolean;
  /** Receives ONE completed delivery unit the moment the SDK closes it —
   *  while the turn is still running, not after it ends (LiveSession's
   *  TurnRequest.onBlock). Awaited, so blocks ship in model order. */
  onBlock?: (block: string) => Promise<void>;
  /**
   * True once `onBlock` has ATTEMPTED a send. Delivery is irreversible: there
   * is no unsend, so a turn that has already put a block on the owner's phone
   * must not be re-run from the top on a recoverable session error. The host's
   * retry consults this before resuming (see LiveSessionManager.runWithRetry).
   */
  hasShipped?: () => boolean;
}

/**
 * Silent-reply checks. User and production send/deferred-send turns match the
 * bare token only; send/deferred-send turns strip trailing bare NO_REPLY blocks
 * before applying their matcher. The embedded matcher is retained for callers
 * that deliberately want legacy substring suppression.
 */
/**
 * Prefix for a transcript entry whose send threw. The block was composed and
 * attempted but is not known to have reached the owner, so recall must not
 * read it back as something he was told.
 */
export const DELIVERY_FAILED_MARKER = "[delivery failed] ";

export const bareSilentMatcher = isSilentReply;
export function embeddedSilentMatcher(response: string): boolean {
  return isSilentReply(response) || response.includes("NO_REPLY");
}

/**
 * Delivery back to the chat the turn came from (user turns). Carries the
 * turn's inbound attachments and its reply-threading target.
 */
export interface ReplyTurnDelivery {
  kind: "reply";
  channel: Channel;
  chatId: string;
  replyToMessageId?: string;
  images?: IncomingMessage["images"];
  documents?: IncomingMessage["documents"];
  /** Steer into the session's in-flight turn instead of queueing one. */
  steer?: boolean;
}

/** Delivery to a target resolved before the turn (cron turns). */
export interface SendTurnDelivery {
  kind: "send";
  channel: Channel;
  chatId: string;
  /** The turn still runs (housekeeping tools complete) but its model output
   *  never reaches the chat. */
  suppressDelivery?: boolean;
  /** log.info message when suppressed output is dropped. */
  suppressedLog?: string;
}

/** Delivery whose target is resolved only after a non-silent, non-error
 *  response (continuity turns). */
export interface DeferredSendTurnDelivery {
  kind: "deferred-send";
  resolveTarget(): { channel: Channel; chatId: string } | undefined;
}

export type TurnDelivery = ReplyTurnDelivery | SendTurnDelivery | DeferredSendTurnDelivery;

export interface TurnErrorPolicy {
  /** Prefix for pending error notes and user-visible error messages,
   *  e.g. "[error] " or "[error] cron failed: ". */
  visiblePrefix: string;
  /** Agent-error RESPONSE handling. "deliver" sends the visible error to the
   *  chat; "note-only" only queues the pending error note. */
  response: "deliver" | "note-only";
  /** log.warn message when a response error is kept out of the chat. */
  responseSuppressedLog?: string;
  /** Thrown-error handling. "deliver": queue a pending error note and send
   *  the visible error. "note-only": queue the note, nothing user-visible.
   *  "ignore": logged only. */
  thrown: "deliver" | "note-only" | "ignore";
  /** log.warn message when a thrown error is kept out of the chat. */
  thrownSuppressedLog?: string;
  /** log.error message for thrown errors. */
  thrownLogMessage: string;
}

export interface TurnSpec {
  key: string;
  /** Ingress path label for observability (watch feed turn events). */
  source: TurnSource;
  /** Prompt body; pending notes are always drained in front of it. */
  prompt: string;
  /** Channel label for the timestamp stamp. When undefined the prompt is sent
   *  unstamped (continuity turns). */
  stampChannelName?: string;
  /** Typing indicator for the turn; absent → no indicator. */
  typing?: { channel: Channel; chatId: string; passiveListen?: boolean };
  delivery: TurnDelivery;
  /** How a response counts as silent (see the exported matchers). */
  silentMatcher: (response: string) => boolean;
  /** log.info message when a silent response skips delivery (send turns). */
  silentLog?: string;
  /** Transcript policy: "always" appends any response, even silent or error
   *  text (user turns); "on-delivery" appends only responses actually sent to
   *  the chat (cron and continuity turns). Every delivered message must be
   *  recorded — an unrecorded delivery is invisible to recall_conversation
   *  (#203). */
  transcript: "always" | "on-delivery";
  errors: TurnErrorPolicy;
}

/**
 * The narrow surface the turn pipeline needs from the Agent. Session/router
 * specifics (target resolution, group detection, steering promotion) stay in
 * the spec builders; this interface is only the shared plumbing.
 */
export interface TurnRunnerDeps {
  drainPendingNotes(sessionKey: string): string;
  runWithRetry(req: RunWithRetryRequest): Promise<string>;
  /** Append an assistant response to the session transcript. */
  appendAssistantTranscript(sessionKey: string, content: string, channelName: string): void;
  queuePendingErrorNote(sessionKey: string, visibleError: string): void;
  /** Typing indicator with per-channel start delay (Agent.startTurnTyping). */
  startTurnTyping(channel: Channel, chatId: string, passiveListen?: boolean): StopTyping;
  delivery: DeliveryPipeline;
}

/** Prefix `[<channel> · <weekday> <mm/dd> <hh:mm> <tz>]` onto a prompt. */
export function injectTimestamp(text: string, channelName?: string): string {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const date = `${mm}/${dd}`;
  const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const tz = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  const prefix = channelName ? `${channelName} · ` : "";
  return `[${prefix}${weekday} ${date} ${time} ${tz}] ${text}`;
}

/**
 * Shared turn pipeline for all three owned-turn ingress paths (user, cron,
 * continuity): drain pending notes → stamp → query via runWithRetry →
 * classify response → transcript → deliver → stop typing → error handling.
 * Policy differences between the paths live in the TurnSpec, built by the
 * Agent's thin per-path entry points.
 */
export class TurnRunner {
  constructor(private readonly deps: TurnRunnerDeps) {}

  /**
   * Run one turn end to end. Resolves true when the turn ran cleanly, false
   * when it errored — errors are fully handled here (logged, surfaced to the
   * chat where the spec allows), so the boolean is a status report for
   * callers like CronScheduler.markRun. Never rejects.
   */
  async runTurn(spec: TurnSpec): Promise<boolean> {
    const stopTyping: StopTyping = spec.typing
      ? this.deps.startTurnTyping(spec.typing.channel, spec.typing.chatId, spec.typing.passiveListen ?? false)
      : async () => {};

    const startedAt = Date.now();
    watchBus.publish({ type: "turn.start", sessionKey: spec.key, source: spec.source });
    let ok = false;
    try {
      const prompt = this.deps.drainPendingNotes(spec.key)
        + (spec.stampChannelName !== undefined
          ? injectTimestamp(spec.prompt, spec.stampChannelName)
          : spec.prompt);

      ok = await this.runDelivery(spec, prompt, stopTyping);
      return ok;
    } catch (err) {
      ok = await this.handleThrownError(spec, err, stopTyping);
      return ok;
    } finally {
      watchBus.publish({
        type: "turn.end",
        sessionKey: spec.key,
        source: spec.source,
        ok,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Run the turn, shipping each completed block as it arrives.
   *
   * Every ingress (user, cron, continuity, background) uses the same sink, so
   * a proactive send, a cron run and an owner reply all reach the channel the
   * same way. What is left for after the turn is only what genuinely needs the
   * whole response: the transcript, the log line, silence and error policy.
   */
  private async runDelivery(
    spec: TurnSpec,
    prompt: string,
    stopTyping: StopTyping,
  ): Promise<boolean> {
    const delivery = spec.delivery;
    const reply = delivery.kind === "reply" ? delivery : undefined;

    const sink = this.makeBlockSink(spec);
    const rawResponse = await this.deps.runWithRetry({
      key: spec.key,
      prompt,
      onBlock: sink.onBlock,
      hasShipped: sink.hasShipped,
      ...(reply
        ? { images: reply.images, documents: reply.documents, steer: reply.steer }
        : {}),
    });

    if (reply?.steer && rawResponse === STEER_MERGED) {
      // Steered message merged into the in-flight turn — that turn's owner
      // records and delivers the combined reply; nothing to deliver here.
      await stopTyping({ clear: true });
      return true;
    }

    // The scaffold-leak filter already ran PER BLOCK in renderBlock, as each
    // block shipped — running it here over the joined response would cut every
    // later block at the first leaked marker.
    const response = rawResponse;
    // One response log per turn, whatever the ingress and whether or not the
    // response ships (silent and suppressed turns still get a line). The
    // channel label comes from the delivery spec, never from resolveTarget —
    // deferred-send turns must not resolve a target for a response that is
    // about to be suppressed.
    const logChannel = delivery.kind === "deferred-send" ? undefined : delivery.channel.name;
    log.info({ channel: logChannel, session: spec.key }, "Tomo: %s", response);

    // Trailing bare-NO_REPLY line(s) silence the ENTIRE response by design
    // (owner decision 2026-07-08): the agent narrates housekeeping turns and
    // ends with NO_REPLY, and that narration is not for the channel. Only
    // trailing lines are inspected, so prose that merely *mentions* NO_REPLY
    // mid-line still delivers — that's all that remains of the #222
    // protection. The accepted tradeoff: a substantive reply that erroneously
    // ends with a bare NO_REPLY line is eaten whole; the agent's contract is
    // to never end a real reply with the token. `response` (unstripped) still
    // drives the error checks below so they see the model's literal output.
    const { visible: deliverText, hadTrailingNoReply } = stripTrailingNoReply(response);
    const silent = hadTrailingNoReply || deliverText.length === 0 || spec.silentMatcher(deliverText);

    // "always" records the model's literal output even when it never ships
    // (user turns keep silent and error text in the transcript); "on-delivery"
    // records only what actually reached the chat (#203).
    if (spec.transcript === "always" && reply) {
      this.deps.appendAssistantTranscript(spec.key, response, reply.channel.name);
    }

    if (isAgentErrorResponse(response)) {
      const visibleError = `${spec.errors.visiblePrefix}${response}`;
      this.deps.queuePendingErrorNote(spec.key, visibleError);
      if (spec.errors.response === "note-only") {
        if (spec.errors.responseSuppressedLog) {
          log.warn({ sessionKey: spec.key }, spec.errors.responseSuppressedLog);
        }
        await stopTyping({ clear: true });
        return false;
      }
      const target = this.resolveSendTarget(delivery);
      if (target) await target.channel.send({ chatId: target.chatId, text: visibleError });
      await stopTyping({ clear: true });
      return false;
    }

    if (delivery.kind === "send" && delivery.suppressDelivery) {
      if (delivery.suppressedLog) log.info({ sessionKey: spec.key }, delivery.suppressedLog);
      await stopTyping({ clear: true });
      return true;
    }

    if (silent) {
      log.info(spec.silentLog ?? "Silent reply (no message sent)");
      await stopTyping({ clear: true });
      return true;
    }

    // A model turn has already shipped, block by block. What reaches here
    // unhandled is a FABRICATED response — LiveSessionManager's "I ran out of
    // steps trying to complete that." and friends — which never produced
    // content blocks and so never reached the sink.
    if (!sink.handledAny()) {
      const target = this.resolveSendTarget(delivery);
      if (target) {
        if (spec.transcript === "on-delivery") {
          this.deps.appendAssistantTranscript(spec.key, deliverText, target.channel.name);
        }
        await this.deps.delivery.deliverResponse(
          spec.key,
          target.channel,
          target.chatId,
          deliverText,
          spec.silentMatcher,
          reply?.replyToMessageId ? { replyTo: reply.replyToMessageId } : {},
        );
      }
    }
    await stopTyping({ clear: true });
    return true;
  }

  /**
   * The turn's outbound sink: one completed block in, at most one channel
   * message out, immediately.
   *
   * TRAILING NO_REPLY, DECIDED (2026-08-28). Under end-of-turn delivery a
   * trailing bare `NO_REPLY` suppressed the ENTIRE turn, earlier blocks
   * included. Mid-turn that is not expressible — those blocks are already on
   * the owner's phone, and a sent message cannot be recalled. The alternative
   * was to hold the last block back until `result` so a trailing NO_REPLY
   * could still cancel it; that was rejected because the final block is
   * precisely the one the owner is waiting for, and holding it would reinstate
   * the end-of-turn latency this change exists to remove — for every turn, to
   * salvage a rare one. It would not even have saved the reported cron repro,
   * where the narration is an EARLIER block than the token.
   *
   * So: a bare-NO_REPLY block suppresses ONLY ITSELF. The invariant that
   * matters (owner decision 2026-07-08) still holds exactly, per block — a
   * block whose trailing line is bare NO_REPLY ships nothing, its MEDIA: and
   * STICKER: attachments included. A whole turn that is only NO_REPLY still
   * sends nothing, because its one block sends nothing.
   *
   * Consequence worth naming: a cron turn that narrates in an early block and
   * ends with NO_REPLY now delivers that early block. Turns that must stay
   * silent whatever the model writes should use `suppressDelivery`, which is
   * honoured here and does not depend on the model's cooperation.
   */
  private makeBlockSink(spec: TurnSpec): {
    onBlock: (block: string) => Promise<void>;
    handledAny: () => boolean;
    hasShipped: () => boolean;
  } {
    const delivery = spec.delivery;
    const reply = delivery.kind === "reply" ? delivery : undefined;
    const suppressed = delivery.kind === "send" && delivery.suppressDelivery === true;

    // "This turn's output was the sink's job", not "bytes left the machine" —
    // a block whose MEDIA: path is missing legitimately sends nothing. Set
    // BEFORE the send so a channel failure cannot make the post-turn fallback
    // re-deliver the whole response on top of blocks that already landed.
    let handledAny = false;
    // "A send was ATTEMPTED against the channel" — the irreversible bit. Once
    // true the turn can never be retried from the top, because a retry would
    // regenerate and re-send blocks the owner may already be holding.
    let shipped = false;
    // Resolved lazily, on the first block that actually ships. Continuity
    // turns resolve their target only for a response that speaks, and an
    // unresolvable target must not be reported for a turn that stays silent.
    let sender: BlockSender | undefined;
    let channelName: string | undefined;

    const onBlock = async (block: string): Promise<void> => {
      if (suppressed) return;
      // Classified on the model's literal words, then handled once, after the
      // turn, by the spec's error policy — never shipped as if it were a reply.
      if (isAgentErrorResponse(block)) return;
      // The 2026-07-08 invariant, per block: text and attachments together.
      if (endsWithTrailingNoReply(block)) return;
      if (spec.silentMatcher(block)) return;

      if (!sender) {
        const target = this.resolveSendTarget(delivery);
        if (!target) return;
        channelName = target.channel.name;
        sender = this.deps.delivery.createBlockSender(
          target.channel,
          target.chatId,
          reply?.replyToMessageId ? { replyTo: reply.replyToMessageId } : {},
        );
      }

      handledAny = true;
      // Set BEFORE the await, not after: an ambiguous send failure (timeout,
      // bridge child death) may already have put this block on the owner's
      // phone. Anything that keys off "did this turn ship" must treat an
      // attempted send as shipped — see LiveSessionManager's no-retry-after-
      // ship rule, where guessing wrong means a duplicate message.
      shipped = true;
      try {
        await sender.deliver(block);
        // Every delivered message must be recorded, or it is invisible to
        // recall_conversation (#203). "always" records the turn's literal
        // response instead, once, after the turn.
        //
        // Recorded AFTER the send resolves, never before. Writing on intent
        // made the transcript claim deliveries that never happened: in an
        // A-succeeds / B-throws turn the owner had only A on his phone while
        // the transcript showed both, so recall_conversation would later
        // "remember" telling him something he never received.
        if (spec.transcript === "on-delivery" && channelName) {
          this.deps.appendAssistantTranscript(spec.key, block, channelName);
        }
      } catch (err) {
        // KNOWN LIMITATION — ambiguous-failure reordering. A throw here is
        // swallowed so a dead channel cannot abort a turn that is still doing
        // useful work; the turn continues and the NEXT block ships normally.
        // But an iMessage send that fails ambiguously (timeout, bridge child
        // death — see channels/imessage-imsg.ts, the `ImsgRpcResponseError`
        // discrimination around the rich-send fallback) may ALREADY have
        // dispatched. If block A times out and block B then sends cleanly, a
        // late-arriving A can land on the phone AFTER B — the owner reads them
        // out of model order. Only the channel can fix this properly (an
        // idempotent send with a dispatch receipt); until then we prefer a
        // possibly-reordered pair over a turn that dies on one bad send.
        log.error({ err, sessionKey: spec.key }, "Block delivery failed");
        // Still recorded, but MARKED. Dropping it would lose the fact that the
        // turn composed this text at all; recording it clean would assert a
        // delivery that did not happen. The marker is also the honest answer
        // for an ambiguous failure, which may or may not have landed.
        if (spec.transcript === "on-delivery" && channelName) {
          this.deps.appendAssistantTranscript(spec.key, `${DELIVERY_FAILED_MARKER}${block}`, channelName);
        }
      }
    };

    return { onBlock, handledAny: () => handledAny, hasShipped: () => shipped };
  }

  private async handleThrownError(spec: TurnSpec, err: unknown, stopTyping: StopTyping): Promise<boolean> {
    log.error({ err }, spec.errors.thrownLogMessage);

    if (spec.errors.thrown === "ignore") {
      await stopTyping({ clear: true });
      return false;
    }

    const detail = err instanceof Error ? err.message : String(err);
    const visibleError = `${spec.errors.visiblePrefix}${detail}`;
    this.deps.queuePendingErrorNote(spec.key, visibleError);

    if (spec.errors.thrown === "note-only") {
      if (spec.errors.thrownSuppressedLog) {
        log.warn({ sessionKey: spec.key }, spec.errors.thrownSuppressedLog);
      }
      await stopTyping({ clear: true });
      return false;
    }

    const target = this.resolveSendTarget(spec.delivery);
    try {
      if (target) await target.channel.send({ chatId: target.chatId, text: visibleError });
    } finally {
      await stopTyping({ clear: true });
    }
    return false;
  }

  private resolveSendTarget(delivery: TurnDelivery): { channel: Channel; chatId: string } | undefined {
    return delivery.kind === "deferred-send" ? delivery.resolveTarget() : delivery;
  }
}
