import type { Channel, IncomingMessage } from "../channels/types.js";
import { isDefiniteFailure } from "../channels/types.js";
import { log } from "../logger.js";
import { isCredentialName, secretRefFor } from "./names.js";
import { MIN_SECRET_LENGTH, registerSecretValue, scrubKnownSecrets } from "./redactor.js";
import type { BrokerState, BrokerStateFile, CredentialBackend, PendingRequest } from "./store.js";

export const CREDENTIAL_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** Allowance for clock differences when judging a message's send time. */
const WINDOW_SLACK_MS = 2 * 60_000;
const MAX_SECRET_LENGTH = 8192;
const MAX_PURPOSE_LENGTH = 200;
const CANCEL_WORDS = new Set(["cancel", "取消"]);
const CHANNEL = "imessage";

export interface BrokerDeps {
  backend: CredentialBackend;
  stateFile: BrokerStateFile;
  isOwnerSender(channelName: string, senderId: string | undefined): boolean;
  /** The owner's iMessage DM, or null when there is none to ask through. */
  ownerImessage(): { channel: Channel; chatId: string } | null;
  /** Tell a session's model how a request ended. Never carries a value. */
  notifySession(sessionKey: string, body: string): void;
  now?: () => number;
  timeoutMs?: number;
}

export type RequestResult =
  | { ok: true; ref: string; expiresAt: number; note?: string }
  | { ok: false; error: string };

/**
 * Keeps a credential the owner sends on request away from the model.
 *
 * `handleInbound` runs at the top of `Agent.enqueueMessage`, before routing, the
 * transcript and the first log line that prints message text. When in doubt it
 * swallows the message: a false capture costs the owner a repeated sentence and
 * they are told, while a false pass is permanent. So a reply racing the prompt is
 * captured, and if the state file cannot be read, the owner's DMs are held back
 * until it can, because it may hold a request whose reply is on its way.
 */
export class CredentialBroker {
  private state: BrokerState = { names: [], pending: null, closedWindows: [], consumedIds: [] };
  private lockedDown = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
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
      if (!this.lockedDown) log.error("Credential broker state is unreadable; holding back the owner's DMs until it is repaired");
      this.lockedDown = true;
      return false;
    }
    this.lockedDown = false;
    const pending = this.state.pending;
    if (pending && pending.expiresAt <= this.now()) this.closeWindow(pending);
    else if (pending) this.armTimer(pending.expiresAt - this.now());
    return true;
  }

  /** So a value still in a running child or a file is scrubbed after a restart. */
  async primeRedaction(): Promise<void> {
    if (this.lockedDown) return;
    for (const name of this.state.names) {
      try {
        const value = await this.deps.backend.get(name);
        if (value !== null) registerSecretValue(value, name);
      } catch {
        log.warn({ name }, "Could not load a credential for redaction");
      }
    }
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async request(name: string, purpose: string, sessionKey: string): Promise<RequestResult> {
    if (!isCredentialName(name)) {
      return { ok: false, error: `"${name}" is not a valid name. Use lowercase letters, digits, ".", "_" and "-", e.g. github-token.` };
    }
    if (this.lockedDown && !this.loadState()) return { ok: false, error: "The credential broker's state is unavailable, so no request was sent." };
    if (this.state.pending) return { ok: false, error: `A request is already open for ${this.state.pending.name}. Wait for it to finish.` };
    const target = this.deps.ownerImessage();
    if (!target) return { ok: false, error: "No owner iMessage chat is available, and credential requests only go through it." };

    // Durable BEFORE the prompt: without the record, a restart would send the
    // owner's reply to the model. No record, no prompt.
    const expiresAt = this.now() + this.timeoutMs;
    const pending = { name, sessionKey, expiresAt };
    try {
      this.deps.stateFile.save({ ...this.state, pending });
    } catch {
      log.error({ name }, "Could not record a credential request; not sending the prompt");
      return { ok: false, error: "The credential broker's state could not be saved, so no request was sent." };
    }
    this.state.pending = pending;
    this.armTimer(this.timeoutMs);

    const cleanPurpose = purpose.replace(/\p{C}+/gu, " ").trim().slice(0, MAX_PURPOSE_LENGTH);
    const prompt = [
      "Tomo is asking for a credential.",
      `Name: ${name}`,
      `Purpose (written by the agent, not verified): ${cleanPurpose}`,
      ...(this.state.names.includes(name) ? ["Your reply replaces the value already stored under this name."] : []),
      "",
      "Your next iMessage in this chat is stored as this credential and is not shown to the model. It stays in Messages, so delete it afterwards.",
      `Reply "cancel" to refuse. Expires in ${Math.round(this.timeoutMs / 60_000)} minutes.`,
    ].join("\n");
    const ref = secretRefFor(name);
    try {
      await target.channel.send({ chatId: target.chatId, text: prompt });
    } catch (err) {
      if (isDefiniteFailure(err)) {
        this.setPending(null);
        return { ok: false, error: "Could not reach the owner on iMessage." };
      }
      // It may be on the owner's phone, so keep listening.
      log.warn({ name }, "Credential prompt send was ambiguous; keeping the request open");
      return { ok: true, ref, expiresAt, note: "The prompt may not have been delivered." };
    }
    return { ok: true, ref, expiresAt };
  }

  /** A stored value, for the harness to inject. Never put this in a tool result. */
  async reveal(name: string): Promise<string | null> {
    if (this.lockedDown || !this.state.names.includes(name)) return null;
    const value = await this.deps.backend.get(name);
    if (value !== null) registerSecretValue(value, name);
    return value;
  }

  /** True when the message was taken and must go no further. Also cleans a message
   *  that passes through, so it stops quoting a captured one. */
  async handleInbound(channel: Channel, message: IncomingMessage): Promise<boolean> {
    if (this.lockedDown) this.loadState();
    const isOwnerDm = !message.isGroup && this.deps.isOwnerSender(channel.name, message.senderId);
    if (this.lockedDown) {
      if (!isOwnerDm) return false;
      channel.settleMessage?.(message.id, "refused");
      await this.say(channel, message.chatId, "Tomo's credential state is unreadable, so this message was held back and not shown to the model. Repair or remove ~/.tomo/data/credentials/state.json.");
      return true;
    }

    const consumed = this.state.consumedIds;
    if (message.id && consumed.includes(message.id)) {
      channel.forgetMessage?.(message.chatId, message.id);
      return true;
    }
    if (message.reactedToId && consumed.includes(message.reactedToId)) {
      message.text = "[tapback on a message that carried a credential]";
    } else if (message.replyToId && consumed.includes(message.replyToId)) {
      message.text = `[replying to a message that carried a credential] ${message.rawText ?? ""}`.trim();
    }
    message.text = scrubKnownSecrets(message.text);
    if (!isOwnerDm) return false;

    // A tapback has no rawText: nobody typed it, so it cannot be a value.
    const typed = channel.name !== CHANNEL || message.rawText !== undefined;
    if (!typed) return false;

    const late = this.state.closedWindows.find((w) =>
      message.timestamp >= w.startsAt - WINDOW_SLACK_MS && message.timestamp <= w.expiresAt + WINDOW_SLACK_MS);
    if (late) return this.dropLate(channel, message, late);

    const pending = this.state.pending;
    if (!pending) return false;
    return channel.name === CHANNEL
      ? this.capture(channel, message, pending)
      : this.dropOffChannel(channel, message, pending);
  }

  /** Sent inside a window that has since closed. It may be the credential, and the
   *  request is over, so it is neither stored nor forwarded. */
  private async dropLate(channel: Channel, message: IncomingMessage, window: PendingRequest): Promise<boolean> {
    this.markConsumed(channel, message);
    channel.settleMessage?.(message.id, "refused");
    await this.say(channel, message.chatId, `A message sent around the time the request for ${window.name} expired arrived late. It was not stored and not shown to the model. If it was something else, send it again.`);
    this.deps.notifySession(window.sessionKey, `The owner's reply to the request for ${secretRefFor(window.name)} arrived after it expired and was discarded. Ask again if it is still needed.`);
    return true;
  }

  private async dropOffChannel(channel: Channel, message: IncomingMessage, pending: PendingRequest): Promise<boolean> {
    channel.forgetMessage?.(message.chatId, message.id);
    channel.settleMessage?.(message.id, "refused");
    await this.say(channel, message.chatId, `Tomo is waiting for ${pending.name} in iMessage, so this message was dropped and not shown to the model. Answer there, or reply "cancel" there.`);
    return true;
  }

  private async capture(channel: Channel, message: IncomingMessage, pending: PendingRequest): Promise<boolean> {
    const value = (message.rawText ?? "").trim();
    const ref = secretRefFor(pending.name);
    this.markConsumed(channel, message);

    if (CANCEL_WORDS.has(value.toLowerCase())) {
      this.setPending(null);
      await this.say(channel, message.chatId, `Cancelled the request for ${pending.name}.`);
      this.deps.notifySession(pending.sessionKey, `The owner refused the request for ${ref}.`);
      return true;
    }
    if ((message.attachmentCount ?? 0) > 0 || value.length < MIN_SECRET_LENGTH || value.length > MAX_SECRET_LENGTH) {
      await this.say(channel, message.chatId, `That was not stored and not shown to the model. ${pending.name} needs plain text of ${MIN_SECRET_LENGTH} to ${MAX_SECRET_LENGTH} characters and no attachment. Send it again, or reply "cancel".`);
      return true;
    }

    this.setPending(null);
    try {
      await this.deps.backend.put(pending.name, value);
    } catch {
      log.error({ name: pending.name }, "Could not store a captured credential");
      await this.say(channel, message.chatId, `Could not store ${pending.name}: the credential store is unavailable. Nothing was shown to the model.`);
      this.deps.notifySession(pending.sessionKey, `The owner replied, but ${ref} could not be stored.`);
      return true;
    }
    registerSecretValue(value, pending.name);
    if (!this.state.names.includes(pending.name)) this.state.names.push(pending.name);
    this.persist();
    log.info({ name: pending.name }, "Credential captured from the owner");
    await this.say(channel, message.chatId, `Stored as ${pending.name}. Your message is still in Messages, so delete it there.`);
    this.deps.notifySession(pending.sessionKey, `The owner provided ${ref}. Use the ref with run_with_secrets. You do not have the value and should not ask for it.`);
    return true;
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
    const target = this.deps.ownerImessage();
    if (target) await this.say(target.channel, target.chatId, `The request for ${pending.name} expired. Do NOT send it now: messages here go to the model again.`);
    this.deps.notifySession(pending.sessionKey, `The request for ${secretRefFor(pending.name)} timed out with no answer.`);
  }

  private closeWindow(pending: PendingRequest): void {
    this.state.closedWindows.push({ ...pending, startsAt: pending.expiresAt - this.timeoutMs });
    this.setPending(null);
  }

  private markConsumed(channel: Channel, message: IncomingMessage): void {
    if (message.id) this.state.consumedIds.push(message.id);
    this.persist();
    channel.forgetMessage?.(message.chatId, message.id);
  }

  private setPending(pending: PendingRequest | null): void {
    if (!pending && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.pending = pending;
    this.persist();
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

  private async say(channel: Channel, chatId: string, text: string): Promise<void> {
    if (channel.name === "web") return;
    try {
      await channel.send({ chatId, text });
    } catch {
      log.warn("Could not send a credential broker notice");
    }
  }
}
