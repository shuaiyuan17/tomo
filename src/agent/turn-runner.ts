import type { Channel, IncomingMessage, StopTyping } from "../channels/types.js";
import { log } from "../logger.js";
import { STEER_MERGED } from "./live-session.js";
import { ATTACHMENT_TAG_RE, isSilentReply } from "./text-utils.js";
import { DeliveryPipeline, isAgentErrorResponse } from "./delivery-pipeline.js";

/** Request shape for the host's runWithRetry (LiveSession send/steer + retry). */
export interface RunWithRetryRequest {
  key: string;
  prompt: string;
  onText?: (text: string) => void;
  images?: Array<{ data: string; mediaType: string }>;
  onBlockComplete?: (text: string) => void | Promise<void>;
  documents?: Array<{ data: string; mediaType: string; filename?: string }>;
  steer?: boolean;
}

/**
 * The two silent-reply checks in use. User turns match the bare token only;
 * cron and continuity turns additionally treat any response CONTAINING
 * NO_REPLY as silent (multi-turn responses may emit NO_REPLY after earlier
 * text output). The mismatch is a known inconsistency preserved deliberately
 * — tightening the substring check to line-anchored is an owner decision.
 */
export const bareSilentMatcher = isSilentReply;
export function embeddedSilentMatcher(response: string): boolean {
  return isSilentReply(response) || response.includes("NO_REPLY");
}

/** Streamed delivery with per-block handling (user turns). */
export interface StreamTurnDelivery {
  kind: "stream";
  channel: Channel;
  chatId: string;
  replyToMessageId?: string;
  images?: IncomingMessage["images"];
  documents?: IncomingMessage["documents"];
  /** Steer into the session's in-flight turn instead of queueing one. */
  steer?: boolean;
}

/** Non-streaming delivery to a target resolved before the turn (cron turns). */
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

/** Non-streaming delivery whose target is resolved only after a non-silent,
 *  non-error response (continuity turns). */
export interface DeferredSendTurnDelivery {
  kind: "deferred-send";
  resolveTarget(): { channel: Channel; chatId: string } | undefined;
}

export type TurnDelivery = StreamTurnDelivery | SendTurnDelivery | DeferredSendTurnDelivery;

export interface TurnErrorPolicy {
  /** Prefix for pending error notes and user-visible error messages,
   *  e.g. "[error] " or "[error] cron failed: ". */
  visiblePrefix: string;
  /** Agent-error RESPONSE handling on send/deferred-send turns. "deliver"
   *  sends the visible error to the chat; "note-only" only queues the pending
   *  error note. Stream turns ignore this — DeliveryPipeline.deliverResponse
   *  owns their error handling. */
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
   *  the chat (cron turns); "never" skips the transcript (continuity turns). */
  transcript: "always" | "on-delivery" | "never";
  /** Response logging for non-streaming turns (stream turns log inside
   *  DeliveryPipeline.deliverResponse). */
  logResponse?: (response: string) => void;
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

    try {
      const prompt = this.deps.drainPendingNotes(spec.key)
        + (spec.stampChannelName !== undefined
          ? injectTimestamp(spec.prompt, spec.stampChannelName)
          : spec.prompt);

      if (spec.delivery.kind === "stream") {
        return await this.runStreamTurn(spec, spec.delivery, prompt, stopTyping);
      }
      return await this.runSendTurn(spec, spec.delivery, prompt, stopTyping);
    } catch (err) {
      return this.handleThrownError(spec, err, stopTyping);
    }
  }

  private async runStreamTurn(
    spec: TurnSpec,
    delivery: StreamTurnDelivery,
    prompt: string,
    stopTyping: StopTyping,
  ): Promise<boolean> {
    const stream = delivery.channel.createStreamingMessage(delivery.chatId, delivery.replyToMessageId);
    const response = await this.deps.runWithRetry({
      key: spec.key,
      prompt,
      onText: (text) => stream.update(text.replace(ATTACHMENT_TAG_RE, "").trim()),
      images: delivery.images,
      onBlockComplete: this.deps.delivery.makeBlockHandler(delivery.channel, delivery.chatId, stream),
      documents: delivery.documents,
      steer: delivery.steer,
    });

    if (delivery.steer && response === STEER_MERGED) {
      // Steered message merged into the in-flight turn — that turn's owner
      // streams and records the combined reply; nothing to deliver here.
      await stopTyping({ clear: true });
      await stream.cancel();
      return true;
    }

    if (spec.transcript === "always") {
      this.deps.appendAssistantTranscript(spec.key, response, delivery.channel.name);
    }

    await this.deps.delivery.deliverResponse(
      spec.key,
      delivery.channel,
      delivery.chatId,
      response,
      stream,
      spec.silentMatcher,
    );
    await stopTyping({ clear: true });
    return true;
  }

  private async runSendTurn(
    spec: TurnSpec,
    delivery: SendTurnDelivery | DeferredSendTurnDelivery,
    prompt: string,
    stopTyping: StopTyping,
  ): Promise<boolean> {
    const response = await this.deps.runWithRetry({ key: spec.key, prompt });
    const silent = spec.silentMatcher(response);
    spec.logResponse?.(response);

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
      if (spec.silentLog) log.info(spec.silentLog);
      await stopTyping({ clear: true });
      return true;
    }

    const target = this.resolveSendTarget(delivery);
    if (target) {
      if (spec.transcript !== "never") {
        this.deps.appendAssistantTranscript(spec.key, response, target.channel.name);
      }
      await this.deps.delivery.deliverAssistantContent(target.channel, target.chatId, response);
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
