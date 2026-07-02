import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type { Channel, IncomingMessage, MessageReaction, StopTyping, StopTypingOptions, StreamingMessage } from "./channels/types.js";
import { config, CONFIG_PATH, RESTART_REASON_FILE } from "./config.js";
import { buildSystemPrompt } from "./workspace/index.js";
import { SessionStore } from "./sessions/index.js";
import type { ReplyTarget } from "./sessions/types.js";
import { checkAndClearCompactTrigger } from "./lcm/index.js";
import {
  isGroupSessionKey,
  parseRawSessionKey,
  privateReplyTargetFromSessionKey,
  replyTargetFromRawSessionKey,
} from "./sessions/keys.js";
import { IdentityRouter, type SessionResolution } from "./router.js";
import { SummonStore } from "./sessions/summon-store.js";
import { createTomoInternalMcpServer } from "./mcp/internal-server.js";
import { McpOAuthManager } from "./mcp/oauth.js";
import { log } from "./logger.js";
import { LiveSession, QUERY_TIMEOUT_ERROR_PREFIX, STEER_MERGED, type QueryResult, type TurnRequest } from "./agent/live-session.js";
import { makeTurnBudget, sdkOptions, usesLcmCompact } from "./agent/sdk-options.js";
import { isSilentReply, ATTACHMENT_TAG_RE, extractAttachments } from "./agent/text-utils.js";
import { deliverTextParts } from "./channels/delivery.js";
import { restoreLiteralNewlines } from "./channels/text-utils.js";
import { normalizeSendTarget } from "./agent/send-target.js";
import { audienceOf, audienceSwitchNote } from "./agent/audience.js";
import { InboundBatcher, type InboundItem } from "./agent/inbound-batcher.js";
import { ChatCommandHandler, backupConfigFile } from "./agent/commands.js";
import { repairSdkSessionForResume } from "./sessions/repair.js";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeJsonAtomicSync } from "./fs-utils.js";

export type SendResult = { ok: true } | { ok: false; error: string };

export interface SessionCatalog {
  identities: Array<{ name: string }>;
  groups: Array<{ key: string; title?: string; participants?: string[] }>;
}

interface UserTurnRequest {
  key: string;
  promptText: string;
  sourceChannelName: string;
  replyChannel: Channel;
  replyChatId: string;
  replyToMessageId?: string;
  images?: IncomingMessage["images"];
  documents?: IncomingMessage["documents"];
  suppressErrors: boolean;
  errorLogMessage: string;
  /** Steer this turn into the session's in-flight turn (config `steering`)
   *  instead of running through the per-session queue. */
  steer?: boolean;
  /** True for turns where most inputs are expected to resolve to NO_REPLY. */
  passiveListen?: boolean;
}

/** Cap on queued pending notes per session — a session that goes a long time
 *  without a turn (e.g. a busy summoned group) keeps only the most recent. */
const MAX_PENDING_NOTES = 15;

interface CronTurnOptions {
  /** False for silent housekeeping turns such as LCM rollups. */
  showTyping?: boolean;
  /** Never deliver this turn's model output to the chat. The turn still runs
   *  so housekeeping tools can complete; failures remain in logs/pending
   *  operational context. */
  suppressDelivery?: boolean;
}

// Context-usage percentage at which the nudge escalates from a daily rollup
// (config.lcm.nudgeAtPct) to a full lcm compact.
const COMPACT_NUDGE_PCT = 80;
const MAX_PENDING_ERROR_NOTES = 3;
const MAX_PENDING_ERROR_CHARS = 1200;
const MAX_SINGLE_PENDING_ERROR_CHARS = 600;

function truncateForPendingError(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

function pendingErrorChars(notes: string[]): number {
  return notes.reduce((sum, note) => sum + note.length, 0);
}

function isAgentErrorResponse(response: string): boolean {
  const text = response.trim();
  return /^API Error: \d+/i.test(text)
    || /^Failed to authenticate\.\s+API Error: \d+/i.test(text)
    || /^\{"type":"error"/.test(text)
    || /^You['’]ve hit (?:your )?(?:session )?limit\b/i.test(text);
}

export class Agent {
  private channels: Channel[] = [];
  private sessions: SessionStore;
  private router: IdentityRouter;
  private liveSessions = new Map<string, LiveSession>();
  // Busy sessions retired by a prompt change: removed from liveSessions (so
  // their key gets a fresh session) but still running an in-flight turn.
  // Tracked so stop() can close them — they'd otherwise outlive shutdown.
  private retiringSessions = new Set<LiveSession>();
  private liveSessionCreates = new Map<string, Promise<LiveSession>>();
  private messageQueues = new Map<string, Promise<void>>();
  private batcher = new InboundBatcher({
    enqueueForSession: (key, task) => this.enqueueForSession(key, task),
    processInboundItems: (items, steer) => this.processInboundItems(items, steer),
    hasBusyLiveSession: (key) => {
      const live = this.liveSessions.get(key);
      return !!live?.isAlive() && live.isBusy();
    },
  });
  private commands: ChatCommandHandler;
  private groupParticipants = new Map<string, Set<string>>();
  private modelOverrides = new Map<string, string>();
  private lastPromptHash: string = "";
  // Context-usage hysteresis: the highest nudge level already fired for the
  // current over-threshold episode. Cleared when usage drops back below
  // config.lcm.nudgeResetPct.
  private contextNudged = new Map<string, "daily" | "compact">();
  // System notes queued by harness events and direct sends, drained and
  // prepended to the next user/cron/continuity turn.
  private pendingNotes = new Map<string, string[]>();
  // Bounded operational errors from prior turns, drained into the next prompt
  // so Tomo can recover with context instead of pretending nothing happened.
  private pendingErrorNotes = new Map<string, string[]>();
  private latestInboundMessages = new Map<string, { channelName: string; chatId: string; messageId: string }>();
  // Last inbound audience per dm: session ("dm" or a raw group key). With
  // summoning, one session interleaves private and group traffic — this is
  // how the harness detects the hop and reminds the model the audience changed.
  private lastAudiences = new Map<string, string>();
  private stopping = false;
  private readonly mcpOAuthManager: McpOAuthManager;

  constructor() {
    this.sessions = new SessionStore(config.sessionsDir, config.historyLimit, config.sdkSessionsDir);
    const summons = new SummonStore(
      join(config.tomoHome, "data", "summons.json"),
      config.summonExpiryMinutes * 60_000,
    );
    this.router = new IdentityRouter(config.identities, this.sessions, config.channelAllowlists, summons);
    this.router.onSummonExpired = (channelName, chatId, identity, notifyGroup) =>
      this.handleSummonExpired(channelName, chatId, identity, notifyGroup);
    this.commands = new ChatCommandHandler({
      router: this.router,
      sessions: this.sessions,
      modelOverrides: this.modelOverrides,
      closeLiveSession: (key) => this.closeLiveSession(key),
      isSessionLive: (key) => this.liveSessions.get(key)?.isAlive() ?? false,
      queuePendingNote: (key, note) => this.queuePendingNote(key, note),
    });
    this.mcpOAuthManager = new McpOAuthManager({
      workspaceDir: config.workspaceDir,
      onServerAuthError: (serverName, err) => this.handleMcpAuthFailure(serverName, err),
    });

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

  private typingStartDelayMs(channelName: string, passiveListen = false): number {
    if (channelName !== "imessage") return 0;
    const ms = passiveListen ? config.imessagePassiveTypingStartDelayMs : config.imessageTypingStartDelayMs;
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  private isPassiveReplyTarget(channelName: string, chatId: string): boolean {
    return isGroupSessionKey(`${channelName}:${chatId}`) && this.isPassiveListenGroup(channelName, chatId);
  }

  private startTurnTyping(channel: Channel, chatId: string, passiveListen = false): StopTyping {
    const delayMs = this.typingStartDelayMs(channel.name, passiveListen);
    if (delayMs <= 0) return channel.startTyping(chatId);

    let sealed = false;
    let started: StopTyping | null = null;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      if (sealed) return;
      started = channel.startTyping(chatId);
    }, delayMs);

    return async (options?: StopTypingOptions) => {
      if (sealed) return;
      sealed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (started) await started(options);
    };
  }

  /** Snapshot of group metadata for the system prompt — null for non-group sessions. */
  private buildGroupContext(sessionKey: string): { chatTitle?: string; participants?: string[]; isPassive: boolean } | undefined {
    if (!isGroupSessionKey(sessionKey)) return undefined;
    const parsed = parseRawSessionKey(sessionKey);
    const entry = this.sessions.getEntry(sessionKey);
    return {
      ...(entry?.chatTitle ? { chatTitle: entry.chatTitle } : {}),
      ...(entry?.participants && entry.participants.length > 0 ? { participants: entry.participants } : {}),
      isPassive: parsed ? this.isPassiveListenGroup(parsed.channelName, parsed.chatId) : false,
    };
  }

  /** Activate a group chat by adding it to the channel's allowlist */
  private async activateGroup(channel: Channel, chatId: string): Promise<void> {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
      if (!channels[channel.name]) channels[channel.name] = {};
      const allowlist = ((channels[channel.name].allowlist ?? []) as string[]);
      if (!allowlist.includes(chatId)) {
        allowlist.push(chatId);
        channels[channel.name].allowlist = allowlist;
        cfg.channels = channels;
        backupConfigFile();
        writeJsonAtomicSync(CONFIG_PATH, cfg, { mode: 0o600 });
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
    channel.onCommand((cmd, chatId, senderName, args, senderId) =>
      this.commands.handle(channel, cmd, chatId, senderName, args, senderId));
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
   * from being stomped by overlapping callers. (With config `steering`,
   * user messages may bypass this queue via LiveSession.steer(), which is
   * the one sanctioned concurrent path.)
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
   * Route an inbound message into the InboundBatcher: DMs and passive groups
   * coalesce rapid messages into one turn; mention-required groups process
   * per-message (mention filtering would be lost otherwise). Resolves once
   * queued, not when the turn completes.
   */
  private async enqueueMessage(channel: Channel, message: IncomingMessage): Promise<void> {
    const isGroup = message.isGroup ?? false;

    // Allowlist gate at receipt, BEFORE resolving: a disallowed chat must not
    // touch routing state (resolve() extends a summon's activity clock) or
    // enter a coalesced batch. Group-secret activation still goes through
    // handleMessage, which handles the secret before its own allowlist check.
    if (!this.router.isAllowed(channel.name, message.chatId)) {
      if (isGroup && config.groupSecret && message.text.trim() === config.groupSecret) {
        this.enqueueForSession(`${channel.name}:${message.chatId}`, () => this.handleMessage(channel, message))
          .catch((err) => log.error({ err, chatId: message.chatId }, "Unhandled error in message queue"));
      } else {
        log.debug({ channel: channel.name, chatId: message.chatId }, "Message blocked at receipt (not in allowlist)");
      }
      return;
    }

    // Resolve ONCE, at receipt — this decides both which queue the message
    // waits in and which session eventually processes it. Re-resolving at
    // processing time would let a /summon or /dismiss that lands while the
    // message waits (in-flight turn, iMessage settle window) re-route it.
    const resolution = this.router.resolve(channel.name, message.chatId, isGroup);
    const sessionKey = resolution.sessionKey;

    const isPassiveGroup = isGroup && this.isPassiveListenGroup(channel.name, message.chatId);
    const canCoalesce = !isGroup || isPassiveGroup;

    if (!canCoalesce) {
      this.enqueueForSession(sessionKey, () => this.handleMessage(channel, message, false, resolution))
        .catch((err) => log.error({ err, sessionKey }, "Unhandled error in message queue"));
      return;
    }

    this.batcher.enqueue(sessionKey, channel, message, canCoalesce, resolution);
  }

  private async processInboundItems(items: InboundItem[], steer = false): Promise<void> {
    // Re-check the allowlist PER ITEM at processing time: it can change while
    // a batch waits (settle window, in-flight turn), and dm: batches may mix
    // items from several chats — a tail-only check would let a now-disallowed
    // group's stale items ride along with an allowed DM message.
    const allowed = items.filter((it) => this.router.isAllowed(it.channel.name, it.message.chatId));
    if (allowed.length < items.length) {
      log.debug({ dropped: items.length - allowed.length }, "Batched items dropped (no longer in allowlist)");
    }
    if (allowed.length === 0) return;
    if (allowed.length === 1) {
      await this.handleMessage(allowed[0].channel, allowed[0].message, steer, allowed[0].resolution);
      return;
    }
    await this.handleBatchedMessages(allowed, steer);
  }

  /** A summon lapsed from inactivity (lazy-detected by the router). Always brief
   *  the dm session so its "summoned" context is cleared; only post the
   *  group-facing handback notice when the lapse was caught while routing a real
   *  group message (`notifyGroup`) — a guard read from `/summon`/`/status`/
   *  `/dismiss` must not emit a spurious group message. */
  private handleSummonExpired(channelName: string, chatId: string, identity: string, notifyGroup: boolean): void {
    const rawKey = `${channelName}:${chatId}`;
    const groupLabel = this.sessions.getEntry(rawKey)?.chatTitle ?? rawKey;
    this.queuePendingNote(
      `dm:${identity}`,
      `[System: Your summon into the group "${groupLabel}" expired after inactivity — its messages no longer reach this session; the group's own Tomo session has taken back over.]`,
    );
    if (!notifyGroup) return;
    const channel = this.getChannel(channelName);
    if (!channel) return;
    channel.send({ chatId, text: "Summon expired after inactivity — handed back to this group's own Tomo session." })
      .catch((err) => log.warn({ err, channel: channelName, chatId }, "Could not post summon expiry notice"));
  }

  /**
   * Per-turn reminder appended to summoned-group prompts. The reply-routing
   * inversion (text → private DM, group → explicit tool call) is the part the
   * model must not get wrong, and pending notes only fire once — this rides
   * along with every summoned message.
   */
  private summonReminder(targets: string[]): string {
    const list = targets.map((t) => `"${t}"`).join(", ");
    return `[System: summoned-group message. To reply in the group, call send_message with mode "direct" and target ${list}. Plain text in this turn goes to your owner's private DM, not the group — reply NO_REPLY unless you have a private side-note for them.]`;
  }

  /** Audience-switch prefix for a dm session turn (see agent/audience.ts).
   *  Updates tracking state; returns "" when the audience didn't change. */
  private noteAudienceSwitch(key: string, audiences: string[]): string {
    if (!key.startsWith("dm:") || audiences.length === 0) return "";
    const prev = this.lastAudiences.get(key);
    this.lastAudiences.set(key, audiences[audiences.length - 1]);
    const note = audienceSwitchNote(prev, audiences, (a) => this.audienceLabel(a));
    return note ? `${note}\n` : "";
  }

  private audienceLabel(audience: string): string {
    if (audience === "dm") return "the private DM";
    const title = this.sessions.getEntry(audience)?.chatTitle;
    return title ? `the group "${title}" (${audience})` : `the group ${audience}`;
  }
  private async getOrCreateLiveSession(key: string): Promise<LiveSession> {
    const session = this.liveSessions.get(key);
    if (session?.isAlive()) return session;

    const creating = this.liveSessionCreates.get(key);
    if (creating) return creating;

    const create = this.createLiveSession(key);
    this.liveSessionCreates.set(key, create);
    try {
      return await create;
    } finally {
      if (this.liveSessionCreates.get(key) === create) {
        this.liveSessionCreates.delete(key);
      }
    }
  }

  private async createLiveSession(key: string): Promise<LiveSession> {
    let session = this.liveSessions.get(key);
    if (session?.isAlive()) return session;

    // Check prompt changes
    const currentHash = this.hashString(buildSystemPrompt());
    if (this.lastPromptHash && currentHash !== this.lastPromptHash) {
      log.info("System prompt changed, creating new sessions");
      for (const [k, s] of this.liveSessions) {
        // Removing the session from the map is what retires it — the next
        // message for its key creates a fresh session with the new prompt.
        // Closing a busy session here would reject its in-flight turn, and
        // runWithRetry's reset-and-retry branch would then re-run the whole
        // turn, repeating side effects its first half already performed — so
        // the actual close waits for the in-flight turn to finish.
        this.liveSessions.delete(k);
        if (s.isBusy()) {
          this.retiringSessions.add(s);
          void s.waitForIdle().then(() => {
            this.retiringSessions.delete(s);
            s.close();
            log.info({ key: k }, "Session closed after prompt change (deferred past in-flight turn)");
          });
        } else {
          s.close();
        }
      }
    }
    this.lastPromptHash = currentHash;

    const resumeId = this.sessions.getSdkSessionId(key);
    if (resumeId) {
      const repair = repairSdkSessionForResume(
        resumeId,
        this.sessions.get(key).messages,
        config.sdkSessionsDir,
      );
      if (repair.error) {
        log.warn({ key, sessionId: resumeId, error: repair.error }, "Could not repair SDK session before resume");
      }
    }
    const model = this.modelOverrides.get(key);
    const turnBudget = makeTurnBudget();
    const externalMcpServers = await this.mcpOAuthManager.buildServersWithAuth(
      config.mcpServers ?? {},
      (serverName, url) => this.forwardMcpAuthorizeUrl(key, serverName, url),
    );
    // Per-session server instance: binds the caller's session key so tool
    // handlers (e.g. send_message) can attribute cross-session sends.
    const opts = sdkOptions(createTomoInternalMcpServer(this, key), resumeId ?? undefined, model, {
      sessionKey: key,
      sdkSessionId: resumeId ?? undefined,
      group: this.buildGroupContext(key),
      onMcpElicitation: (request) => this.handleMcpElicitation(key, request),
    }, turnBudget, externalMcpServers);

    session = new LiveSession(opts, key, turnBudget, () => this.createUnownedTurnRequest(key));
    this.liveSessions.set(key, session);
    log.info(
      {
        key,
        resume: !!resumeId,
        model: opts.model,
        gateway: opts.env?.ANTHROPIC_BASE_URL ? "litellm" : "native",
      },
      "Live session created",
    );
    return session;
  }

  private async forwardMcpAuthorizeUrl(key: string, serverName: string, url: string): Promise<void> {
    const target = this.resolvePrivateReplyTarget(key);
    if (!target) throw new Error(`No private reply target is available for MCP OAuth login (${serverName})`);
    const channel = this.getChannel(target.channelName);
    if (!channel) throw new Error(`Channel "${target.channelName}" is not connected for MCP OAuth login (${serverName})`);

    await channel.send({
      chatId: target.chatId,
      text: [
        `MCP login required for ${serverName}.`,
        "",
        url,
        "",
        "Open the link and finish login. Tomo will continue after the browser callback completes.",
      ].join("\n"),
    });
  }

  private async handleMcpAuthFailure(serverName: string, err: unknown): Promise<void> {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ serverName, err }, "External MCP server omitted after OAuth failure");

    const target = this.findPrivateReplyTarget();
    if (!target) return;
    const channel = this.getChannel(target.channelName);
    if (!channel) return;

    await channel.send({
      chatId: target.chatId,
      text: `MCP server "${serverName}" is unavailable because OAuth failed or timed out: ${detail}. Continuing without that server.`,
    });
  }

  private async handleMcpElicitation(key: string, request: ElicitationRequest): Promise<ElicitationResult> {
    const target = this.resolvePrivateReplyTarget(key);
    if (!target) {
      log.warn({ key, server: request.serverName }, "MCP elicitation requested but no private reply target is available");
      return { action: "decline" };
    }

    const channel = this.getChannel(target.channelName);
    if (!channel) {
      log.warn({ key, channelName: target.channelName, server: request.serverName }, "MCP elicitation requested but channel is not connected");
      return { action: "decline" };
    }

    if (request.mode === "url" && request.url) {
      const lines = [
        `MCP login required for ${request.serverName}.`,
        request.message,
        "",
        request.url,
        "",
        "Open the link and finish login. If Tomo does not continue automatically, retry your request after login completes.",
      ];
      await channel.send({ chatId: target.chatId, text: lines.filter(Boolean).join("\n") });
      log.info({ key, server: request.serverName }, "Forwarded MCP login URL to user");
      return { action: "accept" };
    }

    await channel.send({
      chatId: target.chatId,
      text: `MCP server ${request.serverName} requested additional input, but Tomo can only forward browser login links right now.`,
    });
    log.warn({ key, server: request.serverName, mode: request.mode }, "Declined unsupported MCP elicitation");
    return { action: "decline" };
  }

  private resolveDeliveryTargetForSession(
    sessionKey: string,
    source: string,
  ): { channel: Channel; chatId: string } | undefined {
    let target: ReplyTarget | undefined;

    if (sessionKey.startsWith("dm:")) {
      const identityName = sessionKey.slice(3);
      target = this.router.getReplyTarget(sessionKey)
        ?? this.router.deriveReplyTargetFromConfig(identityName);
      if (!target) {
        log.warn({ sessionKey }, "%s: no reply target for dm session", source);
        return undefined;
      }
    } else {
      target = replyTargetFromRawSessionKey(sessionKey);
      if (!target) {
        log.warn({ sessionKey }, "%s: invalid session key", source);
        return undefined;
      }
    }

    const channel = this.getChannel(target.channelName);
    if (!channel) {
      log.warn({ sessionKey, channelName: target.channelName }, "%s: channel not loaded", source);
      return undefined;
    }

    return { channel, chatId: target.chatId };
  }

  private createUnownedTurnRequest(key: string): TurnRequest | undefined {
    const target = this.resolveDeliveryTargetForSession(key, "Background task");
    if (!target) return undefined;

    const { channel, chatId } = target;
    const stream = channel.createStreamingMessage(chatId);
    const stopTyping = this.startTurnTyping(channel, chatId, this.isPassiveReplyTarget(channel.name, chatId));
    let settled = false;

    const stop = async () => {
      try {
        await stopTyping({ clear: true });
      } catch (err) {
        log.warn({ err, key, channel: channel.name }, "Background task typing cleanup failed");
      }
    };

    return {
      onText: (text) => stream.update(text.replace(ATTACHMENT_TAG_RE, "").trim()),
      onBlockComplete: this.makeBlockHandler(channel, chatId, stream),
      resolve: async (response) => {
        if (settled) return;
        settled = true;
        try {
          this.maybeNudgeCompact(key);
          if (!isSilentReply(response) && !isAgentErrorResponse(response)) {
            this.sessions.append(key, {
              role: "assistant",
              content: response,
              channel: channel.name,
              timestamp: Date.now(),
            });
          }
          await this.deliverResponse(key, channel, chatId, response, stream);
        } catch (err) {
          log.error({ err, key }, "Background task response delivery failed");
          try {
            await stream.cancel();
          } catch {
            // Best effort: the delivery failure was already logged above.
          }
        } finally {
          await stop();
        }
      },
      reject: async (err) => {
        if (settled) return;
        settled = true;
        log.error({ err, key }, "Background task turn failed");
        try {
          await stream.cancel();
        } catch {
          // Best effort; keep the SDK event loop alive.
        } finally {
          await stop();
        }
      },
    };
  }

  private resolvePrivateReplyTarget(key: string): ReplyTarget | undefined {
    if (key.startsWith("dm:")) {
      return this.router.getReplyTarget(key) ?? this.router.deriveReplyTargetFromConfig(key.slice(3));
    }

    if (!isGroupSessionKey(key)) {
      return privateReplyTargetFromSessionKey(key);
    }

    for (const identity of config.identities) {
      const target = this.router.deriveReplyTargetFromConfig(identity.name);
      if (target) return target;
    }
    return undefined;
  }

  private findPrivateReplyTarget(): ReplyTarget | undefined {
    for (const [key] of this.sessions.listSdkSessionIds()) {
      const target = this.resolvePrivateReplyTarget(key);
      if (target) return target;
    }

    for (const identity of config.identities) {
      const target = this.router.deriveReplyTargetFromConfig(identity.name);
      if (target) return target;
    }
    return undefined;
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
    sessionKey: string,
    replyChannel: Channel,
    replyChatId: string,
    response: string,
    stream: StreamingMessage,
  ): Promise<void> {
    log.info({ channel: replyChannel.name, session: sessionKey }, "Tomo: %s", response);

    if (isSilentReply(response)) {
      log.info("Silent reply (no message sent)");
      await stream.cancel();
      return;
    }

    // Surface SDK/API errors that arrive as response text.
    if (isAgentErrorResponse(response)) {
      const visibleError = `[error] ${response}`;
      this.queuePendingErrorNote(sessionKey, visibleError);
      await stream.cancel();
      await replyChannel.send({ chatId: replyChatId, text: visibleError });
      return;
    }

    await stream.finish();
  }

  /**
   * Deliver assistant text that bypasses StreamingMessage. Caption text rides
   * with the first MEDIA send; plain text is split the same way streamed text is.
   */
  private async deliverAssistantContent(
    channel: Channel,
    chatId: string,
    text: string,
    parsed = extractAttachments(text),
  ): Promise<void> {
    const { cleanText, mediaPaths, stickerIds } = parsed;
    const validPaths = mediaPaths.filter((path) => existsSync(path));
    const caption = restoreLiteralNewlines(cleanText);
    let textSent = false;

    for (const [i, path] of validPaths.entries()) {
      await channel.send({ chatId, photo: path, text: i === 0 ? caption : "" });
      if (i === 0 && caption) textSent = true;
    }

    if (!textSent) {
      await deliverTextParts(channel, chatId, cleanText);
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
        if (isAgentErrorResponse(blockText)) {
          await stream.cancel();
          return;
        }
        const attachments = extractAttachments(blockText);
        if (attachments.mediaPaths.length > 0 || attachments.stickerIds.length > 0) {
          await stream.discardBlock();
          await this.deliverAssistantContent(channel, chatId, blockText, attachments);
          return;
        }
        await stream.commitBlock();
      } catch (err) {
        log.warn({ err, channel: channel.name }, "Block delivery failed");
      }
    };
  }

  /**
   * Single context-pressure nudge path, evaluated once per completed turn:
   * runWithRetry covers owned turns (user, cron, continuity); unowned SDK
   * background turns call it from their resolve handler. Skips when SDK
   * auto-compact owns this session.
   *
   * Two escalation levels share one hysteresis latch, so a turn that lands
   * at ≥ COMPACT_NUDGE_PCT queues exactly one housekeeping turn instead of
   * two: at config.lcm.nudgeAtPct ask for a `tomo lcm daily` rollup; at
   * COMPACT_NUDGE_PCT escalate to the lcm compact skill. The latch re-arms
   * when usage drops back below nudgeResetPct (a successful compact knocks
   * it well under).
   *
   * The nudge goes through handleCronMessage so it runs in the per-session
   * queue. Calling runWithRetry directly here would overlap with the next
   * user message's send() and stomp LiveSession's single currentRequest slot,
   * silently swallowing one of the two responses.
   *
   * Callers that hold the turn's session pass its lastResult explicitly —
   * the compact-trigger reload may have already dropped the session from
   * liveSessions, and the latch must still see the result to stay accurate.
   */
  private maybeNudgeCompact(key: string, ctx: QueryResult | null = this.liveSessions.get(key)?.lastResult ?? null): void {
    if (!usesLcmCompact(key)) return;
    if (!ctx || ctx.contextMax <= 0) return;

    const usedFrac = ctx.contextUsed / ctx.contextMax;
    const nudged = this.contextNudged.get(key);

    if (usedFrac < config.lcm.nudgeResetPct / 100) {
      if (nudged) this.contextNudged.delete(key);
      return;
    }

    // The compact threshold never sits below the daily threshold, so a
    // custom nudgeAtPct ≥ COMPACT_NUDGE_PCT escalates straight to compact.
    const compactFrac = Math.max(COMPACT_NUDGE_PCT, config.lcm.nudgeAtPct) / 100;
    const pct = Math.round(usedFrac * 100);
    const groupNote = isGroupSessionKey(key)
      ? " This is a group session — scope the rollup to this group's conversation (threads, decisions, group dynamics); don't mix in personal/DM context from elsewhere."
      : "";

    let nudge: string;
    if (usedFrac >= compactFrac && nudged !== "compact") {
      this.contextNudged.set(key, "compact");
      nudge = `System: Context usage is at ${pct}% (${ctx.contextUsed}/${ctx.contextMax} tokens). Use the lcm compact skill to free up space before the next user message.${groupNote} After the compact finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`;
      log.info({ key, usedPct: `${pct}%` }, "Context nudge (agent should run lcm compact)");
    } else if (usedFrac >= config.lcm.nudgeAtPct / 100 && !nudged) {
      const sid = this.sessions.getSdkSessionId(key);
      if (!sid) return;
      this.contextNudged.set(key, "daily");
      nudge = `System: Context usage is at ${pct}% of the window. Please run \`tomo lcm daily --session-id ${sid} --summary "<today-so-far>"\` to roll up today's activity. Two things to know: (1) the daily compact OVERRIDES today's existing daily block — it does not append; write a fresh summary covering the whole day. (2) The command preserves the last ${config.lcm.dailyFreshTail} raw events as fresh tail.${groupNote} After the compact finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`;
      log.info({ key, usedPct: `${pct}%` }, "Context nudge (agent should run lcm daily)");
    } else {
      return;
    }

    this.handleCronMessage(nudge, key, {
      showTyping: false,
      suppressDelivery: isGroupSessionKey(key),
    }).catch((err) => {
      log.warn({ err, key }, "Compact nudge failed");
    });
  }

  private async runUserTurn(req: UserTurnRequest): Promise<void> {
    const stopTyping = this.startTurnTyping(req.replyChannel, req.replyChatId, req.passiveListen);

    try {
      const stampedText = this.drainPendingNotes(req.key) + this.injectTimestamp(req.promptText, req.sourceChannelName);
      const stream = req.replyChannel.createStreamingMessage(req.replyChatId, req.replyToMessageId);
      const response = await this.runWithRetry(
        req.key,
        stampedText,
        (text) => stream.update(text.replace(ATTACHMENT_TAG_RE, "").trim()),
        req.images,
        this.makeBlockHandler(req.replyChannel, req.replyChatId, stream),
        req.documents,
        req.steer,
      );

      if (req.steer && response === STEER_MERGED) {
        // Steered message merged into the in-flight turn — that turn's owner
        // streams and records the combined reply; nothing to deliver here.
        await stopTyping({ clear: true });
        await stream.cancel();
        return;
      }

      this.sessions.append(req.key, {
        role: "assistant",
        content: response,
        channel: req.replyChannel.name,
        timestamp: Date.now(),
      });

      await this.deliverResponse(req.key, req.replyChannel, req.replyChatId, response, stream);
      await stopTyping({ clear: true });
    } catch (err) {
      log.error({ err }, req.errorLogMessage);

      if (req.suppressErrors) {
        await stopTyping({ clear: true });
        return;
      }

      const detail = err instanceof Error ? err.message : String(err);
      const visibleError = `[error] ${detail}`;
      this.queuePendingErrorNote(req.key, visibleError);
      try {
        await req.replyChannel.send({
          chatId: req.replyChatId,
          text: visibleError,
        });
      } finally {
        await stopTyping({ clear: true });
      }
    }
  }

  private async handleMessage(
    channel: Channel,
    message: IncomingMessage,
    steer = false,
    receiptResolution?: SessionResolution,
  ): Promise<void> {
    if (this.commands.isRestoring) return;

    const hasImages = message.images && message.images.length > 0;
    const hasDocuments = message.documents && message.documents.length > 0;
    const isGroup = message.isGroup ?? false;
    const isMentioned = message.isMentioned ?? false;

    log.info(
      {
        channel: channel.name,
        sender: message.senderName,
        chatTitle: isGroup ? message.chatTitle : undefined,
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

    // Prefer the receipt-time resolution (see enqueueMessage) so summon state
    // changes can't re-route a message that was already queued.
    const resolution = receiptResolution ?? this.router.resolve(channel.name, message.chatId, isGroup);
    const key = resolution.sessionKey;
    const replyChannel = this.getChannel(resolution.replyTarget.channelName) ?? channel;
    const replyChatId = resolution.replyTarget.chatId;

    const textForAgent = this.formatGroupText(channel, message, key);

    if (isGroup) {
      // Track group metadata under the raw group key even while summoned, so
      // the group's own session entry stays fresh for when it takes back over.
      this.updateGroupContext(`${channel.name}:${message.chatId}`, message.senderName, message.chatTitle);
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

    // Summoned group message running on the dm session: remind the model how
    // reply routing works this turn, and flag audience hops (DM ↔ group).
    // Prompt-only — the transcript keeps the clean tagged message.
    const isSummoned = isGroup && key.startsWith("dm:");
    const switchNote = this.noteAudienceSwitch(key, [audienceOf(channel.name, message)]);
    const promptText = switchNote + (isSummoned
      ? `${textForAgent}\n${this.summonReminder([`${channel.name}:${message.chatId}`])}`
      : textForAgent);

    await this.runUserTurn({
      key,
      promptText,
      sourceChannelName: channel.name,
      replyChannel,
      // Reply-threading only makes sense when the reply lands in the chat the
      // message came from — not for summoned groups (reply goes to the DM).
      replyToMessageId: isGroup && replyChatId === message.chatId ? message.id : undefined,
      replyChatId,
      images: message.images,
      documents: message.documents,
      suppressErrors: isPassiveGroup,
      errorLogMessage: "Error handling message",
      steer,
      passiveListen: isPassiveGroup,
    });
  }

  /**
   * Process 2+ messages that piled up behind an in-flight turn as a single
   * follow-up turn. Handles DMs and passive groups; mention-required groups
   * never reach this path.
   */
  private async handleBatchedMessages(
    items: InboundItem[],
    steer = false,
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

    // Allowlist is enforced per item by processInboundItems (the only caller)
    // — a tail-only check here would miss mixed batches.

    // All items in a batch share a receipt-time session key (that's how the
    // batch was keyed); use the last item's resolution rather than re-resolving
    // so summon changes can't re-route an already-queued batch.
    const resolution = last.resolution;
    const key = resolution.sessionKey;
    const replyChannel = this.getChannel(resolution.replyTarget.channelName) ?? lastChannel;
    const replyChatId = resolution.replyTarget.chatId;

    for (const { channel, message } of items) {
      if (message.isGroup) this.updateGroupContext(`${channel.name}:${message.chatId}`, message.senderName, message.chatTitle);
      this.recordLatestInboundMessage(key, channel, message);
      const transcriptText = this.formatGroupText(channel, message, key);
      this.sessions.append(key, {
        role: "user",
        content: transcriptText,
        channel: channel.name,
        senderName: message.senderName,
        timestamp: message.timestamp,
      });
    }

    const numbered = items.map((it, i) => {
      const text = this.formatGroupText(it.channel, it.message, key);
      return `${i + 1}. ${text}`;
    }).join("\n");
    const subject = isGroup
      ? `${items.length} messages arrived from this group in quick succession`
      : `User sent ${items.length} messages in quick succession`;
    // On a dm: session any group-originated item is necessarily summoned
    // (non-summoned groups have their own session keys). A batch can even mix
    // DM messages with messages from multiple summoned groups — the per-item
    // [group ...] tags disambiguate; the reminder lists every group target.
    const summonTargets = key.startsWith("dm:")
      ? [...new Set(items.filter((it) => it.message.isGroup).map((it) => `${it.channel.name}:${it.message.chatId}`))]
      : [];
    const reminder = summonTargets.length > 0 ? `\n${this.summonReminder(summonTargets)}` : "";
    const switchNote = this.noteAudienceSwitch(key, items.map((it) => audienceOf(it.channel.name, it.message)));
    const combined = `${switchNote}[${subject} — read them all together before responding; later messages may revise or cancel earlier ones]\n${numbered}${reminder}`;
    const allImages = items.flatMap((it) => it.message.images ?? []);
    const allDocuments = items.flatMap((it) => it.message.documents ?? []);

    await this.runUserTurn({
      key,
      promptText: combined,
      sourceChannelName: lastChannel.name,
      replyChannel,
      replyChatId,
      replyToMessageId: isGroup && replyChatId === lastMessage.chatId ? lastMessage.id : undefined,
      images: allImages.length > 0 ? allImages : undefined,
      documents: allDocuments.length > 0 ? allDocuments : undefined,
      suppressErrors: isPassiveGroup,
      errorLogMessage: "Error handling batched messages",
      steer,
      passiveListen: isPassiveGroup,
    });
  }

  private async runWithRetry(
    key: string,
    prompt: string,
    onText?: (text: string) => void,
    images?: Array<{ data: string; mediaType: string }>,
    onBlockComplete?: (text: string) => void | Promise<void>,
    documents?: Array<{ data: string; mediaType: string; filename?: string }>,
    steer = false,
  ): Promise<string> {
    try {
      const session = await this.getOrCreateLiveSession(key);
      const response = steer
        ? await session.steer(prompt, onText, images, onBlockComplete, documents)
        : await session.send(prompt, onText, images, onBlockComplete, documents);

      // Merged into another request's in-flight turn — that turn's owner
      // does the per-turn bookkeeping (stats, compact triggers) when it
      // resolves; nothing to record for this caller.
      if (steer && response === STEER_MERGED) return response;

      this.recordTurnCompletion(key, session);
      return response;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "";

      if (this.stopping && errMsg.includes("closed")) {
        log.info({ key }, "Session closed during shutdown; preserving SDK session link");
        return "NO_REPLY";
      }

      if (errMsg.includes("maximum number of turns")) {
        log.warn("Hit max turns, returning partial response");
        return "I ran out of steps trying to complete that. Can you try a simpler request?";
      }

      if (errMsg.includes(QUERY_TIMEOUT_ERROR_PREFIX)) {
        log.warn({ err, key }, "Query timed out; retiring SDK session to avoid resuming stale in-flight work");
        this.closeLiveSession(key);
        this.sessions.retireSdkSessionId(key);
        throw err;
      }

      // Session error — reset and retry once
      if (errMsg.includes("No conversation found") || errMsg.includes("session") || errMsg.includes("closed")) {
        // Shutdown closes live sessions while turns may still be in flight
        // (e.g. the agent restarting itself via Bash). That "Session is
        // closed" is not corruption — resetting here is what used to unlink
        // the resume id and silently start the user over on a blank session.
        if (this.stopping) throw err;

        log.warn({ err }, "Session error, resetting and retrying");
        this.closeLiveSession(key);
        // Only a true resume failure invalidates the persisted SDK session
        // id. "Session is closed"-style errors just mean the child process
        // went away; the JSONL history is intact and MUST be kept so the
        // retry resumes it instead of discarding the conversation.
        if (errMsg.includes("No conversation found")) {
          this.sessions.clearSdkSessionId(key);
        }

        const session = await this.getOrCreateLiveSession(key);
        const response = await session.send(prompt, onText, images, onBlockComplete, documents);
        this.recordTurnCompletion(key, session);
        return response;
      }

      throw err;
    }
  }

  /**
   * Post-turn bookkeeping shared by runWithRetry's first attempt and its
   * session-error retry: capture a new SDK session id, persist stats,
   * reload after an external compact, and run the context-pressure check.
   */
  private recordTurnCompletion(key: string, session: LiveSession): void {
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

    // If compact happened during this turn, reload the session on next
    // turn. With steering, a promoted steered turn may already be running
    // on this session — closing now would kill it, so defer the reload
    // until the session is truly idle.
    if (sid && checkAndClearCompactTrigger(sid, config.sdkSessionsDir)) {
      if (session.isBusy()) {
        void session.waitForIdle().then(() => {
          if (this.liveSessions.get(key) === session) {
            this.closeLiveSession(key);
            log.info({ key }, "Session reloaded after compact (deferred past steered turn)");
          }
        });
      } else {
        this.closeLiveSession(key);
        log.info({ key }, "Session reloaded after compact");
      }
    }

    // Fire-and-forget context-pressure check — don't block the current
    // reply on the nudge. Pass this turn's result explicitly: the reload
    // above may have already removed the session from liveSessions.
    this.maybeNudgeCompact(key, session.lastResult);
  }

  /**
   * Prompt/transcript text for an inbound message. Group messages carry the
   * sender's name; summoned group messages (group message running on a dm:
   * session) additionally carry a [group ...] tag — the dm session's system
   * prompt has no group context, so the tag is what tells the model which
   * audience the message came from. Reply routing is covered by the per-turn
   * summonReminder, which is appended to the prompt but kept out of transcripts.
   */
  private formatGroupText(channel: Channel, message: IncomingMessage, sessionKey: string): string {
    if (!message.isGroup) return message.text;
    const prefixed = `${message.senderName}: ${message.text}`;
    if (!sessionKey.startsWith("dm:")) return prefixed;
    const label = message.chatTitle ?? this.sessions.getEntry(`${channel.name}:${message.chatId}`)?.chatTitle;
    return `[group${label ? ` "${label}"` : ""}] ${prefixed}`;
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

  /** Handle a cron-triggered message (queued per session key). Resolves true
   *  when the turn ran cleanly, false when it errored — errors are fully
   *  handled here (logged, surfaced to the chat where appropriate), so the
   *  boolean is a status report for callers like CronScheduler.markRun, not
   *  something to retry on. Never rejects. */
  async handleCronMessage(message: string, sessionKey: string, options: CronTurnOptions = {}): Promise<boolean> {
    return this.enqueueForSession(sessionKey, () => this.processCronMessage(message, sessionKey, options))
      .catch((err) => {
        log.error({ err, sessionKey }, "Cron message failed in queue");
        return false;
      });
  }

  private async processCronMessage(message: string, sessionKey: string, options: CronTurnOptions): Promise<boolean> {
    const key = sessionKey;
    const delivery = this.resolveDeliveryTargetForSession(sessionKey, "Cron");
    if (!delivery) return false;
    const { channel: deliveryChannel, chatId: deliveryChatId } = delivery;

    const stampedMessage = this.drainPendingNotes(key) + this.injectTimestamp(message, deliveryChannel.name);
    log.info({ channel: deliveryChannel.name, sender: "cron" }, message);

    const stopTyping = options.showTyping === false
      ? async () => {}
      : this.startTurnTyping(
          deliveryChannel,
          deliveryChatId,
          this.isPassiveReplyTarget(deliveryChannel.name, deliveryChatId),
        );

    try {
      const response = await this.runWithRetry(key, stampedMessage);
      const silentCronResponse = isSilentReply(response) || response.includes("NO_REPLY");

      log.info({ channel: deliveryChannel.name }, "Tomo: %s", response);

      if (isAgentErrorResponse(response)) {
        const visibleError = `[error] cron failed: ${response}`;
        this.queuePendingErrorNote(key, visibleError);
        // Scheduled infrastructure failures must never be posted into a group.
        // Silent housekeeping turns suppress them in DMs as well when requested.
        if (isGroupSessionKey(key) || options.suppressDelivery) {
          log.warn({ sessionKey: key }, "Cron error suppressed from chat delivery");
          await stopTyping({ clear: true });
          return false;
        }
        await deliveryChannel.send({ chatId: deliveryChatId, text: visibleError });
        await stopTyping({ clear: true });
        return false;
      }

      if (options.suppressDelivery) {
        log.info({ sessionKey: key }, "Cron output suppressed from chat delivery");
        await stopTyping({ clear: true });
        return true;
      }

      if (silentCronResponse) {
        log.info("Cron completed silently (no reply sent)");
        await stopTyping({ clear: true });
        return true;
      }

      this.sessions.append(key, {
        role: "assistant",
        content: response,
        channel: deliveryChannel.name,
        timestamp: Date.now(),
      });

      await this.deliverAssistantContent(deliveryChannel, deliveryChatId, response);
      await stopTyping({ clear: true });
      return true;
    } catch (err) {
      log.error({ err }, "Cron message handling failed");
      const detail = err instanceof Error ? err.message : String(err);
      const visibleError = `[error] cron failed: ${detail}`;
      this.queuePendingErrorNote(key, visibleError);
      if (isGroupSessionKey(key) || options.suppressDelivery) {
        log.warn({ sessionKey: key }, "Thrown cron error suppressed from chat delivery");
        await stopTyping({ clear: true });
        return false;
      }
      try {
        await deliveryChannel.send({ chatId: deliveryChatId, text: visibleError });
      } finally {
        await stopTyping({ clear: true });
      }
      return false;
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

      if (isAgentErrorResponse(response)) {
        this.queuePendingErrorNote(key, `[error] continuity failed: ${response}`);
        log.warn({ sessionKey: key }, "Continuity returned an agent error response");
        return;
      }

      // Send non-silent responses to the user (check includes() for multi-turn responses
      // where NO_REPLY may appear after earlier text output)
      if (!isSilentReply(response) && !response.includes("NO_REPLY")) {
        const replyTarget = this.router.getReplyTarget(key)
          ?? (key.startsWith("dm:") ? this.router.deriveReplyTargetFromConfig(key.slice(3)) : undefined)
          ?? privateReplyTargetFromSessionKey(key);

        if (replyTarget) {
          const channel = this.getChannel(replyTarget.channelName);
          if (channel) {
            await this.deliverAssistantContent(channel, replyTarget.chatId, response);
          }
        }
      }
    } catch (err) {
      log.error({ err }, "Continuity heartbeat failed");
    }
  }

  private findLastChatId(channelName: string): string | undefined {
    for (const [key] of this.sessions.listSdkSessionIds()) {
      const parsed = parseRawSessionKey(key);
      if (parsed?.channelName === channelName) return parsed.chatId;
    }
    return undefined;
  }

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

    const channel = this.getChannel(replyTarget.channelName);
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
    const summoned = this.router.getSummonedIdentity(replyTarget.channelName, replyTarget.chatId);
    const fromSummoner = summoned !== undefined && callerSessionKey === `dm:${summoned}`;

    try {
      this.sessions.append(sessionKey, {
        role: "assistant",
        content: fromSummoner ? `[via dm:${summoned} (summoned)] ${text}` : `[proactive] ${text}`,
        channel: replyTarget.channelName,
        timestamp: Date.now(),
      });
    } catch (err) {
      // The channel send already succeeded. Reporting a tool failure here
      // invites the caller to retry and duplicate the user-visible message.
      log.warn({ err, sessionKey }, "Message delivered but transcript persistence failed");
    }

    this.queuePendingNote(sessionKey, fromSummoner
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
    const normalized = normalizeSendTarget(target, config.identities);
    if (!normalized) return undefined;
    const { sessionKey, identityName } = normalized;

    if (sessionKey.startsWith("dm:")) {
      const replyTarget = this.router.getReplyTarget(sessionKey)
        ?? this.router.deriveReplyTargetFromConfig(identityName ?? sessionKey.slice(3));
      return replyTarget ? { sessionKey, replyTarget } : undefined;
    }

    // Non-dm session key (channel:<chatId> form, possibly a group). The caller
    // explicitly named a target, so honor group chats too.
    const replyTarget = this.router.getReplyTarget(sessionKey)
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
    for (const entry of this.sessions.listActiveEntries()) {
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
    let arr = this.pendingNotes.get(sessionKey);
    if (!arr) {
      try {
        arr = this.sessions.getPendingNotes(sessionKey);
      } catch (err) {
        log.warn({ err, sessionKey }, "Could not load durable pending notes");
        arr = [];
      }
    }
    arr.push(note);
    if (arr.length > MAX_PENDING_NOTES) {
      const dropped = arr.splice(0, arr.length - MAX_PENDING_NOTES).length;
      log.debug({ sessionKey, dropped }, "Pending notes capped at limit; dropped oldest");
    }
    this.pendingNotes.set(sessionKey, arr);
    try {
      this.sessions.setPendingNotes(sessionKey, arr);
    } catch (err) {
      log.warn({ err, sessionKey }, "Could not persist pending notes");
    }
  }

  private queuePendingErrorNote(sessionKey: string, visibleError: string): void {
    const normalized = visibleError.replace(/\s+/g, " ").trim();
    const clipped = truncateForPendingError(normalized, MAX_SINGLE_PENDING_ERROR_CHARS);
    const notes = [...(this.pendingErrorNotes.get(sessionKey) ?? []), clipped].slice(-MAX_PENDING_ERROR_NOTES);

    while (notes.length > 1 && pendingErrorChars(notes) > MAX_PENDING_ERROR_CHARS) {
      notes.shift();
    }
    this.pendingErrorNotes.set(sessionKey, notes);
  }

  /** Drain notes queued for this session and return them as a prefix. */
  private drainPendingNotes(sessionKey: string): string {
    const drained: string[] = [];
    let notes = this.pendingNotes.get(sessionKey);
    if (!notes) {
      try {
        notes = this.sessions.getPendingNotes(sessionKey);
      } catch (err) {
        log.warn({ err, sessionKey }, "Could not load durable pending notes");
        notes = [];
      }
    }
    if (notes && notes.length > 0) {
      drained.push(...notes);
      try {
        this.sessions.setPendingNotes(sessionKey, []);
        this.pendingNotes.delete(sessionKey);
      } catch (err) {
        // Avoid replaying the same note repeatedly in this process. If the
        // durable clear failed, a restart may replay it, which is safer than
        // silently losing context.
        this.pendingNotes.set(sessionKey, []);
        log.warn({ err, sessionKey }, "Could not clear durable pending notes");
      }
    }

    const errorNotes = this.pendingErrorNotes.get(sessionKey);
    if (errorNotes && errorNotes.length > 0) {
      this.pendingErrorNotes.delete(sessionKey);
      drained.push([
        "[System: Recent Tomo errors before this turn (newest last, capped):",
        ...errorNotes.map((note) => `- ${note}`),
        "Use this as operational context; do not repeat the raw error unless it helps the user.]",
      ].join("\n"));
    }

    return drained.map((n) => `${n}\n\n`).join("");
  }

  /** Send a direct notification to the user's DM channel (no agent query) */
  async sendNotification(text: string): Promise<void> {
    const dmKey = this.router.findFirstDmSession();
    let target: ReplyTarget | undefined;

    if (dmKey) {
      target = this.router.getReplyTarget(dmKey)
        ?? (dmKey.startsWith("dm:") ? this.router.deriveReplyTargetFromConfig(dmKey.slice(3)) : undefined)
        ?? privateReplyTargetFromSessionKey(dmKey);
    }

    if (!target) {
      // No identity session — find the first DM (non-group) session across all channels
      for (const [key] of this.sessions.listSdkSessionIds()) {
        const parsed = privateReplyTargetFromSessionKey(key);
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
    this.stopping = true;
    log.info("Shutting down");
    this.commands.stop();
    for (const [, s] of this.liveSessions) s.close();
    this.liveSessions.clear();
    // Prompt-retired sessions waiting out an in-flight turn are not in the
    // map; shutdown must not leave their SDK children running.
    for (const s of this.retiringSessions) s.close();
    this.retiringSessions.clear();
    await Promise.all(this.channels.map((ch) => ch.stop()));
  }
}
