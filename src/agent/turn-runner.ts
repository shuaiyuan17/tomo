import type { Channel, IncomingMessage, StopTyping } from "../channels/types.js";
import { log } from "../logger.js";
import { watchBus } from "../watch/bus.js";
import type { TurnSource } from "../watch/protocol.js";
import { STEER_MERGED } from "./live-session.js";
import { isSilentReply, stripTrailingNoReply } from "./text-utils.js";
import { DeliveryPipeline, isAgentErrorResponse } from "./delivery-pipeline.js";

/** Request shape for the host's runWithRetry (LiveSession send/steer + retry). */
export interface RunWithRetryRequest {
  key: string;
  prompt: string;
  images?: Array<{ data: string; mediaType: string }>;
  documents?: Array<{ data: string; mediaType: string; filename?: string }>;
  steer?: boolean;
  /** Receives the turn's per-block delivery units just before the response
   *  string resolves (see LiveSession's TurnRequest.onBlocks). */
  onResponseBlocks?: (blocks: string[]) => void;
}

/**
 * Silent-reply checks. User and production send/deferred-send turns match the
 * bare token only; send/deferred-send turns strip trailing bare NO_REPLY blocks
 * before applying their matcher. The embedded matcher is retained for callers
 * that deliberately want legacy substring suppression.
 */
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
   * Run the turn, then deliver its response once. There is no per-block or
   * per-token path: every ingress (user, cron, continuity) waits for the turn
   * to complete and ships the rendered response as one reply.
   */
  private async runDelivery(
    spec: TurnSpec,
    prompt: string,
    stopTyping: StopTyping,
  ): Promise<boolean> {
    const delivery = spec.delivery;
    const reply = delivery.kind === "reply" ? delivery : undefined;

    // The delivery units of the turn, in order. Attachment placement is
    // defined per block ("A, MEDIA:, B" ships A → photo → B), and the joined
    // response string cannot be re-split, so LiveSession hands them over here.
    let responseBlocks: string[] | undefined;
    const rawResponse = await this.deps.runWithRetry({
      key: spec.key,
      prompt,
      onResponseBlocks: (blocks) => { responseBlocks = blocks; },
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

    // The scaffold-leak filter runs PER BLOCK in renderResponseBlocks, before
    // the join — running it here over the joined response would cut every
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
        {
          ...(reply?.replyToMessageId ? { replyTo: reply.replyToMessageId } : {}),
          ...(responseBlocks ? { blocks: responseBlocks } : {}),
        },
      );
    }
    await stopTyping({ clear: true });
    return true;
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
