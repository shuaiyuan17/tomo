import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type { Channel, IncomingMessage, MessageReaction, StopTyping, StopTypingOptions } from "./channels/types.js";
import { config, CONFIG_PATH, RESTART_REASON_FILE } from "./config.js";
import { buildSystemPrompt } from "./workspace/index.js";
import { SessionStore } from "./sessions/index.js";
import type { ReplyTarget } from "./sessions/types.js";
import {
  isGroupSessionKey,
  isDmSessionKey,
  dmIdentityFromSessionKey,
  parseRawSessionKey,
  privateReplyTargetFromSessionKey,
  replyTargetFromRawSessionKey,
} from "./sessions/keys.js";
import { IdentityRouter, type SessionResolution } from "./router.js";
import { SummonStore } from "./sessions/summon-store.js";
import { createTomoInternalMcpServer } from "./mcp/internal-server.js";
import { McpOAuthManager } from "./mcp/oauth.js";
import { log } from "./logger.js";
import { type QueryResult, type TurnRequest } from "./agent/live-session.js";
import { usesLcmCompact } from "./agent/sdk-options.js";
import { isSilentReply, ATTACHMENT_TAG_RE } from "./agent/text-utils.js";
import { audienceOf, audienceSwitchNote } from "./agent/audience.js";
import { InboundBatcher, type InboundItem } from "./agent/inbound-batcher.js";
import { ChatCommandHandler, backupConfigFile } from "./agent/commands.js";
import { SessionQueue } from "./agent/session-queue.js";
import { PendingNotesQueue } from "./agent/pending-notes-queue.js";
import { DeliveryPipeline, isAgentErrorResponse } from "./agent/delivery-pipeline.js";
import { TurnRunner, embeddedSilentMatcher, type RunWithRetryRequest } from "./agent/turn-runner.js";
import { LiveSessionManager } from "./agent/live-session-manager.js";
import { ProactiveSendService, type SendResult, type SessionCatalog } from "./agent/proactive-send.js";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeJsonAtomicSync } from "./fs-utils.js";

export type { SendResult, SessionCatalog } from "./agent/proactive-send.js";

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

export class Agent {
  private channels: Channel[] = [];
  private sessions: SessionStore;
  private router: IdentityRouter;
  private sessionQueue = new SessionQueue();
  private batcher = new InboundBatcher({
    enqueueForSession: (key, task) => this.enqueueForSession(key, task),
    processInboundItems: (items, steer) => this.processInboundItems(items, steer),
    hasBusyLiveSession: (key) => this.liveSessionManager.isBusy(key),
  });
  private commands: ChatCommandHandler;
  private modelOverrides = new Map<string, string>();
  // Context-usage hysteresis: the highest nudge level already fired for the
  // current over-threshold episode. Cleared when usage drops back below
  // config.lcm.nudgeResetPct.
  private contextNudged = new Map<string, "daily" | "compact">();
  private pendingNotesQueue: PendingNotesQueue;
  private delivery: DeliveryPipeline;
  private turnRunner: TurnRunner;
  private liveSessionManager: LiveSessionManager;
  private proactive: ProactiveSendService;
  // Last inbound audience per dm: session ("dm" or a raw group key). With
  // summoning, one session interleaves private and group traffic — this is
  // how the harness detects the hop and reminds the model the audience changed.
  private lastAudiences = new Map<string, string>();
  private readonly mcpOAuthManager: McpOAuthManager;

  constructor() {
    this.sessions = new SessionStore(config.sessionsDir, config.historyLimit, config.sdkSessionsDir);
    this.pendingNotesQueue = new PendingNotesQueue(this.sessions);
    this.delivery = new DeliveryPipeline({
      queuePendingErrorNote: (sessionKey, visibleError) => this.queuePendingErrorNote(sessionKey, visibleError),
    });
    // Late-bound closures: runWithRetry must dispatch through `this` at call
    // time (tests replace it on the instance).
    this.turnRunner = new TurnRunner({
      drainPendingNotes: (sessionKey) => this.drainPendingNotes(sessionKey),
      runWithRetry: (req) => this.runWithRetry(req),
      appendAssistantTranscript: (sessionKey, content, channelName) => {
        this.sessions.append(sessionKey, {
          role: "assistant",
          content,
          channel: channelName,
          timestamp: Date.now(),
        });
      },
      queuePendingErrorNote: (sessionKey, visibleError) => this.queuePendingErrorNote(sessionKey, visibleError),
      startTurnTyping: (channel, chatId, passiveListen) => this.startTurnTyping(channel, chatId, passiveListen),
      delivery: this.delivery,
    });
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
      closeLiveSession: (key) => this.liveSessionManager.closeLiveSession(key),
      isSessionLive: (key) => this.liveSessionManager.isAlive(key),
      queuePendingNote: (key, note) => this.queuePendingNote(key, note),
    });
    this.mcpOAuthManager = new McpOAuthManager({
      workspaceDir: config.workspaceDir,
      onServerAuthError: (serverName, err) => this.handleMcpAuthFailure(serverName, err),
    });
    this.liveSessionManager = new LiveSessionManager({
      buildSystemPrompt: () => buildSystemPrompt(),
      getSdkSessionId: (key) => this.sessions.getSdkSessionId(key),
      setSdkSessionId: (key, sessionId) => this.sessions.setSdkSessionId(key, sessionId),
      clearSdkSessionId: (key) => this.sessions.clearSdkSessionId(key),
      retireSdkSessionId: (key) => { this.sessions.retireSdkSessionId(key); },
      updateStats: (key, result) => this.sessions.updateStats(key, result),
      getSessionMessages: (key) => this.sessions.get(key).messages,
      getModelOverride: (key) => this.modelOverrides.get(key),
      createInternalMcpServer: (key) => createTomoInternalMcpServer(this, key),
      buildExternalMcpServers: (key) => this.mcpOAuthManager.buildServersWithAuth(
        config.mcpServers ?? {},
        (serverName, url) => this.forwardMcpAuthorizeUrl(key, serverName, url),
      ),
      buildGroupContext: (key) => this.buildGroupContext(key),
      handleMcpElicitation: (key, request) => this.handleMcpElicitation(key, request),
      createUnownedTurnRequest: (key) => this.createUnownedTurnRequest(key),
      maybeNudgeCompact: (key, ctx) => this.maybeNudgeCompact(key, ctx),
    });
    this.proactive = new ProactiveSendService({
      getChannel: (name) => this.getChannel(name),
      getSummonedIdentity: (channelName, chatId) => this.router.getSummonedIdentity(channelName, chatId),
      getReplyTarget: (sessionKey) => this.router.getReplyTarget(sessionKey),
      deriveReplyTargetFromConfig: (identityName) => this.router.deriveReplyTargetFromConfig(identityName),
      appendAssistantTranscript: (sessionKey, content, channelName) => {
        this.sessions.append(sessionKey, {
          role: "assistant",
          content,
          channel: channelName,
          timestamp: Date.now(),
        });
      },
      setChatTitle: (sessionKey, title) => this.sessions.setChatTitle(sessionKey, title),
      listActiveEntries: () => this.sessions.listActiveEntries(),
      queuePendingNote: (sessionKey, note) => this.queuePendingNote(sessionKey, note),
      runDelegateTurn: (systemMsg, sessionKey) => this.handleCronMessage(systemMsg, sessionKey),
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
    return this.sessionQueue.enqueue(sessionKey, task);
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
    if (!isDmSessionKey(key) || audiences.length === 0) return "";
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

    const identityName = dmIdentityFromSessionKey(sessionKey);
    if (identityName !== undefined) {
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
      onBlockComplete: this.delivery.makeBlockHandler(channel, chatId, stream),
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
          await this.delivery.deliverResponse(key, channel, chatId, response, stream);
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
    const identityName = dmIdentityFromSessionKey(key);
    if (identityName !== undefined) {
      return this.router.getReplyTarget(key) ?? this.router.deriveReplyTargetFromConfig(identityName);
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
  private maybeNudgeCompact(key: string, ctx: QueryResult | null = this.liveSessionManager.lastResult(key)): void {
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
    await this.turnRunner.runTurn({
      key: req.key,
      prompt: req.promptText,
      stampChannelName: req.sourceChannelName,
      typing: { channel: req.replyChannel, chatId: req.replyChatId, passiveListen: req.passiveListen },
      delivery: {
        kind: "stream",
        channel: req.replyChannel,
        chatId: req.replyChatId,
        replyToMessageId: req.replyToMessageId,
        images: req.images,
        documents: req.documents,
        steer: req.steer,
      },
      silentMatcher: isSilentReply,
      transcript: "always",
      errors: {
        visiblePrefix: "[error] ",
        // Agent-error responses stream back like any text and are handled by
        // DeliveryPipeline.deliverResponse; this only covers thrown errors.
        response: "deliver",
        thrown: req.suppressErrors ? "ignore" : "deliver",
        thrownLogMessage: req.errorLogMessage,
      },
    });
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
    const isSummoned = isGroup && isDmSessionKey(key);
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
    const summonTargets = isDmSessionKey(key)
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

  /** Thin delegate kept on Agent so TurnRunner's late-bound dep (and tests
   *  that stub it on the instance) dispatch through `this`. */
  private runWithRetry(req: RunWithRetryRequest): Promise<string> {
    return this.liveSessionManager.runWithRetry(req);
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
    if (!isDmSessionKey(sessionKey)) return prefixed;
    const label = message.chatTitle ?? this.sessions.getEntry(`${channel.name}:${message.chatId}`)?.chatTitle;
    return `[group${label ? ` "${label}"` : ""}] ${prefixed}`;
  }

  /** Track participants and chat title for a group session. The actual rules
   *  (passive listen, NO_REPLY guidance, participant snapshot) are now part of
   *  the system prompt — see SessionContext.group in sdkOptions — so they
   *  survive compaction. This stays as pure persistence; no LLM injection. */
  private updateGroupContext(key: string, senderName: string, chatTitle?: string): void {
    this.sessions.addParticipant(key, senderName);
    if (chatTitle) this.sessions.setChatTitle(key, chatTitle);
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

    log.info({ channel: deliveryChannel.name, sender: "cron" }, message);

    // Scheduled infrastructure failures must never be posted into a group.
    // Silent housekeeping turns suppress them in DMs as well when requested.
    const suppressErrorDelivery = isGroupSessionKey(key) || options.suppressDelivery === true;

    return this.turnRunner.runTurn({
      key,
      prompt: message,
      stampChannelName: deliveryChannel.name,
      ...(options.showTyping === false ? {} : {
        typing: {
          channel: deliveryChannel,
          chatId: deliveryChatId,
          passiveListen: this.isPassiveReplyTarget(deliveryChannel.name, deliveryChatId),
        },
      }),
      delivery: {
        kind: "send",
        channel: deliveryChannel,
        chatId: deliveryChatId,
        suppressDelivery: options.suppressDelivery,
        suppressedLog: "Cron output suppressed from chat delivery",
      },
      silentMatcher: embeddedSilentMatcher,
      silentLog: "Cron completed silently (no reply sent)",
      transcript: "on-delivery",
      logResponse: (response) => log.info({ channel: deliveryChannel.name }, "Tomo: %s", response),
      errors: {
        visiblePrefix: "[error] cron failed: ",
        response: suppressErrorDelivery ? "note-only" : "deliver",
        responseSuppressedLog: "Cron error suppressed from chat delivery",
        thrown: suppressErrorDelivery ? "note-only" : "deliver",
        thrownSuppressedLog: "Thrown cron error suppressed from chat delivery",
        thrownLogMessage: "Cron message handling failed",
      },
    });
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
    await this.turnRunner.runTurn({
      key,
      prompt,
      // No timestamp stamp, no typing indicator, no transcript — continuity
      // turns are invisible unless the model chooses to speak.
      delivery: {
        kind: "deferred-send",
        resolveTarget: () => {
          const identityName = dmIdentityFromSessionKey(key);
          const replyTarget = this.router.getReplyTarget(key)
            ?? (identityName !== undefined ? this.router.deriveReplyTargetFromConfig(identityName) : undefined)
            ?? privateReplyTargetFromSessionKey(key);
          if (!replyTarget) return undefined;
          const channel = this.getChannel(replyTarget.channelName);
          return channel ? { channel, chatId: replyTarget.chatId } : undefined;
        },
      },
      silentMatcher: embeddedSilentMatcher,
      transcript: "never",
      logResponse: (response) => log.info("Continuity response: %s", response.slice(0, 100)),
      errors: {
        visiblePrefix: "[error] continuity failed: ",
        response: "note-only",
        responseSuppressedLog: "Continuity returned an agent error response",
        thrown: "ignore",
        thrownLogMessage: "Continuity heartbeat failed",
      },
    });
  }

  private findLastChatId(channelName: string): string | undefined {
    for (const [key] of this.sessions.listSdkSessionIds()) {
      const parsed = parseRawSessionKey(key);
      if (parsed?.channelName === channelName) return parsed.chatId;
    }
    return undefined;
  }

  // Proactive messaging (send_message, list_sessions, rename_group_chat,
  // react_to_message MCP tools) — thin delegates so the MCP server wiring
  // keeps calling Agent's public surface. See agent/proactive-send.ts.

  async sendToSession(target: string, text: string, callerSessionKey?: string): Promise<SendResult> {
    return this.proactive.sendToSession(target, text, callerSessionKey);
  }

  async delegateToSession(target: string, request: string): Promise<SendResult> {
    return this.proactive.delegateToSession(target, request);
  }

  async renameGroupChat(target: string, title: string): Promise<SendResult> {
    return this.proactive.renameGroupChat(target, title);
  }

  async reactToLatestMessage(target: string, reaction: MessageReaction, remove = false): Promise<SendResult> {
    return this.proactive.reactToLatestMessage(target, reaction, remove);
  }

  listSessionCatalog(): SessionCatalog {
    return this.proactive.listSessionCatalog();
  }

  private recordLatestInboundMessage(sessionKey: string, channel: Channel, message: IncomingMessage): void {
    this.proactive.recordLatestInboundMessage(sessionKey, channel, message);
  }

  private queuePendingNote(sessionKey: string, note: string): void {
    this.pendingNotesQueue.queueNote(sessionKey, note);
  }

  private queuePendingErrorNote(sessionKey: string, visibleError: string): void {
    this.pendingNotesQueue.queueError(sessionKey, visibleError);
  }

  /** Drain notes queued for this session and return them as a prefix. */
  private drainPendingNotes(sessionKey: string): string {
    return this.pendingNotesQueue.drain(sessionKey);
  }

  /** Send a direct notification to the user's DM channel (no agent query) */
  async sendNotification(text: string): Promise<void> {
    const dmKey = this.router.findFirstDmSession();
    let target: ReplyTarget | undefined;

    if (dmKey) {
      const identityName = dmIdentityFromSessionKey(dmKey);
      target = this.router.getReplyTarget(dmKey)
        ?? (identityName !== undefined ? this.router.deriveReplyTargetFromConfig(identityName) : undefined)
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
    log.info("Shutting down");
    this.commands.stop();
    this.liveSessionManager.stop();
    await Promise.all(this.channels.map((ch) => ch.stop()));
  }
}
