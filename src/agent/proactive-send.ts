import { existsSync } from "node:fs";
import type { Channel, IncomingMessage, MessageReaction, RecentChatMessage } from "../channels/types.js";
import { IMESSAGE_SEND_EFFECTS } from "../channels/types.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { ReplyTarget, SessionEntry } from "../sessions/types.js";
import {
  isGroupSessionKey,
  dmIdentityFromSessionKey,
  replyTargetFromRawSessionKey,
} from "../sessions/keys.js";
import { extractAttachments } from "./text-utils.js";
import { normalizeSendTarget } from "./send-target.js";
import { formatTomoEvent } from "../tomo-event.js";

export type SendResult = { ok: true; note?: string } | { ok: false; error: string };

export interface SessionCatalog {
  identities: Array<{ name: string }>;
  groups: Array<{ key: string; title?: string; participants?: string[] }>;
}

/**
 * The narrow surface the proactive-send tools need from the Agent: channel
 * lookup, router target resolution, transcript/notes persistence, and the
 * cron-turn dispatcher for delegate mode.
 */
export interface ProactiveSendDeps {
  getChannel(name: string): Channel | undefined;
  getSummonedIdentity(channelName: string, chatId: string): string | undefined;
  getReplyTarget(sessionKey: string): ReplyTarget | undefined;
  deriveReplyTargetFromConfig(identityName: string): ReplyTarget | undefined;
  appendAssistantTranscript(sessionKey: string, content: string, channelName: string): void;
  setChatTitle(sessionKey: string, title: string): void;
  listActiveEntries(): SessionEntry[];
  queuePendingNote(sessionKey: string, note: string): void;
  /** Queue a delegate request as a system turn on the target session
   *  (Agent.handleCronMessage — per-session queue, never rejects).
   *  `deliveryTarget` pins the turn's delivery to a specific channel/chat
   *  instead of the session's reply-target resolution. */
  runDelegateTurn(systemMsg: string, sessionKey: string, deliveryTarget?: ReplyTarget): Promise<boolean>;
}

/**
 * Proactive messaging into other sessions: direct sends, delegate requests,
 * group renames, reactions, and edit/unsend of own messages. Backs the
 * tomo-internal MCP tools (send_message, list_sessions, rename_group_chat,
 * react_to_message, edit_message, unsend_message) via the Agent's public
 * delegate methods.
 */
export class ProactiveSendService {
  private latestInboundMessages = new Map<string, { channelName: string; chatId: string; messageId: string }>();

  constructor(private readonly deps: ProactiveSendDeps) {}

  /**
   * Direct mode: post a verbatim message to a target session via Channel.send().
   * No Claude query is invoked for the recipient — the message arrives as-is.
   * A pending note is queued so the recipient's next Claude turn has context.
   */
  async sendToSession(target: string, text: string, callerSessionKey?: string, options?: { replyTo?: string; effect?: string }): Promise<SendResult> {
    const resolved = this.resolveSendTarget(target);
    if (!resolved) {
      return { ok: false, error: `Unknown target "${target}". Call list_sessions to see valid identities and groups.` };
    }
    const { sessionKey, replyTarget } = resolved;

    const channel = this.deps.getChannel(replyTarget.channelName);
    if (!channel) {
      return { ok: false, error: `Channel "${replyTarget.channelName}" is not connected` };
    }

    // Expressive-send effect: a delivery property of the send. The failure
    // model is uniform with the channel layer's (degraded bridge, send.rich
    // refusal): THE TEXT ALWAYS DELIVERS, THE EFFECT SILENTLY VANISHES — and
    // the tool result note says so. A fire-and-forget send must never die on
    // a typo'd effect name ("laser" for "lasers"): an error is only right
    // when the caller can retry, and by the time this returns there is no
    // retry that isn't a duplicate message. Only iMessage can render
    // effects; on any other channel the field is dropped before the send, so
    // nothing ever leaks into visible text.
    let effect: string | undefined;
    let effectNote: string | undefined;
    if (options?.effect !== undefined) {
      const normalized = options.effect.trim().toLowerCase();
      if (!(IMESSAGE_SEND_EFFECTS as readonly string[]).includes(normalized)) {
        effectNote = `Note: unknown effect "${options.effect}" was dropped — the message was sent without it. Valid effects: ${IMESSAGE_SEND_EFFECTS.join(", ")}.`;
      } else if (channel.name === "imessage") {
        effect = normalized;
      } else {
        effectNote = `Note: effect "${normalized}" was ignored — channel "${channel.name}" does not support iMessage effects; the message was sent without it.`;
      }
    }

    // Resolve the reply-to substring to a provider message id before sending
    // anything — a failed match must not half-deliver. Own messages are fair
    // game here: threading onto an earlier Tomo message is legitimate.
    let replyToId: string | undefined;
    if (options?.replyTo !== undefined) {
      const found = this.matchRecentMessage(channel, replyTarget.chatId, options.replyTo, { from: "anyone" });
      if (!found.ok) return found;
      replyToId = found.message.id;
    }

    const { cleanText, mediaPaths, stickerIds } = extractAttachments(text);
    if (mediaPaths.length > 0 || stickerIds.length > 0) {
      // Send text first (matches assistant response ordering). The effect
      // rides the text send — it modifies delivery of text, not attachments.
      if (cleanText) {
        await channel.send({ chatId: replyTarget.chatId, text: cleanText, ...(replyToId ? { replyTo: replyToId } : {}), ...(effect ? { effect } : {}) });
      } else if (effect) {
        effectNote = `Note: effect "${effect}" was ignored — an effect needs message text to ride on, and this send had only attachments.`;
      }
      const validPaths = mediaPaths.filter((p) => existsSync(p));
      for (const path of validPaths) {
        await channel.send({
          chatId: replyTarget.chatId,
          photo: path,
          text: "",
        });
      }
      for (const stickerId of stickerIds) {
        await channel.send({
          chatId: replyTarget.chatId,
          sticker: stickerId,
          text: "",
        });
      }
    } else {
      // No attachments: preserve verbatim text (direct-mode contract)
      await channel.send({ chatId: replyTarget.chatId, text, ...(replyToId ? { replyTo: replyToId } : {}), ...(effect ? { effect } : {}) });
    }

    // Attribute the send in the target session's record. Only claim it came
    // from the summoning identity's main session when the caller actually IS
    // that session — any session can direct-send into a summoned group.
    const summoned = this.deps.getSummonedIdentity(replyTarget.channelName, replyTarget.chatId);
    const fromSummoner = summoned !== undefined && callerSessionKey === `dm:${summoned}`;

    try {
      this.deps.appendAssistantTranscript(
        sessionKey,
        fromSummoner ? `[via dm:${summoned} (summoned)] ${text}` : `[proactive] ${text}`,
        replyTarget.channelName,
      );
    } catch (err) {
      // The channel send already succeeded. Reporting a tool failure here
      // invites the caller to retry and duplicate the user-visible message.
      log.warn({ err, sessionKey }, "Message delivered but transcript persistence failed");
    }

    this.deps.queuePendingNote(sessionKey, formatTomoEvent("direct-send", fromSummoner
      ? `Tomo from ${summoned}'s main session (dm:${summoned}), summoned into this group at the time, sent the following message here: "${text}"`
      : callerSessionKey === sessionKey
        ? `You sent the following message to this conversation earlier as a direct send: "${text}"`
        : `Tomo from another session sent the following message to this conversation earlier: "${text}"`));

    log.info({ sessionKey, channel: replyTarget.channelName, chars: text.length, effect }, "Message sent (direct)");
    return { ok: true, ...(effectNote ? { note: effectNote } : {}) };
  }

  /**
   * Delegate mode: queue a system request for the target session's Claude to
   * compose and send a message in its own voice/context. Fire-and-forget — the
   * caller's tool result returns as soon as the request is dispatched, not when
   * the recipient's Claude finishes. The user observes the actual outcome in
   * the recipient channel directly (since they're a participant).
   *
   * Note: delegate-to-self isn't blocked here. If it happens, the system
   * request is just queued behind the current turn via enqueueForSession —
   * one extra Claude turn fires, no infinite loop. For mid-loop self-progress
   * updates, prefer direct mode (no extra turn).
   */
  async delegateToSession(target: string, request: string): Promise<SendResult> {
    const resolved = this.resolveSendTarget(target);
    if (!resolved) {
      return { ok: false, error: `Unknown target "${target}". Call list_sessions to see valid identities and groups.` };
    }
    const { sessionKey, replyTarget } = resolved;

    if (!this.deps.getChannel(replyTarget.channelName)) {
      return { ok: false, error: `Channel "${replyTarget.channelName}" is not connected` };
    }

    const systemMsg = formatTomoEvent(
      "delegate",
      `From your other conversation, you were asked to: ${request}. Use this conversation's context, tone, and participants to respond appropriately. Reply NO_REPLY if you judge it shouldn't be sent.`,
    );

    // Fire-and-forget — handleCronMessage enqueues per session and runs through
    // a normal Claude turn. The user verifies the outcome in the channel.
    // A raw channel:chatId target canonicalized to a dm key pins delivery to
    // the named channel, like direct mode; otherwise the turn resolves its
    // own delivery target from the session's reply policy.
    this.deps.runDelegateTurn(systemMsg, sessionKey, resolved.rawReplyTarget).catch((err) => {
      log.error({ err, sessionKey }, "Delegated send failed");
    });

    log.info({ sessionKey, channel: replyTarget.channelName, chars: request.length }, "Proactive message dispatched (delegate)");
    return { ok: true };
  }

  /** Rename a group chat via its channel API and persist the local title immediately. */
  async renameGroupChat(target: string, title: string): Promise<SendResult> {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      return { ok: false, error: "Group title cannot be empty" };
    }

    const resolved = this.resolveSendTarget(target);
    if (!resolved) {
      return { ok: false, error: `Unknown target "${target}". Call list_sessions to see valid group keys.` };
    }
    const { sessionKey, replyTarget } = resolved;
    const rawKey = `${replyTarget.channelName}:${replyTarget.chatId}`;

    if (!isGroupSessionKey(rawKey)) {
      return { ok: false, error: `Target "${target}" is not a group chat session` };
    }

    const channel = this.deps.getChannel(replyTarget.channelName);
    if (!channel) {
      return { ok: false, error: `Channel "${replyTarget.channelName}" is not connected` };
    }
    if (!channel.setChatTitle) {
      return { ok: false, error: `Channel "${replyTarget.channelName}" does not support renaming group chats` };
    }

    try {
      await channel.setChatTitle(replyTarget.chatId, trimmedTitle);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: detail };
    }

    this.deps.setChatTitle(sessionKey, trimmedTitle);
    log.info({ sessionKey, channel: replyTarget.channelName }, "Group chat title renamed");
    return { ok: true };
  }

  /**
   * React/tapback to a provider message in a session: the latest inbound one
   * by default, or the newest recent message whose text contains `match`.
   */
  async reactToMessage(target: string, reaction: MessageReaction, remove = false, match?: string): Promise<SendResult> {
    const resolved = this.resolveSendTarget(target);
    if (!resolved) {
      return { ok: false, error: `Unknown target "${target}". Use the current session key or call list_sessions.` };
    }

    const latest = this.latestInboundMessages.get(resolved.sessionKey);

    // Chat scope: an explicitly named channel:chat target pins it; otherwise
    // the latest-inbound record pins the chat messages actually arrived in
    // (a dm session can span channels), falling back to the resolved reply
    // target so `match` still works before any inbound message is seen.
    const chatRef = resolved.rawReplyTarget
      ?? latest
      ?? { channelName: resolved.replyTarget.channelName, chatId: resolved.replyTarget.chatId };

    const channel = this.deps.getChannel(chatRef.channelName);
    if (!channel) {
      return { ok: false, error: `Channel "${chatRef.channelName}" is not connected` };
    }
    if (!channel.reactToMessage) {
      return { ok: false, error: `Channel "${chatRef.channelName}" does not support message reactions` };
    }

    let chatId: string;
    let messageId: string;
    if (match !== undefined) {
      // Own messages are excluded — tapbacking your own message is never the intent.
      const found = this.matchRecentMessage(channel, chatRef.chatId, match, { from: "others" });
      if (!found.ok) return found;
      chatId = chatRef.chatId;
      messageId = found.message.id;
    } else {
      if (!latest) {
        return { ok: false, error: `No latest inbound message is known for "${resolved.sessionKey}" since Tomo started` };
      }
      // The recorded message id belongs to the chat it arrived in, not the
      // pinned scope — react where the message actually lives.
      chatId = latest.chatId;
      messageId = latest.messageId;
    }

    try {
      await channel.reactToMessage(chatId, messageId, reaction, remove);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: detail };
    }

    log.info({ sessionKey: resolved.sessionKey, channel: chatRef.channelName, reaction, remove, matched: match !== undefined || undefined }, "Reacted to message");
    return { ok: true };
  }

  /**
   * Edit the text of a message Tomo previously sent in a session — the most
   * recent own message by default, or the newest own message whose text
   * contains `match`.
   */
  async editSentMessage(target: string, newText: string, match?: string): Promise<SendResult> {
    if (!newText.trim()) {
      return { ok: false, error: "Edited message text cannot be empty" };
    }

    const resolved = this.resolveOwnMessage(target, match, "editMessage");
    if (!resolved.ok) return resolved;

    try {
      await resolved.channel.editMessage!(resolved.chatId, resolved.message.id, newText);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: detail };
    }

    log.info({ sessionKey: resolved.sessionKey, channel: resolved.channel.name, matched: match !== undefined || undefined }, "Edited sent message");
    return { ok: true };
  }

  /**
   * Unsend/delete a message Tomo previously sent in a session — the most
   * recent own message by default, or the newest own message whose text
   * contains `match`.
   */
  async unsendMessage(target: string, match?: string): Promise<SendResult> {
    const resolved = this.resolveOwnMessage(target, match, "unsendMessage");
    if (!resolved.ok) return resolved;

    try {
      await resolved.channel.unsendMessage!(resolved.chatId, resolved.message.id);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: detail };
    }

    log.info({ sessionKey: resolved.sessionKey, channel: resolved.channel.name, matched: match !== undefined || undefined }, "Unsent message");
    return { ok: true };
  }

  /**
   * Resolve a target + optional `match` to one of Tomo's own recent messages
   * in the chat, checking that the channel supports `capability`. Shared by
   * edit/unsend — both only ever operate on messages Tomo sent.
   */
  private resolveOwnMessage(
    target: string,
    match: string | undefined,
    capability: "editMessage" | "unsendMessage",
  ): { ok: true; channel: Channel; chatId: string; message: RecentChatMessage; sessionKey: string } | { ok: false; error: string } {
    const resolved = this.resolveSendTarget(target);
    if (!resolved) {
      return { ok: false, error: `Unknown target "${target}". Use the current session key or call list_sessions.` };
    }

    // Chat scope mirrors reactToMessage: an explicitly named channel:chat
    // target pins it; otherwise the latest-inbound record pins the chat the
    // conversation actually lives in (a dm session can span channels).
    const latest = this.latestInboundMessages.get(resolved.sessionKey);
    const chatRef = resolved.rawReplyTarget
      ?? latest
      ?? { channelName: resolved.replyTarget.channelName, chatId: resolved.replyTarget.chatId };

    const channel = this.deps.getChannel(chatRef.channelName);
    if (!channel) {
      return { ok: false, error: `Channel "${chatRef.channelName}" is not connected` };
    }
    if (!channel[capability]) {
      const verb = capability === "editMessage" ? "editing sent messages" : "unsending messages";
      return { ok: false, error: `Channel "${chatRef.channelName}" does not support ${verb}` };
    }

    if (match !== undefined) {
      const found = this.matchRecentMessage(channel, chatRef.chatId, match, { from: "self" });
      if (!found.ok) return found;
      return { ok: true, channel, chatId: chatRef.chatId, message: found.message, sessionKey: resolved.sessionKey };
    }

    if (!channel.recentMessages) {
      return { ok: false, error: `Channel "${chatRef.channelName}" does not track recent messages` };
    }
    const newestOwn = channel.recentMessages(chatRef.chatId).find((m) => m.fromMe);
    if (!newestOwn) {
      return { ok: false, error: `No message sent by Tomo is known in this chat since Tomo started` };
    }
    return { ok: true, channel, chatId: chatRef.chatId, message: newestOwn, sessionKey: resolved.sessionKey };
  }

  /** Newest recent message in a chat whose text contains `query` (case-insensitive). */
  private matchRecentMessage(
    channel: Channel,
    chatId: string,
    query: string,
    options: { from: "others" | "self" | "anyone" },
  ): { ok: true; message: RecentChatMessage } | { ok: false; error: string } {
    if (!channel.recentMessages) {
      return { ok: false, error: `Channel "${channel.name}" does not track recent messages, so text matching is unavailable` };
    }
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return { ok: false, error: "Match text cannot be empty" };
    }
    const fromOk = (m: RecentChatMessage) =>
      options.from === "anyone" || (options.from === "self") === m.fromMe;
    const found = channel.recentMessages(chatId).find(
      (m) => fromOk(m) && m.text.toLowerCase().includes(needle),
    );
    if (!found) {
      const scope = options.from === "self" ? "message sent by Tomo" : "recent message";
      return { ok: false, error: `No ${scope} in this chat matches "${query}"` };
    }
    return { ok: true, message: found };
  }

  /** Resolve a send_message `target` (identity name or session key) to (sessionKey, replyTarget). */
  private resolveSendTarget(
    target: string,
  ): { sessionKey: string; replyTarget: ReplyTarget; rawReplyTarget?: ReplyTarget } | undefined {
    const normalized = normalizeSendTarget(target, config.identities);
    if (!normalized) return undefined;
    const { sessionKey, identityName, rawReplyTarget } = normalized;

    const dmIdentityName = dmIdentityFromSessionKey(sessionKey);
    if (dmIdentityName !== undefined) {
      // A raw channel:chatId target canonicalized to this dm key keeps its
      // named channel for delivery; router policy only picks the channel
      // when the caller didn't name one.
      const replyTarget = rawReplyTarget
        ?? this.deps.getReplyTarget(sessionKey)
        ?? this.deps.deriveReplyTargetFromConfig(identityName ?? dmIdentityName);
      return replyTarget ? { sessionKey, replyTarget, rawReplyTarget } : undefined;
    }

    // Non-dm session key (channel:<chatId> form, possibly a group). The caller
    // explicitly named a target, so honor group chats too.
    const replyTarget = this.deps.getReplyTarget(sessionKey)
      ?? replyTargetFromRawSessionKey(sessionKey);
    return replyTarget ? { sessionKey, replyTarget } : undefined;
  }

  /** Catalog of valid send_message targets, with friendly metadata for groups. Backs the `list_sessions` tool.
   *  Uses active entries (not just linked SDK sessions) so groups known only
   *  through metadata — e.g. summoned before ever running their own turn —
   *  are still listed as send targets. */
  listSessionCatalog(): SessionCatalog {
    const identities = config.identities.map((i) => ({ name: i.name }));
    const groups: SessionCatalog["groups"] = [];
    for (const entry of this.deps.listActiveEntries()) {
      const key = entry.channelKey;
      if (!isGroupSessionKey(key)) continue;
      groups.push({
        key,
        ...(entry.chatTitle ? { title: entry.chatTitle } : {}),
        ...(entry.participants && entry.participants.length > 0 ? { participants: entry.participants } : {}),
      });
    }
    return { identities, groups };
  }

  recordLatestInboundMessage(sessionKey: string, channel: Channel, message: IncomingMessage): void {
    // Incoming channels are expected to provide provider message ids; keep the
    // guard defensive so synthetic/test messages cannot poison reaction state.
    if (!message.id) return;
    this.latestInboundMessages.set(sessionKey, {
      channelName: channel.name,
      chatId: message.chatId,
      messageId: message.id,
    });
  }
}
