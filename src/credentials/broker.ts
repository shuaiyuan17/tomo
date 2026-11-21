import { joinText, ownerT, type OwnerT, type OwnerText } from "../i18n/index.js";
import { randomUUID } from "node:crypto";
import type { Channel, IncomingMessage } from "../channels/types.js";
import { isDefiniteFailure } from "../channels/types.js";
import { log } from "../logger.js";
import { isCredentialName, keychainReadCommand, secretRefFor } from "./names.js";
import { markRedactionNotReady, markRedactionReady, MIN_SECRET_LENGTH, redactionReady, registerSecretValue, scrubKnownSecrets } from "./redactor.js";
import { isStorableValue } from "./store.js";
import type { BrokerState, BrokerStateFile, CredentialBackend, PendingRequest } from "./store.js";

export const CREDENTIAL_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** Allowance for clock differences when judging a message's send time. */
const WINDOW_SLACK_MS = 2 * 60_000;
export const MAX_SECRET_LENGTH = 8192;
const MAX_PURPOSE_LENGTH = 200;
const CANCEL_WORDS = new Set(["cancel", "取消"]);
/** Where an owner's typed message can carry a value. The web UI's chat never
 *  does: its value comes through the card (`fulfill`), not a chat message. */
const CHAT_CHANNELS = ["imessage", "telegram"] as const;

/** What the owner is shown about a request. Never carries a value. */
export interface CredentialRequestView {
  id: string;
  name: string;
  purpose: string;
  expiresAt: number;
}

/** The chat a turn came in on: where a request made on that turn is asked. */
export interface CredentialOrigin {
  channelName: string;
  chatId: string;
}

/**
 * One way of asking the owner for a value. `message`: the owner's next typed
 * message in their private chat on this channel is the value (iMessage,
 * Telegram). `form`: the value arrives through `CredentialBroker.fulfill`, from
 * a password card the channel shows (the web UI).
 */
export interface CaptureChannel {
  readonly name: string;
  readonly kind: "message" | "form";
  /** Show the request: `prompt` is the chat text; a form shows `view`. Throws
   *  like `Channel.send`, so a definite failure closes the request. */
  open(view: CredentialRequestView, prompt: OwnerText): Promise<void>;
  /** The request ended, however it ended. A form withdraws its card. */
  close(): void;
  /** Tell the owner something on this channel. Never throws. */
  notify(text: OwnerText): Promise<void>;
}

export interface BrokerDeps {
  backend: CredentialBackend;
  stateFile: BrokerStateFile;
  isOwnerSender(channelName: string, senderId: string | undefined): boolean;
  /** The capture channel for a chat, or null when that channel cannot ask. */
  captureChannel(origin: CredentialOrigin): CaptureChannel | null;
  /** Tell a session's model how a request ended. Never carries a value. */
  notifySession(sessionKey: string, body: string): void;
  /** A notice for the owner that needs no model turn (agent.sendNotification). */
  notifyOwner?(text: OwnerText): void;
  now?: () => number;
  timeoutMs?: number;
}

export type RequestResult =
  | { ok: true; ref: string; expiresAt: number; channel: string; note?: string }
  | { ok: false; error: string };

/** The web card's answer. `status` is the HTTP status the route answers with. */
export type FulfillResult =
  | { ok: true; outcome: "stored" | "cancelled" }
  | { ok: false; status: 400 | 409 | 410 | 503; code: string };

export type FulfillInput = { value: string } | { cancel: true };

/**
 * Keeps a credential the owner sends on request away from the model.
 *
 * A request is asked on the channel the turn came in on: iMessage or Telegram
 * take the owner's next typed message in that private chat; the web UI shows a
 * password card whose value comes through `fulfill`, outside `/messages`.
 *
 * `handleInbound` runs at the top of `Agent.enqueueMessage`, before routing, the
 * transcript and the first log line that prints message text. When in doubt it
 * swallows a chat message: a false capture costs the owner a repeated sentence
 * and they are told, while a false pass is permanent. So a reply racing the
 * prompt is captured; while a request is open, owner messages on the OTHER chat
 * channels are dropped (one may be the value); and if the state file cannot be
 * read, the chat channels it still names a request for are held back until it
 * can. The web UI's chat is never held or dropped: a value never arrives there.
 */
export class CredentialBroker {
  private state: BrokerState = { names: [], pending: null, closedWindows: [], consumedIds: [] };
  /** Set while the state file cannot be trusted: the chat channels held back. */
  private held: Set<string> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The owner was told redaction is not ready (once per outage). */
  private redactionAlerted = false;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: BrokerDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? CREDENTIAL_REQUEST_TIMEOUT_MS;
    this.loadState();
  }

  /** Reads the state file. Returns false, locked down, if it cannot be trusted. */
  private loadState(): boolean {
    try {
      this.state = this.deps.stateFile.load();
    } catch {
      const salvaged = this.deps.stateFile.salvageChannels(this.now(), WINDOW_SLACK_MS);
      const held = new Set((salvaged ?? CHAT_CHANNELS).filter((c) => (CHAT_CHANNELS as readonly string[]).includes(c)));
      if (!this.held) {
        log.error({ held: [...held] }, "Credential broker state is unreadable; holding back the owner's messages on the channels it names until it is repaired");
      }
      this.held = held;
      return false;
    }
    this.held = null;
    const pending = this.state.pending;
    if (pending && pending.expiresAt <= this.now()) this.closeWindow(pending);
    else if (pending) this.armTimer(pending.expiresAt - this.now());
    return true;
  }

  /**
   * So a value still in a running child or a file is scrubbed after a restart.
   * True when every stored value is known to the redactor. On failure (state
   * unreadable, keychain unavailable) the redactor is marked not ready: the
   * PostToolUse hook retries this with backoff and, meanwhile, withholds every
   * tool output. The owner is told once.
   */
  async primeRedaction(): Promise<boolean> {
    if (this.held) this.loadState();
    let ok = !this.held;
    if (ok) {
      for (const name of this.state.names) {
        try {
          const value = await this.deps.backend.get(name);
          if (value !== null) registerSecretValue(value, name);
        } catch {
          ok = false;
          log.warn({ name }, "Could not load a credential for redaction");
        }
      }
    }
    if (ok) {
      if (!redactionReady()) log.info("Credential redaction is ready again");
      markRedactionReady();
      this.redactionAlerted = false;
      return true;
    }
    markRedactionNotReady(() => this.primeRedaction());
    if (!this.redactionAlerted) {
      this.redactionAlerted = true;
      log.error("Credential redaction is not ready: stored values could not be loaded, so they would not be masked in tool output. Retrying; tool output is withheld meanwhile.");
      this.deps.notifyOwner?.(ownerT("notices")("credentialsUnavailable"));
    }
    return false;
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The open request a form channel (the web UI) should show, or null. */
  formRequest(channelName = "web"): CredentialRequestView | null {
    const pending = this.state.pending;
    if (this.held || !pending || pending.channel !== channelName || pending.expiresAt <= this.now()) return null;
    return viewOf(pending);
  }

  /**
   * Ask the owner for `name` on `origin`, the chat this turn came in on. Null
   * origin: the turn was not the owner typing in one chat (a cron job, a
   * heartbeat, a batch across channels), and nobody is there to answer.
   */
  async request(name: string, purpose: string, sessionKey: string, origin: CredentialOrigin | null): Promise<RequestResult> {
    if (!isCredentialName(name)) {
      return { ok: false, error: `"${name}" is not a valid name. Use lowercase letters, digits, ".", "_" and "-", e.g. github-token.` };
    }
    if (!origin) {
      return { ok: false, error: "This turn did not come from the owner typing in one chat (it is a scheduled job, a heartbeat, a background turn, or a batch across channels), so nobody is there to answer. Ask on the owner's next message." };
    }
    if (this.held && !this.loadState()) return { ok: false, error: "The credential broker's state is unavailable, so no request was sent." };
    if (this.state.pending) return { ok: false, error: `A request is already open for ${this.state.pending.name}. Wait for it to finish.` };
    const capture = this.deps.captureChannel(origin);
    if (!capture) return { ok: false, error: `Credential requests cannot be asked on ${origin.channelName}. They go through the owner's iMessage or Telegram private chat, or the web UI.` };

    // Durable BEFORE the prompt: without the record, a restart would send the
    // owner's reply to the model. No record, no prompt.
    const expiresAt = this.now() + this.timeoutMs;
    const cleanPurpose = purpose.replace(/\p{C}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_PURPOSE_LENGTH);
    const pending: PendingRequest = {
      id: randomUUID(), name, purpose: cleanPurpose, sessionKey,
      channel: capture.name, chatId: origin.chatId, expiresAt,
    };
    try {
      this.deps.stateFile.save({ ...this.state, pending });
    } catch {
      log.error({ name }, "Could not record a credential request; not sending the prompt");
      return { ok: false, error: "The credential broker's state could not be saved, so no request was sent." };
    }
    this.state.pending = pending;
    this.armTimer(this.timeoutMs);

    const replaces = this.state.names.includes(name);
    const minutes = Math.round(this.timeoutMs / 60_000);
    const t = ownerT("credentials");
    const prompt = capture.kind === "form" ? joinText([]) /* a form shows `view`, not text */ : joinText([
      replaces ? t("promptReplaces", { name, purpose: cleanPurpose }) : t("prompt", { name, purpose: cleanPurpose }),
      capture.name === "telegram" ? t("promptTelegram") : t("promptMessages"),
      t("promptCancel", { minutes }),
    ]);
    const ref = secretRefFor(name);
    try {
      await capture.open(viewOf(pending), prompt);
    } catch (err) {
      if (isDefiniteFailure(err)) {
        this.endRequest(pending);
        return { ok: false, error: `Could not reach the owner on ${capture.name}.` };
      }
      // It may be on the owner's phone, so keep listening.
      log.warn({ name, channel: capture.name }, "Credential prompt send was ambiguous; keeping the request open");
      return { ok: true, ref, expiresAt, channel: capture.name, note: "The prompt may not have been delivered." };
    }
    return { ok: true, ref, expiresAt, channel: capture.name };
  }

  /**
   * The web card's answer, over its own route (never `/messages`). The value
   * goes to the store and nowhere else; the result carries no part of it.
   */
  async fulfill(id: string, input: FulfillInput): Promise<FulfillResult> {
    if (this.held && !this.loadState()) return { ok: false, status: 503, code: "credential_state_unavailable" };
    const pending = this.state.pending;
    if (!pending || pending.id !== id || pending.channel !== "web") {
      const expired = this.state.closedWindows.some((w) => w.id === id);
      return expired ? { ok: false, status: 410, code: "credential_expired" } : { ok: false, status: 409, code: "credential_unknown" };
    }
    if (pending.expiresAt <= this.now()) {
      await this.expire();
      return { ok: false, status: 410, code: "credential_expired" };
    }
    const ref = secretRefFor(pending.name);
    if ("cancel" in input) {
      this.endRequest(pending);
      this.deps.notifySession(pending.sessionKey, `The owner refused the request for ${ref}.`);
      return { ok: true, outcome: "cancelled" };
    }
    const value = input.value.trim();
    if (!acceptableValue(value)) return { ok: false, status: 400, code: "invalid_value" };
    return await this.store(pending, value) ? { ok: true, outcome: "stored" } : { ok: false, status: 503, code: "credential_store_unavailable" };
  }

  /** True when the message was taken and must go no further. Also cleans a message
   *  that passes through, so it stops quoting a captured one. */
  async handleInbound(channel: Channel, message: IncomingMessage): Promise<boolean> {
    const chat = (CHAT_CHANNELS as readonly string[]).includes(channel.name);
    const isOwnerDm = chat && !message.isGroup && this.deps.isOwnerSender(channel.name, message.senderId);
    if (this.held) this.loadState();
    if (this.held) {
      if (!isOwnerDm || !this.held.has(channel.name)) return false;
      channel.settleMessage?.(message.id, "refused");
      const removed = await this.removeMessage(channel, message);
      const t = ownerT("credentials");
      await this.say(channel, message.chatId, t("heldBack", { deleted: removed ? t("deleted") : "" }));
      return true;
    }

    const consumed = this.state.consumedIds;
    const key = (id: string | undefined) => id ? consumedKey(channel.name, message.chatId, id) : undefined;
    const own = key(message.id);
    if (own && consumed.includes(own)) {
      channel.forgetMessage?.(message.chatId, message.id);
      return true;
    }
    const reacted = key(message.reactedToId);
    const repliedTo = key(message.replyToId);
    if (reacted && consumed.includes(reacted)) {
      message.text = "[tapback on a message that carried a credential]";
    } else if (repliedTo && consumed.includes(repliedTo)) {
      message.text = `[replying to a message that carried a credential] ${message.rawText ?? ""}`.trim();
    }
    message.text = scrubKnownSecrets(message.text);
    if (!isOwnerDm) return false;

    // A tapback or a sticker has no rawText: nobody typed it, so it cannot be a value.
    if (message.rawText === undefined) return false;

    const late = this.state.closedWindows.find((w) =>
      message.timestamp >= w.startsAt - WINDOW_SLACK_MS && message.timestamp <= w.expiresAt + WINDOW_SLACK_MS);
    if (late) return this.dropLate(channel, message, late);

    const pending = this.state.pending;
    if (!pending) return false;
    return channel.name === pending.channel
      ? this.capture(channel, message, pending)
      : this.dropOffChannel(channel, message, pending);
  }

  /** Sent inside a window that has since closed. It may be the credential, and the
   *  request is over, so it is neither stored nor forwarded. */
  private async dropLate(channel: Channel, message: IncomingMessage, window: PendingRequest): Promise<boolean> {
    this.markConsumed(channel, message);
    channel.settleMessage?.(message.id, "refused");
    const removed = await this.removeMessage(channel, message);
    const t = ownerT("credentials");
    await this.say(channel, message.chatId, t("late", { name: window.name, deleted: removed ? t("deleted") : "" }));
    this.deps.notifySession(window.sessionKey, `The owner's reply to the request for ${secretRefFor(window.name)} arrived after it expired and was discarded. Ask again if it is still needed.`);
    return true;
  }

  private async dropOffChannel(channel: Channel, message: IncomingMessage, pending: PendingRequest): Promise<boolean> {
    this.markConsumed(channel, message);
    channel.settleMessage?.(message.id, "refused");
    const removed = await this.removeMessage(channel, message);
    const t = ownerT("credentials");
    const where = pending.channel === "web" ? t("where.web") : pending.channel === "telegram" ? t("where.telegram") : t("where.imessage");
    await this.say(channel, message.chatId, t("offChannel", { name: pending.name, where, deleted: removed ? t("deleted") : "" }));
    return true;
  }

  private async capture(channel: Channel, message: IncomingMessage, pending: PendingRequest): Promise<boolean> {
    const value = (message.rawText ?? "").trim();
    const ref = secretRefFor(pending.name);
    this.markConsumed(channel, message);
    const valid = (message.attachmentCount ?? 0) === 0 && acceptableValue(value);

    // CLAIM the request synchronously, before the first await. Deleting the
    // message and writing the keychain both wait, and a second message landing
    // meanwhile must find no open request: otherwise it is captured too and an
    // ordinary sentence overwrites the value, or a later "cancel" is undone.
    // Only an invalid value leaves the request open, to be answered again.
    const cancelled = CANCEL_WORDS.has(value.toLowerCase());
    if (cancelled || valid) this.endRequest(pending);

    const t = ownerT("credentials");
    if (cancelled) {
      await this.say(channel, message.chatId, t("cancelled", { name: pending.name }));
      this.deps.notifySession(pending.sessionKey, `The owner refused the request for ${ref}.`);
      return true;
    }
    const removed = await this.removeMessage(channel, message);
    const tidy = removed ? t("tidyDeleted") : deletionAdvice(t, channel.name);
    if (!valid) {
      await this.say(channel, message.chatId, t("invalid", { tidy, name: pending.name, min: MIN_SECRET_LENGTH, max: MAX_SECRET_LENGTH }));
      return true;
    }
    if (!await this.store(pending, value)) {
      await this.say(channel, message.chatId, t("storeFailed", { name: pending.name, tidy }));
      return true;
    }
    await this.say(channel, message.chatId, t("stored", { name: pending.name, tidy }));
    return true;
  }

  /** Ends `pending` and stores the value. False (and the session told) when the store failed. */
  private async store(pending: PendingRequest, value: string): Promise<boolean> {
    const ref = secretRefFor(pending.name);
    this.endRequest(pending);
    try {
      await this.deps.backend.put(pending.name, value);
    } catch {
      log.error({ name: pending.name }, "Could not store a captured credential");
      this.deps.notifySession(pending.sessionKey, `The owner replied, but ${ref} could not be stored.`);
      return false;
    }
    registerSecretValue(value, pending.name);
    if (!this.state.names.includes(pending.name)) this.state.names.push(pending.name);
    this.persist();
    log.info({ name: pending.name, channel: pending.channel }, "Credential captured from the owner");
    this.deps.notifySession(pending.sessionKey, [
      `The owner provided ${ref}. You do not have the value and must not ask for it, print it, or write it anywhere.`,
      `Use it in Bash only inside a command substitution, so it reaches the command but never the command text or the output: "$(${keychainReadCommand(pending.name)})".`,
      `For example: curl -sS -H "Authorization: Bearer $(${keychainReadCommand(pending.name)})" https://api.example.com/...`,
      "Known values are masked in tool output, but only literally and NOT when the command fails: redirect such a command's output (> out.txt 2>&1) and/or end it with || true so it exits 0.",
    ].join("\n"));
    return true;
  }

  /** Deletes the owner's message from the chat where the channel can (Telegram
   *  private chats). True when it is gone. */
  private async removeMessage(channel: Channel, message: IncomingMessage): Promise<boolean> {
    if (!channel.deleteInboundMessage || !message.id) return false;
    try {
      await channel.deleteInboundMessage(message.chatId, message.id);
      return true;
    } catch {
      log.warn({ channel: channel.name }, "Could not delete a message that may carry a credential");
      return false;
    }
  }

  private armTimer(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.expire(), ms);
    this.timer.unref?.();
  }

  private async expire(): Promise<void> {
    const pending = this.state.pending;
    if (!pending) return;
    this.closeWindow(pending);
    const capture = this.deps.captureChannel({ channelName: pending.channel, chatId: pending.chatId });
    if (capture?.kind === "message") await capture.notify(ownerT("credentials")("expired", { name: pending.name }));
    this.deps.notifySession(pending.sessionKey, `The request for ${secretRefFor(pending.name)} timed out with no answer.`);
  }

  /** A timed-out request: a message SENT inside it may still be delivered late. */
  private closeWindow(pending: PendingRequest): void {
    this.state.closedWindows.push({ ...pending, startsAt: pending.expiresAt - this.timeoutMs });
    this.endRequest(pending);
  }

  private endRequest(pending: PendingRequest): void {
    if (this.state.pending?.id !== pending.id) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state.pending = null;
    this.persist();
    try {
      this.deps.captureChannel({ channelName: pending.channel, chatId: pending.chatId })?.close();
    } catch {
      log.warn({ channel: pending.channel }, "Could not withdraw a credential request");
    }
  }

  private markConsumed(channel: Channel, message: IncomingMessage): void {
    if (message.id) this.state.consumedIds.push(consumedKey(channel.name, message.chatId, message.id));
    this.persist();
    channel.forgetMessage?.(message.chatId, message.id);
  }

  /** Logged, not thrown: this runs on the inbound path, and the in-memory answer
   *  still keeps the message from the model. The old file errs the safe way, since
   *  it still shows the request as open. */
  private persist(): void {
    try {
      this.deps.stateFile.save(this.state);
    } catch {
      log.error("Could not persist credential broker state");
    }
  }

  private async say(channel: Channel, chatId: string, text: OwnerText): Promise<void> {
    if (channel.name === "web") return;
    try {
      await channel.send({ chatId, text });
    } catch {
      log.warn("Could not send a credential broker notice");
    }
  }
}

function viewOf(pending: PendingRequest): CredentialRequestView {
  return { id: pending.id, name: pending.name, purpose: pending.purpose, expiresAt: pending.expiresAt };
}

function acceptableValue(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH && value.length <= MAX_SECRET_LENGTH && isStorableValue(value);
}

function deletionAdvice(t: OwnerT<"credentials">, channelName: string): OwnerText {
  return channelName === "telegram" ? t("tidyTelegram") : t("tidyMessages");
}

/**
 * How a consumed message is remembered. iMessage ids are GUIDs, unique on their
 * own; Telegram's are small integers per chat, so a group's message 42 must not
 * match the owner's private message 42.
 */
function consumedKey(channelName: string, chatId: string, id: string): string {
  return channelName === "imessage" ? id : `${channelName}:${chatId}:${id}`;
}
