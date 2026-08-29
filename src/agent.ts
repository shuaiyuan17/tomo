import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type { Channel, IncomingMessage, MessageReaction, StopTyping, StopTypingOptions } from "./channels/types.js";
import { config, CONFIG_PATH, RESTART_REASON_FILE } from "./config.js";
import { buildSystemPrompt } from "./workspace/index.js";
import { SessionStore } from "./sessions/index.js";
import type { ReplyTarget, SessionMessage } from "./sessions/types.js";
import {
  isGroupSessionKey,
  isDmSessionKey,
  dmIdentityFromSessionKey,
  parseRawSessionKey,
  privateReplyTargetFromSessionKey,
  replyTargetFromRawSessionKey,
} from "./sessions/keys.js";
import { IdentityRouter, type SessionResolution } from "./router.js";
import { annotateSenderName, autoBindHandle, loadPeople, renderParticipantLabels } from "./people.js";
import { SummonStore } from "./sessions/summon-store.js";
import { PauseStore } from "./sessions/pause-store.js";
import { createTomoInternalMcpServer } from "./mcp/internal-server.js";
import { McpOAuthManager, TOKEN_REFRESH_SWEEP_INTERVAL_MS } from "./mcp/oauth.js";
import { log } from "./logger.js";
import { type QueryResult, type TurnRequest } from "./agent/live-session.js";
import { usesLcmCompact } from "./agent/sdk-options.js";
import { decideContextNudge, type ContextNudgeLatch } from "./agent/context-nudge.js";
import { isSilentReply } from "./agent/text-utils.js";
import { audienceOf, audienceSwitchNote } from "./agent/audience.js";
import { InboundBatcher, type InboundItem } from "./agent/inbound-batcher.js";
import { ChatCommandHandler, backupConfigFile } from "./agent/commands.js";
import { SessionQueue } from "./agent/session-queue.js";
import { PendingNotesQueue } from "./agent/pending-notes-queue.js";
import { DeliveryPipeline, isAgentErrorResponse } from "./agent/delivery-pipeline.js";
import { TurnRunner, type RunWithRetryRequest } from "./agent/turn-runner.js";
import { createOrderedBlockTranscript, DELIVERY_FAILED_MARKER, SHUTDOWN_NOT_PROCESSED } from "./agent/block-transcript.js";
import { LiveSessionManager } from "./agent/live-session-manager.js";
import { ProactiveSendService, type SendResult, type SessionCatalog } from "./agent/proactive-send.js";
import { resolveBlockRange } from "./lcm/blocks.js";
import { formatTomoEvent } from "./tomo-event.js";
import { consumeRestartReasonFile } from "./restart-reason.js";
import { pruneTools } from "./lcm/index.js";
import { watchBus } from "./watch/bus.js";
import type { WatchSessionInfo } from "./watch/protocol.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "./fs-utils.js";
import { CONTINUITY_DELIVERY_NOTE } from "./continuity-defaults.js";

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
  /** Deliver to this exact channel/chat instead of resolving from the
   *  session's reply target. Set when the caller named a specific chat
   *  (delegate sends to a raw channel:chatId target canonicalized to a dm
   *  session key). */
  deliveryTarget?: ReplyTarget;
}

/**
 * Deadlines for the two channel-side shutdown steps. Both exist because
 * `start.ts` cannot call `process.exit()` until `stop()` resolves, so an
 * unbounded await here is a daemon that will not die: `quiesce` waits on
 * attachment IO and a network download, and `teardown` waits on grammY's final
 * `getUpdates`, whose own client timeout defaults to 500 seconds.
 */
const CHANNEL_QUIESCE_TIMEOUT_MS = 10_000;
const CHANNEL_TEARDOWN_TIMEOUT_MS = 10_000;

// Context-usage percentage at which the nudge escalates from a daily rollup
// (config.lcm.nudgeAtPct) to a full lcm compact.
const COMPACT_NUDGE_PCT = 80;

// Prune-first only when the dry run shows enough reclaimable volume to
// plausibly drop usage below the reset threshold; otherwise skip straight to
// the daily rollup rung. chars/4 is fine here because tool output is mostly
// ASCII (JSON, logs, file contents).
const PRUNE_NUDGE_MIN_FRAC = 0.10;

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
  // /pause state: raw group keys whose inbound messages are dropped at receipt.
  private pauses: PauseStore;
  private modelOverrides = new Map<string, string>();
  // Context-usage hysteresis: the highest nudge level already fired for the
  // current over-threshold episode. Cleared when usage drops back below
  // config.lcm.nudgeResetPct.
  private contextNudged = new Map<string, ContextNudgeLatch>();
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
  /** Background sweep that refreshes OAuth tokens before they expire (start/stop). */
  private mcpTokenRefreshTimer: ReturnType<typeof setInterval> | undefined;

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
    this.pauses = new PauseStore(join(config.tomoHome, "data", "pauses.json"));
    this.commands = new ChatCommandHandler({
      router: this.router,
      sessions: this.sessions,
      pauses: this.pauses,
      modelOverrides: this.modelOverrides,
      closeLiveSession: (key) => this.liveSessionManager.closeLiveSession(key),
      isSessionLive: (key) => this.liveSessionManager.isAlive(key),
      queuePendingNote: (key, note) => this.queuePendingNote(key, note),
      getExternalMcpStatuses: (key) => this.mcpOAuthManager.getServerStatuses(
        config.mcpServers ?? {},
        this.liveSessionManager.mountedExternalMcpServers(key),
      ),
      startExternalMcpLogin: (serverName) => this.mcpOAuthManager.startLogin(
        serverName,
        config.mcpServers ?? {},
      ),
    });
    this.mcpOAuthManager = new McpOAuthManager({
      workspaceDir: config.workspaceDir,
      onServerAuthError: (serverName, err) => this.handleMcpAuthFailure(serverName, err),
      onServerAuthReady: (serverName, server) =>
        this.liveSessionManager.hotMountExternalMcpServer(serverName, server),
    });
    this.liveSessionManager = new LiveSessionManager({
      buildSystemPrompt: () => buildSystemPrompt(),
      getSdkSessionId: (key) => this.sessions.getSdkSessionId(key),
      setSdkSessionId: (key, sessionId) => this.sessions.setSdkSessionId(key, sessionId),
      clearSdkSessionId: (key) => this.sessions.clearSdkSessionId(key),
      retireSdkSessionId: (key) => { this.sessions.retireSdkSessionId(key); },
      updateStats: (key, result) => {
        this.sessions.updateStats(key, result);
        watchBus.publish({
          type: "turn.stats",
          sessionKey: key,
          costUsd: result.costUsd,
          contextUsed: result.contextUsed,
          contextMax: result.contextMax,
        });
      },
      getSessionMessages: (key) => this.sessions.get(key).messages,
      getModelOverride: (key) => this.modelOverrides.get(key),
      createInternalMcpServer: (key) => createTomoInternalMcpServer(this, key),
      buildExternalMcpServers: (key) => this.mcpOAuthManager.buildServersWithAuth(
        config.mcpServers ?? {},
        (serverName, url) => this.forwardMcpAuthorizeUrl(key, serverName, url),
        // Interactive OAuth may wait ten minutes for a browser callback. Never
        // put chat/session revival behind that wait: the auth flow continues in
        // the background and the server joins a later live session.
        { authorizationWaitMs: 0 },
      ),
      buildGroupContext: (key) => this.buildGroupContext(key),
      handleMcpElicitation: (key, request) => this.handleMcpElicitation(key, request),
      createUnownedTurnRequest: (key) => this.createUnownedTurnRequest(key),
      maybeNudgeCompact: (key, ctx) => this.maybeNudgeCompact(key, ctx),
      refreshExternalMcpToken: (serverName) => {
        void this.mcpOAuthManager.refreshServerToken(serverName, config.mcpServers ?? {})
          .catch((err) => log.warn({ serverName, err }, "MCP token refresh after an auth error failed"));
      },
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
      runDelegateTurn: (systemMsg, sessionKey, deliveryTarget) =>
        this.handleCronMessage(systemMsg, sessionKey, deliveryTarget ? { deliveryTarget } : {}),
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

    // Resolve raw sender names against the people registry so the prompt
    // shows canonical identities ("Kevin Wang (aka: kw; appears as ...)")
    // instead of whatever display string each provider sent. Private people
    // records are never loaded for group sessions.
    let participants: string[] | undefined;
    if (parsed && entry?.participants && entry.participants.length > 0) {
      participants = renderParticipantLabels({
        channelName: parsed.channelName,
        participants: entry.participants,
        participantIds: entry.participantIds,
        people: loadPeople({ includePrivate: false }),
      });
    }

    return {
      ...(entry?.chatTitle ? { chatTitle: entry.chatTitle } : {}),
      ...(participants && participants.length > 0 ? { participants } : {}),
      isPassive: parsed ? this.isPassiveListenGroup(parsed.channelName, parsed.chatId) : false,
    };
  }

  /** Activate a group chat by adding it to the channel's allowlist */
  private async activateGroup(channel: Channel, chatId: string): Promise<void> {
    try {
      // An open channel (no allowlist) already allows this group. Persisting a
      // one-entry allowlist here would flip the whole channel to enforced and
      // lock out every other chat — including the owner's own DM — until
      // restart. Acknowledge and leave the config alone.
      if (!this.router.hasAllowlist(channel.name)) {
        log.info({ channel: channel.name, chatId }, "Group secret received; channel has no allowlist, group is already active");
        await channel.send({ chatId, text: "Tomo is already active in this group." });
        return;
      }
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
   *
   * Resolves to whether the agent took CUSTODY of the message — see
   * MessageHandler. `true` covers deliberate drops (allowlist, /pause) as well
   * as queued work: the decision was made and recorded here, and the channel
   * should acknowledge the message rather than replay it forever. Only a
   * batcher already drained for shutdown answers `false`.
   */
  private async enqueueMessage(channel: Channel, message: IncomingMessage): Promise<boolean> {
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
      return true;
    }

    // A provider redirect opened on another device cannot reach this Mac's
    // localhost callback listener. Let a configured owner paste that full
    // redirect into their DM instead; consume callback-shaped secrets before
    // they can enter a transcript or model context. Groups and non-owners
    // never reach the OAuth manager.
    if (!isGroup && message.senderId && this.router.identityForSender(channel.name, message.senderId)) {
      const consumed = await this.handlePastedMcpCallback(channel, message);
      if (consumed) return true;
    }

    // /pause gate, BEFORE resolving: a paused group's messages are dropped
    // entirely — they never reach a session, the batcher, or the transcript
    // (and must not extend a summon's activity clock). /resume lifts it;
    // slash commands bypass this path, which is how /resume gets through.
    if (isGroup && this.pauses.isPaused(`${channel.name}:${message.chatId}`)) {
      log.debug({ channel: channel.name, chatId: message.chatId }, "Message dropped (group is paused via /pause)");
      return true;
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
      // Through processInboundItems (not handleMessage directly) so the
      // allowlist and /pause state are re-checked at processing time — this
      // task can wait behind an in-flight turn, and both can change meanwhile.
      this.enqueueForSession(sessionKey, () => this.processInboundItems([{ channel, message, resolution }]))
        .catch((err) => log.error({ err, sessionKey }, "Unhandled error in message queue"));
      return true;
    }

    return this.batcher.enqueue(sessionKey, channel, message, canCoalesce, resolution);
  }

  private async handlePastedMcpCallback(channel: Channel, message: IncomingMessage): Promise<boolean> {
    const result = await this.mcpOAuthManager.completeAuthorizationFromChat(message.text);
    if (result.status === "not-matched") return false;
    if (result.status === "unknown-state") {
      log.warn({ channel: channel.name, chatId: message.chatId }, "Ignored MCP OAuth callback with no matching pending state");
      await channel.send({
        chatId: message.chatId,
        text: "⚠️ That MCP OAuth callback does not match an active login. Start a new flow with /mcp login <server> and paste its full redirect URL.",
      });
      return true;
    }
    if (result.status === "ambiguous") {
      await channel.send({
        chatId: message.chatId,
        text: "⚠️ More than one MCP login is pending. Paste the full localhost redirect URL so its state can identify the server.",
      });
      return true;
    }
    if (result.status === "already-completed") {
      await channel.send({
        chatId: message.chatId,
        text: `⚠️ MCP login for "${result.serverName}" was already completed; this callback is single-use.`,
      });
      return true;
    }
    if (result.status === "failed") {
      await channel.send({
        chatId: message.chatId,
        text: `⚠️ [error] MCP login for "${result.serverName}" failed: ${result.error}`,
      });
      return true;
    }

    const expiry = result.expiresAt !== undefined
      ? ` Token valid until ${new Date(result.expiresAt).toLocaleString()}.`
      : "";
    await channel.send({
      chatId: message.chatId,
      text: `✅ MCP login completed for "${result.serverName}".${expiry} Tomo will attach it to live sessions automatically; if runtime hot-mounting is unavailable, the next session will use it.`,
    });
    return true;
  }

  private async processInboundItems(items: InboundItem[], steer = false): Promise<void> {
    // Re-check the allowlist and /pause state PER ITEM at processing time:
    // both can change while a batch waits (settle window, in-flight turn), and
    // dm: batches may mix items from several chats — a tail-only check would
    // let a now-disallowed or now-paused group's stale items ride along with
    // an allowed DM message.
    const allowed = items.filter((it) =>
      this.router.isAllowed(it.channel.name, it.message.chatId)
      && !((it.message.isGroup ?? false) && this.pauses.isPaused(`${it.channel.name}:${it.message.chatId}`)));
    if (allowed.length < items.length) {
      log.debug({ dropped: items.length - allowed.length }, "Batched items dropped (no longer in allowlist, or group paused)");
    }
    if (allowed.length === 0) return;

    // Receipt-time routing remains stable in the ordinary direction: a
    // /dismiss cannot pull a message already accepted by a summoned dm:
    // session back into the group session. The reverse direction is special:
    // an active /summon owns the group exclusively, so pre-summon backlog must
    // move to that dm: queue instead of reviving the dormant group session.
    const routed = allowed.map((item) => this.rerouteQueuedItemToActiveSummon(item));
    const receiptKey = allowed[0].resolution.sessionKey;
    const routedKey = routed[0].resolution.sessionKey;
    if (routedKey !== receiptKey) {
      this.enqueueForSession(routedKey, () => this.processInboundItems(routed))
        .catch((err) => log.error({ err, sessionKey: routedKey }, "Unhandled error rerouting queued group message to summoned session"));
      return;
    }

    if (routed.length === 1) {
      await this.handleMessage(routed[0].channel, routed[0].message, steer, routed[0].resolution);
      return;
    }
    await this.handleBatchedMessages(routed, steer);
  }

  private rerouteQueuedItemToActiveSummon(item: InboundItem): InboundItem {
    if (!(item.message.isGroup ?? false) || isDmSessionKey(item.resolution.sessionKey)) return item;
    const current = this.router.resolve(item.channel.name, item.message.chatId, true);
    if (!isDmSessionKey(current.sessionKey)) return item;
    log.info(
      { from: item.resolution.sessionKey, to: current.sessionKey, messageId: item.message.id },
      "Queued group message handed to active summoned session",
    );
    return { ...item, resolution: current };
  }

  /** Active summon owner for a raw group-session key, without extending the
   * inactivity clock (cron/restart work is not fresh group traffic). */
  private summonedDmKeyForGroupSession(sessionKey: string): string | undefined {
    if (!isGroupSessionKey(sessionKey)) return undefined;
    const parsed = parseRawSessionKey(sessionKey);
    if (!parsed) return undefined;
    const identity = this.router.getSummonedIdentity(parsed.channelName, parsed.chatId);
    return identity ? `dm:${identity}` : undefined;
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
      formatTomoEvent(
        "summon-expired",
        `Your summon into the group "${groupLabel}" expired after inactivity — its messages no longer reach this session; the group's own Tomo session has taken back over.`,
        { name: rawKey },
      ),
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
    return formatTomoEvent(
      "summon-reminder",
      `Summoned-group message. To reply in the group, call send_message with mode "direct" and target ${list}. Plain text in this turn goes to your owner's private DM, not the group — reply NO_REPLY unless you have a private side-note for them.`,
    );
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
        "Open the link and finish login. If the browser is on another device, paste the full localhost redirect URL back into this private DM so Tomo can complete the callback.",
        "The current turn will continue without this server. After login, Tomo will attach it to live sessions automatically; if runtime hot-mounting is unavailable, the next session will use it.",
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

    return this.channelDeliveryTarget(target, sessionKey, source);
  }

  private channelDeliveryTarget(
    target: ReplyTarget,
    sessionKey: string,
    source: string,
  ): { channel: Channel; chatId: string } | undefined {
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
    const stopTyping = this.startTurnTyping(channel, chatId, this.isPassiveReplyTarget(channel.name, chatId));
    let settled = false;
    // One sender for the whole background turn, so its blocks ship as they
    // complete — same path as every other ingress.
    const sender = this.delivery.createBlockSender(channel, chatId);
    // Ordered per-block transcript, same rule as every owned turn: the slot is
    // taken at dispatch and filled at settle, so an abandoned send cannot let a
    // later block's entry overtake it (see agent/block-transcript.ts).
    const transcript = createOrderedBlockTranscript((entry) => {
      this.sessions.append(key, {
        role: "assistant",
        content: entry,
        channel: channel.name,
        timestamp: Date.now(),
      });
    });

    const stop = async () => {
      try {
        await stopTyping({ clear: true });
      } catch (err) {
        log.warn({ err, key, channel: channel.name }, "Background task typing cleanup failed");
      }
    };

    return {
      onBlock: async (block) => {
        // Error text is not a reply: it is handled once, at resolve, so it
        // reaches the chat prefixed and with a pending note queued.
        if (isAgentErrorResponse(block) || isSilentReply(block)) return;
        const slot = transcript.reserve(block);
        try {
          await sender.deliver(block);
          // Recorded per shipped block — an unrecorded delivery is invisible
          // to recall_conversation (#203) — but recorded AFTER the send, never
          // before. Writing on intent made the transcript claim deliveries
          // that never happened (A sends, B throws, transcript shows both).
          slot.settle(block);
        } catch (err) {
          log.error({ err, key }, "Background task block delivery failed");
          // Still recorded, but MARKED: the turn composed this text, and it is
          // not known to have reached the owner.
          slot.settle(`${DELIVERY_FAILED_MARKER}${block}`);
        }
      },
      onBlockAbandoned: () => transcript.abandonOldest(),
      resolve: async (response) => {
        if (settled) return;
        settled = true;
        try {
          this.maybeNudgeCompact(key);
          log.info({ channel: channel.name, session: key }, "Tomo: %s", response);
          // The turn's own blocks have already shipped; only an agent error
          // still needs delivering (and a pending note queued for it).
          if (isAgentErrorResponse(response)) {
            await this.delivery.deliverResponse(key, channel, chatId, response);
          }
        } catch (err) {
          log.error({ err, key }, "Background task response delivery failed");
        } finally {
          await stop();
        }
      },
      reject: async (err) => {
        if (settled) return;
        settled = true;
        log.error({ err, key }, "Background task turn failed");
        await stop();
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
   * The prune → daily → compact ladder shares one hysteresis latch, so a turn
   * queues exactly one housekeeping turn: first try deterministic
   * `tomo lcm prune-tools` when enough bulky tool output is reclaimable, then
   * `tomo lcm daily`, then the lcm compact skill at COMPACT_NUDGE_PCT. The
   * latch re-arms when usage drops back below nudgeResetPct.
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
    const thresholds = {
      nudgeAtPct: config.lcm.nudgeAtPct,
      nudgeResetPct: config.lcm.nudgeResetPct,
      compactNudgePct: COMPACT_NUDGE_PCT,
    };
    const compactFrac = Math.max(COMPACT_NUDGE_PCT, config.lcm.nudgeAtPct) / 100;
    const shouldPrecheckContextNudge = usedFrac >= config.lcm.nudgeAtPct / 100 &&
      usedFrac < compactFrac &&
      (!nudged || nudged === "prune");
    let sid: string | undefined;
    let prunableTokens = 0;
    let prunableSufficient = false;
    let dailyRangeAvailable = true;

    if (shouldPrecheckContextNudge) {
      sid = this.sessions.getSdkSessionId(key);
      if (!sid) return;
      if (!nudged) {
        const dry = pruneTools({ sdkSessionId: sid, sdkSessionsDir: config.sdkSessionsDir, dryRun: true });
        prunableTokens = dry.success ? Math.ceil(dry.totalCharsRemoved / 4) : 0;
        prunableSufficient = prunableTokens >= PRUNE_NUDGE_MIN_FRAC * ctx.contextMax;
      }
      if (nudged === "prune" || !prunableSufficient) {
        dailyRangeAvailable = resolveBlockRange(sid, "daily", undefined, config.sdkSessionsDir) !== null;
      }
    }

    const decision = decideContextNudge({
      usedFrac,
      latchState: nudged,
      prunableSufficient,
      dailyRangeAvailable,
      thresholds,
    });

    if (decision.kind === "none") {
      if (decision.newLatch === null && nudged) {
        this.contextNudged.delete(key);
      }
      return;
    }

    if (decision.newLatch) {
      this.contextNudged.set(key, decision.newLatch);
    }

    const pct = Math.round(usedFrac * 100);
    const groupNote = isGroupSessionKey(key)
      ? " This is a group session — scope the rollup to this group's conversation (threads, decisions, group dynamics); don't mix in personal/DM context from elsewhere."
      : "";
    const compactNudgeText = () => formatTomoEvent(
      "context-nudge",
      `Context usage is at ${pct}% (${ctx.contextUsed}/${ctx.contextMax} tokens). Use the lcm compact skill to free up space before the next user message.${groupNote} After the compact finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`,
      { name: "compact" },
    );

    let nudge: string;
    if (decision.kind === "compact") {
      nudge = compactNudgeText();
      if (decision.reason === "daily-empty") {
        log.info({ key, usedPct: `${pct}%` }, "Context nudge (daily rollup empty; escalating to lcm compact)");
      } else {
        log.info({ key, usedPct: `${pct}%` }, "Context nudge (agent should run lcm compact)");
      }
    } else if (decision.kind === "daily") {
      nudge = formatTomoEvent(
        "context-nudge",
        `Context usage is at ${pct}% of the window. Please run \`tomo lcm daily --session-id ${sid} --summary "<today-so-far>"\` to roll up today's activity. Two things to know: (1) the daily compact OVERRIDES today's existing daily block — it does not append; write a fresh summary covering the whole day. (2) The command preserves the last ${config.lcm.dailyFreshTail} raw events as fresh tail.${groupNote} After the compact finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`,
        { name: "daily" },
      );
      log.info({ key, usedPct: `${pct}%` }, "Context nudge (agent should run lcm daily)");
    } else if (decision.kind === "prune") {
      nudge = formatTomoEvent(
        "context-nudge",
        `Context usage is at ${pct}% (${ctx.contextUsed}/${ctx.contextMax} tokens). Bulky tool results are holding roughly ${prunableTokens} reclaimable tokens. Run \`tomo lcm prune-tools --session-id ${sid}\` to stub them out — this is cheaper than a rollup and loses nothing conversational.${groupNote} After it finishes, reply NO_REPLY so we don't send a user-facing message for this housekeeping turn.`,
        { name: "prune" },
      );
      log.info({ key, usedPct: `${pct}%`, prunableTokens }, "Context nudge (agent should run lcm prune-tools)");
    } else {
      return;
    }

    // ALWAYS suppressed, in every session type. A context nudge (compact /
    // daily / prune-tools) is internal housekeeping: it runs an `lcm` command
    // and has nothing to say to anyone. It used to rely on the prompt's
    // closing "reply NO_REPLY", which only worked while delivery happened at
    // END of turn and that trailing token suppressed the whole turn. Per-block
    // delivery ships an early narration block ("Compacting context…") as soon
    // as it completes, before the NO_REPLY that was meant to silence it — and
    // a sent message cannot be recalled. Silence here must not depend on the
    // model's cooperation.
    this.handleCronMessage(nudge, key, {
      showTyping: false,
      suppressDelivery: true,
    }).catch((err) => {
      log.warn({ err, key }, "Compact nudge failed");
    });
  }

  private async runUserTurn(req: UserTurnRequest): Promise<void> {
    await this.turnRunner.runTurn({
      key: req.key,
      source: "user",
      prompt: req.promptText,
      stampChannelName: req.sourceChannelName,
      typing: { channel: req.replyChannel, chatId: req.replyChatId, passiveListen: req.passiveListen },
      delivery: {
        kind: "reply",
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
    const destination = this.resolveReplyDestination(resolution, channel, message.chatId, isGroup);

    const textForAgent = this.formatGroupText(channel, message, key);

    if (isGroup) {
      // Track group metadata under the raw group key even while summoned, so
      // the group's own session entry stays fresh for when it takes back over.
      this.updateGroupContext(`${channel.name}:${message.chatId}`, message.senderName, message.chatTitle, message.senderId);
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

    // Recorded above so the transcript keeps the message; the turn itself is
    // refused rather than answered somewhere it must not be.
    if (!destination) return;
    const { channel: replyChannel, chatId: replyChatId } = destination;

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
   * Where a turn's reply goes: the router's reply target when its channel is
   * registered. When it is not (a fixed reply policy or a summon naming a
   * provider that is disabled or has no token):
   *
   * - Inbound PRIVATE chat: reply there. CHANNEL AND CHAT ID MOVE TOGETHER —
   *   falling back to the inbound channel while keeping the resolved chatId
   *   would hand an iMessage handle to the Telegram bot (or the reverse). The
   *   inbound DM is the identity's own bound chat, so the owner still gets an
   *   answer — and the only place to tell them their reply channel is down.
   * - Inbound GROUP: FAIL CLOSED (`undefined`; the caller skips the turn). A
   *   summoned group runs on the owner's private dm: session, whose plain
   *   output the router promises stays private; delivering it into the group
   *   because the private channel is down would leak it.
   */
  private resolveReplyDestination(
    resolution: { replyTarget: { channelName: string; chatId: string } },
    inboundChannel: Channel,
    inboundChatId: string,
    inboundIsGroup: boolean,
  ): { channel: Channel; chatId: string } | undefined {
    const { channelName, chatId } = resolution.replyTarget;
    const channel = this.getChannel(channelName);
    if (channel) return { channel, chatId };
    if (inboundIsGroup) {
      log.error(
        { replyChannel: channelName, inboundChannel: inboundChannel.name, chatId: inboundChatId },
        "Reply channel is not registered and the message came from a group; refusing to reply into the group",
      );
      return undefined;
    }
    log.warn(
      { replyChannel: channelName, inboundChannel: inboundChannel.name },
      "Reply channel is not registered; replying on the inbound chat instead",
    );
    return { channel: inboundChannel, chatId: inboundChatId };
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
    const destination = this.resolveReplyDestination(resolution, lastChannel, lastMessage.chatId, isGroup);

    for (const { channel, message } of items) {
      if (message.isGroup) this.updateGroupContext(`${channel.name}:${message.chatId}`, message.senderName, message.chatTitle, message.senderId);
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

    // Transcript recorded; refuse the turn (see resolveReplyDestination).
    if (!destination) return;
    const { channel: replyChannel, chatId: replyChatId } = destination;

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
    // Resolve the sender against the people registry so every group line
    // carries the identity join inline: `kw 🚀 (Kevin Wang): ...`. Public
    // records only, even when a summon routes this line into a dm: session —
    // the reply audience is still the group, and a harness-stitched private
    // canonical name would sit right next to the content being answered.
    const people = loadPeople({ includePrivate: false });
    const sender = annotateSenderName(people, channel.name, message.senderName, message.senderId);
    const prefixed = `${sender}: ${message.text}`;
    if (!isDmSessionKey(sessionKey)) return prefixed;
    const label = message.chatTitle ?? this.sessions.getEntry(`${channel.name}:${message.chatId}`)?.chatTitle;
    return `[group${label ? ` "${label}"` : ""}] ${prefixed}`;
  }

  /** Track participants and chat title for a group session. The actual rules
   *  (passive listen, NO_REPLY guidance, participant snapshot) are now part of
   *  the system prompt — see SessionContext.group in sdkOptions — so they
   *  survive compaction. This stays as pure persistence; no LLM injection. */
  private updateGroupContext(key: string, senderName: string, chatTitle?: string, senderId?: string): void {
    this.sessions.addParticipant(key, senderName, senderId);
    if (chatTitle) this.sessions.setChatTitle(key, chatTitle);
    // Learn stable-id bindings for the people registry as senders appear —
    // no-op unless the display name unambiguously matches an unbound record.
    if (senderId) {
      const parsed = parseRawSessionKey(key);
      if (parsed) autoBindHandle(parsed.channelName, senderId, senderName);
    }
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
    const summonedKey = this.summonedDmKeyForGroupSession(sessionKey);
    if (summonedKey) {
      const parsed = parseRawSessionKey(sessionKey)!;
      const prompt = `${message}\n${this.summonReminder([`${parsed.channelName}:${parsed.chatId}`])}`;
      log.info({ from: sessionKey, to: summonedKey }, "Group background turn handed to active summoned session");
      // This path is also used by send_message(delegate). If the summoning dm:
      // session requested that delegate, awaiting its own queue would deadlock;
      // schedule the owned follow-up and report that it was accepted.
      this.enqueueForSession(summonedKey, () => this.processCronMessage(prompt, summonedKey, {
        ...options,
        // Summoned turns retain the private-output safety model. Group-facing
        // output must use the explicit direct-send path named in the reminder.
        deliveryTarget: undefined,
      })).catch((err) => {
        log.error({ err, sessionKey: summonedKey }, "Summoned group background turn failed in queue");
      });
      return true;
    }

    const key = sessionKey;
    const delivery = options.deliveryTarget
      ? this.channelDeliveryTarget(options.deliveryTarget, sessionKey, "Cron")
      : this.resolveDeliveryTargetForSession(sessionKey, "Cron");
    if (!delivery) return false;
    const { channel: deliveryChannel, chatId: deliveryChatId } = delivery;

    log.info({ channel: deliveryChannel.name, sender: "cron" }, message);

    // Scheduled infrastructure failures must never be posted into a group.
    // Silent housekeeping turns suppress them in DMs as well when requested.
    const suppressErrorDelivery = isGroupSessionKey(key) || options.suppressDelivery === true;

    return this.turnRunner.runTurn({
      key,
      source: "cron",
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
      silentMatcher: isSilentReply,
      silentLog: "Cron completed silently (no reply sent)",
      transcript: "on-delivery",
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

  /**
   * Deliver a restart notice to the session that initiated the restart — the
   * one whose key was persisted alongside the reason. Unlike handleContinuity
   * this never uses a blessed fallback. A raw group session normally receives
   * its own reason, but an active persisted summon owns that group exclusively,
   * so the restart turn moves to the summoned dm: session with the same
   * group-reply reminder as other background work. If the initiating key no
   * longer resolves to a known session, the reason is dropped with a log line
   * rather than rerouted — misdelivery is the failure mode this exists to
   * prevent.
   */
  handleRestartForSession(prompt: string, sessionKey: string): Promise<void> {
    const known = this.sessions.listActiveEntries().some((e) => e.channelKey === sessionKey);
    if (!known) {
      log.warn({ sessionKey }, "Restart reason attributed to unknown session; dropping instead of rerouting");
      return Promise.resolve();
    }

    const summonedKey = this.summonedDmKeyForGroupSession(sessionKey);
    const targetKey = summonedKey ?? sessionKey;
    let routedPrompt = prompt;
    if (summonedKey) {
      const parsed = parseRawSessionKey(sessionKey)!;
      routedPrompt = `${prompt}\n${this.summonReminder([`${parsed.channelName}:${parsed.chatId}`])}`;
      log.info({ from: sessionKey, to: summonedKey }, "Group restart notice handed to active summoned session");
    }

    return this.enqueueForSession(targetKey, () => this.processContinuity(routedPrompt, targetKey))
      .catch((err) => {
        log.error({ err, sessionKey: targetKey }, "Restart notice failed in queue");
      });
  }

  private async processContinuity(prompt: string, key: string): Promise<void> {
    await this.turnRunner.runTurn({
      key,
      source: "continuity",
      prompt,
      // No timestamp stamp, no typing indicator — continuity turns are
      // invisible. A heartbeat speaks only through the explicit `send_message`
      // tool, never through its own text blocks (owner decision 2026-08-28,
      // option A).
      //
      // WHY THE PROMPT ALONE IS NOT ENOUGH ANY MORE. CONTINUITY.md asks for a
      // closing NO_REPLY, and under end-of-turn delivery that trailing token
      // suppressed the whole turn retroactively — narration included. Per-block
      // delivery ships each block as it completes, so a heartbeat that narrates
      // ("Checking the morning routine…"), calls a tool, and only then answers
      // NO_REPLY has already put the narration on the owner's phone, and a sent
      // message cannot be recalled. Silence for a turn nobody asked for must
      // not depend on the model's cooperation.
      //
      // The target is still resolved (and still deferred) because the error
      // policy and `send_message` need it; only the turn's own output is
      // dropped.
      delivery: {
        kind: "deferred-send",
        suppressDelivery: true,
        suppressedLog: "Continuity output suppressed from chat delivery (heartbeats speak via send_message)",
        resolveTarget: () => {
          const identityName = dmIdentityFromSessionKey(key);
          // Final fallback covers raw keys only (dm: keys don't parse), so
          // heartbeats — always DM-keyed — are unaffected; it lets a
          // unsummoned restart notice routed to its initiating group session
          // (see handleRestartForSession) deliver even without a persisted
          // reply target.
          const replyTarget = this.router.getReplyTarget(key)
            ?? (identityName !== undefined ? this.router.deriveReplyTargetFromConfig(identityName) : undefined)
            ?? privateReplyTargetFromSessionKey(key)
            ?? replyTargetFromRawSessionKey(key);
          if (!replyTarget) return undefined;
          const channel = this.getChannel(replyTarget.channelName);
          return channel ? { channel, chatId: replyTarget.chatId } : undefined;
        },
      },
      silentMatcher: isSilentReply,
      transcript: "on-delivery",
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
    // Private targets only: a continuity heartbeat must never run on a group
    // session (its prompt would pollute the group's context, and the model
    // could post into the group via send_message).
    for (const [key] of this.sessions.listSdkSessionIds()) {
      const target = privateReplyTargetFromSessionKey(key);
      if (target?.channelName === channelName) return target.chatId;
    }
    return undefined;
  }

  // Proactive messaging (send_message, list_sessions, rename_group_chat,
  // react_to_message, edit_message, unsend_message MCP tools) — thin
  // delegates so the MCP server wiring keeps calling Agent's public surface.
  // See agent/proactive-send.ts.

  async sendToSession(target: string, text: string, callerSessionKey?: string, options?: { replyTo?: string; effect?: string }): Promise<SendResult> {
    return this.proactive.sendToSession(target, text, callerSessionKey, options);
  }

  async delegateToSession(target: string, request: string): Promise<SendResult> {
    return this.proactive.delegateToSession(target, request);
  }

  async renameGroupChat(target: string, title: string): Promise<SendResult> {
    return this.proactive.renameGroupChat(target, title);
  }

  async reactToMessage(target: string, reaction: MessageReaction, remove = false, match?: string): Promise<SendResult> {
    return this.proactive.reactToMessage(target, reaction, remove, match);
  }

  async editSentMessage(target: string, newText: string, match?: string): Promise<SendResult> {
    return this.proactive.editSentMessage(target, newText, match);
  }

  async unsendMessage(target: string, match?: string): Promise<SendResult> {
    return this.proactive.unsendMessage(target, match);
  }

  listSessionCatalog(): SessionCatalog {
    return this.proactive.listSessionCatalog();
  }

  /** Transcript recall for the internal MCP server (recall_conversation).
   *  Callers pass the session key the server instance was bound to — the
   *  tool can only read its own session's history. */
  searchSessionTranscript(
    sessionKey: string,
    opts: { query?: string; fromTime?: number; toTime?: number; limit?: number },
  ): SessionMessage[] {
    return this.sessions.searchTranscript(sessionKey, opts);
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

  /** Channel + per-session vitals snapshot for the watch server. */
  watchOverview(): { channels: string[]; sessions: WatchSessionInfo[] } {
    return {
      channels: this.channels.map((ch) => ch.name),
      sessions: this.sessions.listActiveEntries().map((e) => ({
        key: e.channelKey,
        ...(e.chatTitle ? { chatTitle: e.chatTitle } : {}),
        lastActiveAt: e.lastActiveAt,
        contextUsed: e.stats?.contextUsed ?? 0,
        contextMax: e.stats?.contextMax ?? 0,
        totalCostUsd: e.stats?.totalCostUsd ?? 0,
        totalQueries: e.stats?.totalQueries ?? 0,
      })),
    };
  }

  /**
   * Route a chat message typed in the `tomo watch` TUI into the owner's dm
   * session. Resolves once the turn is queued — the reply reaches the TUI as
   * a transcript event (and lands in the dm channel like any other reply),
   * so callers don't wait out a multi-minute turn for an ack.
   */
  async handleWatchChat(text: string): Promise<void> {
    const key = this.router.findFirstDmSession();
    if (!key) throw new Error("No dm session yet — message Tomo from a connected channel first");
    const delivery = this.resolveDeliveryTargetForSession(key, "Watch chat");
    if (!delivery) throw new Error("No delivery target for the dm session");
    const { channel, chatId } = delivery;

    this.sessions.append(key, {
      role: "user",
      content: text,
      channel: "terminal",
      timestamp: Date.now(),
    });

    this.enqueueForSession(key, () => this.turnRunner.runTurn({
      key,
      source: "user",
      prompt: text,
      stampChannelName: "terminal",
      delivery: { kind: "send", channel, chatId },
      silentMatcher: isSilentReply,
      silentLog: "Watch chat completed silently (no reply sent)",
      transcript: "on-delivery",
      errors: {
        visiblePrefix: "[error] ",
        response: "deliver",
        thrown: "deliver",
        thrownLogMessage: "Watch chat turn failed",
      },
    })).catch((err) => {
      log.error({ err, sessionKey: key }, "Watch chat failed in queue");
    });
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
    this.startMcpTokenRefreshSweep();
    log.info("Tomo is running");

    // Check for restart reason and notify via continuity-style message.
    // An attributed reason (the restart was initiated from a session — its
    // key rides in the reason file, stamped from TOMO_SESSION_KEY) routes to
    // that session and ONLY that session: the reason is its resume-context,
    // and delivering it anywhere else leaks that session's context across
    // session boundaries (worst case DM→group) and reads to the receiver as
    // its own pending work. Unattributed reasons (auto-update, a human in a
    // terminal, pre-upgrade plain-text files) keep the legacy delivery to
    // the blessed continuity session.
    const restart = consumeRestartReasonFile(RESTART_REASON_FILE);
    if (restart) {
      const { reason, sessionKey } = restart;
      log.info({ reason, sessionKey }, "Restart reason found, notifying agent");
      const prompt = formatTomoEvent("restart", `Restarted. Reason: ${reason} ${CONTINUITY_DELIVERY_NOTE}`);
      const delivery = sessionKey
        ? this.handleRestartForSession(prompt, sessionKey)
        : this.handleContinuity(prompt);
      delivery.catch((err) => log.error({ err }, "Failed to send restart reason"));
    }
  }

  /**
   * Shut down in five phases, ordered by what each one can lose.
   *
   * 1. `closeIngestion()` on every channel — synchronous, no I/O, so the whole
   *    fleet's inbound door is shut within one turn of the event loop. This
   *    bounds the set of messages we owe the user.
   * 2. `quiesce()` — let work already INSIDE a channel's parse path finish
   *    landing in the batcher. A row refused at this stage would be lost, not
   *    replayed: imsg may be seconds into attachment loading, and Telegram has
   *    already told the server it has the update.
   * 3. Drain the batcher into the transcript. Durable, and now working against
   *    a set that cannot grow.
   * 4. Stop the manager: reject in-flight turns and let them flush the blocks
   *    they delivered. Also durable.
   * 5. Only now, physical channel teardown — the slow, fallible part.
   *
   * The order of 4 and 5 is the whole point of the split. Tearing a channel
   * down first meant the manager drained into a dead channel, so blocks
   * produced during shutdown were recorded `[delivery failed]` for messages
   * that would otherwise have shipped. And awaiting teardown BEFORE the drain
   * staked every durable write on grammY's final `getUpdates`, which carries a
   * 500 s default client timeout — one stalled network call and nothing was
   * recorded at all.
   *
   * Hence the nested `finally`s: the recording and the manager stop run even
   * if quiesce fails, and teardown runs even if they do. Both awaits are
   * bounded, because `start.ts` cannot exit until this resolves.
   */
  /**
   * Keep harness-managed OAuth tokens alive while sessions are running. A
   * live session's Authorization header is minted once, when the session is
   * built, so nothing else re-reads the token store — without this sweep an
   * issuer handing out one-hour tokens breaks the server one hour after every
   * login. Each refresh notifies onServerAuthReady, which hot-mounts the new
   * header into the sessions already serving that server.
   */
  private startMcpTokenRefreshSweep(): void {
    const servers = config.mcpServers ?? {};
    if (!Object.values(servers).some((entry) => entry.oauth)) return;
    const sweep = () => {
      void this.mcpOAuthManager.refreshExpiringTokens(servers)
        .then((names) => {
          if (names.length > 0) log.info({ servers: names }, "Refreshed expiring MCP OAuth tokens");
        })
        .catch((err) => log.warn({ err }, "MCP OAuth refresh sweep failed"));
    };
    sweep();
    this.mcpTokenRefreshTimer = setInterval(sweep, TOKEN_REFRESH_SWEEP_INTERVAL_MS);
    this.mcpTokenRefreshTimer.unref();
  }

  async stop(): Promise<void> {
    log.info("Shutting down");
    if (this.mcpTokenRefreshTimer) {
      clearInterval(this.mcpTokenRefreshTimer);
      this.mcpTokenRefreshTimer = undefined;
    }
    this.commands.stop();

    for (const ch of this.channels) {
      try {
        ch.closeIngestion();
      } catch (err) {
        // Contractually I/O-free, so this is a bug rather than a failure mode
        // — but one channel must not keep the others ingesting.
        log.error({ err, channel: ch.name }, "Channel closeIngestion threw");
      }
    }

    try {
      await this.boundedShutdownStep(
        "channel quiesce",
        CHANNEL_QUIESCE_TIMEOUT_MS,
        () => Promise.all(this.channels.map((ch) => ch.quiesce())),
      );
    } finally {
      try {
        // The batcher is guaranteed not to grow again. These are messages the
        // user has already sent and we are choosing not to answer; the
        // transcript record is what keeps that a visible non-answer instead of
        // a silent drop.
        this.recordUnprocessedInbound();

        // Closing the live sessions rejects their in-flight turns, and those
        // turns still have to flush the blocks they delivered into the
        // transcript. Channels are still alive here, so a block produced
        // during this drain still reaches the user.
        await this.liveSessionManager.stop();
      } finally {
        await this.boundedShutdownStep(
          "channel teardown",
          CHANNEL_TEARDOWN_TIMEOUT_MS,
          () => Promise.all(this.channels.map((ch) => ch.teardown())),
        );
      }
    }
  }

  /**
   * Run one shutdown step under a deadline, swallowing failures.
   *
   * Neither a rejection nor a stall may propagate: every caller is on the path
   * to `process.exit()`, and a shutdown step that hangs is indistinguishable
   * from a daemon that refuses to die. The timer is cleared on the fast path
   * so it cannot hold the loop open, and the abandoned work is left running
   * rather than cancelled — there is no cancellation to hand a channel.
   */
  private async boundedShutdownStep(label: string, timeoutMs: number, run: () => Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        run().then(() => "done" as const, (err) => { log.error({ err, step: label }, "Shutdown step failed"); return "done" as const; }),
        expiry,
      ]);
      if (outcome === "timeout") {
        log.warn({ step: label, timeoutMs }, "Shutdown step timed out; continuing");
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Write the transcript record for inbound that shutdown will never process.
   *
   * Not dispatched instead, deliberately: dispatching would mean starting a
   * turn we are about to reject anyway (the manager's admission gate closes a
   * few lines below) and staking the shutdown deadline on a model round-trip.
   * Recording is bounded and keeps the promise that matters — recall has the
   * message, and the marker says plainly that nobody answered it.
   *
   * The user's text is appended verbatim, with the marker as its own
   * assistant entry, so the record reads the way the same message would if it
   * had died one stage later in `TurnRunner` (same marker, same shape) and the
   * user's words are not editorialised.
   *
   * The transcript record is the ONLY durable trace for everything drained
   * here, on both channels. Neither one replays what is already in the
   * batcher:
   *
   * - imsg advanced its rowid cursor at the end of the dispatch that put the
   *   message here, so there is nothing left to un-acknowledge.
   * - Telegram acknowledged it too, whatever we do. grammY sets
   *   `lastTriedUpdateId` BEFORE running middleware (bot.js) and `bot.stop()`
   *   confirms `lastTriedUpdateId + 1` with a final `getUpdates` without
   *   waiting for the middleware stack. An earlier version of this comment
   *   claimed Telegram's offset was "only committed for updates it has handed
   *   over" and that declining one made `getUpdates` redeliver it. That was
   *   false: the update is confirmed either way, so a refusal here loses it.
   *
   * Replay is real only for a message refused BEFORE the channel started
   * processing it, and only on imsg (`handleWatchMessage`'s entry guard leaves
   * the cursor un-advanced). That is why the shutdown sequence lets in-flight
   * parses finish into this batcher instead of refusing them late.
   */
  private recordUnprocessedInbound(): void {
    const pending = this.batcher.drainForShutdown();
    for (const [key, items] of pending) {
      for (const { channel, message } of items) {
        this.sessions.append(key, {
          role: "user",
          content: this.formatGroupText(channel, message, key),
          channel: channel.name,
          senderName: message.senderName,
          timestamp: message.timestamp,
        });
        this.sessions.append(key, {
          role: "assistant",
          content: SHUTDOWN_NOT_PROCESSED,
          channel: channel.name,
          timestamp: Date.now(),
        });
      }
      log.info(
        { sessionKey: key, count: items.length },
        "Recorded inbound messages shutdown will not process",
      );
    }
  }
}
