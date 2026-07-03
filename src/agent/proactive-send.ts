import { existsSync } from "node:fs";
import type { Channel, IncomingMessage, MessageReaction } from "../channels/types.js";
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

export type SendResult = { ok: true } | { ok: false; error: string };

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
   *  (Agent.handleCronMessage — per-session queue, never rejects). */
  runDelegateTurn(systemMsg: string, sessionKey: string): Promise<boolean>;
}

/**
 * Proactive messaging into other sessions: direct sends, delegate requests,
 * group renames, and reactions. Backs the tomo-internal MCP tools
 * (send_message, list_sessions, rename_group_chat, react_to_message) via the
 * Agent's public delegate methods.
 */
export class ProactiveSendService {
  private latestInboundMessages = new Map<string, { channelName: string; chatId: string; messageId: string }>();

  constructor(private readonly deps: ProactiveSendDeps) {}

  /**
   * Direct mode: post a verbatim message to a target session via Channel.send().
   * No Claude query is invoked for the recipient — the message arrives as-is.
   * A pending note is queued so the recipient's next Claude turn has context.
   */
  async sendToSession(target: string, text: string, callerSessionKey?: string): Promise<SendResult> {
    const resolved = this.resolveSendTarget(target);
    if (!resolved) {
      return { ok: false, error: `Unknown target "${target}". Call list_sessions to see valid identities and groups.` };
    }
    const { sessionKey, replyTarget } = resolved;

    const channel = this.deps.getChannel(replyTarget.channelName);
    if (!channel) {
      return { ok: false, error: `Channel "${replyTarget.channelName}" is not connected` };
    }

    const { cleanText, mediaPaths, stickerIds } = extractAttachments(text);
    if (mediaPaths.length > 0 || stickerIds.length > 0) {
      // Send text first (matches assistant response ordering)
      if (cleanText) {
        await channel.send({ chatId: replyTarget.chatId, text: cleanText });
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
      await channel.send({ chatId: replyTarget.chatId, text });
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

    this.deps.queuePendingNote(sessionKey, fromSummoner
      ? `[System: Tomo from ${summoned}'s main session (dm:${summoned}), summoned into this group at the time, sent the following message here: "${text}"]`
      : callerSessionKey === sessionKey
        ? `[System: You sent the following message to this conversation earlier as a direct send: "${text}"]`
        : `[System: Tomo from another session sent the following message to this conversation earlier: "${text}"]`);

    log.info({ sessionKey, channel: replyTarget.channelName, chars: text.length }, "Message sent (direct)");
    return { ok: true };
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

    const systemMsg = `[System: From your other conversation, you were asked to: ${request}. Use this conversation's context, tone, and participants to respond appropriately. Reply NO_REPLY if you judge it shouldn't be sent.]`;

    // Fire-and-forget — handleCronMessage enqueues per session and runs through
    // a normal Claude turn. The user verifies the outcome in the channel.
    this.deps.runDelegateTurn(systemMsg, sessionKey).catch((err) => {
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

  /** React/tapback to the latest inbound provider message seen in a session. */
  async reactToLatestMessage(target: string, reaction: MessageReaction, remove = false): Promise<SendResult> {
    const resolved = this.resolveSendTarget(target);
    if (!resolved) {
      return { ok: false, error: `Unknown target "${target}". Use the current session key or call list_sessions.` };
    }

    const latest = this.latestInboundMessages.get(resolved.sessionKey);
    if (!latest) {
      return { ok: false, error: `No latest inbound message is known for "${resolved.sessionKey}" since Tomo started` };
    }

    const channel = this.deps.getChannel(latest.channelName);
    if (!channel) {
      return { ok: false, error: `Channel "${latest.channelName}" is not connected` };
    }
    if (!channel.reactToMessage) {
      return { ok: false, error: `Channel "${latest.channelName}" does not support message reactions` };
    }

    try {
      await channel.reactToMessage(latest.chatId, latest.messageId, reaction, remove);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: detail };
    }

    log.info({ sessionKey: resolved.sessionKey, channel: latest.channelName, reaction, remove }, "Reacted to latest message");
    return { ok: true };
  }

  /** Resolve a send_message `target` (identity name or session key) to (sessionKey, replyTarget). */
  private resolveSendTarget(target: string): { sessionKey: string; replyTarget: ReplyTarget } | undefined {
    const normalized = normalizeSendTarget(target, config.identities);
    if (!normalized) return undefined;
    const { sessionKey, identityName } = normalized;

    const dmIdentityName = dmIdentityFromSessionKey(sessionKey);
    if (dmIdentityName !== undefined) {
      // A raw channel:chatId target canonicalized to this dm key keeps its
      // named channel for delivery; router policy only picks the channel
      // when the caller didn't name one.
      const replyTarget = normalized.rawReplyTarget
        ?? this.deps.getReplyTarget(sessionKey)
        ?? this.deps.deriveReplyTargetFromConfig(identityName ?? dmIdentityName);
      return replyTarget ? { sessionKey, replyTarget } : undefined;
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
