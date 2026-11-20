import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Channel } from "../channels/types.js";
import { config, CONFIG_BACKUP_PATH, CONFIG_PATH, RESTART_REASON_FILE } from "../config.js";
import { writeFileAtomicSync } from "../fs-utils.js";
import type { OwnerRouter } from "../router.js";
import { ownerDisplayName, type OwnerConfig } from "../owner.js";
import { redactChatIdForLog } from "./blocked-inbound-log.js";
import { withConfigLockSync } from "../config-file.js";
import type { SessionStore } from "../sessions/index.js";
import type { PauseStore } from "../sessions/pause-store.js";
import { dmSessionKeyForIdentity, isGroupSessionKey } from "../sessions/keys.js";
import { writeRestartReasonFile } from "../restart-reason.js";
import { DEFAULT_MODEL, MODEL_ALIASES } from "../models.js";
import { formatDateTime, formatNumber, joinText, ownerLocale, ownerT, raw, type OwnerT, type OwnerText } from "../i18n/index.js";
import { switchSessionModel, type ModelSwitchRefusal } from "./model-switch.js";
import { buildSessionCostReport } from "../costs.js";
import {
  CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
  liteLlmModeLabel,
} from "../litellm.js";
import { log } from "../logger.js";
import { shortErrorMessage } from "../error-text.js";
import { formatTomoEvent } from "../tomo-event.js";
import { PetStore } from "../mcp/pet-store.js";
import { petMoodLabel, petStageLabel } from "../mcp/pet-labels.js";
import type { ExternalMcpServerStatus, McpLoginStart } from "../mcp/oauth.js";
import { mergeMcpStatus, type McpLiveRead, type MergedMcpStatus } from "../mcp/status-merge.js";
import { ClaudeLoginManager } from "./claude-login.js";
import { buildUsageReport } from "./usage.js";
import { limitsLogFor } from "../usage/limits-log.js";
import { litellmRoutesModel } from "../litellm.js";
import { TASKS_COMMAND } from "../channels/chat-commands.js";
import type { SessionTaskList } from "../web/tasks.js";
import { formatTaskList, startOfLocalDay } from "./tasks-command.js";
import { parseTodoArgs, runTodoCommand, todoUnavailable, todoUsage } from "./todo-command.js";
import { TodoStore } from "../todos/store.js";

/** Back up ~/.tomo/config.json before a programmatic rewrite. */
export { backupConfigFile } from "./model-switch.js";

/** The chat reply for a refused /model switch. */
function modelRefusalText(t: OwnerT<"commands">, reason: ModelSwitchRefusal, arg: string, resolved: string): OwnerText {
  switch (reason) {
    case "unknown_model": return t("model.unknown", { arg, aliases: Object.keys(MODEL_ALIASES).join(", "), direct: DEFAULT_MODEL, gateway: CHATGPT_SUBSCRIPTION_DEFAULT_MODEL });
    case "gateway_required": return t("model.gatewayRequired", { model: resolved });
    case "gateway_unroutable": return t("model.gatewayUnroutable", { example: CHATGPT_SUBSCRIPTION_DEFAULT_MODEL });
    case "persist_failed": return t("model.persistFailed");
    // Only reachable with options /model does not pass.
    case "turn_in_flight": return t("model.turnInFlight");
    case "model_changed": return t("model.modelChanged");
  }
}

export interface ChatCommandDeps {
  router: OwnerRouter;
  sessions: SessionStore;
  /** Shared with the Agent — paused groups are dropped at message receipt. */
  pauses: PauseStore;
  /** Shared with the Agent — per-session model overrides read at session create time. */
  modelOverrides: Map<string, string>;
  closeLiveSession(key: string): void;
  isSessionLive(key: string): boolean;
  /** Resolves to the number of human messages actually rewound, the earliest
   *  one's opening words, and whether a running turn had to be stopped first. */
  rewindSession(key: string, count: number): Promise<{ count: number; preview: string; stoppedTurn?: boolean; droppedMessages?: number; nothingToRewind?: boolean }>;
  queuePendingNote(sessionKey: string, note: string): void;
  getExternalMcpStatuses(sessionKey: string): ExternalMcpServerStatus[];
  startExternalMcpLogin(serverName: string): Promise<McpLoginStart>;
  /** The key's SDK-reported MCP connections: undefined with no live session, null when it did not answer. */
  readLiveMcpStatus(sessionKey: string): Promise<McpLiveRead>;
  /** Reconnect one MCP server on the key's live session (never creates one). */
  reconnectMcpServer(sessionKey: string, serverName: string): Promise<"reconnected" | "failed" | "busy" | "no-live-session">;
  /** One session's tasks from the web Tasks panel's board (`TaskBoard.listFor`);
   *  undefined when there is no board (web UI off). */
  listTasks(sessionKey: string, since: number): SessionTaskList | undefined;
  /** Send plain text to the owner's private DM (its reply target); false when there is none. */
  sendToOwnerDm(owner: OwnerConfig, text: OwnerText): Promise<boolean>;
  /** The todo store `/todo` reads and writes (tests); defaults to `<tomoHome>/data/todos`. */
  todoStore?: () => TodoStore;
}

/**
 * Handles slash commands typed in chat (/new, /model, /status, /pet,
 * /cost, /restore, /login, /mcp, /pause, /resume, /rewind, /tasks, /todo).
 * Wired to Channel.onCommand by the Agent.
 */
export class ChatCommandHandler {
  private restoringConfig = false;
  private readonly claudeLogin = new ClaudeLoginManager();

  constructor(private readonly deps: ChatCommandDeps) {}

  /** True once /restore has begun — the Agent drops inbound messages until restart. */
  get isRestoring(): boolean {
    return this.restoringConfig;
  }

  stop(): void {
    this.claudeLogin.stop();
  }

  /** Every command reply goes out here: only translated text (or text marked `raw`) is accepted. */
  private async reply(channel: Channel, chatId: string, text: OwnerText): Promise<void> {
    await channel.send({ chatId, text });
  }

  async handle(channel: Channel, command: string, chatId: string, senderName: string, args?: string, senderId?: string): Promise<void> {
    const t = ownerT("commands");
    // Commands obey the same channel allowlist as inbound messages
    // (Agent.enqueueMessage): check channel+chatId BEFORE resolving, so a
    // disallowed chat can't touch routing state, and drop silently — the
    // message path never replies to chats outside the allowlist.
    if (!this.deps.router.isAllowed(channel.name, chatId)) {
      log.debug({ channel: channel.name, chat: redactChatIdForLog(chatId), command }, "Command blocked at receipt (not in allowlist)");
      return;
    }

    if (this.restoringConfig) {
      await this.reply(channel, chatId, t("restoring"));
      return;
    }

    // Check /login before resolving a session: a rejected group login must not
    // create or mutate a conversation entry as a side effect.
    if (command === "login") {
      await this.handleClaudeLogin(channel, chatId, senderId, args);
      return;
    }

    if (command === "mcp") {
      await this.handleExternalMcpCommand(channel, chatId, senderId, args);
      return;
    }

    if (command === "rewind") {
      const identity = this.ownerFor(channel, senderId);
      if (isGroupSessionKey(`${channel.name}:${chatId}`) || !identity) {
        await this.reply(channel, chatId, t("dmOnly", { command: "rewind" }));
        return;
      }
      const arg = args?.trim() || "1";
      if (!/^[1-9]\d*$/.test(arg) || !Number.isSafeInteger(Number(arg))) {
        await this.reply(channel, chatId, t("rewind.usage"));
        return;
      }
      let rewound: { count: number; preview: string; stoppedTurn?: boolean; droppedMessages?: number; nothingToRewind?: boolean };
      try {
        rewound = await this.deps.rewindSession(dmSessionKeyForIdentity(identity.name), Number(arg));
      } catch (err) {
        log.warn({ err }, "Session rewind failed");
        await this.reply(channel, chatId, t("rewind.failed", { error: shortErrorMessage(err) }));
        return;
      }
      const dropped = rewound.droppedMessages ? t("rewind.dropped", { count: rewound.droppedMessages }) : "";
      if (rewound.nothingToRewind) {
        await this.reply(channel, chatId, t("rewind.nothing", { dropped }));
        return;
      }
      const target = rewound.preview ? t("rewind.target", { preview: rewound.preview }) : "";
      const moved = rewound.count > Number(arg) ? t("rewind.moved", { asked: arg }) : "";
      const stopped = rewound.stoppedTurn ? t("rewind.stopped", { dropped }) : "";
      await this.reply(channel, chatId, t("rewind.done", { count: rewound.count, target, moved, stopped }));
      return;
    }

    const { sessionKey: key } = this.deps.router.resolve(channel.name, chatId, false);

    if (command === TASKS_COMMAND) {
      await this.handleTasksCommand(channel, chatId, key, args, senderId);
      return;
    }

    if (command === "todo") {
      await this.handleTodoCommand(channel, chatId, key, args, senderId);
      return;
    }

    if (command === "summon" || command === "dismiss") {
      await this.handleSummonCommand(channel, command, chatId, senderName, senderId);
      return;
    }

    if (command === "pause" || command === "resume") {
      await this.handlePauseCommand(channel, command, chatId, senderName);
      return;
    }

    if (command === "new") {
      this.deps.closeLiveSession(key);
      this.deps.sessions.clearSdkSessionId(key);
      log.info({ channel: channel.name, chatId, sender: senderName }, "New session started via /new");
      await this.reply(channel, chatId, t("newSession"));
      return;
    }

    if (command === "model") {
      if (!this.isOwner(channel, senderId)) {
        log.info({ channel: channel.name, chatId, sender: senderName }, "/model refused (sender is not the owner)");
        await this.reply(channel, chatId, !config.owner ? t("noOwner", { command: "model" }) : t("model.ownerOnly"));
        return;
      }
      const arg = args?.trim();
      if (!arg) {
        const current = this.deps.modelOverrides.get(key) ?? config.model;
        const lines = [t("model.current", { model: current })];
        for (const [shortName, fullName] of Object.entries(MODEL_ALIASES)) {
          lines.push(fullName === current ? t("model.aliasActive", { alias: shortName, model: fullName }) : t("model.alias", { alias: shortName, model: fullName }));
        }
        if (config.litellm?.baseUrl) {
          lines.push(t("model.gatewayModels", { example: CHATGPT_SUBSCRIPTION_DEFAULT_MODEL }));
        }
        lines.push(t("model.directIds", { example: DEFAULT_MODEL }));
        await this.reply(channel, chatId, joinText(lines));
        return;
      }

      // No turn-in-flight check here: /model has always switched at once.
      const outcome = switchSessionModel({ modelOverrides: this.deps.modelOverrides,
        closeLiveSession: (sessionKey) => this.deps.closeLiveSession(sessionKey) }, key, arg);
      if (!outcome.ok) {
        await this.reply(channel, chatId, modelRefusalText(t, outcome.reason, arg, outcome.model ?? arg));
        return;
      }
      const resolved = outcome.model;
      log.info({ channel: channel.name, chatId, model: resolved }, "Model switched via /model");
      await this.reply(channel, chatId, t("model.switched", { model: resolved }));
      return;
    }

    if (command === "restore") {
      if (!this.isOwner(channel, senderId)) {
        log.info({ channel: channel.name, chatId, sender: senderName }, "/restore refused (sender is not the owner)");
        await this.reply(channel, chatId, !config.owner ? t("noOwner", { command: "restore" }) : t("restore.ownerOnly"));
        return;
      }
      await this.restoreConfigAndRestart(channel, chatId, key);
      return;
    }

    if (command === "pet") {
      const store = new PetStore(join(config.tomoHome, "data", "pet.json"));
      let pet = store.load();
      if (!pet) {
        await this.reply(channel, chatId, t("pet.none"));
        return;
      }

      pet = store.tick(pet);
      store.save(pet);

      const ageDays = Math.max(0, Math.floor(
        (Date.now() - new Date(pet.born_at).getTime()) / (24 * 60 * 60 * 1000),
      ));
      const lines = [
        t("pet.title", { name: pet.name, species: pet.species }),
        t("pet.stageLine", { count: ageDays, stage: petStageLabel(t, pet.stage), mood: petMoodLabel(t, store.computeMood(pet)) }),
        t("pet.hungerLine", { hunger: Math.round(pet.hunger), happiness: Math.round(pet.happiness) }),
        t("pet.energyLine", { energy: Math.round(pet.energy), health: Math.round(pet.health) }),
        t("pet.bondLine", { bond: store.effectiveAffection(pet), mistakes: pet.care_mistakes }),
      ];

      if (pet.sleeping && pet.sleep_until) {
        lines.push(t("pet.sleeping", { until: formatDateTime(new Date(pet.sleep_until).getTime()) }));
      } else if (pet.recovering) {
        lines.push(t("pet.recovering"));
      }

      await this.reply(channel, chatId, joinText(lines));
      return;
    }

    if (command === "cost") {
      const logPath = join(config.logsDir, "tomo.log");
      await this.reply(channel, chatId, buildSessionCostReport(key, { logPath }));
      return;
    }

    if (command === "usage") {
      // /usage exposes account-wide plan + utilization + scoped caps, so gate it
      // EXACTLY like /login: owner's private DM only, and — unlike /model and
      // /restore — it never falls open when no identities exist (channels
      // default to open, so a bare DM must not read the owner's subscription
      // state). A group is shared, so any member is refused regardless.
      if (isGroupSessionKey(`${channel.name}:${chatId}`)) {
        await this.reply(channel, chatId, t("dmOnly", { command: "usage" }));
        return;
      }
      const usageIdentity = this.ownerFor(channel, senderId);
      if (!usageIdentity) {
        log.info({ channel: channel.name, chatId, sender: senderName }, "/usage refused (sender is not the owner)");
        await this.reply(channel, chatId, !config.owner ? t("noOwnerRetry", { command: "usage" }) : t("usage.ownerOnly"));
        return;
      }
      // Classify gateway routing the same way the SDK does — from the session's
      // effective model, not merely "is a gateway configured".
      const effectiveModel = this.deps.modelOverrides.get(key) ?? config.model;
      await this.reply(channel, chatId, await buildUsageReport({
          authMethod: config.auth.method,
          gatewayActive: litellmRoutesModel(config.litellm, effectiveModel),
          onData: (data) => { void limitsLogFor(config.tomoHome).recordOAuthUsage(data); },
        }));
      return;
    }

    if (command === "status") {
      const model = this.deps.modelOverrides.get(key) ?? config.model;
      const session = this.deps.sessions.get(key);
      const entry = this.deps.sessions.getEntry(key);

      const locale = ownerLocale();
      const lines: OwnerText[] = [];
      lines.push(t("status.title"));
      lines.push(t("status.session", { key }));
      lines.push(t("status.channel", { channel: channel.name }));
      const summoned = this.deps.router.getSummonedIdentity(channel.name, chatId);
      if (summoned) lines.push(t("status.summoned", { identity: summoned }));
      if (this.deps.pauses.isPaused(`${channel.name}:${chatId}`)) {
        lines.push(t("status.paused"));
      }
      lines.push(t("status.model", { model }));
      if (config.litellm?.baseUrl) {
        lines.push(t("status.gateway", { mode: liteLlmModeLabel(config.litellm.mode) }));
      }
      lines.push(this.deps.isSessionLive(key) ? t("status.liveYes") : t("status.liveNo"));

      // Count from the transcript file, not session.messages — the in-memory
      // session holds only the recent tail.
      const msgCount = this.deps.sessions.countRecentUserMessages(key);
      lines.push(t("status.messages", { count: msgCount }));

      if (session.createdAt) {
        lines.push(t("status.created", { at: formatDateTime(session.createdAt, locale) }));
      }
      if (session.updatedAt) {
        lines.push(t("status.lastActive", { at: formatDateTime(session.updatedAt, locale) }));
      }

      if (entry?.stats) {
        const s = entry.stats;
        lines.push(t("status.queries", { count: s.totalQueries }));
        lines.push(t("status.cost", { cost: `$${s.totalCostUsd.toFixed(4)}` }));
        lines.push(t("status.tokens", { input: formatNumber(s.totalInputTokens, locale), output: formatNumber(s.totalOutputTokens, locale) }));
        if (s.contextMax > 0) {
          lines.push(t("status.context", {
            percent: formatNumber(s.contextUsed / s.contextMax, locale, { style: "percent", maximumFractionDigits: 0 }),
            used: formatNumber(s.contextUsed, locale), max: formatNumber(s.contextMax, locale),
          }));
        }
      }

      await this.reply(channel, chatId, joinText(lines));
      return;
    }
  }

  /**
   * /tasks (alias /task): the Tasks panel's list for THIS chat's own session,
   * answered by the harness — no model call. A DM sees its own session (for
   * the owner, the owner's session). A group sees only the group's own
   * session — never a DM's or another group's task text, which may be
   * private — except when the group is summoned into the owner's session AND
   * the sender is the owner: the summoned turns run there, so the owner gets
   * the owner's list (summoning is the owner's statement of trust), sent
   * to the owner's private DM — the group only sees "Sent to your DM.".
   * `/tasks all` lists every task that ended today instead of the last few.
   */
  private async handleTasksCommand(channel: Channel, chatId: string, resolvedKey: string, args: string | undefined, senderId?: string): Promise<void> {
    const t = ownerT("commands");
    const arg = args?.trim().toLowerCase() ?? "";
    if (arg !== "" && arg !== "all") {
      await this.reply(channel, chatId, t("tasks.usage"));
      return;
    }
    let key = resolvedKey;
    // Summoned group + owner sender: the owner's list, which must never be
    // posted in the group (everyone there reads it) — it goes to the owner's
    // private DM, and the group gets one content-free line.
    let ownerDm: OwnerConfig | undefined;
    if (isGroupSessionKey(`${channel.name}:${chatId}`)) {
      key = `${channel.name}:${chatId}`;
      const owner = this.ownerFor(channel, senderId);
      const summoned = this.deps.router.getSummonedIdentity(channel.name, chatId);
      if (owner && summoned !== undefined && summoned === owner.name.toLowerCase()) {
        key = dmSessionKeyForIdentity(owner.name);
        ownerDm = owner;
      }
    }
    const now = Date.now();
    const list = this.deps.listTasks(key, startOfLocalDay(now));
    if (!list) {
      await this.reply(channel, chatId, t("tasks.unavailable"));
      return;
    }
    const text = formatTaskList(list, { now, all: arg === "all", locale: ownerLocale() });
    if (ownerDm) {
      let sent = false;
      try { sent = await this.deps.sendToOwnerDm(ownerDm, text); } catch (err) {
        log.warn({ err }, "/tasks: could not send the list to the owner's DM");
      }
      await this.reply(channel, chatId, sent ? t("sentToDm") : t("dmUnreachable"));
      return;
    }
    await this.reply(channel, chatId, text);
  }

  /**
   * /todo: the todo list for THIS chat's scope, answered by the harness — no
   * model call. Same routing as /tasks: a DM sees the owner's scope (every
   * item); a group sees only its own items, and only the owner may add, finish
   * or drop there; a group summoned into the owner's session with the owner as
   * sender gets the owner's scope, with the reply sent to the owner's private
   * DM and only "Sent to your DM." in the group.
   */
  private async handleTodoCommand(channel: Channel, chatId: string, resolvedKey: string, args: string | undefined, senderId?: string): Promise<void> {
    const t = ownerT("commands");
    const parsed = parseTodoArgs(args);
    if (!parsed) {
      await this.reply(channel, chatId, todoUsage());
      return;
    }
    let key = resolvedKey;
    let ownerDm: OwnerConfig | undefined;
    const owner = this.ownerFor(channel, senderId);
    if (isGroupSessionKey(`${channel.name}:${chatId}`)) {
      key = `${channel.name}:${chatId}`;
      const summoned = this.deps.router.getSummonedIdentity(channel.name, chatId);
      if (owner && summoned !== undefined && summoned === owner.name.toLowerCase()) {
        key = dmSessionKeyForIdentity(owner.name);
        ownerDm = owner;
      } else if (parsed.kind !== "list" && !owner) {
        await this.reply(channel, chatId, t("todo.ownerOnly"));
        return;
      }
    }
    let text: OwnerText;
    try {
      const store = this.deps.todoStore?.() ?? new TodoStore();
      text = runTodoCommand(parsed, { store, scopeKey: key, now: Date.now() });
    } catch (err) {
      log.warn({ err }, "/todo failed");
      text = todoUnavailable(shortErrorMessage(err));
    }
    if (ownerDm) {
      let sent = false;
      try { sent = await this.deps.sendToOwnerDm(ownerDm, text); } catch (err) {
        log.warn({ err }, "/todo: could not send the reply to the owner's DM");
      }
      await this.reply(channel, chatId, sent ? t("sentToDm") : t("dmUnreachable"));
      return;
    }
    await this.reply(channel, chatId, text);
  }

  /**
   * /summon pulls the owner's main dm: session into a group: subsequent group
   * messages run on the dm session (full personal context) while turn output
   * still goes to the owner's private DM. Group-facing replies require an
   * explicit send_message direct tool call to the raw group session key.
   */
  private async handleSummonCommand(
    channel: Channel,
    command: "summon" | "dismiss",
    chatId: string,
    senderName: string,
    senderId?: string,
  ): Promise<void> {
    const t = ownerT("commands");
    const rawKey = `${channel.name}:${chatId}`;
    if (!isGroupSessionKey(rawKey)) {
      await this.reply(channel, chatId, t("groupOnly", { command }));
      return;
    }
    if (!this.deps.router.isAllowed(channel.name, chatId)) {
      log.debug({ channel: channel.name, chat: redactChatIdForLog(chatId) }, `/${command} blocked (group not in allowlist)`);
      return;
    }

    const groupLabel = this.deps.sessions.getEntry(rawKey)?.chatTitle ?? rawKey;

    if (command === "dismiss") {
      const summoned = this.deps.router.getSummonedIdentity(channel.name, chatId);
      if (!summoned) {
        await this.reply(channel, chatId, t("summon.noneHere"));
        return;
      }
      this.deps.router.dismissGroup(channel.name, chatId);
      this.deps.queuePendingNote(
        `dm:${summoned}`,
        formatTomoEvent(
          "dismiss",
          `You have been dismissed from the group "${groupLabel}" — its messages no longer reach this session, and the group's own Tomo session has taken back over.`,
          { name: rawKey },
        ),
      );
      await this.reply(channel, chatId, t("summon.dismissed"));
      return;
    }

    const identity = this.ownerFor(channel, senderId);
    if (!identity) {
      log.info({ channel: channel.name, chatId, sender: senderName }, "/summon refused (sender is not the owner)");
      await this.reply(channel, chatId, t("summon.ownerOnly"));
      return;
    }

    const already = this.deps.router.getSummonedIdentity(channel.name, chatId);
    if (already) {
      await this.reply(channel, chatId, t("summon.already", { identity: already }));
      return;
    }

    this.deps.router.summonGroup(channel.name, chatId);
    const expiryNote = config.summonExpiryMinutes > 0
      ? ` or after ${config.summonExpiryMinutes} minutes of group inactivity`
      : "";
    this.deps.queuePendingNote(
      dmSessionKeyForIdentity(identity.name),
      formatTomoEvent(
        "summon",
        `${ownerDisplayName(identity)} summoned you into the group chat "${groupLabel}" (${rawKey}). Until dismissed${expiryNote}, messages from that group arrive in this session tagged [group ...] with the sender's name. To reply in the group, call send_message with mode "direct" and target "${rawKey}" — compose the reply yourself, with your context. Plain text you output goes to ${ownerDisplayName(identity)}'s private DM, not the group. Everyone in the group can read what you send it — keep private memory and DM context out of group-facing messages.`,
        { name: rawKey },
      ),
    );
    log.info({ channel: channel.name, chatId, identity: identity.name, sender: senderName }, "Group summoned via /summon");
    await this.reply(channel, chatId, expiryNote
      ? t("summon.summonedExpiry", { owner: ownerDisplayName(identity), minutes: config.summonExpiryMinutes })
      : t("summon.summoned", { owner: ownerDisplayName(identity) }));
  }

  /**
   * /pause drops ALL of a group's inbound messages at receipt — nothing
   * reaches the agent, its context, or the transcript — until someone sends
   * /resume. Group-only; ANY group member can pause or resume (no owner
   * check). Slash commands keep flowing while paused — that is how /resume
   * gets through.
   */
  private async handlePauseCommand(
    channel: Channel,
    command: "pause" | "resume",
    chatId: string,
    senderName: string,
  ): Promise<void> {
    const t = ownerT("commands");
    const rawKey = `${channel.name}:${chatId}`;
    if (!isGroupSessionKey(rawKey)) {
      await this.reply(channel, chatId, t("groupOnly", { command }));
      return;
    }

    if (command === "pause") {
      if (this.deps.pauses.isPaused(rawKey)) {
        await this.reply(channel, chatId, t("pause.already"));
        return;
      }
      this.deps.pauses.pause(rawKey, senderName);
      log.info({ channel: channel.name, chatId, sender: senderName }, "Group paused via /pause");
      await this.reply(channel, chatId, t("pause.paused"));
      return;
    }

    if (!this.deps.pauses.resume(rawKey)) {
      await this.reply(channel, chatId, t("pause.notPaused"));
      return;
    }
    log.info({ channel: channel.name, chatId, sender: senderName }, "Group resumed via /resume");
    await this.reply(channel, chatId, t("pause.resumed"));
  }

  /** Gate for config-mutating commands (/model, /restore): the sender must be
   *  the owner on this channel — the same check /login uses. FAILS CLOSED:
   *  with no owner configured nobody may change the model or restore config. */
  private isOwner(channel: Channel, senderId?: string): boolean {
    return this.deps.router.isOwnerSender(channel.name, senderId);
  }

  /** The owner, when this sender is the owner on this channel (fails closed). */
  private ownerFor(channel: Channel, senderId?: string): OwnerConfig | undefined {
    return this.deps.router.isOwnerSender(channel.name, senderId) ? this.deps.router.owner() : undefined;
  }

  private async handleClaudeLogin(
    channel: Channel,
    chatId: string,
    senderId?: string,
    args?: string,
  ): Promise<void> {
    const t = ownerT("commands");
    const rawKey = `${channel.name}:${chatId}`;
    if (isGroupSessionKey(rawKey)) {
      await this.reply(channel, chatId, t("dmOnly", { command: "login" }));
      return;
    }

    const identity = this.ownerFor(channel, senderId);
    if (!identity) {
      log.warn({ channel: channel.name, chatId }, "/login refused (sender is not the owner)");
      // /login mutates Claude credentials, so unlike /model and /restore it
      // never falls open when no identities exist — instead point the user at
      // the setup path.
      await this.reply(channel, chatId, !config.owner ? t("noOwnerRetry", { command: "login" }) : t("login.ownerOnly"));
      return;
    }

    const arg = args?.trim() ?? "";
    if (arg.toLowerCase() === "cancel") {
      const cancelled = this.claudeLogin.cancel(identity.name);
      await this.reply(channel, chatId, cancelled ? t("login.cancelled") : t("login.noneWaiting"));
      return;
    }

    try {
      if (!arg) {
        const { url, reused } = await this.claudeLogin.start(identity.name);
        await this.reply(channel, chatId, joinText([
          reused ? t("login.alreadyWaiting") : t("login.started"),
          raw(url),
          t("login.instructions"),
        ]));
        return;
      }

      const completion = await this.claudeLogin.complete(identity.name, arg);
      const reason = completion.verified
        ? "Claude login refreshed via owner DM"
        : "Claude login refreshed via owner DM; verification probe failed";
      // Attribute the owner's DM session so the post-restart notice routes
      // back to it instead of the blessed default session.
      writeRestartReasonFile(RESTART_REASON_FILE, {
        reason,
        sessionKey: dmSessionKeyForIdentity(identity.name),
      });
      await this.reply(channel, chatId, completion.verified
        ? t("login.verified")
        : completion.verificationError ? t("login.unverifiedDetail", { error: completion.verificationError }) : t("login.unverified"));
      this.scheduleRestart();
    } catch (err) {
      const detail = shortErrorMessage(err);
      log.warn({ err, identity: identity.name }, "Claude login command failed");
      await this.reply(channel, chatId, t("login.failed", { error: detail }));
    }
  }

  private async handleExternalMcpCommand(
    channel: Channel,
    chatId: string,
    senderId?: string,
    args?: string,
  ): Promise<void> {
    const t = ownerT("commands");
    const rawKey = `${channel.name}:${chatId}`;
    if (isGroupSessionKey(rawKey)) {
      await this.reply(channel, chatId, t("dmOnly", { command: "mcp" }));
      return;
    }

    const identity = this.ownerFor(channel, senderId);
    if (!identity) {
      log.warn({ channel: channel.name, chatId }, "/mcp refused (sender is not the owner)");
      await this.reply(channel, chatId, !config.owner ? t("noOwnerRetry", { command: "mcp" }) : t("mcp.ownerOnly"));
      return;
    }

    const arg = args?.trim() ?? "";
    const sessionKey = dmSessionKeyForIdentity(identity.name);
    if (!arg) {
      const live = await this.deps.readLiveMcpStatus(sessionKey);
      const rows = mergeMcpStatus(live, this.deps.getExternalMcpStatuses(sessionKey));
      if (rows.length === 0) {
        await this.reply(channel, chatId, live === undefined ? t("mcp.noneNoSession") : t("mcp.none"));
        return;
      }
      const header = live === undefined ? t("mcp.headerNoSession") : live === null ? t("mcp.headerNoReport") : t("mcp.header");
      await this.reply(channel, chatId, joinText([header, ...rows.map((row) => formatMergedMcpStatus(t, row))]));
      return;
    }

    const reconnect = /^reconnect\s+(\S+)$/i.exec(arg);
    if (reconnect) {
      const outcome = await this.deps.reconnectMcpServer(sessionKey, reconnect[1]);
      await this.reply(channel, chatId, outcome === "reconnected" ? t("mcp.reconnected", { server: reconnect[1] })
        : outcome === "no-live-session" ? t("mcp.reconnectNoSession")
        : outcome === "busy" ? t("mcp.reconnectBusy")
        : t("mcp.reconnectFailed", { server: reconnect[1] }));
      return;
    }

    const match = /^login\s+(\S+)$/i.exec(arg);
    if (!match) {
      await this.reply(channel, chatId, t("mcp.usage"));
      return;
    }

    const serverName = match[1];
    try {
      const login = await this.deps.startExternalMcpLogin(serverName);
      await this.reply(channel, chatId, joinText([
        login.reused ? t("mcp.loginWaiting", { server: serverName }) : t("mcp.loginStarted", { server: serverName }),
        raw(login.url),
        t("mcp.loginInstructions"),
      ]));
    } catch (err) {
      log.warn({ err, serverName }, "External MCP login command failed");
      await this.reply(channel, chatId, t("mcp.loginFailed", { error: shortErrorMessage(err) }));
    }
  }

  private scheduleRestart(): void {
    if (process.env.NODE_ENV === "test") return;
    setTimeout(() => {
      const cli = process.argv[1];
      if (!cli) {
        process.kill(process.pid, "SIGTERM");
        return;
      }
      const child = spawn(process.execPath, [cli, "restart"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }, 100);
  }

  private async restoreConfigAndRestart(channel: Channel, chatId: string, sessionKey: string): Promise<void> {
    const t = ownerT("commands");
    if (!existsSync(CONFIG_BACKUP_PATH)) {
      await this.reply(channel, chatId, t("restore.noBackup"));
      return;
    }

    try {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      // Under the shared config lock, and published atomically (temp file +
      // rename): `tomo config` or another daemon writer must never observe or
      // merge into a half-copied file, nor write over the restore.
      withConfigLockSync(CONFIG_PATH, () => {
        writeFileAtomicSync(CONFIG_PATH, readFileSync(CONFIG_BACKUP_PATH, "utf-8"), { mode: 0o600 });
      });

      const reason = "Restored ~/.tomo/config.json from ~/.tomo/config.json.bak";
      // Attribute the session that issued /restore so the post-restart notice
      // routes back to it.
      writeRestartReasonFile(RESTART_REASON_FILE, { reason, sessionKey });

      this.restoringConfig = true;
      await this.reply(channel, chatId, t("restore.done"));

      this.scheduleRestart();
    } catch (err) {
      log.warn({ err }, "/restore failed");
      await this.reply(channel, chatId, t("restore.failed", { error: shortErrorMessage(err) }));
    }
  }
}

function liveLabel(t: OwnerT<"commands">, live: MergedMcpStatus["live"]): OwnerText {
  switch (live) {
    case "connected": return t("mcp.live.connected");
    case "failed": return t("mcp.live.failed");
    case "needs-auth": return t("mcp.live.needsAuth");
    case "pending": return t("mcp.live.pending");
    case "disabled": return t("mcp.live.disabled");
    case "no-live-session": return t("mcp.live.noLiveSession");
    case "unknown": return t("mcp.live.unknown");
    case "not-reported": return t("mcp.live.notReported");
  }
}

function formatMergedMcpStatus(t: OwnerT<"commands">, row: MergedMcpStatus): OwnerText {
  const parts: OwnerText[] = [liveLabel(t, row.live)];
  if (row.oauth) {
    const expiry = row.oauth.expiresAt !== undefined ? formatDateTime(row.oauth.expiresAt) : undefined;
    if (row.oauth.state === "ready") parts.push(expiry ? t("mcp.tokenUntil", { at: expiry }) : t("mcp.tokenReady"));
    else if (row.oauth.state === "auth-pending") parts.push(t("mcp.signInPending"));
    else if (row.oauth.state === "auth-failed") parts.push(row.oauth.lastError ? t("mcp.authFailedDetail", { error: row.oauth.lastError }) : t("mcp.authFailed"));
    else parts.push(t("mcp.loginRequired"));
  } else if (row.configured) parts.push(t("mcp.noOAuth"));
  else parts.push(t("mcp.sessionProvided"));
  if (row.action === "login") parts.push(row.configured ? t("mcp.loginCommand", { name: row.name }) : t("mcp.signInRequired"));
  if (row.action === "reconnect") parts.push(t("mcp.reconnectCommand", { name: row.name }));
  return t("mcp.row", { name: row.name, parts: joinText(parts, " · ") });
}
