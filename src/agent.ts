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
import {
  annotateSenderName,
  autoBindHandle,
  createPeopleSnapshot,
  findPersonByHandle,
  loadPeople,
  renderParticipantLabels,
  resolveSenderTimeZone,
  type PeopleSnapshot,
} from "./people.js";
import { SummonStore } from "./sessions/summon-store.js";
import { PauseStore } from "./sessions/pause-store.js";
import { createTomoInternalMcpServer } from "./mcp/internal-server.js";
import { McpOAuthManager, TOKEN_REFRESH_SWEEP_INTERVAL_MS } from "./mcp/oauth.js";
import { log } from "./logger.js";
import { type QueryResult, type TurnRequest } from "./agent/live-session.js";
import { usesLcmCompact } from "./agent/sdk-options.js";
import { decideContextNudge, type ContextNudgeLatch } from "./agent/context-nudge.js";
import { isSilentReply } from "./agent/text-utils.js";
import { audienceOf, audienceSwitchNote, TurnAudienceRegistry } from "./agent/audience.js";
import { InboundBatcher, type InboundItem } from "./agent/inbound-batcher.js";
import { ChatCommandHandler, backupConfigFile } from "./agent/commands.js";
import { SessionQueue } from "./agent/session-queue.js";
import { PendingNotesQueue } from "./agent/pending-notes-queue.js";
import { DeliveryPipeline, isAgentErrorResponse, failedDeliveryEntry } from "./agent/delivery-pipeline.js";
import { TurnRunner, type RunWithRetryRequest } from "./agent/turn-runner.js";
import { formatGroupTag } from "./agent/inbound-markers.js";
import { createOrderedBlockTranscript, SHUTDOWN_NOT_PROCESSED } from "./agent/block-transcript.js";
import { LiveSessionManager } from "./agent/live-session-manager.js";
import { ProactiveSendService, type SendResult, type SessionCatalog } from "./agent/proactive-send.js";
import { resolveBlockRange } from "./lcm/blocks.js";
import { appendToTomoEventBody, formatTomoEvent } from "./tomo-event.js";
import { consumeRestartReasonFile } from "./restart-reason.js";
import {
  consumeRestartRequestFromToolResult,
  drainRestartRequests,
  restartWorkerInvocation,
  takePendingRestartRequest,
  type RestartRequest,
  type RestartRequestDiscard,
} from "./restart-request.js";
import { pruneTools } from "./lcm/index.js";
import { watchBus } from "./watch/bus.js";
import type { WatchSessionInfo } from "./watch/protocol.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "./fs-utils.js";
import { CONTINUITY_DELIVERY_NOTE } from "./continuity-defaults.js";
import { spawn } from "node:child_process";

export type { SendResult, SessionCatalog } from "./agent/proactive-send.js";

interface UserTurnRequest {
  key: string;
  promptText: string;
  sourceChannelName: string;
  /** The sender's IANA time zone for this turn's stamp, when one applies —
   *  see Agent.senderTimeZone. Undefined for a batch whose senders disagree. */
  senderTimeZone?: string;
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
  /** Where this turn's message(s) must be ANSWERED if the turn they steer into
   *  is silent: the summoned GROUP key for a group message running on a dm:
   *  session, the session's own key otherwise. Same derivation as
   *  summonReminder, and one entry PER MESSAGE in the batch's numbering order
   *  — a coalesced batch can mix the owner's DM with one or more summoned
   *  groups, and the note pairs targets with those ordinals. */
  steerAudience: string[];
  /** True for turns where most inputs are expected to resolve to NO_REPLY. */
  passiveListen?: boolean;
  /** This turn's inbound audiences, in order (see agent/audience.ts): "dm",
   *  or a raw group key for a summoned group's messages. Session-scoped MCP
   *  tools resolve against these, not against the session key. */
  audiences?: string[];
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
  /** When this turn is handed to an active summoned dm session, resolve only
   *  once that turn has actually run, instead of once it has been queued.
   *  Callers that record a completion (CronScheduler.markRun advances or
   *  deletes the job) must set this, or they record success before any work
   *  happens. Off by default because the delegate path calls this from inside
   *  a session turn that the handoff target may be waiting on — see
   *  processCronMessage. */
  waitForHandoff?: boolean;
  /** The audience this turn carries from the session that ASKED for it —
   *  `send_message(mode: "delegate")`, or a group's background turn handed to
   *  the summoning dm: session. Registered in the TurnAudienceRegistry for the
   *  turn's duration, so its session-scoped MCP tools resolve against the
   *  origin rather than the session key it happens to run on. Left undefined
   *  for harness-originated turns (the cron scheduler, LCM nudges), which the
   *  owner owns outright. */
  audiences?: string[];
}

interface QueuedInboundWork {
  sessionKey: string;
  items: InboundItem[];
  steer: boolean;
}

/**
 * Deadlines for the two channel-side shutdown steps. Both exist because
 * `start.ts` cannot call `process.exit()` until `stop()` resolves, so an
 * unbounded await here is a daemon that will not die: `quiesce` waits on
 * attachment IO and a network download, and `teardown` waits on grammY's final
 * `getUpdates`, whose own client timeout defaults to 500 seconds.
 */
const CHANNEL_QUIESCE_TIMEOUT_MS = 10_000;
/**
 * How long shutdown waits for an in-flight OAuth refresh sweep. A token
 * exchange is one HTTP round-trip; anything slower is a hung endpoint we
 * should not hold the daemon open for.
 */
const MCP_SWEEP_SHUTDOWN_TIMEOUT_MS = 3_000;
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
  /**
   * Inbound work that has been accepted by a channel but has not started its
   * per-session task yet. Unlike the generic SessionQueue tail, this retains
   * the messages themselves so shutdown can record them instead of merely
   * waiting for an arbitrary queued model turn.
   */
  private queuedInbound = new Map<symbol, QueuedInboundWork>();
  /** Set once `recordUnprocessedInbound` has swept `queuedInbound`. */
  private inboundDrained = false;
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
  private restartInFlight = false;
  /**
   * Set the moment `stop()` begins. A deferred restart claimed after that
   * point would spawn a helper that brings the daemon straight back up — so
   * `tomo stop` on a session that had just asked for a restart would look like
   * it failed. Shutdown wins; the request is dropped, with a line saying so.
   */
  private stopping = false;
  private proactive: ProactiveSendService;
  // Last inbound audience per dm: session ("dm" or a raw group key). With
  // summoning, one session interleaves private and group traffic — this is
  // how the harness detects the hop and reminds the model the audience changed.
  private lastAudiences = new Map<string, string>();
  /** Which turns are live on which session — the basis for scoping MCP tools
   *  to the audience a turn actually came from. See TurnAudienceRegistry. */
  private turnAudiences = new TurnAudienceRegistry();
  private readonly mcpOAuthManager: McpOAuthManager;
  /** Background sweep that refreshes OAuth tokens before they expire (start/stop). */
  private mcpTokenRefreshTimer: ReturnType<typeof setInterval> | undefined;
  /** The most recent sweep — awaited (bounded) by stop() so none is abandoned mid-write. */
  private mcpSweepInFlight: Promise<void> | undefined;

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
      isOwnAudienceTurn: (key) => this.isOwnAudienceTurn(key),
      handleMcpElicitation: (key, request) => this.handleMcpElicitation(key, request),
      createUnownedTurnRequest: (key) => this.createUnownedTurnRequest(key),
      handleToolResult: (key, toolName, content, isError) => {
        this.handleToolResult(key, toolName, content, isError);
      },
      handleTurnComplete: (key) => {
        this.handleTurnComplete(key);
      },
      maybeNudgeCompact: (key, ctx) => this.maybeNudgeCompact(key, ctx),
      refreshExternalMcpToken: (serverName) => this.mcpOAuthManager
        .refreshServerToken(serverName, config.mcpServers ?? {})
        .catch((err) => {
          log.warn({ serverName, err }, "MCP token refresh after an auth error failed");
          return "failed" as const;
        }),
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
      runDelegateTurn: (systemMsg, sessionKey, deliveryTarget, audiences) =>
        this.handleCronMessage(systemMsg, sessionKey, {
          ...(deliveryTarget ? { deliveryTarget } : {}),
          ...(audiences ? { audiences } : {}),
        }),
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
      this.enqueueInboundForSession(sessionKey, [{ channel, message, resolution }]);
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
      // Transfer custody into a fresh queued-inbound record before returning.
      // A plain SessionQueue task here recreates #295 when the destination key
      // is busy and shutdown lands while this handoff waits.
      this.enqueueInboundForSession(routedKey, routed, steer, "rerouting queued group message to summoned session");
      return;
    }

    if (routed.length === 1) {
      await this.handleMessage(routed[0].channel, routed[0].message, steer, routed[0].resolution);
      return;
    }
    await this.handleBatchedMessages(routed, steer);
  }

  /**
   * Queue inbound work while retaining enough information to salvage it at
   * shutdown. The record is removed immediately before processing starts;
   * processInboundItems reaches the transcript append synchronously before
   * its first model/channel await, or transfers custody to another record if
   * summon routing moves it to a different session queue.
   */
  private enqueueInboundForSession(
    sessionKey: string,
    items: InboundItem[],
    steer = false,
    action = "message queue",
  ): void {
    // Past the shutdown drain nothing will look at `queuedInbound` again, so
    // parking here would acknowledge the message and lose it — the failure
    // this method exists to close. Reachable: `quiesce` is bounded, and
    // `boundedShutdownStep` leaves an over-deadline parse running, so its
    // message can arrive after the sweep. Record it rather than refuse it;
    // the channel has already committed to this one (see
    // recordUnprocessedInbound's note on both providers).
    if (this.inboundDrained) {
      log.warn(
        { sessionKey, count: items.length },
        "Inbound arrived after the shutdown drain; recording without processing",
      );
      this.recordInboundItems(new Map([[sessionKey, items]]));
      return;
    }
    const token = Symbol(sessionKey);
    this.queuedInbound.set(token, { sessionKey, items, steer });
    this.enqueueForSession(sessionKey, async () => {
      const work = this.queuedInbound.get(token);
      if (!work) return; // shutdown already recorded it
      this.queuedInbound.delete(token);
      await this.processInboundItems(work.items, work.steer);
    }).catch((err) => log.error({ err, sessionKey }, `Unhandled error ${action}`));
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
   *
   * The privacy half is stated as a NORM, not as a list of which tools are
   * disabled. Naming the blocked tools would tell a model that has just been
   * refused where else to look — and the enforcement is not total: the
   * system prompt for a dm: session is built once per live session and
   * already carries private people names. The PreToolUse private-memory guard
   * now DOES cover a summoned turn (see `agent/permissions.ts`, gated on
   * `isOwnAudienceTurn`), so Read/Grep/Bash over memory/private are blocked
   * too — but the norm is still the right thing to state, since it also covers
   * what the model already has in context. "Off limits, by any route" is both
   * the instruction we want and the honest description.
   */
  private summonReminder(targets: string[]): string {
    const list = targets.map((t) => `"${t}"`).join(", ");
    return formatTomoEvent(
      "summon-reminder",
      `Summoned-group message. To reply in the group, call send_message with mode "direct" and target ${list}. Plain text in this turn goes to your owner's private DM, not the group — reply NO_REPLY unless you have a private side-note for them. The owner's private context is off limits for this turn: private people records and private DM history are not yours to look up, quote or summarise here, by any route — the group is steering this turn.`,
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
      // `block` is the model's words (classification + transcript); `outgoing`
      // is the wire copy, which the outlet guard may have prefixed with an
      // advisory. Same split as TurnRunner's sink.
      onBlock: async (block, outgoing = block) => {
        // Error text is not a reply: it is handled once, at resolve, so it
        // reaches the chat prefixed and with a pending note queued.
        if (isAgentErrorResponse(block) || isSilentReply(block)) return;
        const slot = transcript.reserve(block);
        try {
          await sender.deliver(outgoing);
          // Recorded per shipped block — an unrecorded delivery is invisible
          // to recall_conversation (#203) — but recorded AFTER the send, never
          // before. Writing on intent made the transcript claim deliveries
          // that never happened (A sends, B throws, transcript shows both).
          slot.settle(block);
        } catch (err) {
          log.error({ err, key }, "Background task block delivery failed");
          // Still recorded, but MARKED: the turn composed this text, and it is
          // not known to have reached the owner.
          slot.settle(failedDeliveryEntry(block, err));
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
    // A turn whose context reading failed carries an approximation of its OWN
    // tokens over the last known window — a small fraction of a full session.
    // Acting on it would read as "the session just emptied", clear the latch,
    // and re-issue housekeeping that has already run. An unknown reading is
    // not a low one: skip the turn and leave the latch where it is.
    if (ctx.contextEstimated) {
      log.debug({ key }, "Context nudge skipped (usage reading unavailable this turn)");
      return;
    }

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

    // Latched BEFORE dispatch (the nudge turn must not re-trigger itself) and
    // rolled back below if the turn never happened — see the .then()/.catch().
    const latch = decision.newLatch;
    if (latch) {
      this.contextNudged.set(key, latch);
    }
    // Undo that arming — but only if the latch is still OURS: a later turn may
    // have escalated it (prune → daily → compact) while this nudge was in
    // flight, and clearing that one would re-issue a rung the session has
    // already moved past.
    const rollBackLatch = (why: string): void => {
      if (!latch || this.contextNudged.get(key) !== latch) return;
      this.contextNudged.delete(key);
      log.warn({ key, latch }, why);
    };

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
    }).then((ok) => {
      if (ok) return;
      // handleCronMessage does not REJECT on failure — it resolves false (no
      // deliverable target, the turn ended on an error result, the queue threw
      // and was swallowed). Leaving the latch set on that answer means the
      // housekeeping never ran AND nothing will ask for it again until usage
      // falls back below nudgeResetPct, which is precisely what it cannot do
      // with the rollup unwritten. Roll the latch back so the next completed
      // turn re-evaluates the ladder from where it actually stands.
      rollBackLatch("Context nudge turn failed; latch cleared for a retry");
    }).catch((err) => {
      // And a REJECTION is the same outcome with a louder failure mode. That
      // handleCronMessage cannot currently reject is a property of ITS
      // implementation (a terminal `.catch(() => false)`), not of this call
      // site, and a latch stuck on for the rest of the session's life is too
      // quiet a thing to leave resting on that.
      log.warn({ err, key }, "Compact nudge failed");
      rollBackLatch("Context nudge turn threw; latch cleared for a retry");
    });
  }

  private async runUserTurn(req: UserTurnRequest): Promise<void> {
    // Published for the duration of the turn so session-scoped MCP tools can
    // see where this turn's input actually came from. Registered per TURN, not
    // per session: turns overlap under steering, and a per-key slot let the
    // second one's cleanup unscope the first. Removed afterwards, so a later
    // cron or background turn on the same session is the owner's again and
    // does not inherit a summoned group's narrower scope.
    const turnId = this.turnAudiences.begin(req.key, req.audiences);
    try {
      await this.runUserTurnInner(req);
    } finally {
      this.turnAudiences.end(req.key, turnId);
    }
  }

  /** The session key a session-scoped MCP tool should be judged against for
   *  the turn in flight. See TurnAudienceRegistry for why this is not simply
   *  `sessionKey`. */
  scopedCallerKey(sessionKey: string): string {
    const scoped = this.turnAudiences.scopedCallerKey(sessionKey);
    if (scoped !== sessionKey) {
      // Also fires for a background turn (cron, continuity, watch chat) that
      // happens to overlap a live summoned-group turn on this session: those
      // do not run through runUserTurn and so register no audience of their
      // own, and pick up the group's. Narrower than they would otherwise get,
      // never wider — but worth being able to see when a scheduled job
      // reports that it could not touch its own scheduled task.
      log.debug({ sessionKey, scopedTo: scoped }, "Session-scoped tool call narrowed to the turn's audience");
    }
    return scoped;
  }

  /**
   * Is the turn in flight the session's own — i.e. may tools read this
   * session's private surfaces?
   *
   * False for a summoned-group turn on a `dm:` session, for a mixed batch, and
   * while concurrent turns on the session disagree about the audience. The
   * private people subtree (`memory/private/people/`) and the owner's DM
   * transcript are off limits for such a turn — see `internal-server.ts`,
   * which gates `buildPeopleTools`/`buildRecallTools` on this, and
   * `agent/permissions.ts`, whose PreToolUse hook gates the private memory
   * FILES on it.
   */
  isOwnAudienceTurn(sessionKey: string): boolean {
    return this.turnAudiences.isOwnAudienceTurn(sessionKey);
  }

  private async runUserTurnInner(req: UserTurnRequest): Promise<void> {
    await this.turnRunner.runTurn({
      key: req.key,
      source: "user",
      prompt: req.promptText,
      stampChannelName: req.sourceChannelName,
      stampSenderTimeZone: req.senderTimeZone,
      typing: { channel: req.replyChannel, chatId: req.replyChatId, passiveListen: req.passiveListen },
      delivery: {
        kind: "reply",
        channel: req.replyChannel,
        chatId: req.replyChatId,
        replyToMessageId: req.replyToMessageId,
        images: req.images,
        documents: req.documents,
        steer: req.steer,
        steerAudience: req.steerAudience,
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

    // ONE registry read for this message, shared by every consumer below
    // (sender annotation, handle auto-binding, the stamp's sender clock).
    // Lazy, so a message that needs no lookup still reads nothing.
    const people = createPeopleSnapshot();
    const textForAgent = this.formatGroupText(channel, message, key, people);

    if (isGroup) {
      // Track group metadata under the raw group key even while summoned, so
      // the group's own session entry stays fresh for when it takes back over.
      this.updateGroupContext(`${channel.name}:${message.chatId}`, message.senderName, message.chatTitle, message.senderId, people);
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
    const audiences = [audienceOf(channel.name, message)];
    const switchNote = this.noteAudienceSwitch(key, audiences);
    // The audience this message came from, derived exactly like the summon
    // reminder's targets — a summoned group must be answered in the group,
    // even though the turn runs on the owner's dm: session. (Distinct from
    // `audiences` above, which spells a private DM as "dm" for the audience-
    // switch note; this one must be a send_message target, so it names the
    // session key.)
    const audience = [isSummoned ? `${channel.name}:${message.chatId}` : key];
    const promptText = switchNote + (isSummoned
      ? `${textForAgent}\n${this.summonReminder([`${channel.name}:${message.chatId}`])}`
      : textForAgent);

    await this.runUserTurn({
      key,
      promptText,
      sourceChannelName: channel.name,
      senderTimeZone: this.senderTimeZone(channel, message, people),
      replyChannel,
      // Reply-threading only makes sense when the reply lands in the chat the
      // message came from — not for summoned groups (reply goes to the DM).
      replyToMessageId: isGroup && replyChatId === message.chatId ? message.id : undefined,
      replyChatId,
      images: message.images,
      documents: message.documents,
      audiences,
      suppressErrors: isPassiveGroup,
      errorLogMessage: "Error handling message",
      steer,
      steerAudience: audience,
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

    // ONE registry read for the WHOLE batch — shared by every item's
    // transcript line, its prompt line, and the batch's sender clock below.
    const people = createPeopleSnapshot();

    for (const { channel, message } of items) {
      if (message.isGroup) this.updateGroupContext(`${channel.name}:${message.chatId}`, message.senderName, message.chatTitle, message.senderId, people);
      this.recordLatestInboundMessage(key, channel, message);
      const transcriptText = this.formatGroupText(channel, message, key, people);
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

    // NUMBERED LINES ARE THE HARNESS'S, AND ONLY THE HARNESS'S. Everything
    // after `N. ` is sender-controlled — the message body, and for a group the
    // sender name and chat title too — so a body containing "\n2. ..." used to
    // fabricate an item that reads exactly like a real one. That matters
    // beyond tidiness: the silent-turn note pairs each audience with the
    // ORDINAL of the message it belongs to (see silentTurnSteerNote), so a
    // forged "2." makes "message 2 → target: ..." ambiguous — and the same
    // trick could forge any of the bracketed markers around it.
    //
    // Continuation lines are indented past the `N. ` gutter, so no line a
    // sender writes can start at column 0. Line terminators are normalised to
    // "\n" first: a lone CR (and U+2028/9) breaks a line for a reader too, and
    // an un-normalised one would slip past an indent keyed only on "\n". This
    // is prompt framing only — the transcript keeps the message verbatim.
    const numbered = items.map((it, i) => {
      const text = this.formatGroupText(it.channel, it.message, key, people);
      return `${i + 1}. ${text.replace(/\r\n|[\n\r\u2028\u2029]/g, "\n   ")}`;
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
    const audiences = items.map((it) => audienceOf(it.channel.name, it.message));
    const switchNote = this.noteAudienceSwitch(key, audiences);
    const combined = `${switchNote}[${subject} — read them all together before responding; later messages may revise or cancel earlier ones]\n${numbered}${reminder}`;
    const allImages = items.flatMap((it) => it.message.images ?? []);
    const allDocuments = items.flatMap((it) => it.message.documents ?? []);

    // ONE stamp covers the whole batch, so a sender clock may only go on it
    // when every message in it agrees — otherwise the reading would be
    // attributed to messages it does not describe. Disagreement (including one
    // sender with a time zone and one without) drops the segment entirely.
    const senderZones = new Set(items.map((it) => this.senderTimeZone(it.channel, it.message, people)));
    const senderTimeZone = senderZones.size === 1 ? [...senderZones][0] : undefined;

    await this.runUserTurn({
      key,
      promptText: combined,
      sourceChannelName: lastChannel.name,
      senderTimeZone,
      replyChannel,
      replyChatId,
      replyToMessageId: isGroup && replyChatId === lastMessage.chatId ? lastMessage.id : undefined,
      images: allImages.length > 0 ? allImages : undefined,
      documents: allDocuments.length > 0 ? allDocuments : undefined,
      audiences,
      suppressErrors: isPassiveGroup,
      errorLogMessage: "Error handling batched messages",
      steer,
      // PER ITEM, not per batch, IN `numbered`'s ORDER. `summonTargets` (the
      // summon reminder's list) holds only GROUP keys, so a batch that mixed a
      // private DM message with a summoned group's would have told the model to
      // answer all of it in the group — the owner's private question posted to
      // the group, or never answered at all. Each item is paired with the
      // audience it came from, and the note identifies it by the ordinal
      // `numbered` gave it above (nothing sender-controlled is quoted); a group
      // item on a dm: session is necessarily summoned.
      steerAudience: items.map((it) => (isDmSessionKey(key) && (it.message.isGroup ?? false)
        ? `${it.channel.name}:${it.message.chatId}`
        : key)),
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
  private formatGroupText(
    channel: Channel,
    message: IncomingMessage,
    sessionKey: string,
    people: PeopleSnapshot,
  ): string {
    if (!message.isGroup) return message.text;
    // Resolve the sender against the people registry so every group line
    // carries the identity join inline: `ali ✨ (Alice Example): ...`. Public
    // records only, even when a summon routes this line into a dm: session —
    // the reply audience is still the group, and a harness-stitched private
    // canonical name would sit right next to the content being answered.
    const sender = annotateSenderName(people.scoped(false), channel.name, message.senderName, message.senderId);
    const prefixed = `${sender}: ${message.text}`;
    if (!isDmSessionKey(sessionKey)) return prefixed;
    const label = message.chatTitle ?? this.sessions.getEntry(`${channel.name}:${message.chatId}`)?.chatTitle;
    return `${formatGroupTag(label)} ${prefixed}`;
  }

  /**
   * The sender's own time zone for the inbound stamp, or undefined.
   *
   * Scope mirrors `formatGroupText`: a GROUP message resolves against PUBLIC
   * records only — a summon runs the line on the owner's dm: session, but the
   * message still came from the group, and a private record must not leak a
   * fact about someone into it. A private (non-group) message may use the full
   * registry, the same rule `loadPeopleSection` applies to the system prompt.
   *
   * Never throws: a registry that cannot be read costs the segment, not the
   * message.
   */
  private senderTimeZone(channel: Channel, message: IncomingMessage, people: PeopleSnapshot): string | undefined {
    try {
      const isGroup = message.isGroup ?? false;
      return resolveSenderTimeZone(people.scoped(!isGroup), channel.name, message.senderName, message.senderId);
    } catch (err) {
      log.warn({ err, channel: channel.name }, "Could not resolve the sender's time zone");
      return undefined;
    }
  }

  /** Track participants and chat title for a group session. The actual rules
   *  (passive listen, NO_REPLY guidance, participant snapshot) are now part of
   *  the system prompt — see SessionContext.group in sdkOptions — so they
   *  survive compaction. This stays as pure persistence; no LLM injection. */
  private updateGroupContext(
    key: string,
    senderName: string,
    chatTitle?: string,
    senderId?: string,
    people?: PeopleSnapshot,
  ): void {
    this.sessions.addParticipant(key, senderName, senderId);
    if (chatTitle) this.sessions.setChatTitle(key, chatTitle);
    // Learn stable-id bindings for the people registry as senders appear —
    // no-op unless the display name unambiguously matches an unbound record.
    if (senderId) {
      const parsed = parseRawSessionKey(key);
      if (!parsed) return;
      // autoBindHandle has to do its own (private-inclusive) load before it
      // writes, so skip the call outright once this snapshot already shows the
      // id bound — the steady state for every sender after their first
      // message, and what keeps a message to one registry read.
      if (people && findPersonByHandle(people.scoped(true), parsed.channelName, senderId)) return;
      autoBindHandle(parsed.channelName, senderId, senderName);
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
      const handoff = this.enqueueForSession(summonedKey, () => this.processCronMessage(prompt, summonedKey, {
        ...options,
        // Summoned turns retain the private-output safety model. Group-facing
        // output must use the explicit direct-send path named in the reminder.
        deliveryTarget: undefined,
        // The turn now runs on the OWNER's session key while its prompt and
        // its reply audience are the group's. Register the group so its
        // session-scoped tools stay group-scoped instead of inheriting the
        // owner's — this is the same hole as the delegate one, reached from
        // the other side (a job the group scheduled, firing into a session
        // whose key says "the owner's private DM"). "dm" is dropped rather
        // than unioned: an owner-originated request into a group is not a
        // conflict, it is simply group-facing. A DIFFERENT group's audience is
        // kept, so the union fails closed the way it should.
        audiences: [...new Set([
          ...(options.audiences ?? []).filter((a) => a !== "dm"),
          `${parsed.channelName}:${parsed.chatId}`,
        ])],
      }));
      // A caller that records completion (the cron scheduler advances or
      // deletes the job on the returned boolean) must wait for the handed-off
      // turn — otherwise the job is marked done, and a one-shot deleted,
      // before the work runs, and a daemon that stops in between loses it with
      // no interrupted-run trace. Safe here because the handoff target is a
      // different queue from the group session we were enqueued on.
      if (options.waitForHandoff) {
        return handoff.catch((err) => {
          log.error({ err, sessionKey: summonedKey }, "Summoned group background turn failed in queue");
          return false;
        });
      }
      // This path is also used by send_message(delegate). If the summoning dm:
      // session requested that delegate, awaiting its own queue would deadlock;
      // schedule the owned follow-up and report that it was accepted.
      handoff.catch((err) => {
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

    // A SUPPRESSED CRON TURN IS A SILENT TURN, AND MUST SAY SO. Heartbeats and
    // restart notices have carried this sentence since 2026-08-28; the silent
    // cron turns (LCM rollup nudges, context nudges) carried nothing, so the
    // model wrote its answer into reply text that "Cron output suppressed from
    // chat delivery" then dropped. Added HERE rather than in each producer's
    // event body so the sentence tracks the flag that makes it true: an
    // ordinary scheduled job DOES deliver its reply text, and telling it
    // otherwise would push it into send_message and deliver the answer twice.
    //
    // Written INTO the event body, never after the closing tag: a sentence
    // trailing the envelope reads as conversational text to LCM's warm-tail
    // classifier, which would let silent housekeeping nudges displace real
    // conversation in the fresh tail (see appendToTomoEventBody).
    const prompt = options.suppressDelivery === true
      ? appendToTomoEventBody(message, CONTINUITY_DELIVERY_NOTE)
      : message;

    // Scheduled infrastructure failures must never be posted into a group.
    // Silent housekeeping turns suppress them in DMs as well when requested.
    const suppressErrorDelivery = isGroupSessionKey(key) || options.suppressDelivery === true;

    // Published for the turn's duration when it carries a foreign origin, the
    // same way runUserTurn publishes an inbound turn's audience. Harness-owned
    // turns (the cron scheduler, LCM nudges) register nothing and keep the
    // session's own scope — except while a summoned turn overlaps them, which
    // narrows them to that group and which `scopedCallerKey` logs at debug.
    const turnId = options.audiences ? this.turnAudiences.begin(key, options.audiences) : undefined;
    try {
      return await this.turnRunner.runTurn({
        key,
        source: "cron",
        prompt,
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
    } finally {
      if (turnId !== undefined) this.turnAudiences.end(key, turnId);
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

    // A restart notice for a group, routed onto the owner's session because the
    // group is summoned, is the group's turn wherever it runs — same rule as
    // the cron handoff in processCronMessage.
    const audiences = summonedKey ? [sessionKey] : undefined;
    return this.enqueueForSession(targetKey, () => this.processContinuity(routedPrompt, targetKey, audiences))
      .catch((err) => {
        log.error({ err, sessionKey: targetKey }, "Restart notice failed in queue");
      });
  }

  private async processContinuity(prompt: string, key: string, audiences?: string[]): Promise<void> {
    const turnId = audiences ? this.turnAudiences.begin(key, audiences) : undefined;
    try {
      await this.runContinuityTurn(prompt, key);
    } finally {
      if (turnId !== undefined) this.turnAudiences.end(key, turnId);
    }
  }

  private async runContinuityTurn(prompt: string, key: string): Promise<void> {
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

  /**
   * `send_message(mode: "delegate")`. The delegated turn runs on the TARGET
   * session, so the caller's audience has to be resolved HERE, while the
   * calling turn is still live in the registry, and handed down — by the time
   * the turn runs, the caller's registration is gone.
   *
   * Refuses outright when the caller's own turn is unattributable (a coalesced
   * batch spanning the owner's DM and a summoned group, or two groups). That
   * turn cannot say which audience the request came from, and a delegate is
   * precisely the operation that would launder the ambiguity into full scope
   * on another session.
   */
  async delegateToSession(target: string, request: string, callerSessionKey?: string): Promise<SendResult> {
    let callerAudiences: string[] | undefined;
    if (callerSessionKey !== undefined) {
      callerAudiences = this.turnAudiences.originAudience(callerSessionKey);
      if (!callerAudiences) {
        return {
          ok: false,
          error: "delegate mode is unavailable on this turn: its messages span more than one audience (a private DM and a summoned group, or two groups), so the delegated turn cannot be attributed to one of them. Reply in this conversation instead, or use mode \"direct\" to send verbatim text.",
        };
      }
    }
    return this.proactive.delegateToSession(target, request, callerAudiences);
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

  /**
   * A session-originated `tomo restart` is acknowledged only when its Bash
   * result comes back through the SDK event stream. Starting the helper here
   * gives us an exact persistence boundary instead of racing daemon shutdown
   * against an arbitrary timer.
   *
   * ASSUMPTION, worth stating because nothing enforces it: we treat the
   * arrival of the streamed `tool_result` event as proof that the SDK child
   * has already written that result to its transcript. There is no flush
   * handshake — the event says the child produced the result, not that it
   * durably recorded it. If the child batches its JSONL writes, a restart
   * fired on this event could still race the write, which would land us back
   * in #257 with a narrower window. The end-of-turn fallback is strictly safer
   * on that axis (the turn is over, so the write has happened), and this path
   * exists because it is *sooner*. Revisit if the SDK ever exposes a flush.
   *
   * `BashOutput` is accepted alongside `Bash`: a backgrounded
   * `tomo restart &`-style invocation returns its marker through the
   * background-output tool, not the original call.
   */
  private handleToolResult(
    sessionKey: string,
    toolName: string,
    content: unknown,
    isError: boolean,
  ): void {
    if ((toolName !== "Bash" && toolName !== "BashOutput") || isError) return;
    if (this.stopping) {
      // Same rule as handleTurnComplete: a stop in progress outranks a restart.
      this.drainRestartRequests(sessionKey, "shutting-down");
      return;
    }
    const request = consumeRestartRequestFromToolResult(
      content,
      sessionKey,
      undefined,
      undefined,
      (discarded) => this.logRestartRequestDiscard(sessionKey, discarded),
    );
    if (!request) return;

    if (this.restartInFlight) {
      // DRAIN, don't just return. This marker's own file is already consumed,
      // but a second `tomo restart` in the same turn leaves a second file, and
      // returning here left it on disk: the restart completes, and within the
      // TTL the next turn's fallback claims the straggler and restarts AGAIN,
      // announcing the older reason.
      const alsoDropped = this.drainRestartRequests(sessionKey, "superseded");
      this.queuePendingErrorNote(
        sessionKey,
        alsoDropped > 0
          ? `A Tomo restart was already in progress; ${alsoDropped + 1} duplicate restart requests were ignored.`
          : "A Tomo restart was already in progress; the duplicate restart request was ignored.",
      );
      return;
    }
    this.restartInFlight = true;
    this.launchAcknowledgedRestart(request);
  }

  /**
   * Throw away restart requests this daemon will not honour, and say so.
   *
   * `superseded`: a restart is not a queue — once one is in flight, every
   * other request for that session is answered by it, and leaving a file
   * behind means the daemon comes back up and restarts a second time off a
   * request nobody is waiting on. `shutting-down`: a restart would resurrect a
   * daemon that was deliberately stopped. Returns how many were dropped; every
   * one is reported through the discard log, including the one that would
   * otherwise have been acted on.
   */
  private drainRestartRequests(sessionKey: string, reason: "superseded" | "shutting-down"): number {
    return drainRestartRequests(
      sessionKey,
      reason,
      undefined,
      (discarded) => this.logRestartRequestDiscard(sessionKey, discarded),
    );
  }

  private logRestartRequestDiscard(sessionKey: string, discarded: RestartRequestDiscard): void {
    log.warn(
      {
        sessionKey,
        reason: discarded.reason,
        ...("request" in discarded ? { requestId: discarded.request.id, requestedAt: discarded.request.requestedAt } : {}),
      },
      "Discarded a restart request without restarting",
    );
  }

  /**
   * Fallback for a restart whose marker never came back.
   *
   * The handshake in `handleToolResult` needs the marker line to survive into
   * the Bash tool result, and the model writes the command: `tomo restart
   * >/dev/null`, a redirect into a log, or `... | tail -1` all discard it. The
   * CLI has already told the owner a restart is coming, so the turn ending is
   * the backstop — later than the acknowledgement boundary #257 wants, but
   * still after the SDK recorded the tool result, and infinitely better than
   * silently doing nothing. A request claimed here is one that mid-turn
   * acknowledgement missed, so log it: a rising rate means the model has
   * settled on a redirecting invocation and the happy path has gone dark.
   */
  private handleTurnComplete(sessionKey: string): void {
    if (this.stopping) {
      // `tomo stop` MUST NOT be undone by a restart. The completion signal
      // fires on shutdown exits too (that is the point of the `finally`), so
      // without this a session that had just asked for a restart would have
      // its request claimed here and spawn a helper that brings the daemon
      // straight back up — the user's stop silently reversed.
      this.drainRestartRequests(sessionKey, "shutting-down");
      return;
    }
    if (this.restartInFlight) {
      // Same reason as the marker path: claim and drop rather than leave the
      // file for the post-restart daemon to act on.
      this.drainRestartRequests(sessionKey, "superseded");
      return;
    }
    const request = takePendingRestartRequest(
      sessionKey,
      undefined,
      (discarded) => this.logRestartRequestDiscard(sessionKey, discarded),
    );
    if (!request) return;
    log.warn(
      { sessionKey, requestId: request.id },
      "Restart request never appeared in a Bash result; restarting at end of turn",
    );
    this.restartInFlight = true;
    this.launchAcknowledgedRestart(request);
  }

  private launchAcknowledgedRestart(request: RestartRequest): void {
    const cliPath = process.argv[1];
    if (!cliPath) {
      this.reportScheduledRestartFailure(request.sessionKey, "CLI entry point is unavailable");
      return;
    }

    const worker = restartWorkerInvocation(request, cliPath);
    const child = spawn(worker.command, worker.args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: worker.env,
    });
    let stderr = "";
    let failureReported = false;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    const reportFailure = (detail: string) => {
      if (failureReported) return;
      failureReported = true;
      this.reportScheduledRestartFailure(request.sessionKey, detail);
    };
    child.once("error", (err) => reportFailure(err.message));
    child.once("exit", (code, signal) => {
      if (code === 0) return;
      const detail = stderr.trim() || `restart helper exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`;
      reportFailure(detail);
    });
    child.unref();
  }

  private reportScheduledRestartFailure(sessionKey: string, detail: string): void {
    this.restartInFlight = false;
    const message = `Scheduled Tomo restart failed: ${detail}`;
    log.error({ sessionKey, detail }, "Scheduled restart failed");
    this.queuePendingErrorNote(sessionKey, message);
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
      // Held (not cleared on completion) so stop() can wait for an exchange
      // that is still in flight: abandoning one mid-write leaves the token
      // store to a callback racing process exit, and its hot-mounts land on
      // sessions shutdown has already closed. Awaiting a settled promise is
      // free, so there is nothing to gain from clearing it.
      this.mcpSweepInFlight = this.mcpOAuthManager.refreshExpiringTokens(servers)
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
    // Set BEFORE anything awaits: turns are still draining, and each one that
    // ends runs the deferred-restart check. From here on a restart request is
    // dropped rather than honoured, so `tomo stop` cannot be reversed by one.
    this.stopping = true;
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

    // Before the live sessions are torn down, so a refresh that is mid-flight
    // finishes its store write and its hot-mount against sessions that are
    // still alive, rather than against ones stop() has just closed.
    if (this.mcpSweepInFlight) {
      const sweep = this.mcpSweepInFlight;
      await this.boundedShutdownStep("mcp token sweep", MCP_SWEEP_SHUTDOWN_TIMEOUT_MS, () => sweep);
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
  /**
   * Crash-path entry point for {@link recordUnprocessedInbound}.
   *
   * Called from the `uncaughtException` handler, where nothing may be awaited
   * and no channel may be trusted. This one step is worth taking anyway: it is
   * a synchronous append to the local transcript, and it is what stops a crash
   * turning an already-received message into a silent non-answer (#294).
   */
  recordUnprocessedInboundOnCrash(): void {
    this.recordUnprocessedInbound();
  }

  private recordUnprocessedInbound(): void {
    const batched = this.batcher.drainForShutdown();
    // Set with the batcher's own `stopping`, and like it: one-time. From here
    // `queuedInbound` is never swept again, so a record parked there after
    // this point would be exactly the acknowledged-and-gone drop #295 is
    // about — `enqueueInboundForSession` records instead of parking.
    this.inboundDrained = true;

    // Queued-inbound first: an item here is already waiting on a session task,
    // so it was accepted before anything still parked in the batcher for the
    // same key (a dm: session summoned to a group holds both). Ordering only
    // decides how the transcript reads; every entry carries its own
    // provider timestamp either way.
    const pending = new Map<string, InboundItem[]>();
    for (const [token, work] of this.queuedInbound) {
      pending.set(work.sessionKey, [...(pending.get(work.sessionKey) ?? []), ...work.items]);
      this.queuedInbound.delete(token);
    }
    for (const [key, items] of batched) {
      pending.set(key, [...(pending.get(key) ?? []), ...items]);
    }
    this.recordInboundItems(pending);
  }

  /** Append `<user message>` + the not-processed marker for each item. */
  private recordInboundItems(pending: Map<string, InboundItem[]>): void {
    // One read for the whole drain: this runs during shutdown, where every
    // avoidable synchronous file read delays the exit.
    const people = createPeopleSnapshot();
    for (const [key, items] of pending) {
      for (const { channel, message } of items) {
        this.sessions.append(key, {
          role: "user",
          content: this.formatGroupText(channel, message, key, people),
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
