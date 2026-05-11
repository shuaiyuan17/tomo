import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Channel, IncomingMessage, MessageReaction, StreamingMessage } from "./channels/types.js";
import { config, CONFIG_PATH, RESTART_REASON_FILE } from "./config.js";
import { buildSystemPrompt } from "./workspace/index.js";
import { SessionStore } from "./sessions/index.js";
import type { ReplyTarget } from "./sessions/types.js";
import { checkAndClearCompactTrigger } from "./lcm/index.js";
import { isGroupSessionKey } from "./lcm/blocks.js";
import { IdentityRouter } from "./router.js";
import { createTomoInternalMcpServer } from "./mcp/internal-server.js";
import { log } from "./logger.js";
import { LiveSession } from "./agent/live-session.js";
import { makeTurnBudget, sdkOptions, usesLcmCompact } from "./agent/sdk-options.js";
import { isSilentReply, ATTACHMENT_TAG_RE, extractAttachments } from "./agent/text-utils.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

export type SendResult = { ok: true } | { ok: false; error: string };

export interface SessionCatalog {
  identities: Array<{ name: string }>;
  groups: Array<{ key: string; title?: string; participants?: string[] }>;
}

export class Agent {
  private channels: Channel[] = [];
  private sessions: SessionStore;
  private router: IdentityRouter;
  private liveSessions = new Map<string, LiveSession>();
  private messageQueues = new Map<string, Promise<void>>();
  // DM messages that arrived while a turn was in flight, waiting to be
  // coalesced into one user turn. Keyed by sessionKey. Drained by the next
  // queued task; later tasks find nothing and no-op.
  private pendingBatches = new Map<string, Array<{ channel: Channel; message: IncomingMessage }>>();
  private groupParticipants = new Map<string, Set<string>>();
  private modelOverrides = new Map<string, string>();
  private lastPromptHash: string = "";
  // Context-usage hysteresis: track whether we've nudged the agent to compact
  // for the current over-threshold episode. Reset when usage drops below LOW.
  private contextNudged = new Map<string, boolean>();
  // Notes queued by sendToSession() — drained and prepended to the recipient's
  // next user/cron/continuity turn so their Claude has context that a
  // proactive message went out.
  private pendingNotes = new Map<string, string[]>();
  private latestInboundMessages = new Map<string, { channelName: string; chatId: string; messageId: string }>();
  private readonly internalMcpServer: McpSdkServerConfigWithInstance;

  constructor() {
    this.sessions = new SessionStore(config.sessionsDir, config.historyLimit);
    this.router = new IdentityRouter(config.identities, this.sessions, config.channelAllowlists);
    this.internalMcpServer = createTomoInternalMcpServer(this);

    // Load persistent per-session model overrides
    for (const [key, model] of Object.entries(config.sessionModelOverrides)) {
      this.modelOverrides.set(key, model);
    }
  }

  /** Look up a channel by name */
  private getChannel(name: string): Channel | undefined {
    return this.channels.find((ch) => ch.name === name);
  }

  /**
   * Is this group a "passive listen" group? Tomo sees every message (no
   * @mention required) and decides via NO_REPLY whether to respond.
   * iMessage groups are always passive (the channel can't reliably detect
   * mentions). Telegram (and others) opt in via config.passiveGroups.
   */
  private isPassiveListenGroup(channelName: string, chatId: string): boolean {
    if (channelName === "imessage") return true;
    return (config.passiveGroups[channelName] ?? []).includes(chatId);
  }

  /** Snapshot of group metadata for the system prompt — null for non-group sessions. */
  private buildGroupContext(sessionKey: string): { chatTitle?: string; participants?: string[]; isPassive: boolean } | undefined {
    if (!isGroupSessionKey(sessionKey)) return undefined;
    const colonIdx = sessionKey.indexOf(":");
    const channelName = colonIdx >= 0 ? sessionKey.slice(0, colonIdx) : "";
    const chatId = colonIdx >= 0 ? sessionKey.slice(colonIdx + 1) : "";
    const entry = this.sessions.getEntry(sessionKey);
    return {
      ...(entry?.chatTitle ? { chatTitle: entry.chatTitle } : {}),
      ...(entry?.participants && entry.participants.length > 0 ? { participants: entry.participants } : {}),
      isPassive: channelName ? this.isPassiveListenGroup(channelName, chatId) : false,
    };
  }

  /** Activate a group chat by adding it to the channel's allowlist */
  private async activateGroup(channel: Channel, chatId: string): Promise<void> {
    try {
      const { readFileSync, writeFileSync } = await import("node:fs");
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
      if (!channels[channel.name]) channels[channel.name] = {};
      const allowlist = ((channels[channel.name].allowlist ?? []) as string[]);
      if (!allowlist.includes(chatId)) {
        allowlist.push(chatId);
        channels[channel.name].allowlist = allowlist;
        cfg.channels = channels;
        writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
        // Update the router's in-memory allowlist
        this.router.addToAllowlist(channel.name, chatId);
      }
      log.info({ channel: channel.name, chatId }, "Group chat activated via secret");
      await channel.send({ chatId, text: "Tomo activated in this group." });
    } catch (err) {
      log.error({ err }, "Failed to activate group");
    }
  }

  addChannel(channel: Channel): void {
    channel.onMessage((msg) => this.enqueueMessage(channel, msg));
    channel.onCommand((cmd, chatId, senderName, args) => this.handleCommand(channel, cmd, chatId, senderName, args));
    this.channels.push(channel);
  }

  /** Active sessions as [sessionKey, sdkSessionId] pairs (RollupRunner etc). */
  listActiveSessions(): [string, string][] {
    return this.sessions.listSdkSessionIds();
  }

  /**
   * Serialize work on a session key across ALL ingress paths (user, cron,
   * continuity). Each task runs FIFO so only one send() is in flight per
   * key at any time — prevents LiveSession's shared currentRequest slot
   * from being stomped by overlapping callers.
   */
  private enqueueForSession<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const prev = this.messageQueues.get(sessionKey) ?? Promise.resolve();
    const result = prev.then(() => task());
    // Keep the queue alive even if this task throws
    const next = result.then(() => {}, (err) => {
      log.error({ err, sessionKey }, "Unhandled error in session queue");
    });
    this.messageQueues.set(sessionKey, next);
    return result;
  }

  /**
   * Queue messages per session key so they process sequentially. For DMs, also
   * coalesce: messages that pile up behind an in-flight turn are merged into a
   * single follow-up turn so the agent sees them together (e.g. "do X" → "wait"
   * → "nevermind" all become one prompt). Passive groups (iMessage, opt-in
   * Telegram) coalesce too — every message reaches Tomo there anyway, so
   * batching just reduces turn count. Mention-required groups bypass
   * coalescing because per-message mention filtering would be lost.
   */
  private async enqueueMessage(channel: Channel, message: IncomingMessage): Promise<void> {
    const isGroup = message.isGroup ?? false;
    const { sessionKey } = this.router.resolve(channel.name, message.chatId, isGroup);

    const isPassiveGroup = isGroup && this.isPassiveListenGroup(channel.name, message.chatId);
    const canCoalesce = !isGroup || isPassiveGroup;

    // Fire-and-forget: the returned promise resolves as soon as the message is
    // queued, NOT when the SDK turn completes. If a caller (e.g. a channel
    // adapter) awaits this, that's fine — they don't block the next ingress
    // on an in-flight turn, which is what lets rapid messages pile up for the
    // queue to coalesce.
    if (!canCoalesce) {
      this.enqueueForSession(sessionKey, () => this.handleMessage(channel, message))
        .catch((err) => log.error({ err, sessionKey }, "Unhandled error in message queue"));
      return;
    }

    const batch = this.pendingBatches.get(sessionKey) ?? [];
    batch.push({ channel, message });
    this.pendingBatches.set(sessionKey, batch);

    this.enqueueForSession(sessionKey, async () => {
      const items = this.pendingBatches.get(sessionKey);
      if (!items || items.length === 0) return;
      this.pendingBatches.delete(sessionKey);

      if (items.length === 1) {
        await this.handleMessage(items[0].channel, items[0].message);
      } else {
        log.info(
          { sessionKey, count: items.length },
          `Coalescing ${items.length} queued messages into one turn`,
        );
        await this.handleBatchedMessages(items);
      }
    }).catch((err) => log.error({ err, sessionKey }, "Unhandled error in message queue"));
  }

  private static readonly AVAILABLE_MODELS: Record<string, string> = {
    "sonnet": "claude-sonnet-4-6",
    "sonnet-1m": "claude-sonnet-4-6[1m]",
    "opus": "claude-opus-4-7",
    "opus-1m": "claude-opus-4-7[1m]",
    "haiku": "claude-haiku-4-5",
  };

  private async handleCommand(channel: Channel, command: string, chatId: string, senderName: string, args?: string): Promise<void> {
    const { sessionKey: key } = this.router.resolve(channel.name, chatId, false);

    if (command === "new") {
      this.closeLiveSession(key);
      this.sessions.clearSdkSessionId(key);
      log.info({ channel: channel.name, chatId, sender: senderName }, "New session started via /new");
      await channel.send({ chatId, text: "New session started." });
      return;
    }

    if (command === "model") {
      const arg = args?.trim().toLowerCase();
      if (!arg) {
        const current = this.modelOverrides.get(key) ?? config.model;
        const lines = [`Current: ${current}`, "", "Switch with: /model <name>", ""];
        for (const [shortName, fullName] of Object.entries(Agent.AVAILABLE_MODELS)) {
          const marker = fullName === current ? " (active)" : "";
          lines.push(`  ${shortName} — ${fullName}${marker}`);
        }
        await channel.send({ chatId, text: lines.join("\n") });
        return;
      }

      const resolved = Agent.AVAILABLE_MODELS[arg] ?? arg;
      this.modelOverrides.set(key, resolved);
      // Model change requires new session (process uses one model)
      this.closeLiveSession(key);
      log.info({ channel: channel.name, chatId, model: resolved }, "Model switched via /model");
      await channel.send({ chatId, text: `Switched to ${resolved}` });
      return;
    }

    if (command === "status") {
      const model = this.modelOverrides.get(key) ?? config.model;
      const session = this.sessions.get(key);
      const entry = this.sessions.getEntry(key);
      const live = this.liveSessions.get(key);

      const lines: string[] = [];
      lines.push(`Session: ${key}`);
      lines.push(`Channel: ${channel.name}`);
      lines.push(`Model: ${model}`);
      lines.push(`Live: ${live?.isAlive() ? "yes" : "no"}`);

      const msgCount = session.messages.filter((m) => m.role === "user").length;
      lines.push(`Messages: ${msgCount} user turns`);

      if (session.createdAt) {
        lines.push(`Created: ${new Date(session.createdAt).toLocaleString()}`);
      }
      if (session.updatedAt) {
        lines.push(`Last active: ${new Date(session.updatedAt).toLocaleString()}`);
      }

      if (entry?.stats) {
        const s = entry.stats;
        lines.push("");
        lines.push(`Queries: ${s.totalQueries}`);
        lines.push(`Cost: $${s.totalCostUsd.toFixed(4)}`);
        lines.push(`Tokens: ${s.totalInputTokens.toLocaleString()} in / ${s.totalOutputTokens.toLocaleString()} out`);
        if (s.contextMax > 0) {
          const pct = ((s.contextUsed / s.contextMax) * 100).toFixed(0);
          lines.push(`Context: ${pct}% (${s.contextUsed.toLocaleString()} / ${s.contextMax.toLocaleString()})`);
        }
      }

      await channel.send({ chatId, text: lines.join("\n") });
      return;
    }
  }

  private getOrCreateLiveSession(key: string): LiveSession {
    let session = this.liveSessions.get(key);
    if (session?.isAlive()) return session;

    // Check prompt changes
    const currentHash = this.hashString(buildSystemPrompt());
    if (this.lastPromptHash && currentHash !== this.lastPromptHash) {
      log.info("System prompt changed, creating new sessions");
      for (const [k, s] of this.liveSessions) {
        s.close();
        this.liveSessions.delete(k);
      }
    }
    this.lastPromptHash = currentHash;

    const resumeId = this.sessions.getSdkSessionId(key);
    const model = this.modelOverrides.get(key);
    const turnBudget = makeTurnBudget();
    const opts = sdkOptions(this.internalMcpServer, resumeId ?? undefined, model, {
      sessionKey: key,
      sdkSessionId: resumeId ?? undefined,
      group: this.buildGroupContext(key),
    }, turnBudget);

    session = new LiveSession(opts, key, turnBudget);
    this.liveSessions.set(key, session);
    log.info({ key, resume: !!resumeId, model: opts.model }, "Live session created");
    return session;
  }

  private closeLiveSession(key: string): void {
    const session = this.liveSessions.get(key);
    if (session) {
      session.close();
      this.liveSessions.delete(key);
    }
  }

  private hashString(s: string): string {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return String(hash);
  }

  /**
   * Finalize the streaming message after a turn completes. Per-block delivery
   * happens during the run (each `assistant` event triggers `commitBlock` via
   * the `onBlockComplete` callback below), so by the time we get here the
   * stream's only remaining job is flushing any trailing buffer state.
   *
   * Handles three special cases:
   *   - Bare NO_REPLY response: cancel the stream (drops in-flight Telegram
   *     edits, no-op for iMessage's already-shipped buffer).
   *   - API errors surfaced as response text: finish + send a clean `[error]`.
   *   - Otherwise: stream.finish() flushes any final-block buffer.
   *
   * MEDIA tags are shipped per block via `shipBlockMedia` during the run, so
   * we don't extract them here.
   */
  private async deliverResponse(
    replyChannel: Channel,
    replyChatId: string,
    response: string,
    stream: StreamingMessage,
  ): Promise<void> {
    log.info({ channel: replyChannel.name }, "Tomo: %s", response);

    if (isSilentReply(response)) {
      log.info("Silent reply (no message sent)");
      await stream.cancel();
      return;
    }

    // Surface API errors that the SDK returns as response text
    if (/^API Error: \d+/i.test(response) || /^\{"type":"error"/.test(response)) {
      await stream.finish();
      await replyChannel.send({ chatId: replyChatId, text: `[error] ${response}` });
      return;
    }

    await stream.finish();
  }

  /**
   * Ship MEDIA:/STICKER: attachments referenced in a single block. The block's text is
   * already going through the streamed message (with attachment tags stripped at
   * `update()` time), so attachments here go without a caption — the matching
   * text shows up alongside as its own streamed message.
   */
  private async shipBlockAttachments(
    channel: Channel,
    chatId: string,
    blockText: string,
  ): Promise<void> {
    const { mediaPaths, stickerIds } = extractAttachments(blockText);
    for (const path of mediaPaths) {
      if (!existsSync(path)) continue;
      await channel.send({ chatId, photo: path, text: "" });
    }
    for (const stickerId of stickerIds) {
      await channel.send({ chatId, text: "", sticker: stickerId });
    }
  }

  /**
   * Build the per-block handler passed to the live session. The handler runs
   * inside the SDK event loop (`live-session.handleEvent`); any error it
   * throws would propagate up and kill the session mid-turn — which then
   * trips `runWithRetry`'s "session error" branch and double-fires the whole
   * turn. So channel-side delivery errors are caught + logged here and never
   * leave this boundary.
   */
  private makeBlockHandler(
    channel: Channel,
    chatId: string,
    stream: StreamingMessage,
  ): (text: string) => Promise<void> {
    return async (blockText: string) => {
      try {
        await stream.commitBlock();
        await this.shipBlockAttachments(channel, chatId, blockText);
      } catch (err) {
        log.warn({ err, channel: channel.name }, "Block delivery failed");
      }
    };
  }

  /**
   * If the live session's last turn pushed context past 80%, fire a one-shot
   * compact nudge (fire-and-forget). Skips when SDK auto-compact owns this
   * session. Shared by handleMessage and handleBatchedMessages.
   */
  private maybeNudgeCompact(key: string): void {
    const liveSession = this.liveSessions.get(key);
    const ctx = liveSession?.lastResult;
    if (!ctx || ctx.contextMax <= 0 || !usesLcmCompact(key)) return;
    const pct = Math.round((ctx.contextUsed / ctx.contextMax) * 100);
    if (pct < 80) return;
    const groupNote = isGroupSessionKey(key)
      ? " This is a group session — scope the rollup to this group's conversation (threads, decisions, group dynamics); don't mix in personal/DM context from elsewhere."
      : "";
    this.runWithRetry(
      key,
      `System: Context usage is at ${pct}% (${ctx.contextUsed}/${ctx.contextMax} tokens). Use the lcm compact skill to free up space before the next user message.${groupNote} After the compact finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`,
    ).catch(() => {});
  }

  private async handleMessage(channel: Channel, message: IncomingMessage): Promise<void> {
    const hasImages = message.images && message.images.length > 0;
    const hasDocuments = message.documents && message.documents.length > 0;
    const isGroup = message.isGroup ?? false;
    const isMentioned = message.isMentioned ?? false;

    log.info(
      {
        channel: channel.name,
        sender: message.senderName,
        group: isGroup || undefined,
        mentioned: isMentioned || undefined,
        images: hasImages ? message.images!.length : undefined,
        documents: hasDocuments ? message.documents!.length : undefined,
      },
      message.text,
    );

    // Group secret activation: if message matches the secret, add group to allowlist
    if (isGroup && config.groupSecret && message.text.trim() === config.groupSecret) {
      await this.activateGroup(channel, message.chatId);
      return;
    }

    // Allowlist check: reject messages from unknown senders
    if (!this.router.isAllowed(channel.name, message.chatId)) {
      log.debug({ channel: channel.name, chatId: message.chatId }, "Message blocked (not in allowlist)");
      return;
    }

    const resolution = this.router.resolve(channel.name, message.chatId, isGroup);
    const key = resolution.sessionKey;
    const replyChannel = this.getChannel(resolution.replyTarget.channelName) ?? channel;
    const replyChatId = resolution.replyTarget.chatId;

    const textForAgent = isGroup ? `${message.senderName}: ${message.text}` : message.text;

    if (isGroup) {
      this.updateGroupContext(key, message.senderName, message.chatTitle);
    }
    this.recordLatestInboundMessage(key, channel, message);

    this.sessions.append(key, {
      role: "user",
      content: textForAgent,
      channel: channel.name,
      senderName: message.senderName,
      timestamp: message.timestamp,
    });

    const isPassiveGroup = isGroup && this.isPassiveListenGroup(channel.name, message.chatId);

    if (isGroup && !isMentioned && !isPassiveGroup) {
      log.debug("Group message ignored (not mentioned)");
      return;
    }

    // Passive groups: skip typing indicator (most messages will be NO_REPLY)
    const stopTyping = isPassiveGroup ? () => {} : replyChannel.startTyping(replyChatId);

    try {
      const stampedText = this.drainPendingNotes(key) + this.injectTimestamp(textForAgent, channel.name);

      const stream = replyChannel.createStreamingMessage(replyChatId, isGroup ? message.id : undefined);
      const response = await this.runWithRetry(
        key,
        stampedText,
        (text) => stream.update(text.replace(ATTACHMENT_TAG_RE, "").trim()),
        message.images,
        this.makeBlockHandler(replyChannel, replyChatId, stream),
        message.documents,
      );
      await stopTyping();

      this.maybeNudgeCompact(key);

      this.sessions.append(key, {
        role: "assistant",
        content: response,
        channel: replyChannel.name,
        timestamp: Date.now(),
      });

      await this.deliverResponse(replyChannel, replyChatId, response, stream);
    } catch (err) {
      await stopTyping();
      log.error({ err }, "Error handling message");

      // Passive groups: suppress error messages to avoid polluting the chat
      if (isPassiveGroup) return;

      const detail = err instanceof Error ? err.message : String(err);
      await replyChannel.send({
        chatId: replyChatId,
        text: `[error] ${detail}`,
      });
    }
  }

  /**
   * Process 2+ messages that piled up behind an in-flight turn as a single
   * follow-up turn. Handles DMs and passive groups; mention-required groups
   * never reach this path.
   */
  private async handleBatchedMessages(
    items: Array<{ channel: Channel; message: IncomingMessage }>,
  ): Promise<void> {
    const last = items[items.length - 1];
    const lastChannel = last.channel;
    const lastMessage = last.message;
    const isGroup = lastMessage.isGroup ?? false;
    const isPassiveGroup = isGroup && this.isPassiveListenGroup(lastChannel.name, lastMessage.chatId);

    log.info(
      { channel: lastChannel.name, sender: lastMessage.senderName, count: items.length, group: isGroup || undefined },
      `batched: ${items.map((it) => JSON.stringify(it.message.text.slice(0, 40))).join(" | ")}`,
    );

    if (!this.router.isAllowed(lastChannel.name, lastMessage.chatId)) {
      log.debug(
        { channel: lastChannel.name, chatId: lastMessage.chatId },
        "Batched messages blocked (not in allowlist)",
      );
      return;
    }

    const resolution = this.router.resolve(lastChannel.name, lastMessage.chatId, isGroup);
    const key = resolution.sessionKey;
    const replyChannel = this.getChannel(resolution.replyTarget.channelName) ?? lastChannel;
    const replyChatId = resolution.replyTarget.chatId;

    for (const { channel, message } of items) {
      if (isGroup) this.updateGroupContext(key, message.senderName, message.chatTitle);
      this.recordLatestInboundMessage(key, channel, message);
      const transcriptText = isGroup ? `${message.senderName}: ${message.text}` : message.text;
      this.sessions.append(key, {
        role: "user",
        content: transcriptText,
        channel: channel.name,
        senderName: message.senderName,
        timestamp: message.timestamp,
      });
    }

    const stopTyping = isPassiveGroup ? () => {} : replyChannel.startTyping(replyChatId);

    try {
      const numbered = items.map((it, i) => {
        const text = isGroup ? `${it.message.senderName}: ${it.message.text}` : it.message.text;
        return `${i + 1}. ${text}`;
      }).join("\n");
      const subject = isGroup
        ? `${items.length} messages arrived from this group in quick succession`
        : `User sent ${items.length} messages in quick succession`;
      const combined = `[${subject} — read them all together before responding; later messages may revise or cancel earlier ones]\n${numbered}`;
      const stampedText = this.drainPendingNotes(key) + this.injectTimestamp(combined, lastChannel.name);
      const allImages = items.flatMap((it) => it.message.images ?? []);
      const allDocuments = items.flatMap((it) => it.message.documents ?? []);

      const stream = replyChannel.createStreamingMessage(replyChatId, isGroup ? lastMessage.id : undefined);
      const response = await this.runWithRetry(
        key,
        stampedText,
        (text) => stream.update(text.replace(ATTACHMENT_TAG_RE, "").trim()),
        allImages.length > 0 ? allImages : undefined,
        this.makeBlockHandler(replyChannel, replyChatId, stream),
        allDocuments.length > 0 ? allDocuments : undefined,
      );
      await stopTyping();

      this.maybeNudgeCompact(key);

      this.sessions.append(key, {
        role: "assistant",
        content: response,
        channel: replyChannel.name,
        timestamp: Date.now(),
      });

      await this.deliverResponse(replyChannel, replyChatId, response, stream);
    } catch (err) {
      await stopTyping();
      log.error({ err }, "Error handling batched messages");
      if (isPassiveGroup) return;
      const detail = err instanceof Error ? err.message : String(err);
      await replyChannel.send({ chatId: replyChatId, text: `[error] ${detail}` });
    }
  }

  private async runWithRetry(
    key: string,
    prompt: string,
    onText?: (text: string) => void,
    images?: Array<{ data: string; mediaType: string }>,
    onBlockComplete?: (text: string) => void | Promise<void>,
    documents?: Array<{ data: string; mediaType: string; filename?: string }>,
  ): Promise<string> {
    try {
      const session = this.getOrCreateLiveSession(key);
      const response = await session.send(prompt, onText, images, onBlockComplete, documents);

      // Capture session ID if new
      const sid = session.getSessionId();
      if (sid && !this.sessions.getSdkSessionId(key)) {
        this.sessions.setSdkSessionId(key, sid);
        log.info({ sessionId: sid, key }, "Session ID captured");
      }

      // Save stats
      if (session.lastResult) {
        this.sessions.updateStats(key, session.lastResult);
      }

      // If compact happened during this turn, reload the session on next turn
      if (sid && checkAndClearCompactTrigger(sid)) {
        this.closeLiveSession(key);
        log.info({ key }, "Session reloaded after compact");
      }

      // Context-usage hysteresis: nudge agent to run `tomo lcm daily` when
      // context usage crosses the high-water mark; reset when it drops back
      // below the low-water mark (a successful compact knocks it well under).
      // Skip when the session uses SDK auto-compact (only groups opted out via
      // config.lcm.groupCompactStyle="sdk"; DMs and groups by default use LCM).
      if (sid && usesLcmCompact(key)) {
        const HIGH = config.lcm.nudgeAtPct / 100;
        const LOW = config.lcm.nudgeResetPct / 100;
        const ctxUsed = session.lastResult?.contextUsed ?? 0;
        const ctxMax = session.lastResult?.contextMax ?? 0;
        const usedFrac = ctxMax > 0 ? ctxUsed / ctxMax : 0;
        const nudged = this.contextNudged.get(key) === true;

        if (usedFrac < LOW && nudged) {
          this.contextNudged.set(key, false);
        }

        if (usedFrac >= HIGH && !nudged) {
          this.contextNudged.set(key, true);
          const pct = Math.round(usedFrac * 100);
          const groupNote = isGroupSessionKey(key)
            ? " This is a group session — scope the summary to this group's conversation (threads, decisions, group dynamics); don't mix in personal/DM context from elsewhere."
            : "";
          const nudge = `System: Context usage is at ${pct}% of the window. Please run \`tomo lcm daily --session-id ${sid} --summary "<today-so-far>"\` to roll up today's activity. Two things to know: (1) the daily compact OVERRIDES today's existing daily block — it does not append; write a fresh summary covering the whole day. (2) The command preserves the last ${config.lcm.dailyFreshTail} raw events as fresh tail.${groupNote} After the compact finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`;
          log.info({ key, usedPct: `${pct}%` }, "Context nudge (agent should run lcm daily)");
          // Fire-and-forget — don't block the current reply on the nudge
          this.handleCronMessage(nudge, key).catch((err) => {
            log.warn({ err, key }, "Context nudge failed");
          });
        }
      }

      return response;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "";

      if (errMsg.includes("maximum number of turns")) {
        log.warn("Hit max turns, returning partial response");
        return "I ran out of steps trying to complete that. Can you try a simpler request?";
      }

      // Session error — reset and retry once
      if (errMsg.includes("No conversation found") || errMsg.includes("session") || errMsg.includes("closed")) {
        log.warn({ err }, "Session error, resetting and retrying");
        this.closeLiveSession(key);
        this.sessions.clearSdkSessionId(key);

        const session = this.getOrCreateLiveSession(key);
        return session.send(prompt, onText, images, onBlockComplete, documents);
      }

      throw err;
    }
  }

  /** Track participants and chat title for a group session. The actual rules
   *  (passive listen, NO_REPLY guidance, participant snapshot) are now part of
   *  the system prompt — see SessionContext.group in sdkOptions — so they
   *  survive compaction. This stays as pure persistence + in-memory tracking;
   *  no LLM injection. */
  private updateGroupContext(key: string, senderName: string, chatTitle?: string): void {
    let participants = this.groupParticipants.get(key);
    if (!participants) {
      participants = new Set();
      this.groupParticipants.set(key, participants);
    }
    participants.add(senderName);
    this.sessions.addParticipant(key, senderName);
    if (chatTitle) this.sessions.setChatTitle(key, chatTitle);
  }

  private injectTimestamp(text: string, channelName?: string): string {
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

  /** Handle a cron-triggered message (queued per session key) */
  async handleCronMessage(message: string, sessionKey: string): Promise<void> {
    return this.enqueueForSession(sessionKey, () => this.processCronMessage(message, sessionKey))
      .catch((err) => {
        log.error({ err, sessionKey }, "Cron message failed in queue");
      });
  }

  private async processCronMessage(message: string, sessionKey: string): Promise<void> {
    const key = sessionKey;
    let deliveryChannel: Channel;
    let deliveryChatId: string;

    if (sessionKey.startsWith("dm:")) {
      // Unified identity session — read persisted replyTarget, fall back to identity config
      const identityName = sessionKey.slice(3);
      const target =
        this.router.getReplyTarget(sessionKey) ??
        this.router.deriveReplyTargetFromConfig(identityName);
      if (!target) {
        log.warn({ sessionKey }, "Cron: no reply target for dm session");
        return;
      }
      const ch = this.getChannel(target.channelName);
      if (!ch) {
        log.warn({ sessionKey, channelName: target.channelName }, "Cron: channel not loaded");
        return;
      }
      deliveryChannel = ch;
      deliveryChatId = target.chatId;
    } else {
      // Raw per-channel key: <channel>:<chatId> (DM without identity, or group chat)
      const colonIdx = sessionKey.indexOf(":");
      if (colonIdx < 0) {
        log.warn({ sessionKey }, "Cron: invalid session key");
        return;
      }
      const channelName = sessionKey.slice(0, colonIdx);
      const chatId = sessionKey.slice(colonIdx + 1);
      const ch = this.getChannel(channelName);
      if (!ch) {
        log.warn({ sessionKey, channelName }, "Cron: channel not loaded");
        return;
      }
      deliveryChannel = ch;
      deliveryChatId = chatId;
    }

    const stampedMessage = this.drainPendingNotes(key) + this.injectTimestamp(message, deliveryChannel.name);
    log.info({ channel: deliveryChannel.name, sender: "cron" }, message);

    const stopTyping = deliveryChannel.startTyping(deliveryChatId);

    try {
      const response = await this.runWithRetry(key, stampedMessage);
      await stopTyping();

      log.info({ channel: deliveryChannel.name }, "Tomo: %s", response);

      if (isSilentReply(response) || response.includes("NO_REPLY")) {
        log.info("Cron completed silently (no reply sent)");
        return;
      }

      this.sessions.append(key, {
        role: "assistant",
        content: response,
        channel: deliveryChannel.name,
        timestamp: Date.now(),
      });

      await deliveryChannel.send({ chatId: deliveryChatId, text: response });
    } catch (err) {
      await stopTyping();
      log.error({ err }, "Cron message handling failed");
      const detail = err instanceof Error ? err.message : String(err);
      await deliveryChannel.send({ chatId: deliveryChatId, text: `[error] cron failed: ${detail}` });
    }
  }

  /** Handle a continuity heartbeat — runs on the first active DM session (queued) */
  async handleContinuity(prompt: string): Promise<void> {
    // Resolve target session key first so we can enqueue against it
    const dmKey = this.router.findFirstDmSession();
    let key: string;

    if (dmKey) {
      key = dmKey;
    } else {
      const channel = this.channels[0];
      if (!channel) { log.warn("Continuity: no channel available"); return; }
      const chatId = this.findLastChatId(channel.name);
      if (!chatId) { log.debug("Continuity: no active session, skipping"); return; }
      key = `${channel.name}:${chatId}`;
    }

    return this.enqueueForSession(key, () => this.processContinuity(prompt, key))
      .catch((err) => {
        log.error({ err, sessionKey: key }, "Continuity failed in queue");
      });
  }

  private async processContinuity(prompt: string, key: string): Promise<void> {
    try {
      const response = await this.runWithRetry(key, this.drainPendingNotes(key) + prompt);
      log.info("Continuity response: %s", response.slice(0, 100));

      // Send non-silent responses to the user (check includes() for multi-turn responses
      // where NO_REPLY may appear after earlier text output)
      if (!isSilentReply(response) && !response.includes("NO_REPLY")) {
        const replyTarget = this.router.getReplyTarget(key)
          ?? (key.startsWith("dm:") ? this.router.deriveReplyTargetFromConfig(key.slice(3)) : undefined)
          ?? this.parseChannelKey(key);

        if (replyTarget) {
          const channel = this.getChannel(replyTarget.channelName);
          if (channel) {
            const { cleanText, mediaPaths, stickerIds } = extractAttachments(response);
            if (mediaPaths.length > 0 || stickerIds.length > 0) {
              const validPaths = mediaPaths.filter((p) => existsSync(p));
              let sentText = false;
              for (const path of validPaths) {
                await channel.send({
                  chatId: replyTarget.chatId,
                  photo: path,
                  text: !sentText ? cleanText : "",
                });
                sentText = true;
              }
              for (const stickerId of stickerIds) {
                await channel.send({
                  chatId: replyTarget.chatId,
                  sticker: stickerId,
                  text: "",
                });
              }
              if (!sentText && cleanText) {
                await channel.send({ chatId: replyTarget.chatId, text: cleanText });
              }
            } else {
              await channel.send({ chatId: replyTarget.chatId, text: cleanText });
            }
          }
        }
      }
    } catch (err) {
      log.error({ err }, "Continuity heartbeat failed");
    }
  }

  /** Parse a "channel:chatId" key into a reply target (fallback for non-identity users).
   *  Skips group chats (Telegram negative IDs, iMessage group GUIDs). */
  private parseChannelKey(key: string): ReplyTarget | undefined {
    if (key.startsWith("dm:")) return undefined; // dm keys use deriveReplyTargetFromConfig
    const colonIdx = key.indexOf(":");
    if (colonIdx < 0) return undefined;
    const channelName = key.slice(0, colonIdx);
    const chatId = key.slice(colonIdx + 1);
    if (!channelName || !chatId) return undefined;
    // Skip Telegram group chats (negative IDs)
    if (channelName === "telegram" && chatId.startsWith("-")) return undefined;
    // Skip iMessage group chats (GUID contains ";+;")
    if (channelName === "imessage" && chatId.includes(";+;")) return undefined;
    return { channelName, chatId };
  }

  private findLastChatId(channelName: string): string | undefined {
    for (const [key] of this.sessions.listSdkSessionIds()) {
      if (key.startsWith(`${channelName}:`)) {
        return key.slice(channelName.length + 1);
      }
    }
    return undefined;
  }

  /**
   * Direct mode: post a verbatim message to a target session via Channel.send().
   * No Claude query is invoked for the recipient — the message arrives as-is.
   * A pending note is queued so the recipient's next Claude turn knows context.
   */
  async sendToSession(target: string, text: string): Promise<SendResult> {
    const resolved = this.resolveSendTarget(target);
    if (!resolved) {
      return { ok: false, error: `Unknown target "${target}". Call list_sessions to see valid identities and groups.` };
    }
    const { sessionKey, replyTarget } = resolved;

    const channel = this.getChannel(replyTarget.channelName);
    if (!channel) {
      return { ok: false, error: `Channel "${replyTarget.channelName}" is not connected` };
    }

    await channel.send({ chatId: replyTarget.chatId, text });

    this.sessions.append(sessionKey, {
      role: "assistant",
      content: `[proactive] ${text}`,
      channel: replyTarget.channelName,
      timestamp: Date.now(),
    });

    this.queuePendingNote(sessionKey, `[System: You proactively sent the following message to this conversation earlier (initiated from another session): "${text}"]`);

    log.info({ sessionKey, channel: replyTarget.channelName, chars: text.length }, "Proactive message sent (direct)");
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

    if (!this.getChannel(replyTarget.channelName)) {
      return { ok: false, error: `Channel "${replyTarget.channelName}" is not connected` };
    }

    const systemMsg = `[System: From your other conversation, you were asked to: ${request}. Use this conversation's context, tone, and participants to respond appropriately. Reply NO_REPLY if you judge it shouldn't be sent.]`;

    // Fire-and-forget — handleCronMessage enqueues per session and runs through
    // a normal Claude turn. The user verifies the outcome in the channel.
    this.handleCronMessage(systemMsg, sessionKey).catch((err) => {
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

    const channel = this.getChannel(replyTarget.channelName);
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

    this.sessions.setChatTitle(sessionKey, trimmedTitle);
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

    const channel = this.getChannel(latest.channelName);
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
    // Identity name (no colon) → dm:<name>
    if (!target.includes(":")) {
      const identity = config.identities.find((i) => i.name === target);
      if (!identity) return undefined;
      const sessionKey = `dm:${identity.name}`;
      const replyTarget = this.router.getReplyTarget(sessionKey)
        ?? this.router.deriveReplyTargetFromConfig(identity.name);
      return replyTarget ? { sessionKey, replyTarget } : undefined;
    }
    // Session key form (dm:<name> or <channel>:<chatId>)
    // Use parseRawChannelKey, NOT parseChannelKey — the latter rejects group
    // chats by design (it's for sendNotification's "find any DM" fallback).
    // Here the caller explicitly named a target; honor it even if it's a group.
    const replyTarget = this.router.getReplyTarget(target)
      ?? (target.startsWith("dm:") ? this.router.deriveReplyTargetFromConfig(target.slice(3)) : undefined)
      ?? this.parseRawChannelKey(target);
    return replyTarget ? { sessionKey: target, replyTarget } : undefined;
  }

  /** Parse a "<channel>:<chatId>" key into a ReplyTarget. Group-friendly; for
   *  explicit-target paths only. Use parseChannelKey for notification fallbacks. */
  private parseRawChannelKey(key: string): ReplyTarget | undefined {
    if (key.startsWith("dm:")) return undefined;
    const colonIdx = key.indexOf(":");
    if (colonIdx < 0) return undefined;
    const channelName = key.slice(0, colonIdx);
    const chatId = key.slice(colonIdx + 1);
    if (!channelName || !chatId) return undefined;
    return { channelName, chatId };
  }

  /** Catalog of valid send_message targets, with friendly metadata for groups. Backs the `list_sessions` tool. */
  listSessionCatalog(): SessionCatalog {
    const identities = config.identities.map((i) => ({ name: i.name }));
    const groups: SessionCatalog["groups"] = [];
    for (const [key] of this.sessions.listSdkSessionIds()) {
      if (!isGroupSessionKey(key)) continue;
      const entry = this.sessions.getEntry(key);
      groups.push({
        key,
        ...(entry?.chatTitle ? { title: entry.chatTitle } : {}),
        ...(entry?.participants && entry.participants.length > 0 ? { participants: entry.participants } : {}),
      });
    }
    return { identities, groups };
  }

  private recordLatestInboundMessage(sessionKey: string, channel: Channel, message: IncomingMessage): void {
    // Incoming channels are expected to provide provider message ids; keep the
    // guard defensive so synthetic/test messages cannot poison reaction state.
    if (!message.id) return;
    this.latestInboundMessages.set(sessionKey, {
      channelName: channel.name,
      chatId: message.chatId,
      messageId: message.id,
    });
  }

  private queuePendingNote(sessionKey: string, note: string): void {
    const arr = this.pendingNotes.get(sessionKey) ?? [];
    arr.push(note);
    this.pendingNotes.set(sessionKey, arr);
  }

  /** Drain notes queued for this session (e.g. by sendToSession) and return them as a prefix. */
  private drainPendingNotes(sessionKey: string): string {
    const notes = this.pendingNotes.get(sessionKey);
    if (!notes || notes.length === 0) return "";
    this.pendingNotes.delete(sessionKey);
    return notes.map((n) => `${n}\n\n`).join("");
  }

  /** Send a direct notification to the user's DM channel (no agent query) */
  async sendNotification(text: string): Promise<void> {
    const dmKey = this.router.findFirstDmSession();
    let target: ReplyTarget | undefined;

    if (dmKey) {
      target = this.router.getReplyTarget(dmKey)
        ?? (dmKey.startsWith("dm:") ? this.router.deriveReplyTargetFromConfig(dmKey.slice(3)) : undefined)
        ?? this.parseChannelKey(dmKey);
    }

    if (!target) {
      // No identity session — find the first DM (non-group) session across all channels
      for (const [key] of this.sessions.listSdkSessionIds()) {
        const parsed = this.parseChannelKey(key);
        if (parsed) { target = parsed; break; }
      }
    }

    if (!target) { log.debug("Notification: no active DM session"); return; }

    const channel = this.getChannel(target.channelName);
    if (!channel) return;

    await channel.send({ chatId: target.chatId, text });
  }

  async start(): Promise<void> {
    log.info({ channels: this.channels.length }, "Starting Tomo");
    await Promise.all(this.channels.map((ch) => ch.start()));
    log.info("Tomo is running");

    // Check for restart reason and notify via continuity-style message
    if (existsSync(RESTART_REASON_FILE)) {
      const reason = readFileSync(RESTART_REASON_FILE, "utf-8").trim();
      try { unlinkSync(RESTART_REASON_FILE); } catch { /* ignore */ }
      if (reason) {
        log.info({ reason }, "Restart reason found, notifying agent");
        this.handleContinuity(`System: Restarted. Reason: ${reason}`).catch((err) =>
          log.error({ err }, "Failed to send restart reason")
        );
      }
    }
  }

  async stop(): Promise<void> {
    log.info("Shutting down");
    for (const [, s] of this.liveSessions) s.close();
    this.liveSessions.clear();
    await Promise.all(this.channels.map((ch) => ch.stop()));
  }
}
