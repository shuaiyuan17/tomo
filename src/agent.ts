import { formatDateTime, ownerT, type OwnerText } from "./i18n/index.js";
import type { Channel, ChannelFaultNotice, IncomingMessage, MessageReaction, StopTyping, StopTypingOptions } from "./channels/types.js";
import type { CompactReservation } from "./lcm/background-gate.js";
import { config, CONFIG_BACKUP_PATH, CONFIG_PATH, RESTART_REASON_FILE } from "./config.js";
import { buildIdentityPrompt, promptContextSnapshot } from "./workspace/index.js";
import { SessionStore } from "./sessions/index.js";
import type { ReplyTarget, SessionMessage, UsageBaseline } from "./sessions/types.js";
import {
  isGroupSessionKey,
  isDmSessionKey,
  dmIdentityFromSessionKey,
  parseRawSessionKey,
  privateReplyTargetFromSessionKey,
  replyTargetFromRawSessionKey,
  isTaskSessionKey,
  taskIdFromSessionKey,
  taskSessionKey,
} from "./sessions/keys.js";
import { SubsessionService, type OwnerMessageResult, type TaskTurnOutcome } from "./agent/subsessions/service.js";
import { parseTaskAddress, type TaskAddress } from "./agent/subsessions/address.js";
import { taskCommandReply } from "./agent/subsessions/commands.js";
import { SubsessionStore } from "./agent/subsessions/store.js";
import { subsessionDetail, subsessionList, subsessionView, type SubsessionLive } from "./web/subsessions-view.js";
import { resolveModelName } from "./models.js";
import type { SubsessionRecord } from "./agent/subsessions/types.js";
import type { WebSubsessionAccess } from "./channels/web.js";
import { buildSubsessionPrompt } from "./agent/subsessions/prompt.js";
import { createTodoLink } from "./agent/subsessions/todo-link.js";
import { TodoStore } from "./todos/store.js";
import { CRON_STORE_PATH } from "./cron/store.js";
import { createTaskCronLink } from "./agent/subsessions/cron-link.js";
import { EFFORT_LEVELS, type EffortLevel } from "./config.js";
import type { SessionContext } from "./agent/sdk-options.js";
import { privateMemoryBarFor } from "./agent/permissions.js";
import { assessGroupPermission, attachmentBarredFor } from "./agent/private-memory-guard.js";
import { effectiveGroupSandbox, type GroupSandboxConfig } from "./agent/group-fs-policy.js";
import { PermissionBroker, PermissionLedger, permissionLedgerPath, type PermissionAccess, type PermissionAssessment, type PermissionRequestView } from "./permissions/broker.js";
import { findGrant, grantForRequest, newGrantId, persistGroupGrant, revokeGroupGrant } from "./permissions/config-grants.js";
import { OwnerRouter, type SessionResolution } from "./router.js";
import { ignoredAllowlistDmEntries, isOwnerHandle, ownerSessionKey } from "./owner.js";
import { BlockedInboundLog, redactChatIdForLog } from "./agent/blocked-inbound-log.js";
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
import { shortErrorMessage } from "./error-text.js";
import { SteerDeclinedError, TurnInterruptedError, type QueryResult, type ReplyContext, type TurnRequest } from "./agent/live-session.js";
import { isSilentReply } from "./agent/text-utils.js";
import { audienceOf, audienceSwitchNote, TurnAudienceRegistry, type TurnOrigin } from "./agent/audience.js";
import { InboundBatcher, type InboundItem } from "./agent/inbound-batcher.js";
import { formatInterruptedAgentsNotice, isResumable, MAX_AUTO_RESUMES, RunningAgentsLedger, type RunningTaskRecord } from "./agent/running-agents-ledger.js";
import { DurableInbox, INBOX_STALE_NOT_PROCESSED, restoreMessage, type InboxRecord } from "./agent/durable-inbox.js";
import { ChatCommandHandler, backupConfigFile } from "./agent/commands.js";
import type { TaskBoard } from "./web/tasks.js";
import { describeSessionModel, switchSessionModel, type ModelSwitchOutcome } from "./agent/model-switch.js";
import { prepareSettledSessionRewind } from "./agent/settled-rewind.js";
import { RewindError } from "./agent/session-rewind.js";
import { SessionQueue } from "./agent/session-queue.js";
import { PendingNotesQueue } from "./agent/pending-notes-queue.js";
import { DeliveryPipeline, isAgentErrorResponse, deliveredEntry, failedDeliveryEntry } from "./agent/delivery-pipeline.js";
import { TurnRunner, type MirrorTicket, type OwnerNoticeTarget, type RunWithRetryRequest, type ShutdownTurnEnd } from "./agent/turn-runner.js";
import { OwnerErrorNotifier } from "./agent/owner-error-notice.js";
import { formatGroupTag } from "./agent/inbound-markers.js";
import { CredentialBroker } from "./credentials/broker.js";
import { captureChannelFor } from "./credentials/capture.js";
import { BrokerStateFile, KeychainBackend } from "./credentials/store.js";
import { createOrderedBlockTranscript, SHUTDOWN_NOT_PROCESSED } from "./agent/block-transcript.js";
import { LiveSessionManager } from "./agent/live-session-manager.js";
import { ProactiveSendService, type SendResult, type SessionCatalog } from "./agent/proactive-send.js";
import { appendToTomoEventBody, formatTomoEvent, markOwnerAudience } from "./tomo-event.js";
import { UsageLedger, triggerSnippet, type UsageLedgerRow, type UsageSource } from "./usage/ledger.js";
import { usageDataDir } from "./usage/dir.js";
import { readSessionWindowPercent } from "./usage/limits-log.js";
import { consumeRestartReasonFile } from "./restart-reason.js";
import { watchBus } from "./watch/bus.js";
import type { WatchSessionInfo } from "./watch/protocol.js";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { withConfigLockSync } from "./config-file.js";
import { writeJsonAtomicSync } from "./fs-utils.js";
import { CONTINUITY_DELIVERY_NOTE } from "./continuity-defaults.js";
import type { CronTurnOptions, InboxTurnHooks, QueuedInboundWork, RewindOutcome, UserTurnRequest } from "./agent/agent-turn-types.js";
import { OwnerAdoption } from "./agent/owner-adoption.js";
import { ContextNudger } from "./agent/context-nudger.js";
import { RestartCoordinator } from "./agent/restart-coordinator.js";
import { OwnerNotices } from "./agent/owner-notices.js";
import { oauthLabel, type McpOAuthLabel } from "./mcp/status-merge.js";
import { McpAuthPrompts } from "./agent/mcp-auth-prompts.js";

export type { SendResult, SessionCatalog } from "./agent/proactive-send.js";

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
/** How long shutdown waits for queued usage-ledger rows (local appends). */
const USAGE_LEDGER_SHUTDOWN_TIMEOUT_MS = 2_000;
/**
 * How long shutdown waits for an aborted /rewind to wind down. Abort is
 * honoured between steps, so this only covers one step already in flight
 * (a fork or transcript read); a stall past it is abandoned, never published.
 */
const REWIND_SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * How long after start the full legacy-transcript migration status is logged
 * again.
 *
 * `settled`/`deferred` only mean something once keys have been touched, and at
 * start none have. Five minutes is past the inbound traffic that follows a
 * restart (the continuity turn, the restart notice, whatever was queued) without
 * being so late that an operator reading the log has moved on. A timer rather
 * than a "first N keys" counter because it needs no hook on the message path.
 */
const MIGRATION_STATUS_RELOG_MS = 5 * 60_000;
/** How often the interrupted-subagents startup check is retried for sessions whose pending notes could not be read. */
const INTERRUPTED_AGENTS_RETRY_MS = 60_000;
/** How soon the owner is told again that the notes file was moved aside, when telling them failed. */
const PENDING_NOTES_QUARANTINE_NOTICE_RETRY_MS = 60_000;
/** This process: an interrupted-agents note is about the restart before it.
 *  A task id can be interrupted again by a later restart (a resumed agent
 *  keeps its id), and that is a new note, not the old one still queued. */
const BOOT_ID = randomUUID().slice(0, 8);

/**
 * How long a reply that matches no task waits for task sends still in flight
 * (see enqueueMessage). The wait runs after the inbox has the message, so a
 * crash during it loses nothing: the replay matches the reply again.
 */
const TASK_SEND_SETTLE_MS = 30_000;

/** How much of a stale unmatched reply its warning note quotes. */
const STALE_REPLY_EXCERPT = 2000;

export class Agent {
  private channels: Channel[] = [];
  /** Null unless `credentialBroker.enabled`. Read by the internal MCP server. */
  readonly credentialBroker: CredentialBroker | null;
  /** `request_permission`: a sandboxed group asks the owner for a path. Read by the internal MCP server. */
  readonly permissionBroker: PermissionBroker;
  private sessions: SessionStore;
  private router: OwnerRouter;
  /** Owner-facing, rate-limited trace of inbound messages the admission gate refused. */
  private readonly blockedInbound = new BlockedInboundLog();
  private sessionQueue = new SessionQueue();
  /** Per-key chain serializing /rewind (see rewindSession). */
  private rewinds = new Map<string, Promise<void>>();
  /** Rewinds in progress, awaited (bounded) by stop() after it aborts them. */
  private activeRewinds = new Set<Promise<unknown>>();
  /** Fired by stop(): rewinds stop between waits/attempts and discard their fork. */
  private readonly rewindAbort = new AbortController();
  /**
   * Inbound work that has been accepted by a channel but has not started its
   * per-session task yet. Unlike the generic SessionQueue tail, this retains
   * the messages themselves so shutdown can record them instead of merely
   * waiting for an arbitrary queued model turn.
   */
  private queuedInbound = new Map<symbol, QueuedInboundWork>();
  /** Set once `recordUnprocessedInbound` has swept `queuedInbound`. */
  private inboundDrained = false;
  /** Web requests whose turns are in flight per session. Several when owner
   *  browser input joined a running turn (#382); provider batching never
   *  steers into a session while this holds any. */
  private webRequestIds = new Map<string, Set<string>>();
  private batcher = new InboundBatcher({
    enqueueForSession: (key, task) => this.enqueueForSession(key, task),
    processInboundItems: (items, steer) => this.processInboundItems(items, steer),
    hasBusyLiveSession: (key) => this.liveSessionManager.isBusy(key),
    canSteerIntoSession: (key) => !this.webRequestIds.has(key),
  });
  private commands: ChatCommandHandler;
  /** The web Tasks panel's board, read by /tasks (unset while the web UI is off). */
  private taskSource: Pick<TaskBoard, "listFor"> | undefined;
  // /pause state: raw group keys whose inbound messages are dropped at receipt.
  private pauses: PauseStore;
  private usageLedger: UsageLedger;
  private modelOverrides = new Map<string, string>();
  private readonly ownerAdoption: OwnerAdoption;
  private readonly contextNudger: ContextNudger;
  private readonly restarts: RestartCoordinator;
  /** Sub-sessions (long tasks in their own `task:` sessions); undefined while `subsessions.enabled` is off. */
  readonly subsessions: SubsessionService | undefined;
  /** Sessions with a sub-session mirror note in flight: one at a time (see takeMirrorNote). */
  private readonly mirrorInFlight = new Set<string>();
  /** Sessions with a mirror wake turn queued: later rounds ride on it. */
  private readonly mirrorWakeQueued = new Set<string>();
  private readonly ownerNotices: OwnerNotices;
  private readonly mcpAuthPrompts: McpAuthPrompts;
  private pendingNotesQueue: PendingNotesQueue;
  /**
   * Durable record of every accepted inbound message until a turn consumes
   * it (see DurableInbox). Undefined when `config.inbox` is off or the log
   * could not be opened — the in-memory path then runs exactly as before.
   */
  private inbox: DurableInbox | undefined;
  /** Subagents/background commands running per session, mirrored to disk (see running-agents-ledger.ts). */
  private runningAgents: RunningAgentsLedger | undefined;
  private detachRunningAgents: (() => void) | undefined;
  /** Throttle for reportInboxFault's owner DM. */
  private lastInboxFaultNoticeAt = 0;
  private delivery: DeliveryPipeline;
  private turnRunner: TurnRunner;
  private liveSessionManager: LiveSessionManager;
  /**
   * Set the moment `stop()` begins. A deferred restart claimed after that
   * point would spawn a helper that brings the daemon straight back up — so
   * `tomo stop` on a session that had just asked for a restart would look like
   * it failed. Shutdown wins; the request is dropped, with a line saying so.
   */
  private stopping = false;
  /** End time of each session's last successful turn this process saw — the
   *  start of the range an owner notice suggests compacting. */
  private readonly lastGoodTurnAt = new Map<string, number>();
  /** Owner DMs for errors kept out of a chat (rate-limited). */
  private readonly ownerErrorNotifier = new OwnerErrorNotifier({
    send: (text, report) => this.ownerNotices.sendOwnerNotice(text, report.deliverTo),
    enabled: () => config.notifyOwnerOnSuppressedErrors !== false,
  });
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
  /** Re-logs the full migration status once, after the first keys have been
   *  touched (see `start`). Unref'd, and cleared by `stop`. */
  private migrationStatusTimer: ReturnType<typeof setTimeout> | undefined;
  /** Where unreadable pending-notes files were moved this process, not yet told to the owner. */
  private pendingNotesQuarantined: string[] = [];
  /** The channels have started: an owner notice can be sent. */
  private channelsUp = false;
  /** Re-runs the interrupted-subagents startup check for sessions whose pending notes could not be read. */
  private interruptedAgentsRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingNotesQuarantineTimer: ReturnType<typeof setTimeout> | undefined;
  /** The most recent sweep — awaited (bounded) by stop() so none is abandoned mid-write. */
  private mcpSweepInFlight: Promise<void> | undefined;

  constructor() {
    this.sessions = new SessionStore(config.sessionsDir, config.historyLimit, config.sdkSessionsDir);
    this.ownerAdoption = new OwnerAdoption(this.sessions, this.modelOverrides);
    this.contextNudger = new ContextNudger(
      this.sessions,
      (message, sessionKey, options) => this.handleCronMessage(message, sessionKey, options),
    );
    this.restarts = new RestartCoordinator({
      isStopping: () => this.stopping,
      queuePendingErrorNote: (sessionKey, visibleError) => this.queuePendingErrorNote(sessionKey, visibleError),
      onRestartClaimed: (sessionKey) => { if (isTaskSessionKey(sessionKey)) this.subsessions?.onRestartClaimed(sessionKey); },
      onRestartClaimFailed: (sessionKey) => { if (isTaskSessionKey(sessionKey)) this.subsessions?.onRestartClaimFailed(sessionKey); },
    });
    this.mcpAuthPrompts = new McpAuthPrompts({
      resolvePrivateReplyTarget: (key) => this.resolvePrivateReplyTarget(key),
      findPrivateReplyTarget: () => this.findPrivateReplyTarget(),
      getChannel: (name) => this.getChannel(name),
    });
    this.pendingNotesQueue = new PendingNotesQueue(this.sessions);
    this.sessions.onPendingNotesQuarantined = (aside) => {
      // Called from inside a read of the notes (maybe under a store lock):
      // only flags are set here. The sub-session service stops cleaning up
      // at once; the fresh file gets what is in memory, the lost sub-session
      // notes are written again, and the owner is told, once that read is over.
      this.subsessions?.pendingNotesLost();
      queueMicrotask(() => {
        try {
          this.pendingNotesQueue.persistLoaded();
        } catch (err) {
          log.error({ err }, "Could not write the loaded pending notes to the fresh file");
        }
        this.notePendingNotesQuarantined(aside);
      });
    };
    if (config.inbox) {
      try {
        this.inbox = new DurableInbox({ path: join(config.tomoHome, "data", "inbox.jsonl") });
      } catch (err) {
        log.error({ err }, "Durable inbox unavailable; inbound messages are held in memory only");
      }
    }
    if (config.interruptedAgents) {
      try {
        this.runningAgents = new RunningAgentsLedger({
          path: join(config.tomoHome, "data", "running-agents.json"),
          resolveTranscriptPath: (sessionKey, taskId) => {
            const sdkSessionId = this.sessions.getSdkSessionId(sessionKey);
            return sdkSessionId ? join(config.sdkSessionsDir, sdkSessionId, "subagents", `agent-${taskId}.jsonl`) : undefined;
          },
          warn: (obj, msg) => log.warn(obj, msg),
          autoResume: config.interruptedAgentsAutoResume,
        });
        this.detachRunningAgents = this.runningAgents.attach(watchBus);
      } catch (err) {
        log.warn({ err }, "Running-agents ledger unavailable; interrupted subagents will not be reported after a restart");
      }
    } else {
      RunningAgentsLedger.discard(join(config.tomoHome, "data", "running-agents.json"), (obj, msg) => log.warn(obj, msg));
    }
    this.delivery = new DeliveryPipeline({
      queuePendingErrorNote: (sessionKey, visibleError) => this.queuePendingErrorNote(sessionKey, visibleError),
    });
    // Late-bound closures: runWithRetry must dispatch through `this` at call
    // time (tests replace it on the instance).
    this.turnRunner = new TurnRunner({
      drainPendingNotes: (sessionKey) => this.drainPendingNotes(sessionKey),
      restorePendingNotes: (sessionKey, drained) => this.pendingNotesQueue.restore(sessionKey, drained),
      settlePendingNotes: (sessionKey, drained) => this.pendingNotesQueue.settle(sessionKey, drained),
      restoreInterruptedPendingNotes: (sessionKey, drained) => this.pendingNotesQueue.restoreInterrupted(sessionKey, drained),
      // A live session keeps the MEMORY.md / roster it was built with; a small
      // change rides in ahead of the turn as a note. NOT through the durable
      // queue: replayed after a restart it would describe a prompt the new
      // session does not have. A turn that did not complete rolls the
      // session's snapshot back instead.
      takePromptContextNote: (sessionKey) => this.liveSessionManager.takePromptContextNote(sessionKey),
      settlePromptContextNote: (ticket, told) => {
        if (told) this.liveSessionManager.settlePromptContextNote(ticket);
        else this.liveSessionManager.restorePromptContextNote(ticket);
      },
      // What the owner and this session's sub-sessions said to each other,
      // read from the task table each time (so never replayed stale after a
      // restart) and marked seen only by a turn that completed.
      takeMirrorNote: (sessionKey) => this.takeMirrorNote(sessionKey),
      settleMirrorNote: (ticket, told) => {
        this.mirrorInFlight.delete(ticket.key);
        if (told) this.subsessions?.markMirrorSeen(ticket.upTo);
      },
      // Persisted (sessions' pending-notes file): a reply the owner never got
      // must still be known to the next turn if the daemon restarts first.
      queueDeliveryFailureNote: (sessionKey, note) => this.queuePendingNote(
        sessionKey,
        formatTomoEvent("errors", note, { name: "delivery" }),
      ),
      runWithRetry: (req) => this.runWithRetry(req),
      mirrorMedia: (sessionKey, ref, path) => this.mirrorMediaToWeb(sessionKey, ref, path),
      appendAssistantTranscript: (sessionKey, content, channelName, correlation) => {
        this.sessions.append(sessionKey, {
          role: "assistant",
          ...correlation,
          content,
          channel: channelName,
          timestamp: Date.now(),
        });
      },
      queuePendingErrorNote: (sessionKey, visibleError) => this.queuePendingErrorNote(sessionKey, visibleError),
      startTurnTyping: (channel, chatId, passiveListen) => this.startTurnTyping(channel, chatId, passiveListen),
      isPrivateMemoryBarred: (sessionKey) => this.isPrivateMemoryBarred(sessionKey),
      isAttachmentBarred: (sessionKey, path) => this.isAttachmentBarred(sessionKey, path),
      delivery: this.delivery,
      undeliveredReplyAtTurnEnd: (sessionKey) => this.liveSessionManager.takeUndeliveredReply(sessionKey),
      requestRestate: (sessionKey, target) => this.restateUndeliveredReply(sessionKey, target),
      reportSuppressedError: (sessionKey, target, detail) => this.reportSuppressedError(sessionKey, target, detail),
      recordTurnOutcome: (sessionKey, ok) => { if (ok) this.lastGoodTurnAt.set(sessionKey, Date.now()); },
    });
    const summons = new SummonStore(
      join(config.tomoHome, "data", "summons.json"),
      config.summonExpiryMinutes * 60_000,
    );
    this.router = new OwnerRouter(config.owner, this.sessions, config.channelAllowlists, summons,
      (from, to) => this.ownerAdoption.adoptLegacySession(from, to));
    this.ownerNotices = new OwnerNotices({
      sessions: this.sessions,
      router: this.router,
      getChannel: (name) => this.getChannel(name),
      isStopping: () => this.stopping,
      lastGoodTurnAt: this.lastGoodTurnAt,
      ownerErrorNotifier: this.ownerErrorNotifier,
    });
    this.router.onSummonExpired = (channelName, chatId, identity, notifyGroup) =>
      this.handleSummonExpired(channelName, chatId, identity, notifyGroup);
    this.pauses = new PauseStore(join(config.tomoHome, "data", "pauses.json"));
    this.usageLedger = new UsageLedger(usageDataDir(config.tomoHome));
    this.commands = new ChatCommandHandler({
      router: this.router,
      sessions: this.sessions,
      pauses: this.pauses,
      modelOverrides: this.modelOverrides,
      closeLiveSession: (key) => this.liveSessionManager.closeLiveSession(key),
      isSessionLive: (key) => this.liveSessionManager.isAlive(key),
      rewindSession: (key, count) => this.rewindSession(key, count),
      queuePendingNote: (key, note) => this.queuePendingNote(key, note),
      getExternalMcpStatuses: (key) => this.mcpOAuthManager.getServerStatuses(
        config.mcpServers ?? {},
        this.liveSessionManager.mountedExternalMcpServers(key),
      ),
      readLiveMcpStatus: (key) => this.liveSessionManager.readMcpStatus(key),
      reconnectMcpServer: (key, serverName) => this.liveSessionManager.reconnectMcpServer(key, serverName),
      startExternalMcpLogin: (serverName) => this.mcpOAuthManager.startLogin(
        serverName,
        config.mcpServers ?? {},
      ),
      listTasks: (key, since) => this.taskSource?.listFor(key, since),
      sendToOwnerDm: async (owner, text) => {
        const target = this.router.dmReplyTarget(ownerSessionKey(owner));
        // Only a private DM: a reply target that is a group must not receive it.
        if (!target || isGroupSessionKey(`${target.channelName}:${target.chatId}`)) return false;
        const dm = this.getChannel(target.channelName);
        if (!dm) return false;
        await dm.send({ chatId: target.chatId, text });
        return true;
      },
    });
    this.mcpOAuthManager = new McpOAuthManager({
      workspaceDir: config.workspaceDir,
      onServerAuthError: (serverName, err) => this.mcpAuthPrompts.handleMcpAuthFailure(serverName, err),
      onServerAuthReady: (serverName, server) =>
        this.liveSessionManager.hotMountExternalMcpServer(serverName, server),
    });
    this.liveSessionManager = new LiveSessionManager({
      buildIdentityPrompt: () => buildIdentityPrompt(),
      promptContextSnapshot: (key, { strict }) => promptContextSnapshot({ isGroup: isGroupSessionKey(key), strict }),
      getSdkSessionId: (key) => this.sessions.getSdkSessionId(key),
      setSdkSessionId: (key, sessionId) => this.sessions.setSdkSessionId(key, sessionId),
      clearSdkSessionId: (key) => this.sessions.clearSdkSessionId(key),
      retireSdkSessionId: (key) => { this.sessions.retireSdkSessionId(key); },
      getUsageBaseline: (key, sdkSessionId) => this.resumeUsageBaseline(key, sdkSessionId),
      updateStats: (key, result) => {
        // Stats only. The registry's usage baseline is advanced by landed
        // usage-ledger rows alone (recordUsage below), never by a result
        // seen: a baseline that ran ahead of the ledger would let a resume
        // skip a turn whose row failed to land.
        const { usageBaseline: _seen, ...stats } = result;
        void _seen;
        this.sessions.updateStats(key, stats);
        watchBus.publish({
          type: "turn.stats",
          sessionKey: key,
          costUsd: result.costUsd,
          contextUsed: result.contextUsed,
          contextMax: result.contextMax,
          // Carried so a consumer can mark the reading rather than render a
          // turn's own token count over the window as the session's pressure —
          // which is a plausible-looking low percentage, not a missing one.
          ...(result.contextEstimated ? { contextEstimated: true } : {}),
        });
      },
      recordUsage: (key, build, onWritten) => {
        let row: UsageLedgerRow | undefined;
        void this.usageLedger.appendFor(key, () => (row = build()), () => {
          onWritten();
          // The registry copy follows the ledger, one landed row at a time.
          if (row) this.sessions.setUsageBaseline(key, row.snapshot ?? null);
        });
      },
      getSessionMessages: (key) => this.sessions.get(key).messages,
      // A sub-session runs on the model its task record names (or subsessions.defaultModel).
      getModelOverride: (key) => (isTaskSessionKey(key) ? this.subsessions?.modelFor(key) : this.modelOverrides.get(key)),
      subsessionContext: (key) => this.subsessionContext(key),
      createInternalMcpServer: (key) => createTomoInternalMcpServer(this, key),
      ...(this.runningAgents && config.interruptedAgentsAutoResume
        ? { resumeGate: (key: string, taskId: string) => this.runningAgents?.gateResume(key, taskId) ?? null }
        : {}),
      // A sub-session gets no external MCP server (sdk-options.ts drops them
      // too): nothing is built for it, so no OAuth prompt is started for it.
      buildExternalMcpServers: async (key) => isTaskSessionKey(key) ? {} : this.mcpOAuthManager.buildServersWithAuth(
        config.mcpServers ?? {},
        (serverName, url) => this.mcpAuthPrompts.forwardMcpAuthorizeUrl(key, serverName, url),
        // Interactive OAuth may wait ten minutes for a browser callback. Never
        // put chat/session revival behind that wait: the auth flow continues in
        // the background and the server joins a later live session.
        { authorizationWaitMs: 0 },
      ),
      buildGroupContext: (key) => this.buildGroupContext(key),
      isOwnAudienceTurn: (key) => this.isOwnAudienceTurn(key),
      scopedCallerKey: (key) => this.scopedCallerKey(key),
      groupSandbox: (key, opts) => this.groupSandboxFor(key, opts),
      noteSandboxedCall: (key, text) => this.permissionBroker.noteCall(key, text),
      handleMcpElicitation: (key, request) => this.mcpAuthPrompts.handleMcpElicitation(key, request),
      createUnownedTurnRequest: (key) => this.createUnownedTurnRequest(key),
      handleToolResult: (key, toolName, content, isError, turn) => {
        this.handleToolResult(key, toolName, content, isError, turn);
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
      notifyOwner: (text) => this.notifyOwner(text),
    });
    this.proactive = new ProactiveSendService({
      getChannel: (name) => this.getChannel(name),
      isPrivateMemoryBarred: (sessionKey) => this.isPrivateMemoryBarred(sessionKey),
      isAttachmentBarred: (sessionKey, path) => this.isAttachmentBarred(sessionKey, path),
      getSummonedIdentity: (channelName, chatId) => this.router.getSummonedIdentity(channelName, chatId),
      dmReplyTarget: (sessionKey) => this.router.dmReplyTarget(sessionKey),
      sessionReplyTarget: (sessionKey) => this.router.sessionReplyTarget(sessionKey),
      appendAssistantTranscript: (sessionKey, content, channelName, correlation) => {
        this.sessions.append(sessionKey, {
          role: "assistant",
          ...correlation,
          content,
          channel: channelName,
          timestamp: Date.now(),
        });
      },
      mirrorMedia: (sessionKey, ref, path) => this.mirrorMediaToWeb(sessionKey, ref, path),
      setChatTitle: (sessionKey, title) => this.sessions.setChatTitle(sessionKey, title),
      listActiveEntries: () => this.sessions.listActiveEntries(),
      queuePendingNote: (sessionKey, note) => this.queuePendingNote(sessionKey, note),
      runDelegateTurn: (systemMsg, sessionKey, deliveryTarget, audiences) =>
        this.handleCronMessage(systemMsg, sessionKey, {
          usageSource: "delegate",
          ...(deliveryTarget ? { deliveryTarget } : {}),
          ...(audiences ? { audiences } : {}),
        }),
    });

    this.credentialBroker = this.createCredentialBroker();
    this.permissionBroker = this.createPermissionBroker();

    // Load persistent per-session model overrides
    for (const [key, model] of Object.entries(config.sessionModelOverrides)) {
      this.modelOverrides.set(key, model);
    }

    this.subsessions = config.subsessions.enabled ? this.createSubsessionService() : undefined;
  }

  /**
   * The sub-session service and everything it needs from the agent. Every
   * dependency resolves the task's owning scope from its record (parentKey),
   * never from a hardcoded owner key, so a group-scoped task (future work)
   * would report, notify and be fenced through its group.
   */
  private createSubsessionService(): SubsessionService {
    const cron = createTaskCronLink(CRON_STORE_PATH);
    return new SubsessionService({
      store: new SubsessionStore(join(config.tomoHome, "data", "subsessions.json"), {
        onChange: () => { for (const listener of this.subsessionListeners) listener(); },
      }),
      config: () => config.subsessions,
      runTaskTurn: (key, prompt, opts) => this.runTaskTurn(key, prompt, opts),
      sendToScope: async (parentKey, text, taskKey, noteFrom, harnessPrefix) => {
        // No direct-send note: the owning session sees what its tasks say through the mirror.
        const result = await this.proactive.sendToSession(parentKey, text, taskKey, { noteFrom, harnessPrefix, skipNote: true });
        return result.ok
          ? { ok: true, ...(result.channel ? { channel: result.channel } : {}), ...(result.messageIds ? { messageIds: result.messageIds } : {}) }
          : { ok: false, error: result.error };
      },
      noticeToScope: async (parentKey, text) => {
        if (parentKey === this.router.ownerSessionKey()) {
          await this.notifyOwner(text);
          return;
        }
        const target = this.resolveDeliveryTargetForSession(parentKey, "Sub-session notice");
        if (target) await target.channel.send({ chatId: target.chatId, text });
      },
      noticeOwner: async (text) => { await this.notifyOwner(text); },
      // A task owned by the owner's DM speaks for the owner alone: its notes
      // never drain into a summoned group's turn on that session.
      queuePendingNote: (key, note, id) => this.queuePendingNote(key, isDmSessionKey(key) ? markOwnerAudience(note) : note, id),
      hasPendingNote: (key, predicate, whenUnreadable) => this.pendingNotesQueue.hasNote(key, predicate, whenUnreadable),
      persistPendingNotes: (key) => this.pendingNotesQueue.persistNow(key),
      wakeScope: (parentKey, prompt) => {
        const body = appendToTomoEventBody(prompt, CONTINUITY_DELIVERY_NOTE);
        this.enqueueForSession(parentKey, () => this.processContinuity(body, parentKey, undefined, ownerT("notices")("suppressed.turn.subsessionReport"), "background"))
          .catch((err) => log.error({ err, sessionKey: parentKey }, "Sub-session report turn failed in queue"));
      },
      contextUsage: (key) => {
        const last = this.liveSessionManager.lastResult(key);
        return last ? { used: last.contextUsed, estimated: last.contextEstimated === true } : undefined;
      },
      cronJobCount: (key) => cron.count(key),
      removeCronJobs: (key) => cron.removeAll(key),
      stopSession: (key, timeoutMs) => this.stopTaskSession(key, timeoutMs),
      hasTurnInFlight: (key) => this.liveSessionManager.hasTurnInFlight(key),
      hasBackgroundWork: (key) => this.hasBackgroundWork(key),
      closeSession: (key) => this.liveSessionManager.closeLiveSession(key),
      registryReadable: () => this.sessions.registryReadable(),
      hasSdkSession: (key) => this.sessions.getSdkSessionId(key) !== undefined,
      hasLiveSession: (key) => this.liveSessionManager.hasLiveSession(key),
      ensureRegistryEntry: (key) => this.sessions.ensureEntry(key),
      unlinkRegistryEntry: (key) => this.sessions.clearSdkSessionId(key),
      registryTaskKeys: () => this.sessions.listActiveEntries().map((e) => e.channelKey).filter(isTaskSessionKey),
      isStopping: () => this.stopping,
      sessionQuotaPercent: () => readSessionWindowPercent(join(usageDataDir(config.tomoHome), "limits.ndjson")),
      ...(config.subsessions.todos ? { todos: createTodoLink(new TodoStore()) } : {}),
      mirrorWake: (parentKey) => this.mirrorWake(parentKey),
    });
  }

  /**
   * The sub-session mirror note for a turn on `key`: only a turn of the
   * session's own audience (a summoned group's turn on the owner's session
   * gets none), and one at a time per session, so two overlapping turns never
   * both claim the same lines.
   */
  private takeMirrorNote(key: string): MirrorTicket | undefined {
    if (!this.subsessions || this.mirrorInFlight.has(key) || !this.isOwnAudienceTurn(key)) return undefined;
    const note = this.subsessions.mirrorNote(key);
    if (!note) return undefined;
    this.mirrorInFlight.add(key);
    return { key, prefix: `${note.text}\n\n`, upTo: note.upTo };
  }

  /**
   * mirror "turn": a silent turn on the owning session so it sees a round of
   * a task's conversation with the owner. One queued at a time; when it runs
   * it carries everything unseen by then (rounds merge), and it does not run
   * at all if another turn has already shown it.
   */
  private mirrorWake(parentKey: string): void {
    if (this.mirrorWakeQueued.has(parentKey)) return;
    this.mirrorWakeQueued.add(parentKey);
    const prompt = appendToTomoEventBody(formatTomoEvent("subsession-activity",
      "A sub-session conversation is shown above. Take it in; nothing you write here is sent. If nothing needs doing, end with NO_REPLY.",
      { name: "check" }), CONTINUITY_DELIVERY_NOTE);
    this.enqueueForSession(parentKey, async () => {
      this.mirrorWakeQueued.delete(parentKey);
      // Only for words the owner wrote (another turn may have shown them meanwhile).
      if (this.stopping || !this.subsessions?.hasUnseenOwnerWords(parentKey)) return;
      // Asked again here: the quota window can fill while the wake waits.
      if (!this.subsessions.mirrorTurnAllowed()) return;
      await this.processContinuity(prompt, parentKey, undefined, ownerT("notices")("suppressed.turn.subsessionMirror"), "background");
    }).catch((err) => {
      this.mirrorWakeQueued.delete(parentKey);
      log.error({ err, sessionKey: parentKey }, "Sub-session mirror turn failed in queue");
    });
  }

  /** A sub-session's prompt and limits; undefined for every other key (see LiveSessionManager). */
  private subsessionContext(key: string): SessionContext["subsession"] {
    if (!isTaskSessionKey(key)) return undefined;
    const effort = this.subsessions?.effortFor(key);
    return {
      staticPrompt: buildSubsessionPrompt({
        agentName: config.agentName ?? "Tomo",
        ownerName: config.owner?.displayName ?? config.owner?.name ?? "the owner",
      }),
      groupScope: this.taskScopeIsGroup(key),
      maxTurns: config.subsessions.maxTurns,
      ...(effort && (EFFORT_LEVELS as readonly string[]).includes(effort) ? { effort: effort as EffortLevel } : {}),
    };
  }

  /**
   * Is a task's owning scope a group? Privacy follows the scope that spawned
   * the task. An unknown scope (no record, unreadable table) counts as a
   * group: fail closed.
   */
  private taskScopeIsGroup(key: string): boolean {
    const parent = this.subsessions?.parentKeyOf(key);
    return parent === undefined ? true : isGroupSessionKey(parent);
  }

  /**
   * One silent turn on a task key, queued on that key. Nothing it writes
   * reaches a chat (a task speaks through its task_* tools); errors are kept
   * to a pending note on the task itself, and the service decides what
   * follows. The text it ended with comes back for the service's fallback.
   */
  private runTaskTurn(key: string, prompt: string, opts: { bare: boolean }): Promise<TaskTurnOutcome> {
    return this.enqueueForSession(key, async () => {
      let stopped = false;
      let shutdown = false;
      let response: string | undefined;
      const ok = await this.turnRunner.runTurn({
        key,
        source: "continuity",
        usage: { source: "background" },
        prompt,
        bare: opts.bare,
        delivery: {
          kind: "deferred-send",
          suppressDelivery: true,
          suppressedLog: "Sub-session output kept out of chat (a task speaks through its task_* tools)",
          resolveTarget: () => undefined,
          onSuppressedResponse: (text) => { response = text; },
        },
        silentMatcher: isSilentReply,
        transcript: "on-delivery",
        errors: {
          visibleError: "continuity",
          response: "note-only",
          responseSuppressedLog: "Sub-session turn returned an agent error response",
          thrown: "ignore",
          thrownLogMessage: "Sub-session turn failed",
        },
        onShutdown: () => { shutdown = true; },
        onStopped: () => { stopped = true; },
      });
      return { ok: ok && !stopped && !shutdown, stopped, shutdown, ...(response !== undefined ? { response } : {}) };
    }).catch((err): TaskTurnOutcome => {
      log.error({ err, sessionKey: key }, "Sub-session turn failed in queue");
      return { ok: false, shutdown: this.stopping };
    });
  }

  /** Soft stop (the SDK's interrupt), then close; closed anyway after `timeoutMs`. */
  private async stopTaskSession(key: string, timeoutMs: number): Promise<void> {
    await this.liveSessionManager.stopTurn(key).catch(() => false);
    const deadline = Date.now() + timeoutMs;
    while (this.liveSessionManager.hasTurnInFlight(key) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (this.liveSessionManager.hasTurnInFlight(key)) log.warn({ key }, "Sub-session did not stop in time; closing its session");
    this.liveSessionManager.closeLiveSession(key);
  }

  /** The broker when `credentialBroker.enabled`, else null. */
  private createCredentialBroker(): CredentialBroker | null {
    if (!config.credentialBroker?.enabled) return null;
    const broker = new CredentialBroker({
      backend: new KeychainBackend(),
      stateFile: new BrokerStateFile(join(config.tomoHome, "data", "credentials", "state.json")),
      isOwnerSender: (channelName, senderId) => this.router.isOwnerSender(channelName, senderId),
      // Asked where the turn came in on: iMessage, Telegram, or the web card.
      captureChannel: (origin) => captureChannelFor(this.getChannel(origin.channelName), origin.chatId),
      notifySession: (sessionKey, body) => {
        this.handleCronMessage(formatTomoEvent("credential", body, { name: "result" }), sessionKey, { showTyping: false })
          .catch((err) => log.error({ err, sessionKey }, "Credential result turn failed to queue"));
      },
      // Deferred: the first load runs in this constructor, before any channel
      // is added, and the notice would have nowhere to go.
      notifyOwner: (text) => {
        setTimeout(() => {
          this.sendNotification(text).catch((err) => log.warn({ err }, "Could not tell the owner about credential redaction"));
        }, 15_000).unref?.();
      },
    });
    void broker.primeRedaction();
    return broker;
  }

  /** The permission broker, always on: it only acts when a group turn calls `request_permission`. */
  private createPermissionBroker(): PermissionBroker {
    return new PermissionBroker({
      ledger: new PermissionLedger(permissionLedgerPath(config.tomoHome)),
      workspaceDir: config.workspaceDir,
      assess: (groupKey, sessionKey, path, access) => this.assessPermission(groupKey, sessionKey, path, access),
      ownerDm: () => this.permissionDmTarget(),
      card: () => {
        const web = this.getChannel("web") as (Channel & { publishPermissionRequests?: (r: PermissionRequestView[]) => void }) | undefined;
        return typeof web?.publishPermissionRequests === "function"
          ? { publish: (requests) => web.publishPermissionRequests!(requests) } : undefined;
      },
      isOwnerSender: (channelName, senderId) => this.router.isOwnerSender(channelName, senderId),
      persistAlways: (groupKey, access, path, grant) => persistGroupGrant(groupKey, access, path, this.grantTarget(), { ...grant, at: new Date().toISOString() }),
      newGrantId: () => newGrantId(config.groupSandbox),
      findGrant: (grantId) => {
        const found = findGrant(config.groupSandbox, grantId);
        return found ? { groupKey: found.groupKey, path: found.grant.path } : undefined;
      },
      grantForRequest: (requestId) => grantForRequest(config.groupSandbox, requestId)?.grantId,
      revokeAlways: (groupKey, path) => revokeGroupGrant(groupKey, path, this.grantTarget()),
      notifySession: (sessionKey, groupKey, outcome, body, onTurnBegin) => {
        // Registered with the group as its audience, so a summoned group's
        // answer turn stays scoped to that group; its turn id is handed back
        // so an Allow once binds to this one turn (PermissionBroker.withOnceGrants).
        this.handleCronMessage(formatTomoEvent("permission", body, { name: outcome }), sessionKey,
          { showTyping: false, audiences: [groupKey], ...(onTurnBegin ? { onTurnBegin } : {}) })
          .catch((err) => log.error({ err, sessionKey }, "Permission result turn failed to queue"));
      },
      liveTurnIds: (sessionKey) => this.turnAudiences.liveTurnIds(sessionKey),
      isTurnLive: (id) => this.turnAudiences.isLive(id),
      groupTitle: (groupKey) => this.sessions.getEntry(groupKey)?.chatTitle,
    });
  }

  private grantTarget() {
    return { configPath: CONFIG_PATH, backupPath: CONFIG_BACKUP_PATH, live: config };
  }

  /**
   * The group sandbox config the guard applies on `sessionKey` right now:
   * config's `groupSandbox` (legacy allowlist folded in) plus the Allow-once
   * grants live on this session's turns.
   */
  groupSandboxFor(sessionKey: string, opts: { once: boolean } = { once: true }): GroupSandboxConfig {
    const base = effectiveGroupSandbox(config.groupSandbox, config.groupShellAllowlist);
    return opts.once ? this.permissionBroker.withOnceGrants(base, sessionKey) : base;
  }

  /** Is `path` already reachable for the group, never grantable, or worth asking the owner about? */
  private assessPermission(groupKey: string, sessionKey: string, path: string, access: PermissionAccess): PermissionAssessment {
    return assessGroupPermission(this.groupSandboxFor(sessionKey).groups[groupKey], path, access);
  }

  /**
   * The owner's private chat for a permission request: iMessage or Telegram
   * only (where a coded reply is read; the web UI has its card), and only a
   * handle that is still the owner's. The last-active target first, then the
   * configured one.
   */
  private permissionDmTarget(): { channel: Channel; chatId: string } | undefined {
    const owner = config.owner;
    const key = this.router.ownerSessionKey();
    if (!owner || !key) return undefined;
    for (const target of [this.router.getReplyTarget(key), this.router.deriveReplyTargetFromConfig(owner.name)]) {
      if (!target || (target.channelName !== "imessage" && target.channelName !== "telegram")) continue;
      if (!isOwnerHandle(owner, target.channelName, target.chatId)) continue;
      const channel = this.getChannel(target.channelName);
      if (channel) return { channel, chatId: target.chatId };
    }
    return undefined;
  }

  /** Look up a channel by name */
  /** An attachment delivered on another channel, filed for the web view (Channel.mirrorMedia); best effort. */
  private mirrorMediaToWeb(sessionKey: string, ref: string, path: string): void {
    try { this.getChannel("web")?.mirrorMedia?.(sessionKey, ref, path); } catch (err) { log.debug({ err }, "Attachment not mirrored to the web view"); }
  }

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
      // A channel with no allowlist has no active groups (admission fails
      // closed), so the secret CREATES the list here. That no longer touches
      // DMs: the owner's DM is admitted through its identity binding, not
      // through the allowlist.
      withConfigLockSync(CONFIG_PATH, () => {
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
        }
      });
      // Update the router's in-memory allowlist (also when the file already
      // listed it, e.g. hand-edited since startup).
      this.router.addToAllowlist(channel.name, chatId);
      log.info({ channel: channel.name, chatId }, "Group chat activated via secret");
      await channel.send({ chatId, text: ownerT("notices")("group.activated") });
    } catch (err) {
      log.error({ err }, "Failed to activate group");
    }
  }

  /** Give /tasks the web Tasks panel's board, so the chat list and the panel share one state. */
  setTaskSource(source: Pick<TaskBoard, "listFor">): void {
    this.taskSource = source;
  }

  addChannel(channel: Channel): void {
    this.warnIfChannelHasNoOwner(channel.name);
    channel.onMessage((msg) => this.enqueueMessage(channel, msg));
    // Same allowlist the ingress path enforces, offered to the channel early
    // so it can decline to DOWNLOAD what enqueueMessage is about to drop. It
    // is advisory: the channel still dispatches, and the decision below is
    // still the one that counts.
    channel.onAdmission?.((chatId) => this.router.isAllowed(channel.name, chatId));
    // A channel fault the channel cannot fix itself goes to the owner's DM.
    channel.onOwnerNotice?.((notice) => this.notifyOwner(channelFaultText(notice)));
    channel.onCommand((cmd, chatId, senderName, args, senderId) =>
      this.commands.handle(channel, cmd, chatId, senderName, args, senderId));
    this.channels.push(channel);
  }

  /**
   * Browser messages the previous run accepted and never finished (web
   * request journal). They are NOT re-run — one may already have been handed
   * to the model and partly acted on — so the owner's session is told once,
   * on its next turn, and the browser shows them as interrupted.
   */
  /**
   * Which of these browser requests already have their user message in the
   * owner session's transcript (its recent tail). Read-only; a request not
   * found keeps its interrupted text until the owner deals with it.
   */
  recordedWebRequests(requestIds: string[], chatId: string): Set<string> {
    if (requestIds.length === 0) return new Set();
    const wanted = new Set(requestIds);
    try {
      const key = this.router.resolve("web", chatId, false).sessionKey;
      return new Set(this.sessions.get(key).messages.flatMap((m) => m.role === "user" && m.requestId && wanted.has(m.requestId) ? [m.requestId] : []));
    } catch { return new Set(); }
  }

  /** Returns true once the note is durably queued (written and fsynced). */
  noteInterruptedWebRequests(items: Array<{ timestamp: number; text?: string }>, chatId: string): boolean {
    if (items.length === 0) return true;
    const key = this.router.resolve("web", chatId, false).sessionKey;
    const quoted = items.slice(-3).map((item) => item.text ? `- "${item.text.replace(/\s+/g, " ").slice(0, 160)}"` : "- (text not kept)");
    return this.queuePendingNote(key, formatTomoEvent("web",
      `${items.length} message${items.length === 1 ? "" : "s"} sent from the browser ${items.length === 1 ? "was" : "were"} accepted before Tomo restarted and never answered${items.length > 3 ? " (latest three)" : ""}:\n${quoted.join("\n")}\n`
      + "They were not re-run automatically: one may already have been partly acted on. The browser marks them interrupted. If one still matters, check what was done and mention it to the owner before acting on it.",
      { name: "interrupted" }));
  }

  /**
   * Daemon start: log the owner notices once (multi-identity pick, legacy
   * adoption, no owner, ignored allowlist DM entries), adopt a legacy
   * per-channel owner session if one is due, and make sure the owner's `dm:`
   * session entry exists — so every channel added later binds to that one
   * session. Writes nothing for an install whose owner session is linked.
   */
  prepareOwner(): void {
    for (const notice of config.ownerNotices) {
      if (notice.level === "warn") log.warn({ ownerSource: config.ownerSource }, notice.message);
      else log.info({ ownerSource: config.ownerSource }, notice.message);
    }
    const ignored = ignoredAllowlistDmEntries(config.owner, config.channelAllowlists);
    for (const [channel, count] of Object.entries(ignored)) {
      log.warn(
        { channel, count },
        "DM entries in this channel's allowlist are ignored: the allowlist only activates groups, and only the owner's DMs are answered.",
      );
    }
    this.ownerAdoption.finishInterruptedAdoption();
    const key = this.router.prepareOwnerSession();
    if (key) log.info({ sessionKey: key }, "Owner session ready");
  }

  /**
   * Admission fails closed, so a provider channel nobody is bound to answers
   * no DM at all. Say so once at startup, loudly, with the fix — otherwise a
   * fresh iMessage setup just looks broken.
   */
  private warnIfChannelHasNoOwner(channelName: string): void {
    if (channelName === "web") return;
    if (!this.router.hasBoundOwner(channelName)) {
      log.warn(
        { channel: channelName },
        "No owner handle is bound on this channel, so its DMs are ignored. Run `tomo config` and add your handle on this channel to the owner.",
      );
    }
    if (!this.router.hasAllowlist(channelName)) {
      const passive = config.passiveGroups[channelName] ?? [];
      if (passive.length > 0) {
        log.warn(
          { channel: channelName, passiveGroups: passive.length },
          "passiveGroups are listed for this channel, but it has no allowlist, so those groups are not active. Send the group secret in each group, or add their ids to the channel's allowlist.",
        );
      }
      log.info(
        { channel: channelName },
        config.groupSecret
          ? "No group is activated on this channel yet; send the group secret in a group to activate it."
          : "Group chats on this channel are off (no group is activated and no group secret is set). Enable them with `tomo config` → Group chats.",
      );
    }
  }

  /** The SDK session id behind a session key, or undefined before its first turn. */
  sdkSessionIdFor(key: string): string | undefined {
    return this.sessions.getSdkSessionId(key);
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
   * /rewind. Deliberately NOT on the session queue: the owner reaches for it
   * when a turn is stuck, and behind the queue it would wait for that very
   * turn. Instead it interrupts the running turn (never retried, nothing more
   * delivered from it) and holds the key in the LiveSessionManager while it
   * forks, so every other turn for this key — queued user messages, steered
   * drains, crons, heartbeats — waits and then runs on the rewound
   * conversation. Nothing queued is dropped or re-run. Rewinds of one key
   * run one at a time.
   */
  private rewindSession(key: string, count: number): Promise<RewindOutcome> {
    const previous = this.rewinds.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.rewindSessionNow(key, count));
    const settled = run.then(() => {}, () => {});
    this.rewinds.set(key, settled);
    this.activeRewinds.add(settled);
    void settled.then(() => {
      this.activeRewinds.delete(settled);
      if (this.rewinds.get(key) === settled) this.rewinds.delete(key);
    });
    return run;
  }

  private async rewindSessionNow(key: string, count: number): Promise<RewindOutcome> {
    const stopping = () => new RewindError({ kind: "stopping" });
    if (this.stopping) throw stopping();
    // A brand-new conversation has no stored SDK id until its first turn
    // returns a result — so a FIRST turn that is stuck has none either. There
    // is nothing to fork, but the owner still needs the turn stopped.
    // Always suspended, even then: the first turn may still be building its
    // session (not yet busy), and only the hold plus the interrupt stop it.
    const stopOnly = !this.sessions.getSdkSessionId(key);
    const suspension = await this.liveSessionManager.suspendForRewind(key);
    try {
      if (this.stopping) throw stopping();
      const sid = this.sessions.getSdkSessionId(key);
      if (stopOnly && !sid) {
        if (!suspension.stoppedTurn) throw new RewindError({ kind: "no_conversation" });
        return { count: 0, preview: "", stoppedTurn: suspension.stoppedTurn, droppedMessages: suspension.droppedMessages, nothingToRewind: true };
      }
      if (!sid) throw new RewindError({ kind: "no_conversation" });
      const rewind = await prepareSettledSessionRewind(sid, count, config.workspaceDir, config.sdkSessionsDir, (prepared) => {
        if (this.stopping) throw stopping();
        prepared.assertUnchanged();
        this.sessions.replaceSdkSessionId(key, sid, prepared.sessionId);
      }, { signal: this.rewindAbort.signal });
      return { count: rewind.count, preview: rewind.preview, stoppedTurn: suspension.stoppedTurn, droppedMessages: suspension.droppedMessages };
    } finally {
      suspension.release();
    }
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
    if (channel.name === "web" && (this.stopping || this.commands.isRestoring || message.isGroup || message.chatId !== "owner")) return false;
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
        this.blockedInbound.record(channel.name, message.chatId, isGroup);
      }
      return true;
    }

    // Before routing, the batcher, the transcript and the log line in
    // handleMessage: a message taken here reaches none of them.
    if (this.credentialBroker && await this.credentialBroker.handleInbound(channel, message)) {
      return true;
    }
    // The owner answering a group's permission request ("1 K7Q", or a quoted
    // reply). Never a group message: the broker returns before parsing one.
    if (await this.permissionBroker.handleInbound(channel, message)) {
      return true;
    }

    // A provider redirect opened on another device cannot reach this Mac's
    // localhost callback listener. Let a configured owner paste that full
    // redirect into their DM instead; consume callback-shaped secrets before
    // they can enter a transcript or model context. Groups and non-owners
    // never reach the OAuth manager.
    if (!isGroup && this.router.isOwnerSender(channel.name, message.senderId)) {
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

    // A sub-session addressed by the owner (`/s …`, or a reply to one of its
    // messages): their own DM only, after every gate above and before the
    // inbox. A command is answered here and consumed, like a broker's
    // message; a message keeps its path below (inbox, dedup, replay) with
    // the task's key. Not from the web UI yet: a web request is bound to a
    // reply this route would never give.
    let taskKey: string | undefined;
    let unmatchedReply = false;
    if (this.subsessions && !isGroup && channel.name !== "web" && this.router.isOwnerSender(channel.name, message.senderId)) {
      const routed = await this.routeOwnerToTask(channel, message);
      if (routed === "consumed") return true;
      if (routed && "sending" in routed) {
        // Which tasks were sending, kept WITH the message (so in the inbox
        // too): if it still matches nothing after they settle — or after a
        // restart — the owner session is told it may have been meant for them.
        unmatchedReply = true;
        message = { ...message, taskSendsInFlight: routed.sending };
      } else if (routed) ({ message, taskKey } = routed);
    }

    // Resolve ONCE, at receipt — this decides both which queue the message
    // waits in and which session eventually processes it. Re-resolving at
    // processing time would let a /summon or /dismiss that lands while the
    // message waits (in-flight turn, iMessage settle window) re-route it.
    // (Resolved for a task message too: it moves the owner's reply target.)
    let resolution = this.router.resolve(channel.name, message.chatId, isGroup);
    if (channel.name === "web") resolution.replyTarget = { channelName: "web", chatId: message.id };
    if (taskKey) resolution = { ...resolution, sessionKey: taskKey };

    // DURABLE CUSTODY. Persist before the `true` below reaches the channel:
    // that answer is what makes imsg commit its cursor, and Telegram has
    // already confirmed the update. From here a crash replays the message on
    // the next start instead of losing it. Web turns are bound to a live HTTP
    // request that does not survive a restart (the browser sees the failure
    // and can resend), and the group secret must never be written to disk.
    let inboxId: string | undefined;
    if (this.inbox && channel.name !== "web" && !(config.groupSecret && message.text.trim() === config.groupSecret)) {
      const persisted = this.inbox.accept(channel.name, message, resolution);
      if (persisted.status === "duplicate") {
        log.info({ channel: channel.name, messageId: message.id }, "Inbound message already in the durable inbox; not dispatching it twice");
        return true;
      }
      if (persisted.status === "accepted") inboxId = persisted.id;
      else if (persisted.reason === "failed") {
        // THE WRITE FAILED: an ingress fault, not a reason to quietly fall
        // back to memory. Answering `true` now would make a channel that
        // commits on our answer (imsg's rowid cursor) forget the message, and
        // a crash before the turn would then lose it for good.
        if (channel.redeliversUnacknowledged) {
          // Do not take custody. A throw is the hand-off contract's "row not
          // handled" (MessageHandler): imsg leaves its cursor where it was,
          // floors it at this row and resubscribes, so the row comes again
          // (with backoff) until a write succeeds. Nothing is dispatched here,
          // so the redelivery is the only copy — never a second answer.
          throw new InboxPersistError(channel.name, message.id);
        }
        // The channel confirmed this before we saw it (grammY acks the
        // update first), so refusing would only lose it now instead of on a
        // crash. Process it in memory as before, and say so loudly.
        this.reportInboxFault(
          ownerT("notices")("inbox.unsaved", { channel: channel.name }),
          { channel: channel.name, messageId: message.id },
        );
      }
    }

    // A reply that matched no task while a task's send was still in flight:
    // the owner may be answering that very message, whose ids are not known
    // yet. Wait for the sends to settle — AFTER custody, so a crash here
    // loses nothing (the replay matches the reply again) — then look again.
    if (unmatchedReply) resolution = await this.settleUnmatchedReply(channel.name, message, resolution);

    const accepted = this.dispatchInbound(channel, message, resolution, inboxId);
    // Refused only past the shutdown drain. A durably persisted message is
    // still ours — the next start replays it — so custody stands.
    return accepted || inboxId !== undefined;
  }

  /**
   * Hand an accepted message to the batcher or the per-session queue. Shared
   * by live ingress and the durable-inbox replay, so a replayed message takes
   * exactly the path it would have taken the first time.
   */
  private dispatchInbound(
    channel: Channel,
    message: IncomingMessage,
    resolution: SessionResolution,
    inboxId: string | undefined,
  ): boolean {
    // A message to a sub-session never runs a turn here: it is handed to the
    // task (its pendingInput, on disk) — also on a replay, which re-checks
    // that the task is still there.
    if (isTaskSessionKey(resolution.sessionKey)) return this.deliverToTask(channel, message, resolution, inboxId);
    const isGroup = message.isGroup ?? false;
    const sessionKey = resolution.sessionKey;
    const isPassiveGroup = isGroup && this.isPassiveListenGroup(channel.name, message.chatId);
    // Owner web input can join an active private user turn (#382). Replies
    // stay on the turn's own outlet and are mirrored to the browser; group,
    // summoned, silent and background work stays queued. LiveSession.steer
    // checks eligibility again, synchronously, right before injection.
    if (channel.name === "web" && config.steering && this.liveSessionManager.isBusy(sessionKey)
      && this.isOwnAudienceTurn(sessionKey) && this.liveSessionManager.isInteractiveTurn(sessionKey)) {
      void this.processInboundItems([{ channel, message, resolution }], true).catch((err) => {
        channel.settleMessage?.(message.id, "unknown"); log.error({ err }, "Web steering failed");
      });
      return true;
    }
    // Provider batching never steers into a live web turn (canSteerIntoSession).
    // Web must stay out of the batch path: handleBatchedMessages writes no
    // web requestId and ignores userRecorded (see appendInboundUser).
    const canCoalesce = (!isGroup || isPassiveGroup) && channel.name !== "web";

    if (!canCoalesce) {
      // Through processInboundItems (not handleMessage directly) so the
      // allowlist and /pause state are re-checked at processing time — this
      // task can wait behind an in-flight turn, and both can change meanwhile.
      this.enqueueInboundForSession(resolution.sessionKey, [{ channel, message, resolution, ...(inboxId ? { inboxId } : {}) }]);
      return true;
    }

    return this.batcher.enqueue(resolution.sessionKey, channel, message, canCoalesce, resolution, inboxId);
  }

  /**
   * Is this owner DM addressed to a sub-session? `"consumed"`: a `/s`
   * command, answered here. A message: the task's key and the message with
   * the `/s <id>` prefix taken off. A reply or tapback on one of a task's
   * messages routes to that task as it is.
   */
  private async routeOwnerToTask(channel: Channel, message: IncomingMessage): Promise<"consumed" | { sending: string[] } | { taskKey: string; message: IncomingMessage } | undefined> {
    const service = this.subsessions;
    const scope = this.router.ownerSessionKey();
    if (!service || !scope) return undefined;
    const typed = message.rawText ?? message.text;
    const address = typed ? parseTaskAddress(typed) : undefined;
    if (address && address.kind !== "message") {
      await this.answerTaskCommand(channel, message.chatId, scope, address);
      return "consumed";
    }
    if (address) {
      // Channels put markers in front of what was typed (`[replying to …]`,
      // an attachment's path): keep them, replace only the typed part.
      const text = message.text.endsWith(typed) ? `${message.text.slice(0, message.text.length - typed.length)}${address.body}` : address.body;
      return { taskKey: taskSessionKey(address.id), message: { ...message, text, rawText: address.body } };
    }
    const ref = message.replyToId ?? message.reactedToId;
    const task = ref ? service.taskForReply(scope, channel.name, ref) : undefined;
    if (task) return { taskKey: task.sessionKey, message };
    // The owner can see (and answer) a task's message before its send
    // resolves with the ids that map replies to it. Decided after custody.
    if (!ref || !service.sendsInFlight(scope)) return undefined;
    const sending = service.sendingTasks(scope).map((t) => t.id);
    return sending.length > 0 ? { sending } : undefined;
  }

  /**
   * An owner reply that matched no task while task sends were in flight
   * (already in the inbox): wait for those sends, then match it again. Still
   * unmatched with a send pending, it stays with the owner's session, which
   * is told the owner may be answering that task: only the owner's own words
   * reach a task as theirs, so it asks them to send it again with /s.
   */
  private async settleUnmatchedReply(channelName: string, message: IncomingMessage, resolution: SessionResolution): Promise<SessionResolution> {
    const service = this.subsessions;
    const scope = this.router.ownerSessionKey();
    const ref = message.replyToId ?? message.reactedToId;
    if (!service || !scope || !ref) return resolution;
    await service.whenSendsSettle(scope, TASK_SEND_SETTLE_MS);
    const task = service.taskForReply(scope, channelName, ref);
    if (task) return { ...resolution, sessionKey: task.sessionKey };
    this.warnUnmatchedReply(scope, ref, message.taskSendsInFlight ?? []);
    return resolution;
  }

  /**
   * An owner reply that still matches no task, sent while these tasks were
   * sending (their send settled with no id we could record, or never
   * settled): the owner's session is told the owner may be answering one.
   */
  private warnUnmatchedReply(scope: string, ref: string, taskIds: string[], stale?: string): boolean {
    if (!this.subsessions || taskIds.length === 0) return true;
    // Named by id alone when the task table cannot be read (or the task is gone).
    const names = taskIds.map((id) => {
      let title: string | undefined;
      try { title = this.subsessions?.available() ? this.subsessions.get(id)?.title : undefined; } catch { /* unreadable */ }
      return title ? `${id} ("${title}")` : id;
    }).join(", ");
    const resend = taskIds.map((id) => `/s ${id} <message>`).join(" or ");
    log.warn({ ref, tasks: taskIds }, "Owner reply matched no task while a task send was in flight; it stays with the owner's session");
    if (stale !== undefined) {
      // Too old to replay: no "next message" follows, so the note quotes the
      // reply, and is pinned (an inbox note): the record closes once it is
      // written, and the cap must not drop the only word of it.
      const quoted = stale.length > STALE_REPLY_EXCERPT ? `${stale.slice(0, STALE_REPLY_EXCERPT)}…` : stale;
      return this.queuePendingNote(scope, markOwnerAudience(formatTomoEvent("inbox",
        `Before Tomo restarted the owner replied to a message Tomo could not match, and it was too old to answer after the restart. Sub-session ${names} was sending a message to the owner at the time, so the owner may have been answering it; the task never got it. Tell the owner, and ask them to send it again as ${resend} if it was meant for the task. Their reply:\n\n${quoted}`,
        { name: "stale-unmatched-reply" })));
    }
    return this.queuePendingNote(scope, markOwnerAudience(formatTomoEvent("subsession-activity",
      `The owner's next message replies to a message Tomo could not match. Sub-session ${names} was sending a message to the owner at the time, so the owner may be answering it. If so, tell them it reached you instead, and ask them to send it again as ${resend}: only then does it reach the task as their own words.`)));
  }

  /** Did this owner message reach the task? Undefined when the table can't tell. */
  private taskHasOwnerMessage(id: string, messageId: string): boolean | undefined {
    if (!this.subsessions?.available()) return undefined;
    try {
      const record = this.subsessions.get(id);
      if (record?.ownerMessageIds.includes(messageId)) return true;
      // Read from an older backup: an id it lacks may still have been handed over.
      if (record?.restored) return undefined;
      return record ? false : undefined;
    } catch {
      return undefined;
    }
  }

  /** The task an inbox record is for: its own key, or an owner reply that matches a task's message now. */
  private replayTaskKey(channelName: string, message: IncomingMessage, resolution: SessionResolution): string | undefined {
    if (isTaskSessionKey(resolution.sessionKey)) return resolution.sessionKey;
    const scope = this.router.ownerSessionKey();
    const ref = message.replyToId ?? message.reactedToId;
    if (!this.subsessions?.available() || !scope || !ref || resolution.sessionKey !== scope || message.isGroup) return undefined;
    try {
      return this.subsessions.taskForReply(scope, channelName, ref)?.sessionKey;
    } catch {
      return undefined;
    }
  }

  /** A replayed owner reply addressed by reference: match it to a task again (its ids may be known now). */
  private replayResolution(channelName: string, message: IncomingMessage, resolution: SessionResolution): SessionResolution {
    const scope = this.router.ownerSessionKey();
    const ref = message.replyToId ?? message.reactedToId;
    if (!this.subsessions || !scope || !ref || resolution.sessionKey !== scope || message.isGroup) return resolution;
    const taskKey = this.replayTaskKey(channelName, message, resolution);
    if (taskKey) return { ...resolution, sessionKey: taskKey };
    // Sent while a task's send was in flight, and the restart came before it matched.
    this.warnUnmatchedReply(scope, ref, message.taskSendsInFlight ?? []);
    return resolution;
  }

  /** `/s`, `/s <id>`, `/s <id> stop|start|model <name>`: answered in the chat it came from. */
  private async answerTaskCommand(channel: Channel, chatId: string, scope: string, address: Exclude<TaskAddress, { kind: "message" }>): Promise<void> {
    const t = ownerT("subsessions");
    const service = this.subsessions!;
    let text: OwnerText;
    try {
      text = await taskCommandReply(t, service, scope, address);
    } catch (err) {
      log.warn({ err, command: address.kind }, "Sub-session command failed");
      text = t("cmd.unavailable");
    }
    log.info({ channel: channel.name, command: address.kind, ...("id" in address ? { id: address.id } : {}) }, "Sub-session command (/s)");
    await channel.send({ chatId, text }).catch((err) => log.warn({ err }, "Could not answer a /s command"));
  }

  /**
   * Hand the owner's message to its task. On success the inbox record is
   * done (the task's table holds it now). A task that is gone or ended — or
   * a table that cannot be read — sends the message on to the owner's own
   * session instead, with a line saying where it was meant to go.
   */
  private deliverToTask(channel: Channel, message: IncomingMessage, resolution: SessionResolution, inboxId: string | undefined): boolean {
    const id = taskIdFromSessionKey(resolution.sessionKey);
    const scope = this.router.ownerSessionKey();
    const files = [...(message.images ?? []), ...(message.documents ?? [])]
      .map((a) => a.savedPath).filter((p): p is string => typeof p === "string");
    const result: OwnerMessageResult = this.subsessions && scope && id
      ? this.subsessions.ownerMessage(scope, id, message.text, {
        messageId: taskMessageId(channel.name, message),
        files,
      })
      : { ok: false, reason: "unknown" };
    if (result.ok) {
      this.inbox?.markDone(inboxId ? [inboxId] : []);
      if (!result.duplicate) {
        // The owning session learns of it through the mirror (the task's
        // conversation log), with what the task said back.
        log.info({ channel: channel.name, task: result.record.id, status: result.record.status }, "Owner message handed to a sub-session");
        if (result.record.status === "queued") {
          void channel.send({ chatId: message.chatId, text: ownerT("subsessions")("cmd.queuedMessage", { id: result.record.id }) })
            .catch((err) => log.warn({ err }, "Could not acknowledge a message to a queued sub-session"));
        }
      }
      return true;
    }
    const where = id ?? resolution.sessionKey;
    const why = result.reason === "ended" ? "has ended"
      : result.reason === "unknown" ? "does not exist"
        : result.reason === "full" ? "already has too many messages waiting"
          : "could not be reached (its task list is unreadable)";
    log.info({ task: where, reason: result.reason }, "Message for a sub-session goes to the owner's session instead");
    const owner = this.router.resolve(channel.name, message.chatId, false);
    const note = `[The owner sent this to sub-session ${where}, which ${why}; it reached you instead.]`;
    return this.dispatchInbound(channel, { ...message, text: `${note}\n${message.text}` }, owner, inboxId);
  }

  private async handlePastedMcpCallback(channel: Channel, message: IncomingMessage): Promise<boolean> {
    const result = await this.mcpOAuthManager.completeAuthorizationFromChat(message.text);
    if (result.status === "not-matched") return false;
    const t = ownerT("notices");
    if (result.status === "unknown-state") {
      log.warn({ channel: channel.name, chatId: message.chatId }, "Ignored MCP OAuth callback with no matching pending state");
      await channel.send({
        chatId: message.chatId,
        text: t("mcpOAuth.callbackUnknown"),
      });
      return true;
    }
    if (result.status === "ambiguous") {
      await channel.send({
        chatId: message.chatId,
        text: t("mcpOAuth.callbackAmbiguous"),
      });
      return true;
    }
    if (result.status === "already-completed") {
      await channel.send({
        chatId: message.chatId,
        text: t("mcpOAuth.callbackUsed", { server: result.serverName }),
      });
      return true;
    }
    if (result.status === "failed") {
      await channel.send({
        chatId: message.chatId,
        text: t("mcpOAuth.callbackFailed", { server: result.serverName, error: result.error }),
      });
      return true;
    }

    await channel.send({
      chatId: message.chatId,
      text: result.expiresAt !== undefined
        ? t("mcpOAuth.completedUntil", { server: result.serverName, at: formatDateTime(result.expiresAt) })
        : t("mcpOAuth.completed", { server: result.serverName }),
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
    for (const item of items) {
      if (!allowed.includes(item)) item.channel.settleMessage?.(item.message.id, "refused");
    }
    // A deliberate drop is a consumption: it must not come back after a restart.
    this.inbox?.markDone(inboxIdsOf(items.filter((item) => !allowed.includes(item))));
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

    // `start` is written the moment the prompt reaches the SDK (the first
    // point the model can act on it), not here: a crash before that is
    // replayed as a fresh message rather than written off as "may already
    // have run". From `start` on a crash is NOT re-run — the turn may already
    // have acted — and the next start tells the session instead, quoting the
    // messages (see replayInbox).
    const inboxIds = inboxIdsOf(routed);
    const progress = { unconsumed: false, handedOff: false, cutShort: false };
    const hooks: InboxTurnHooks | undefined = inboxIds.length > 0
      ? {
        notConsumed: () => { progress.unconsumed = true; },
        cutShort: (selfRestart) => {
          progress.cutShort = true;
          // Written now, while the inbox is still open (shutdown closes it
          // after the sessions), so the note after the restart can say this
          // turn restarted Tomo itself. Best effort: lost, it reads as an
          // ordinary interruption.
          if (selfRestart) this.inbox?.markSelfRestart(inboxIds, selfRestart.reason);
        },
        onPromptHandedOff: () => { progress.handedOff = true; this.markInboxStarted(routedKey, inboxIds); },
      }
      : undefined;
    try {
      if (routed.length === 1) {
        await this.handleMessage(routed[0].channel, routed[0].message, steer, routed[0].resolution, routed[0].userRecorded, hooks);
        return;
      }
      await this.handleBatchedMessages(routed, steer, hooks);
    } finally {
      if (inboxIds.length > 0) {
        if (progress.unconsumed && !progress.handedOff) {
          // A turn was set up for these but the prompt never reached the model
          // (session build failed, refused for shutdown, a steer whose session
          // died before the CLI pulled it). Not consumed, so not done: the
          // record stays `received` and the next start answers it. Marking it
          // done here would drop a message nobody ever saw.
          log.warn({ sessionKey: routedKey, count: inboxIds.length }, "Durable inbox: turn ended before its prompt reached the model; left for replay on next start");
        } else if (progress.cutShort) {
          // Graceful shutdown stopped this turn mid-flight: the reply may be
          // missing or partial, exactly as after a crash. Left `started`, so
          // the next start tells the session (quoting the messages) instead of
          // the shutdown silently writing them off.
          log.info({ sessionKey: routedKey, count: inboxIds.length }, "Durable inbox: turn cut short by shutdown; the next start tells the session");
        } else if (steer) {
          // A steered message may have MERGED into another turn: its answer is
          // that turn's reply, which is delivered and recorded only when that
          // turn's own queue task finishes — after our STEER_MERGED resolves.
          // The host may be a web or cron turn with no inbox record of its own,
          // so marking done now would let a crash in that window drop the
          // message silently. Behind the session queue, done lands after it.
          this.enqueueForSession(routedKey, async () => { this.inbox?.markDone(inboxIds); })
            .catch((err) => log.warn({ err, sessionKey: routedKey }, "Durable inbox: deferred done failed"));
        } else {
          this.inbox?.markDone(inboxIds);
        }
      }
    }
  }

  /**
   * Record that a turn took these inbox records. A `start` the inbox could
   * not write leaves a log a crash would replay — and answer twice — so it is
   * raised loudly (see DurableInbox.markStarted).
   */
  private markInboxStarted(sessionKey: string, ids: string[]): void {
    const unwritten = this.inbox?.markStarted(ids) ?? [];
    if (unwritten.length === 0) return;
    this.reportInboxFault(
      ownerT("notices")("inbox.unmarked", { count: unwritten.length, session: sessionKey }),
      { sessionKey, ids: unwritten },
    );
  }

  /**
   * An inbox write failed in a way that weakens a delivery guarantee: log it
   * as an error and tell the owner (at most once per INBOX_FAULT_NOTICE_MS —
   * a dead disk fails every message, and one DM says it).
   */
  private reportInboxFault(text: OwnerText, context: Record<string, unknown>): void {
    log.error(context, `Durable inbox fault: ${text}`);
    const now = Date.now();
    if (now - this.lastInboxFaultNoticeAt < INBOX_FAULT_NOTICE_MS) return;
    this.lastInboxFaultNoticeAt = now;
    void this.notifyOwner(text).catch((err) => log.warn({ err }, "Could not send durable inbox fault notice"));
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
      try { await this.processInboundItems(work.items, work.steer); }
      catch (err) {
        for (const item of work.items) item.channel.settleMessage?.(item.message.id, "unknown");
        throw err;
      }
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
    channel.send({ chatId, text: ownerT("notices")("group.summonExpired") })
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
   * `isOwnAudienceTurn`), so Read/Grep over memory/private are blocked by path
   * and Bash runs inside a `sandbox-exec` profile that denies the directory in
   * the kernel (`agent/bash-sandbox.ts`) — but the norm is still the right thing
   * to state, since it also covers what the model already has in context. "Off
   * limits, by any route" is both the instruction we want and the honest
   * description.
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

  private resolveDeliveryTargetForSession(
    sessionKey: string,
    source: string,
  ): { channel: Channel; chatId: string } | undefined {
    let target: ReplyTarget | undefined;

    if (dmIdentityFromSessionKey(sessionKey) !== undefined) {
      target = this.router.dmReplyTarget(sessionKey);
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

  /**
   * The usage baseline a resume of `sdkSessionId` on `key` starts from. The
   * LEDGER is the source: its last row for that SDK session carries the
   * cumulative snapshot, written in the same append as the turn's delta, so
   * the two cannot disagree. Rows still queued land first.
   *
   * The registry's copy is the fallback for a session the ledger has no row
   * for. It is advanced ONLY by landed ledger rows (and starts at zero with a
   * new SDK session), so it can lag the ledger but never lead it: a session
   * whose rows have all failed resumes from zero and its first landed row
   * carries everything, rather than skipping what never landed. Not "no
   * registry at all": sessions older than the ledger have a registry
   * baseline and no row, and starting them from zero would charge each one's
   * whole lifetime to its first row.
   */
  private async resumeUsageBaseline(key: string, sdkSessionId: string): Promise<UsageBaseline | undefined> {
    await this.usageLedger.idle();
    const fromLedger = this.usageLedger.lastSnapshot(key, sdkSessionId);
    if (fromLedger !== undefined) return fromLedger ?? undefined;
    return this.sessions.getUsageBaseline(key);
  }

  private createUnownedTurnRequest(key: string): TurnRequest | undefined {
    if (isTaskSessionKey(key)) return this.createTaskBackgroundRequest(key);
    const target = this.resolveDeliveryTargetForSession(key, "Background task");
    if (!target) return undefined;

    const { channel, chatId } = target;
    const stopTyping = this.startTurnTyping(channel, chatId, this.isPassiveReplyTarget(channel.name, chatId));
    let settled = false;
    // One sender for the whole background turn, so its blocks ship as they
    // complete — same path as every other ingress.
    const sender = this.delivery.createBlockSender(channel, chatId, {
      // A background turn ships through the same fence as an owned one: its
      // audience is whatever is registered for the session at send time.
      blockPrivateMedia: () => this.isPrivateMemoryBarred(key),
      attachmentBarred: (path) => this.isAttachmentBarred(key, path),
    });
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
          const receipt = await sender.deliver(outgoing);
          // Recorded per shipped block — an unrecorded delivery is invisible
          // to recall_conversation (#203) — but recorded AFTER the send, never
          // before. Writing on intent made the transcript claim deliveries
          // that never happened (A sends, B throws, transcript shows both).
          slot.settle(deliveredEntry(block, receipt));
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
        // Nothing is delivered for a failed background turn, on any session,
        // so nobody hears of it unless the owner is told.
        if (!(err instanceof TurnInterruptedError)) {
          const target = this.ownerNoticeTarget(key, ownerT("notices")("suppressed.turn.backgroundTask"));
          if (target) this.reportSuppressedError(key, target, shortErrorMessage(err));
        }
        await stop();
      },
    };
  }

  /**
   * A turn the SDK starts on its own on a task key (a background subagent
   * reporting back). Silent like every task turn: nothing reaches a chat. When
   * it ends, the service hears of it (a task waiting on something external is
   * active again, and gets its auto-continue).
   */
  private createTaskBackgroundRequest(key: string): TurnRequest {
    let settled = false;
    return {
      onBlock: async () => {},
      onBlockAbandoned: () => {},
      resolve: async () => {
        if (settled) return;
        settled = true;
        log.info({ session: key }, "Sub-session background turn ended");
        this.subsessions?.onBackgroundReport(key);
      },
      reject: async (err) => {
        if (settled) return;
        settled = true;
        if (!(err instanceof TurnInterruptedError)) log.error({ err, key }, "Sub-session background turn failed");
        this.subsessions?.onBackgroundTurnFailed(key);
      },
    };
  }

  /**
   * Where something private for the session `key` goes (an MCP login link,
   * an elicitation, an auth failure). With an owner configured that is
   * ALWAYS the owner's DM — never another private chat, even one with a
   * legacy raw session or a former identity's dm: session. Only an install
   * with no owner falls back to the session's own private chat.
   */
  private resolvePrivateReplyTarget(key: string): ReplyTarget | undefined {
    if (config.owner) return this.ownerPrivateReplyTarget();
    if (!isGroupSessionKey(key)) return privateReplyTargetFromSessionKey(key);
    return undefined;
  }

  private findPrivateReplyTarget(): ReplyTarget | undefined {
    if (config.owner) return this.ownerPrivateReplyTarget();
    for (const [key] of this.sessions.listSdkSessionIds()) {
      const target = this.resolvePrivateReplyTarget(key);
      if (target) return target;
    }
    return undefined;
  }

  /** The owner's private DM target: last-active, else the first bound handle. */
  private ownerPrivateReplyTarget(): ReplyTarget | undefined {
    const owner = config.owner;
    const key = this.router.ownerSessionKey();
    if (!owner || !key) return undefined;
    return this.router.dmReplyTarget(key);
  }

  /**
   * The owner asked for a compact of their own session from the web UI (see
   * ContextNudger.requestCompact). `sessionKey` is the owner conversation the
   * web shows (its catalog rule, possibly a legacy key), chosen by the caller.
   */
  requestOwnerCompact(sessionKey: string, onSettled?: (outcome: "done" | "unverified" | "failed") => void): "queued" | "already_requested" | "no_owner" {
    if (!config.owner) return "no_owner";
    return this.contextNudger.requestCompact(sessionKey, onSettled);
  }

  /** Listeners told after every write of the sub-session table (the web Tasks rail). */
  private readonly subsessionListeners = new Set<() => void>();
  /** Be told whenever the sub-session table changes; returns the unsubscribe. */
  onSubsessionsChanged(listener: () => void): () => void {
    this.subsessionListeners.add(listener);
    return () => { this.subsessionListeners.delete(listener); };
  }

  /**
   * The owner's sub-sessions as the web UI reaches them: listed and read for
   * the owner's own scope only, and written exactly as `/s <id> <text>` from
   * the owner's DM writes (SubsessionService.ownerMessage). Undefined while
   * sub-sessions are off. Nothing here can reach a task of another scope, a
   * group, or the owner's DM session itself.
   */
  webSubsessions(): WebSubsessionAccess | undefined {
    const service = this.subsessions;
    if (!service) return undefined;
    const working = (key: string) => this.liveSessionManager.hasTurnInFlight(key);
    // The model as its turns resolve it (sdk-options): the record's, else subsessions.defaultModel, else `model`.
    const live = (record: SubsessionRecord): SubsessionLive => {
      const chosen = service.modelFor(record.sessionKey) ?? config.model;
      return { background: service.backgroundRunning(record), model: resolveModelName(chosen) ?? chosen };
    };
    return {
      list: () => {
        const scope = this.router.ownerSessionKey();
        if (!scope || !service.available()) return { available: false, tasks: [] };
        try { return { available: true, tasks: subsessionList(service.list(scope), scope, Date.now(), working, live) }; }
        catch { return { available: false, tasks: [] }; }
      },
      get: (id) => {
        const scope = this.router.ownerSessionKey();
        // null: the table cannot be read right now (try again), not "no such task".
        if (!scope || !service.available()) return null;
        let record;
        try { record = service.get(id); } catch { return null; }
        return record ? subsessionDetail(record, scope, Date.now(), working(record.sessionKey), live(record)) : undefined;
      },
      message: (id, text, requestId) => {
        const scope = this.router.ownerSessionKey();
        if (!scope) return { ok: false, reason: "unknown" };
        const result = service.ownerMessage(scope, id, text, { messageId: `web:${requestId}` });
        if (!result.ok) return { ok: false, reason: result.reason };
        if (!result.duplicate) log.info({ channel: "web", task: result.record.id, status: result.record.status }, "Owner message handed to a sub-session");
        const task = subsessionView(result.record, scope, Date.now(), working(result.record.sessionKey), live(result.record));
        return task ? { ok: true, duplicate: result.duplicate, task } : { ok: false, reason: "unknown" };
      },
    };
  }

  /** The web Study's view of a session key's model. Never creates a session. */
  webModelView(sessionKey: string): ReturnType<typeof describeSessionModel> {
    return describeSessionModel(this.modelOverrides, sessionKey, this.liveSessionManager.hasTurnInFlight(sessionKey));
  }

  /**
   * The owner switched a session's model from the web Study: the same shared
   * switch as `/model` (validation, config.json, live-session restart), but
   * refused while a turn is in flight and when the model is no longer the
   * one the owner reviewed (`from`). The caller decides which key may be
   * switched (the owner conversation only).
   */
  switchModelFromWeb(sessionKey: string, model: string, from: string): ModelSwitchOutcome {
    const outcome = switchSessionModel({
      modelOverrides: this.modelOverrides,
      closeLiveSession: (key) => this.liveSessionManager.closeLiveSession(key),
      hasTurnInFlight: (key) => this.liveSessionManager.hasTurnInFlight(key),
    }, sessionKey, model, { expectedCurrent: from, unchangedIsNoop: true });
    if (outcome.ok && outcome.changed) log.info({ sessionKey, model: outcome.model, previous: outcome.previous }, "Model switched from the web UI");
    else if (!outcome.ok) log.info({ sessionKey, reason: outcome.reason }, "Model switch from the web UI refused");
    return outcome;
  }

  /** Context-pressure nudge after a completed turn — see ContextNudger. */
  private maybeNudgeCompact(key: string, ctx: QueryResult | null = this.liveSessionManager.lastResult(key)): void {
    this.contextNudger.maybeNudgeCompact(key, ctx);
  }

  private async runUserTurn(req: UserTurnRequest): Promise<void> {
    if (req.webRequestId) {
      const requests = this.webRequestIds.get(req.key) ?? new Set<string>();
      requests.add(req.webRequestId); this.webRequestIds.set(req.key, requests);
    }
    // Published for the duration of the turn so session-scoped MCP tools can
    // see where this turn's input actually came from. Registered per TURN, not
    // per session: turns overlap under steering, and a per-key slot let the
    // second one's cleanup unscope the first. Removed afterwards, so a later
    // cron or background turn on the same session is the owner's again and
    // does not inherit a summoned group's narrower scope.
    const turnId = this.turnAudiences.begin(req.key, req.audiences, req.origins);
    // Until the SDK takes the prompt, this turn has not consumed its messages.
    req.inboxHooks?.notConsumed();
    try {
      await this.runUserTurnInner(req);
    } finally {
      this.turnAudiences.end(req.key, turnId);
      if (req.webRequestId) {
        const requests = this.webRequestIds.get(req.key); requests?.delete(req.webRequestId);
        if (!requests?.size) this.webRequestIds.delete(req.key);
      }
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

  /**
   * The chat the turn in flight on this session came in on, for a request that
   * must be answered where the owner is typing (`request_credential`). Null
   * for a cron, heartbeat or other background turn, and for a batch or
   * concurrent turns spanning more than one chat. Alongside
   * `isOwnAudienceTurn`, which says WHOSE turn it is; this says WHERE.
   */
  turnOrigin(sessionKey: string): TurnOrigin | null {
    return this.turnAudiences.turnOrigin(sessionKey) ?? null;
  }

  /**
   * Is `memory/private/` closed to the turn in flight on this session?
   *
   * The same question the PreToolUse guard asks per tool call, from the same
   * function (`privateMemoryBarFor`) — asked here for the OUTBOUND side, where
   * a `MEDIA:` path is a read the tool guard never sees: the channel opens the
   * file and puts its contents in the chat. Resolved per call, never cached:
   * `isOwnAudienceTurn` changes turn to turn while a group is summoned in.
   */
  isPrivateMemoryBarred(sessionKey: string): boolean {
    return privateMemoryBarFor(
      this.isGroupScoped(sessionKey),
      () => this.isOwnAudienceTurn(sessionKey),
    ) !== null;
  }

  /**
   * On this session's turn in flight, must `path` be dropped as an attachment?
   * False when the turn is not barred. Otherwise the group-aware answer from
   * `attachmentBarredFor`: a sandboxed group ships only what it may read.
   */
  isAttachmentBarred(sessionKey: string, path: string): boolean {
    const bar = privateMemoryBarFor(this.isGroupScoped(sessionKey), () => this.isOwnAudienceTurn(sessionKey));
    if (bar === null) return false;
    return attachmentBarredFor(
      path,
      bar,
      sessionKey,
      () => this.scopedCallerKey(sessionKey),
      () => this.groupSandboxFor(sessionKey),
    );
  }

  /** A group session, or a sub-session whose owning scope is a group (or unknown). */
  private isGroupScoped(sessionKey: string): boolean {
    return isTaskSessionKey(sessionKey) ? this.taskScopeIsGroup(sessionKey) : isGroupSessionKey(sessionKey);
  }

  private async runUserTurnInner(req: UserTurnRequest): Promise<void> {
    await this.turnRunner.runTurn({
      requestId: req.webRequestId,
      key: req.key,
      source: "user",
      // A summoned group's messages run on the owner's dm: session.
      ...(req.audiences?.some((a) => isGroupSessionKey(a)) ? { usage: { source: "group" as const } } : {}),
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
      ...(req.inboxHooks ? {
        onPromptHandedOff: req.inboxHooks.onPromptHandedOff,
        onShutdown: (kind: ShutdownTurnEnd, selfRestart?: { reason?: string }) => { if (kind === "interrupted") req.inboxHooks?.cutShort(selfRestart); },
      } : {}),
      errors: {
        visibleError: "reply",
        // Agent-error responses stream back like any text and are handled by
        // DeliveryPipeline.deliverResponse; this only covers thrown errors.
        response: "deliver",
        thrown: req.suppressErrors ? "ignore" : "deliver",
        thrownLogMessage: req.errorLogMessage,
        ...(req.suppressErrors && req.ownerNotice ? { ownerNotice: req.ownerNotice } : {}),
      },
    });
  }

  private async handleMessage(
    channel: Channel,
    message: IncomingMessage,
    steer = false,
    receiptResolution?: SessionResolution,
    userRecorded = false,
    inboxHooks?: InboxTurnHooks,
  ): Promise<void> {
    if (this.commands.isRestoring) {
      channel.settleMessage?.(message.id, "refused");
      // /restore drops input until the restart it leads to. A durably held
      // message is not dropped: it stays `received` and that restart answers it.
      inboxHooks?.notConsumed();
      return;
    }

    const hasImages = message.images && message.images.length > 0;
    const hasDocuments = message.documents && message.documents.length > 0;
    const isGroup = message.isGroup ?? false;
    const isMentioned = message.isMentioned ?? false;

    // Group secret activation, BEFORE anything logs or records the text: the
    // secret is the only way into a closed group, so it must never reach the
    // log file (or the transcript) verbatim.
    if (isGroup && config.groupSecret && message.text.trim() === config.groupSecret) {
      log.info({ channel: channel.name, chat: redactChatIdForLog(message.chatId) }, "Group secret received");
      await this.activateGroup(channel, message.chatId);
      return;
    }

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

    // Allowlist check: reject messages from unknown senders
    if (!this.router.isAllowed(channel.name, message.chatId)) {
      log.debug({ channel: channel.name, chat: redactChatIdForLog(message.chatId) }, "Message blocked (not in allowlist)");
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

    if (!userRecorded) this.appendInboundUser(key, channel, message, textForAgent, { webRequestId: true });

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

    try {
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
        origins: [{ channelName: channel.name, chatId: message.chatId }],
        suppressErrors: isPassiveGroup,
        ...(isPassiveGroup ? { ownerNotice: this.ownerNoticeTarget(key, ownerT("notices")("suppressed.turn.message"), `${channel.name}:${message.chatId}`) } : {}),
        errorLogMessage: "Error handling message",
        steer,
        steerAudience: audience,
        passiveListen: isPassiveGroup,
        ...(inboxHooks ? { inboxHooks } : {}),
        ...(channel.name === "web" ? { webRequestId: message.id } : {}),
      });
    } catch (err) {
      if (!(err instanceof SteerDeclinedError)) throw err;
      // Owner web input whose turn stopped being joinable before injection
      // (nothing reached the SDK): back into the session's FIFO queue as its
      // own turn, behind whatever is already waiting there — never around it.
      log.info({ sessionKey: key }, "Web steer declined at injection; queued as its own turn");
      this.enqueueInboundForSession(key, [{ channel, message, resolution, userRecorded: true }]);
    }
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
    inboxHooks?: InboxTurnHooks,
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
      // No web requestId and no userRecorded check here: both only matter for
      // web input, and web never coalesces (canCoalesce in enqueueMessage).
      // Kept exactly as the batch path always wrote it; if web ever reaches
      // this path, its records would lack the requestId the browser pairs on,
      // so say so loudly instead of silently writing them.
      // Diagnostic only: a logging failure must not abort the batch.
      if (channel.name === "web") {
        try {
          log.error({ sessionKey: key, messageId: message.id }, "Web message reached the batch path; its transcript record has no requestId (canCoalesce should exclude web)");
        } catch { /* ignore */ }
      }
      this.appendInboundUser(key, channel, message, transcriptText, { webRequestId: false });
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
      origins: items.map((it) => ({ channelName: it.channel.name, chatId: it.message.chatId })),
      suppressErrors: isPassiveGroup,
      ...(isPassiveGroup ? { ownerNotice: this.ownerNoticeTarget(key, ownerT("notices")("suppressed.turn.message"), `${lastChannel.name}:${lastMessage.chatId}`) } : {}),
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
      ...(inboxHooks ? { inboxHooks } : {}),
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
    channel: Pick<Channel, "name">,
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
  /**
   * A turn ended on a reply the model wrote in a thinking block, which is
   * dropped under `showThinking: false` (live-session.ts header). Run one
   * follow-up turn on the same session, to the same target, that tells the
   * model so and lets it say the reply as text — or NO_REPLY if it was
   * narration. `restate: true` keeps the follow-up from chaining.
   */
  private restateUndeliveredReply(sessionKey: string, target: { channel: Channel; chatId: string } | undefined): void {
    const nudge = formatTomoEvent(
      "undelivered-reply",
      "Your last turn ended on a message written in a thinking block; it was NOT delivered to the user. " +
      "If it was meant for them, say it now as plain text, verbatim. If it was internal narration, reply NO_REPLY.",
    );
    this.handleCronMessage(nudge, sessionKey, {
      showTyping: false,
      restate: true,
      ...(target ? { deliveryTarget: { channelName: target.channel.name, chatId: target.chatId } } : {}),
    }).catch((err) => {
      log.error({ err, sessionKey }, "restate turn failed to queue");
    });
  }

  async handleCronMessage(message: string, sessionKey: string, options: CronTurnOptions = {}): Promise<boolean> {
    // A sub-session's check-back is a lifecycle event, not a turn of its own:
    // the service wakes the task through its scheduler (slots).
    if (isTaskSessionKey(sessionKey)) return this.subsessions?.onCronFire(sessionKey, message) ?? false;
    return this.enqueueForSession(sessionKey, () => this.processCronMessage(message, sessionKey, options))
      .catch((err) => {
        log.error({ err, sessionKey }, "Cron message failed in queue");
        return false;
      });
  }

  /**
   * The owner's `dm:` key for a raw `<channel>:<owner handle>` key, once the
   * owner session exists (registry has, or had, an entry for it). Undefined
   * otherwise — including while an adoption is still pending, when the raw
   * key IS the owner's conversation and must keep running there.
   */
  private ownerKeyForRawOwnerSession(sessionKey: string): string | undefined {
    const parsed = parseRawSessionKey(sessionKey);
    const owner = config.owner;
    const ownerKey = this.router.ownerSessionKey();
    if (!parsed || !owner || !ownerKey) return undefined;
    if (!isOwnerHandle(owner, parsed.channelName, parsed.chatId)) return undefined;
    return this.sessions.hasEverHadEntry(ownerKey) ? ownerKey : undefined;
  }

  private async processCronMessage(message: string, sessionKey: string, options: CronTurnOptions): Promise<boolean> {
    // Resolved at EXECUTION time, not dispatch: a job dispatched on the raw
    // owner key while an adoption was pending may run after a DM completed
    // that adoption. Running it on the raw key then would recreate a raw
    // session beside the owner's (a fork). Hand it to the owner's queue.
    const adoptedKey = this.ownerKeyForRawOwnerSession(sessionKey);
    if (adoptedKey) {
      log.info({ from: sessionKey, to: adoptedKey }, "Background turn on a raw owner key handed to the owner session");
      const handoff = this.enqueueForSession(adoptedKey, () => this.processCronMessage(message, adoptedKey, options));
      if (options.waitForHandoff) {
        return handoff.catch((err) => {
          log.error({ err, sessionKey: adoptedKey }, "Owner background turn failed in queue");
          return false;
        });
      }
      handoff.catch((err) => { log.error({ err, sessionKey: adoptedKey }, "Owner background turn failed in queue"); });
      return true;
    }
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
    if (turnId !== undefined) options.onTurnBegin?.(turnId);
    try {
      return await this.turnRunner.runTurn({
        key,
        source: "cron",
        // The trigger is the message as the caller wrote it, before the
        // delivery note above was appended to it.
        usage: {
          ...(options.jobId
            ? { source: "cron" as const, jobId: options.jobId, ...(options.jobName ? { jobName: options.jobName } : {}) }
            : { source: options.usageSource ?? "system" }),
          ...(triggerSnippet(message) ? { trigger: triggerSnippet(message) } : {}),
        },
        ...(options.restate ? { restate: true } : {}),
        ...(options.onShutdown ? { onShutdown: options.onShutdown } : {}),
        ...(options.onEmpty ? { onEmpty: options.onEmpty } : {}),
        ...(options.onStopped ? { onStopped: options.onStopped } : {}),
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
          visibleError: "cron",
          response: suppressErrorDelivery ? "note-only" : "deliver",
          responseSuppressedLog: "Cron error suppressed from chat delivery",
          thrown: suppressErrorDelivery ? "note-only" : "deliver",
          thrownSuppressedLog: "Thrown cron error suppressed from chat delivery",
          thrownLogMessage: "Cron message handling failed",
          // Any error held back from the chat is news to the owner — on the
          // owner's own DM too: a silent housekeeping turn failing on an
          // expired login is otherwise only a pending note for a next turn
          // that fails the same way.
          ...(suppressErrorDelivery
            ? {
              ownerNotice: this.ownerNoticeTarget(
                key,
                options.jobName ? ownerT("notices")("suppressed.turn.cronJob", { name: options.jobName }) : ownerT("notices")("suppressed.turn.background"),
                // A group's turn handed to the summoned dm: session (or a
                // group's delegate) is still the group's failure.
                options.audiences?.find((a) => isGroupSessionKey(a)),
              ),
            }
            : {}),
        },
      });
    } finally {
      if (turnId !== undefined) this.turnAudiences.end(key, turnId);
    }
  }

  /** Handle a continuity heartbeat — runs on the first active DM session (queued) */
  async handleContinuity(prompt: string): Promise<void> {
    // Resolve target session key first so we can enqueue against it
    const dmKey = this.router.ownerSessionKey();
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

    return this.enqueueForSession(key, () => this.processContinuity(prompt, key, undefined, ownerT("notices")("suppressed.turn.heartbeat"), "heartbeat"))
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
    // A sub-session that restarted Tomo is recovered by the sub-session
    // service (it waits for the owner); its reason is in the log.
    if (isTaskSessionKey(sessionKey)) {
      log.info({ sessionKey }, "Restart reason from a sub-session; the sub-session service handles its recovery");
      return Promise.resolve();
    }
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
    return this.enqueueForSession(targetKey, () => this.processContinuity(routedPrompt, targetKey, audiences, ownerT("notices")("suppressed.turn.restart"), "restart"))
      .catch((err) => {
        log.error({ err, sessionKey: targetKey }, "Restart notice failed in queue");
      });
  }

  private async processContinuity(
    prompt: string,
    key: string,
    audiences: string[] | undefined,
    turnKind: OwnerText,
    usageSource: UsageSource,
  ): Promise<void> {
    const turnId = audiences ? this.turnAudiences.begin(key, audiences) : undefined;
    try {
      // A summoned group's restart notice runs on the owner's dm: session;
      // its failure still belongs to (and is reported as) the group's.
      const groupKey = audiences?.find((a) => isGroupSessionKey(a));
      await this.runContinuityTurn(prompt, key, turnKind, usageSource, groupKey);
    } finally {
      if (turnId !== undefined) this.turnAudiences.end(key, turnId);
    }
  }

  private async runContinuityTurn(
    prompt: string,
    key: string,
    turnKind: OwnerText,
    usageSource: UsageSource,
    noticeGroupKey?: string,
  ): Promise<void> {
    await this.turnRunner.runTurn({
      key,
      source: "continuity",
      usage: { source: usageSource },
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
          // The raw-key fallback (dm: keys don't parse) leaves heartbeats —
          // always DM-keyed — unaffected; it lets a unsummoned restart notice
          // routed to its initiating group session (see
          // handleRestartForSession) deliver even without a persisted reply
          // target.
          const replyTarget = this.router.sessionReplyTarget(key);
          if (!replyTarget) return undefined;
          const channel = this.getChannel(replyTarget.channelName);
          return channel ? { channel, chatId: replyTarget.chatId } : undefined;
        },
      },
      silentMatcher: isSilentReply,
      transcript: "on-delivery",
      errors: {
        visibleError: "continuity",
        response: "note-only",
        responseSuppressedLog: "Continuity returned an agent error response",
        thrown: "ignore",
        thrownLogMessage: "Continuity heartbeat failed",
        // Nothing from a continuity turn is ever delivered, error included —
        // an expired login fails every heartbeat silently unless the owner
        // is told (rate-limited, so an hourly heartbeat cannot spam).
        ownerNotice: this.ownerNoticeTarget(key, turnKind, noticeGroupKey),
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

  async sendToSession(target: string, text: string, callerSessionKey?: string, options?: { replyTo?: string; effect?: string; noteFrom?: string }): Promise<SendResult> {
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

  private queuePendingNote(sessionKey: string, note: string, id?: string): boolean {
    return this.pendingNotesQueue.queueNote(sessionKey, note, id);
  }

  private queuePendingErrorNote(sessionKey: string, visibleError: string): void {
    this.pendingNotesQueue.queueError(sessionKey, visibleError);
  }

  /** Restart handshake on a Bash result — see RestartCoordinator. */
  private handleToolResult(
    sessionKey: string,
    toolName: string,
    content: unknown,
    isError: boolean,
    turn?: ReplyContext,
  ): void {
    this.restarts.handleToolResult(sessionKey, toolName, content, isError, turn);
    if (isTaskSessionKey(sessionKey)) this.subsessions?.noteToolUse(sessionKey);
  }

  /** End-of-turn restart fallback — see RestartCoordinator. */
  private handleTurnComplete(sessionKey: string): void {
    this.restarts.handleTurnComplete(sessionKey);
  }

  /** Drain notes queued for this session and return them as a prefix. */
  private drainPendingNotes(sessionKey: string): string {
    return this.pendingNotesQueue.drain(sessionKey, { holdOwnerAudience: !this.isOwnAudienceTurn(sessionKey) });
  }

  /** Channel + per-session vitals snapshot for the watch server. */
  /** Read-only: a background shell's full command, by its tool_use id (web task view). */
  readToolCommand(sessionKey: string, toolUseId: string): string | undefined {
    return this.liveSessionManager.toolCommand(sessionKey, toolUseId);
  }

  /** Stop the session's running turn at the owner's request (web Stop). False when nothing runs. */
  stopTurn(sessionKey: string): Promise<boolean> {
    return this.liveSessionManager.stopTurn(sessionKey);
  }

  /** Stop one running task at the owner's request (web task view). False when it could not be asked. */
  stopTask(sessionKey: string, taskId: string): Promise<boolean> {
    return this.liveSessionManager.stopTask(sessionKey, taskId);
  }

  /** Move a foreground task to the background at the owner's request (web task view). */
  backgroundTask(sessionKey: string, toolUseId: string): Promise<boolean> {
    return this.liveSessionManager.backgroundTask(sessionKey, toolUseId);
  }

  /** Read-only: a shell/Monitor task's output tail (web task view). */
  readTaskOutput(sessionKey: string, taskId: string): Promise<{ output: string; size: number } | undefined> {
    return this.liveSessionManager.taskOutput(sessionKey, taskId);
  }

  /** Does the key's live session have background work a compact reload would cut? */
  hasBackgroundWork(sessionKey: string): boolean {
    const state = this.liveSessionManager.backgroundState(sessionKey);
    return state.activeBackgroundTasks > 0 || state.awaitingTaskReport;
  }

  /**
   * Approve-and-mark a compact of the session behind `sdkSessionId` (the
   * rollup gate; see agent/compact-reservations.ts). A session id no key in
   * this daemon knows has no live session to reload: approved without a mark.
   */
  reserveCompactForSdkSession(sdkSessionId: string): CompactReservation {
    const key = this.liveSessionManager.keyForSdkSession(sdkSessionId)
      ?? this.listActiveSessions().find(([, sid]) => sid === sdkSessionId)?.[0];
    if (!key) return { ok: true, key: null, reservationId: null };
    return this.reserveCompact(key, sdkSessionId);
  }

  /** Approve-and-mark a compact of the key's session (lcm_rollup). */
  reserveCompact(sessionKey: string, sdkSessionId: string): CompactReservation {
    const result = this.liveSessionManager.reserveCompact(sessionKey, sdkSessionId);
    return result.ok ? { ok: true, key: sessionKey, reservationId: result.reservationId } : { ...result, key: sessionKey };
  }

  /** The approved rewrite is over (succeeded, failed, or its client went away). */
  finishCompact(reservation: CompactReservation): void {
    if (reservation.ok && reservation.key && reservation.reservationId) {
      this.liveSessionManager.finishCompact(reservation.key, reservation.reservationId);
    }
  }

  /** Read-only: SDK-reported MCP connection state of live sessions (web Study). */
  readMcpStatuses() {
    return this.liveSessionManager.readMcpStatuses();
  }

  /**
   * Tomo's own OAuth state of the configured external servers (no secrets,
   * no error text), for the web Study to show beside the SDK's live state.
   */
  mcpOAuthStates(): Array<{ name: string; oauth: McpOAuthLabel }> {
    return this.mcpOAuthManager.getServerStatuses(config.mcpServers ?? {}, new Set())
      .filter((status) => status.oauth)
      .map((status) => ({ name: status.name, oauth: oauthLabel(status) }));
  }

  /** An explicit reconnect of one MCP server on the owner's live session (web Study). */
  reconnectOwnerMcpServer(serverName: string): Promise<"reconnected" | "failed" | "busy" | "no-live-session"> {
    const key = this.router.ownerSessionKey();
    if (!key) return Promise.resolve("no-live-session");
    return this.liveSessionManager.reconnectMcpServer(key, serverName);
  }

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
    const key = this.router.ownerSessionKey();
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
        visibleError: "reply",
        response: "deliver",
        thrown: "deliver",
        thrownLogMessage: "Watch chat turn failed",
      },
    })).catch((err) => {
      log.error({ err, sessionKey: key }, "Watch chat failed in queue");
    });
  }

  /** See OwnerNotices.ownerNoticeTarget. */
  private ownerNoticeTarget(sessionKey: string, turnKind: OwnerText, groupKey?: string): OwnerNoticeTarget {
    return this.ownerNotices.ownerNoticeTarget(sessionKey, turnKind, groupKey);
  }

  /** Fire-and-forget owner DM for a suppressed error; never throws. */
  private reportSuppressedError(sessionKey: string, target: OwnerNoticeTarget, detail: string): void {
    this.ownerNotices.reportSuppressedError(sessionKey, target, detail);
  }

  /**
   * DM the configured OWNER (no agent query); never falls back to another
   * private chat. Resolves false when nothing was sent.
   */
  async notifyOwner(text: OwnerText): Promise<boolean> {
    return this.ownerNotices.notifyOwner(text);
  }

  /** Send a direct notification to the user's DM channel (no agent query) */
  async sendNotification(text: OwnerText): Promise<void> {
    return this.ownerNotices.sendNotification(text);
  }

  async start(): Promise<void> {
    log.info({ channels: this.channels.length }, "Starting Tomo");
    // Before any turn: from here on the ledger owns every turn (backfill stops here).
    this.usageLedger.markStarted();
    // Snapshot what the PREVIOUS run left BEFORE any channel starts ingesting:
    // a message accepted while another channel is still starting is already
    // dispatched by live ingress, and replaying it too would run it twice (or
    // misread its fresh turn as interrupted).
    const recovered = this.inbox?.pending() ?? [];
    try {
      // Sub-session restart recovery runs BEFORE any channel ingests, so no
      // input can reach a task recovery has not looked at yet. It schedules
      // nothing: dispatch opens with start() below, after the inbox replay.
      this.subsessions?.recoverAtStartup();
    } catch (err) {
      log.error({ err }, "Sub-session recovery failed");
    }
    await Promise.all(this.channels.map((ch) => ch.start()));
    this.channelsUp = true;
    // A pending-notes file moved aside while starting (recovery reads it) is told now.
    this.tellPendingNotesQuarantined();
    try {
      this.replayInbox(recovered);
    } catch (err) {
      // Replay is recovery, never a startup prerequisite.
      log.error({ err }, "Durable inbox replay failed");
    }
    try {
      this.notifyInterruptedAgents();
    } catch (err) {
      log.warn({ err }, "Could not report interrupted subagents");
    }
    try {
      // After the channels and the inbox: opens dispatch, and sends what
      // recovery had to tell the owner (a report's wake among them).
      this.subsessions?.start();
    } catch (err) {
      log.error({ err }, "Sub-session start failed");
    }
    try {
      // Requests the last run left open died with it: denied (restart), and their sessions told.
      this.permissionBroker.reconcileAfterRestart();
    } catch (err) {
      log.warn({ err }, "Could not reconcile the permission ledger");
    }
    this.startMcpTokenRefreshSweep();
    log.info("Tomo is running");

    // WHAT THE TRANSCRIPT MIGRATION STILL OWES. `ambiguous`, `sidecars` and
    // `orphans` are read off the sessions directory, so they are accurate here,
    // before any key has been touched. `settled` and `deferred` ARE NOT: they
    // count what this process tried and could not finish, and at this point it
    // has not tried anything — so logging them here always read "clean" no
    // matter what state the directory was in. They are logged once, later, when
    // the keys that receive traffic have actually been touched. The prune drops
    // ledger rows whose stem has nothing left on disk.
    // TODO(tomo status): surface `migrationStatus()` as a `tomo status` field.
    this.sessions.pruneLegacyStemLedger();
    const onDisk = this.sessions.migrationStatus();
    log.info(
      { ambiguous: onDisk.ambiguous, sidecars: onDisk.sidecars, orphans: onDisk.orphans },
      "Legacy transcript migration: what is on disk",
    );
    this.migrationStatusTimer = setTimeout(() => {
      log.info(this.sessions.migrationStatus(), "Legacy transcript migration status");
    }, MIGRATION_STATUS_RELOG_MS);
    this.migrationStatusTimer.unref();

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
    this.subsessions?.stop();
    // Before any session is closed: closing empties its task set, and what is
    // still running now was interrupted, not finished.
    this.runningAgents?.freeze();
    this.detachRunningAgents?.();
    this.detachRunningAgents = undefined;
    this.credentialBroker?.shutdown();
    this.permissionBroker.shutdown();
    if (this.mcpTokenRefreshTimer) {
      clearInterval(this.mcpTokenRefreshTimer);
      this.mcpTokenRefreshTimer = undefined;
    }
    if (this.pendingNotesQuarantineTimer) {
      clearTimeout(this.pendingNotesQuarantineTimer);
      this.pendingNotesQuarantineTimer = undefined;
    }
    if (this.interruptedAgentsRetryTimer) {
      clearTimeout(this.interruptedAgentsRetryTimer);
      this.interruptedAgentsRetryTimer = undefined;
    }
    if (this.migrationStatusTimer) {
      clearTimeout(this.migrationStatusTimer);
      this.migrationStatusTimer = undefined;
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

        // A rewind still working would otherwise hold its key past shutdown
        // (turns parked behind it) or publish a fork mid-teardown. Abort it —
        // it stops between waits and attempts and discards any fork — and
        // give it a bounded moment to finish. LiveSessionManager.stop()
        // releases any hold a stalled one still has.
        this.rewindAbort.abort();
        if (this.activeRewinds.size > 0) {
          const rewinds = [...this.activeRewinds];
          await this.boundedShutdownStep("rewind", REWIND_SHUTDOWN_TIMEOUT_MS, () => Promise.allSettled(rewinds));
        }

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
        this.inbox?.close();
        // The last turns' ledger rows are queued writes; let them land.
        await this.boundedShutdownStep("usage ledger", USAGE_LEDGER_SHUTDOWN_TIMEOUT_MS, () => this.usageLedger.idle());
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

  /**
   * Write an inbound channel message to the transcript as a `user` record.
   * The one place that shapes this record for the single-message, batched and
   * shutdown-drain paths, so they can't drift apart field by field.
   *
   * `webRequestId` adds `requestId: message.id` for web input (the browser
   * pairs its pending bubble on it). The batch path passes false: web never
   * coalesces (see canCoalesce in enqueueMessage), and the batch path has
   * never written a requestId.
   */
  private appendInboundUser(
    key: string,
    channel: Pick<Channel, "name">,
    message: IncomingMessage,
    content: string,
    opts: { webRequestId: boolean },
  ): void {
    this.sessions.append(key, {
      role: "user",
      content,
      channel: channel.name,
      ...(opts.webRequestId && channel.name === "web" ? { requestId: message.id } : {}),
      senderName: message.senderName,
      timestamp: message.timestamp,
    });
  }

  /**
   * Append `<user message>` + the not-processed marker for each item.
   *
   * Items still pending in the durable inbox are skipped: the next start
   * replays them, and recording them here as well would put the message in
   * the transcript twice with a marker that turns out to be false.
   */
  private recordInboundItems(
    pending: Map<string, Array<Pick<InboundItem, "message" | "inboxId" | "userRecorded"> & { channel: Pick<Channel, "name"> }>>,
    marker: string = SHUTDOWN_NOT_PROCESSED,
  ): void {
    // One read for the whole drain: this runs during shutdown, where every
    // avoidable synchronous file read delays the exit.
    const people = createPeopleSnapshot();
    for (const [key, all] of pending) {
      const items = all.filter((it) => !(it.inboxId && this.inbox?.isPending(it.inboxId) && marker === SHUTDOWN_NOT_PROCESSED));
      const leftForReplay = all.length - items.length;
      if (leftForReplay > 0) {
        log.info({ sessionKey: key, count: leftForReplay }, "Inbound messages left in the durable inbox for replay on next start");
      }
      if (items.length === 0) continue;
      for (const { channel, message, userRecorded } of items) {
        if (!userRecorded) this.appendInboundUser(key, channel, message, this.formatGroupText(channel, message, key, people), { webRequestId: true });
        this.sessions.append(key, {
          role: "assistant",
          content: marker,
          channel: channel.name,
          ...(channel.name === "web" ? { requestId: message.id } : {}),
          timestamp: Date.now(),
        });
      }
      this.inbox?.markDone(inboxIdsOf(items));
      log.info(
        { sessionKey: key, count: items.length },
        "Recorded inbound messages shutdown will not process",
      );
    }
  }

  /**
   * Tell each session which of its subagents and background commands the last
   * restart or crash cut off — that session ONLY (never rerouted: an agent id
   * is only addressable from the SDK session that started it). Nothing is
   * resumed; the model decides.
   *
   * CUSTODY HAND-OFF, as for the durable inbox's `interrupted` note: the list
   * goes into the durable pending-notes store, which keeps a note until a turn
   * that TOOK it ran to its normal result (a turn that failed, was refused, or
   * was cut short puts it back). Only once it is persisted there is the ledger
   * entry dropped; a note that could not be persisted leaves the entry, so the
   * next start tells the session again. A background turn is then queued so
   * the note reaches the model now rather than at the next message.
   *
   * With `interruptedAgents.autoResume` the note and the turn ask for each
   * resumable subagent to be resumed right away. They only remind: the resume
   * cap is enforced by the SendMessage hook (RunningAgentsLedger.gateResume),
   * so a repeated reminder is harmless. An agent found interrupted again past
   * its limit is reported to the owner directly, until that send succeeds.
   */
  private notifyInterruptedAgents(): void {
    const ledger = this.runningAgents;
    if (!ledger) return;
    const known = new Set(this.sessions.listActiveEntries().map((e) => e.channelKey));
    // A session whose stored notes cannot be read is settled later, once
    // they read (`retryInterruptedAgentsNotes`): until then neither "a note
    // is owed" nor "none is" is known, and a new note could not be written.
    const retry = new Set([...known].filter((key) => !this.pendingNotesQueue.storedReadable(key)));
    // A note an earlier start handed off but no turn finished with is still
    // owed: give it its turn again now, not only at the next message.
    const owed = new Set([...known].filter((key) => !retry.has(key) && this.hasInterruptedAgentsNote(key)));
    for (const [key, records] of ledger.pendingBySession()) {
      if (!known.has(key)) {
        log.warn({ sessionKey: key, count: records.length }, "Interrupted subagents belong to an unknown session; dropping the notice");
        ledger.acknowledge(key);
        continue;
      }
      if (retry.has(key)) continue;
      // Not written: tried again until it is (the ledger keeps the records).
      if (this.queueInterruptedAgentsNote(ledger, key, records)) owed.add(key);
      else retry.add(key);
    }
    this.sendOwedResumeFailures(ledger);
    for (const key of owed) this.wakeForInterruptedAgents(key);
    if (retry.size > 0) {
      log.warn({ sessions: [...retry] }, "Interrupted-subagents notes not written yet (pending notes unreadable or the write failed); tried again");
      this.scheduleInterruptedAgentsRetry(retry);
    }
  }

  /** The pending-notes file could not be read and was moved aside (see SessionStore.loadPendingNotes): the owner is told, once the channels are up. */
  private notePendingNotesQuarantined(aside: string): void {
    this.pendingNotesQuarantined.push(aside);
    if (this.channelsUp) this.tellPendingNotesQuarantined();
  }

  private tellPendingNotesQuarantined(): void {
    if (this.pendingNotesQuarantined.length === 0 || this.stopping || this.pendingNotesQuarantineTimer) return;
    const asides = this.pendingNotesQuarantined;
    this.pendingNotesQuarantined = [];
    const files = asides.map((p) => basename(p));
    const text = ownerT("notices")("pendingNotesQuarantined", { files: files.join(", "), count: files.length });
    // Not sent: kept (with any moved aside meanwhile) and tried again.
    const failed = (err?: unknown): void => {
      log.warn({ err, files }, "Could not tell the owner the pending notes file was moved aside; trying again");
      this.pendingNotesQuarantined = [...asides, ...this.pendingNotesQuarantined];
      if (this.stopping || this.pendingNotesQuarantineTimer) return;
      this.pendingNotesQuarantineTimer = setTimeout(() => {
        this.pendingNotesQuarantineTimer = undefined;
        this.tellPendingNotesQuarantined();
      }, PENDING_NOTES_QUARANTINE_NOTICE_RETRY_MS);
      this.pendingNotesQuarantineTimer.unref();
    };
    void this.notifyOwner(text)
      .then((sent) => { if (!sent) failed(); })
      .catch((err) => failed(err));
  }

  private hasInterruptedAgentsNote(key: string): boolean {
    return this.pendingNotesQueue.hasNote(key, (n) => n.includes('<tomo-event type="interrupted-agents"'));
  }

  /** Queue the notice for `records` and acknowledge them. False when the note could not be persisted (kept for the next start). */
  private queueInterruptedAgentsNote(ledger: RunningAgentsLedger, key: string, records: RunningTaskRecord[]): boolean {
    const autoResume = config.interruptedAgentsAutoResume
      ? { failed: new Set(records.filter((r) => isResumable(r) && ledger.resumeCount(key, r.taskId) >= MAX_AUTO_RESUMES).map((r) => r.taskId)) }
      : undefined;
    // One id per set of interrupted agents and process: a retry after a
    // failed write writes the note held in memory again, never a second copy.
    const id = `interrupted-agents:${BOOT_ID}:${createHash("sha256").update(records.map((r) => r.taskId).sort().join("\n")).digest("hex").slice(0, 16)}`;
    if (!this.queuePendingNote(key, formatTomoEvent("interrupted-agents", formatInterruptedAgentsNotice(records, undefined, autoResume)), id)) {
      log.error({ sessionKey: key }, "Could not persist the interrupted-subagents note; tried again (and kept for the next start)");
      return false;
    }
    ledger.acknowledge(key);
    log.info({ sessionKey: key, ids: records.map((r: RunningTaskRecord) => r.taskId) }, "Reporting subagents interrupted by the last restart");
    return true;
  }

  /**
   * The startup check for sessions whose stored notes could not be read:
   * looked at again every `INTERRUPTED_AGENTS_RETRY_MS` until each reads, then
   * settled the way `notifyInterruptedAgents` would have (queue the notice for
   * what the ledger still holds, wake the session if a notice is owed).
   */
  private scheduleInterruptedAgentsRetry(keys: Set<string>): void {
    if (this.interruptedAgentsRetryTimer) clearTimeout(this.interruptedAgentsRetryTimer);
    // stop() may already have run (it can land while start() awaits the
    // channels): never arm a timer after shutdown.
    if (this.stopping) return;
    this.interruptedAgentsRetryTimer = setTimeout(() => {
      this.interruptedAgentsRetryTimer = undefined;
      if (this.stopping) return;
      try {
        this.retryInterruptedAgentsNotes(keys);
      } catch (err) {
        log.error({ err }, "Interrupted-subagents retry failed");
      }
    }, INTERRUPTED_AGENTS_RETRY_MS);
    this.interruptedAgentsRetryTimer.unref();
  }

  private retryInterruptedAgentsNotes(keys: Set<string>): void {
    const ledger = this.runningAgents;
    if (!ledger) return;
    const pending = ledger.pendingBySession();
    const still = new Set<string>();
    for (const key of keys) {
      if (!this.pendingNotesQueue.storedReadable(key)) {
        still.add(key);
        continue;
      }
      const records = pending.get(key);
      // A key leaves the retry set only once its note is on disk.
      if (records && !this.queueInterruptedAgentsNote(ledger, key, records)) {
        still.add(key);
        continue;
      }
      if (this.hasInterruptedAgentsNote(key)) this.wakeForInterruptedAgents(key);
    }
    if (still.size > 0) this.scheduleInterruptedAgentsRetry(still);
  }

  private wakeForInterruptedAgents(key: string): void {
    // A sub-session's note waits for its own next turn (the resume after
    // this restart): it is not woken outside its scheduler.
    if (isTaskSessionKey(key)) return;
    const prompt = formatTomoEvent(
      "interrupted-agents",
      config.interruptedAgentsAutoResume
        ? "Startup check after a restart: if a note above lists interrupted subagents, for each resumable one use SendMessage to resume it right away, "
          + "unless the owner has explicitly said not to, or it has already been resumed or has finished since (check the conversation): "
          + "tell it it was interrupted by a restart, have it first check how far it got and which side effects "
          + "(commits, pushes, messages sent, files changed) already happened, then continue without redoing them. "
          + "Skip any the note marks otherwise; Explore/Plan subagents and background commands cannot be resumed. "
          + `If no note lists any, there is nothing to do. ${CONTINUITY_DELIVERY_NOTE}`
        : "Startup check after a restart: if a note above lists interrupted subagents or commands, decide whether each is "
          + `still worth continuing; otherwise there is nothing to do. ${CONTINUITY_DELIVERY_NOTE}`,
      { name: "check" },
    );
    this.enqueueForSession(key, () => this.processContinuity(prompt, key, undefined, ownerT("notices")("suppressed.turn.interruptedAgents"), "restart"))
      .catch((err) => log.error({ err, sessionKey: key }, "Interrupted-subagents notice failed in queue"));
  }

  /** Tell the owner (no model turn) which subagents failed past their resume limit; unsent ones are tried again next start. */
  private sendOwedResumeFailures(ledger: RunningAgentsLedger): void {
    const bySession = new Map<string, string[]>();
    for (const { sessionKey, taskId } of ledger.owedFailureNotices()) bySession.set(sessionKey, [...(bySession.get(sessionKey) ?? []), taskId]);
    for (const [sessionKey, ids] of bySession) {
      log.warn({ sessionKey, ids }, "Interrupted subagents are past their resume limit; reporting them as failed");
      void this.notifyOwner(ownerT("notices")("interruptedAgents.autoResumeFailed", {
        count: ids.length, session: sessionKey, max: MAX_AUTO_RESUMES, agents: ids.join("\n"),
      }))
        .then((sent) => { if (sent) ledger.failureNoticeSent(sessionKey, ids); })
        .catch((err) => log.warn({ err, sessionKey }, "Could not tell the owner about failed interrupted subagents"));
    }
  }

  /**
   * Settle what the durable inbox still holds from the previous run. Called
   * once, from start(), after the channels are up (a replayed turn has to be
   * able to reply).
   *
   * - `received` → dispatched again through the normal ingress path, so they
   *   coalesce, steer and settle exactly as they would have. The session is
   *   told the messages are being answered late.
   * - `started` → NOT re-run: the turn that was consuming them may already
   *   have called tools or sent part of a reply. The session gets a note to
   *   check before assuming they were answered.
   * - too old (`inboxReplayMaxAgeMinutes`), or their channel is gone → the
   *   transcript records them with a not-processed marker, as a graceful
   *   shutdown would have.
   */
  private replayInbox(records: InboxRecord[]): void {
    if (!this.inbox || records.length === 0) return;

    const maxAgeMs = config.inboxReplayMaxAgeMinutes * 60_000;
    const now = Date.now();
    // Per session, and apart: a turn cut short by the `tomo restart` it ran
    // itself gets its own wording (see selfRestartLead).
    const interrupted = new Map<string, { session: string; selfRestart: boolean; recs: InboxRecord[] }>();
    const stale = new Map<string, Array<{ channel: Pick<Channel, "name">; message: IncomingMessage; inboxId: string }>>();
    const replay: Array<{ rec: InboxRecord; channel: Channel }> = [];
    for (const rec of records) {
      const key = rec.resolution.sessionKey;
      if (rec.status === "started") {
        const selfRestart = rec.selfRestart !== undefined;
        const groupKey = `${selfRestart ? "self" : "cut"}:${key}`;
        const group = interrupted.get(groupKey) ?? { session: key, selfRestart, recs: [] };
        group.recs.push(rec);
        interrupted.set(groupKey, group);
        continue;
      }
      const channel = this.getChannel(rec.channel);
      // A message to a sub-session is not answered late in a chat: it waits
      // in the task's own queue like any other input, so the replay window
      // does not apply (ownerMessageIds dedups one handed over before).
      const forTask = channel !== undefined && this.replayTaskKey(rec.channel, restoreMessage({ ...rec.message, images: undefined, documents: undefined }), rec.resolution) !== undefined;
      if (!forTask && (!channel || maxAgeMs <= 0 || now - rec.receivedAt > maxAgeMs)) {
        let message = restoreMessage({ ...rec.message, images: undefined, documents: undefined });
        let recordAt = key;
        // A message the owner sent a sub-session whose channel is gone now is
        // recorded in the owner's own conversation, where they can see it was
        // not processed: a task key's transcript is one nobody reads.
        const owner = isTaskSessionKey(key) ? this.router.ownerSessionKey() : undefined;
        // An owner reply sent while a task was sending, still unmatched: the
        // owner's session is told it may have been meant for that task.
        const ref = message.replyToId ?? message.reactedToId;
        const scope = this.router.ownerSessionKey();
        if (!owner && scope && key === scope && ref && message.taskSendsInFlight?.length) {
          // Matched once its sends settled and handed to that task before the
          // crash (only the inbox's done-write was lost): the task has it, and
          // asking the owner to send it again would run it twice.
          const messageId = taskMessageId(rec.channel, message);
          if (message.taskSendsInFlight.some((id) => this.taskHasOwnerMessage(id, messageId) === true)) {
            this.inbox.markDone([rec.id]);
            continue;
          }
          if (!this.warnUnmatchedReply(scope, ref, message.taskSendsInFlight, message.text)) {
            log.error({ inboxId: rec.id }, "Could not persist the note for a stale unmatched reply; the inbox record is kept for the next start");
            continue;
          }
        }
        if (owner) {
          const id = taskIdFromSessionKey(key) ?? key;
          // Handed over before the crash (only the inbox's done-write was
          // lost): the task has it, nothing to tell.
          const delivered = this.taskHasOwnerMessage(id, taskMessageId(rec.channel, message));
          if (delivered === true) {
            this.inbox.markDone([rec.id]);
            continue;
          }
          recordAt = owner;
          const typed = message.text;
          message = { ...message, text: `[The owner sent this to sub-session ${id}; it was too old to deliver after the restart.]\n${message.text}` };
          // And the owner's session is told, so the owner hears it may never
          // have arrived. Only once that note is on disk is the record closed;
          // otherwise the next start tries again.
          const told = this.queuePendingNote(owner, markOwnerAudience(formatTomoEvent("inbox",
            `Before Tomo restarted the owner sent this to sub-session ${id}, and it was too old to deliver after the restart, so the task ${delivered === false ? "never got it" : "may never have got it (its task list could not be read to check)"}. Tell the owner, and ask whether to send it again (/s ${id} <message>):\n\n${typed}`,
            { name: "stale-task-message" })));
          if (!told) {
            log.error({ task: id, inboxId: rec.id }, "Could not persist the note for a stale message to a sub-session; the inbox record is kept for the next start");
            continue;
          }
        }
        stale.set(recordAt, [...(stale.get(recordAt) ?? []), { channel: channel ?? { name: rec.channel }, message, inboxId: rec.id }]);
        continue;
      }
      replay.push({ rec, channel });
    }

    for (const { session: key, selfRestart, recs } of interrupted.values()) {
      const oldest = new Date(recs[0].receivedAt).toISOString();
      // The messages themselves travel with the note: the turn may have died
      // before the prompt ever reached the transcript, and a note that only
      // says "something was interrupted" leaves nothing to answer.
      //
      // CUSTODY HAND-OFF. From here the note is the message's only copy, so
      // the inbox record is closed only once EVERY part of it is in the
      // durable pending-notes store (which keeps a note until the turn that
      // carries it ends — see PendingNotesQueue). A note that could not be
      // persisted leaves the record started: the next start tells the session
      // again (a repeated note, never a lost message).
      const chunks = interruptedNoteChunks(recs);
      // Stable ids: a start after one part failed to write writes the
      // others again, and the parts already queued are not added twice.
      const idBase = `inbox-interrupted:${createHash("sha256").update(recs.map((r) => r.id).join("\n")).digest("hex").slice(0, 16)}`;
      let persisted = true;
      chunks.forEach((chunk, i) => {
        const part = chunks.length > 1
          ? ` (part ${i + 1} of ${chunks.length}; the quoted text continues across parts exactly where each one ends)`
          : "";
        const lead = selfRestart
          ? selfRestartLead(recs, oldest, part)
          : `Tomo restarted while a turn was handling ${recs.length === 1 ? "a message" : `${recs.length} messages`} received from ${oldest}${part}. `
            + "Your reply may be missing or incomplete; check the conversation before assuming it was answered, "
            + "and answer now if it was not.\n";
        const ok = this.queuePendingNote(key, formatTomoEvent("inbox", lead + chunk, { name: "interrupted" }), `${idBase}:${i}`);
        persisted &&= ok;
      });
      if (persisted) {
        this.inbox.markDone(recs.map((r) => r.id));
      } else {
        log.error({ sessionKey: key, count: recs.length }, "Durable inbox: could not persist the interrupted-turn note; the inbox record is kept so the next start tells the session again");
      }
      log.warn({ sessionKey: key, count: recs.length, selfRestart }, "Durable inbox: turn was interrupted by a restart; session notified, not re-run");
    }

    if (stale.size > 0) this.recordInboundItems(stale, INBOX_STALE_NOT_PROCESSED);

    const perSession = new Map<string, number>();
    for (const item of replay) item.rec = { ...item.rec, resolution: this.replayResolution(item.rec.channel, restoreMessage(item.rec.message), item.rec.resolution) };
    for (const { rec } of replay) perSession.set(rec.resolution.sessionKey, (perSession.get(rec.resolution.sessionKey) ?? 0) + 1);
    for (const [key, count] of perSession) {
      this.queuePendingNote(key, formatTomoEvent(
        "inbox",
        `${count === 1 ? "The next message" : `The next ${count} messages`} arrived before Tomo restarted and ${count === 1 ? "is" : "are"} being answered late.`,
        { name: "replay" },
      ));
      log.info({ sessionKey: key, count }, "Durable inbox: replaying messages received before the restart");
    }
    for (const { rec, channel } of replay) {
      this.dispatchInbound(channel, restoreMessage(rec.message), rec.resolution, rec.id);
    }
  }
}

/** The dedup id an owner message to a sub-session is recorded under (`ownerMessageIds`). */
function taskMessageId(channelName: string, message: Pick<IncomingMessage, "id" | "inboxKey">): string {
  return `${channelName}:${message.id}${message.inboxKey ? `:${message.inboxKey}` : ""}`;
}

/**
 * Size of one `interrupted` note part. Larger quoted text is split across
 * parts — never truncated: the note is the message's only remaining copy.
 */
const INTERRUPTED_NOTE_CHUNK = 16_000;

/**
 * Lead of the `interrupted` note for a turn that ran `tomo restart` itself.
 * The restart was its own doing, so this is not reported as an accident; but
 * whatever the turn meant to do after the restart call never ran.
 */
function selfRestartLead(recs: InboxRecord[], oldest: string, part: string): string {
  const reason = recs.find((r) => r.selfRestart?.reason)?.selfRestart?.reason;
  return `This turn restarted Tomo itself${reason ? ` (reason: ${reason})` : ""}, while handling `
    + `${recs.length === 1 ? "a message" : `${recs.length} messages`} received from ${oldest}${part}. `
    + "Check the conversation: if the sender has not yet received the answer, or anything after the restart call "
    + "was unfinished, deliver or continue it now; reply NO_REPLY only when nothing is owed.\n";
}

/** A channel's fault notice, worded for the owner. */
function channelFaultText(notice: ChannelFaultNotice): OwnerText {
  switch (notice.kind) {
    case "imsgLaneBlocked":
      return ownerT("notices")("imsgLaneBlocked", { restarts: notice.restarts, minutes: Math.round(notice.windowMs / 60_000) });
  }
}

/** One interrupted message as quoted in the note, in full: sender, text, saved attachments. */
function formatInterruptedMessage(rec: InboxRecord, i: number, total: number): string {
  const text = rec.message.text ?? "";
  const sender = rec.message.senderName ? `${rec.message.senderName}: ` : "";
  const attachments = [...(rec.message.images ?? []), ...(rec.message.documents ?? [])]
    .map((a) => `\n  [attachment ${a.mediaType}: ${a.savedPath ?? "not saved"}]`).join("");
  return `Message ${i + 1}${total > 1 ? ` of ${total}` : ""} (${new Date(rec.receivedAt).toISOString()}) — ${sender}${text}${attachments}`;
}

/**
 * Every interrupted message, quoted in full, cut into note-sized parts in
 * order. A message longer than one part continues in the next. Nothing is
 * left out or shortened: a character not quoted here is a character lost.
 */
export function interruptedNoteChunks(recs: readonly InboxRecord[], chunkSize = INTERRUPTED_NOTE_CHUNK): string[] {
  // By code point, so a cut never splits a surrogate pair.
  const all = Array.from(recs.map((rec, i) => formatInterruptedMessage(rec, i, recs.length)).join("\n"));
  const chunks: string[] = [];
  for (let at = 0; at < all.length; at += chunkSize) chunks.push(all.slice(at, at + chunkSize).join(""));
  return chunks.length > 0 ? chunks : [""];
}

/** Owner DMs about inbox faults: at most one per this window. */
const INBOX_FAULT_NOTICE_MS = 10 * 60_000;

/**
 * The durable inbox could not persist an inbound message from a channel that
 * redelivers what it was not told it handed off. Thrown out of the message
 * handler so the channel treats the row as not handled.
 */
export class InboxPersistError extends Error {
  constructor(channelName: string, messageId: string) {
    super(`Durable inbox could not persist ${channelName} message ${messageId}; not taking custody so the channel redelivers it`);
    this.name = "InboxPersistError";
  }
}

function inboxIdsOf(items: ReadonlyArray<{ inboxId?: string }>): string[] {
  return items.flatMap((item) => (item.inboxId ? [item.inboxId] : []));
}
