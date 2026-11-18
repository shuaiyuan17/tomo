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
import { DEFAULT_MODEL, MODEL_ALIASES, modelHelpText } from "../models.js";
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
import type { ExternalMcpServerStatus, McpLoginStart } from "../mcp/oauth.js";
import { ClaudeLoginManager } from "./claude-login.js";
import { buildUsageReport } from "./usage.js";
import { limitsLogFor } from "../usage/limits-log.js";
import { litellmRoutesModel } from "../litellm.js";
import { TASKS_COMMAND } from "../channels/chat-commands.js";
import type { SessionTaskList } from "../web/tasks.js";
import { formatTaskList, startOfLocalDay } from "./tasks-command.js";
import { parseTodoArgs, runTodoCommand, TODO_USAGE } from "./todo-command.js";
import { TodoStore } from "../todos/store.js";

/** Back up ~/.tomo/config.json before a programmatic rewrite. */
export { backupConfigFile } from "./model-switch.js";

/** The chat reply for a refused /model switch (texts unchanged since before the shared switch). */
function modelRefusalText(reason: ModelSwitchRefusal, arg: string, resolved: string): string {
  switch (reason) {
    case "unknown_model": return `⚠️ Unknown model "${arg}". Use ${modelHelpText()}.`;
    case "gateway_required": return `⚠️ "${resolved}" needs a LiteLLM gateway. Run \`tomo config\` → LiteLLM gateway to set one up first.`;
    case "gateway_unroutable": return `⚠️ The configured ChatGPT subscription gateway only routes chatgpt/* models, e.g. ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}.`;
    case "persist_failed": return "⚠️ [error] Could not save the model override to ~/.tomo/config.json — model unchanged. Check the file (or /restore) and try again.";
    // Only reachable with options /model does not pass.
    case "turn_in_flight": return "⚠️ A reply is still running; try again once it has finished.";
    case "model_changed": return "⚠️ The model changed meanwhile; check /model and try again.";
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
  /** One session's tasks from the web Tasks panel's board (`TaskBoard.listFor`);
   *  undefined when there is no board (web UI off). */
  listTasks(sessionKey: string, since: number): SessionTaskList | undefined;
  /** Send plain text to the owner's private DM (its reply target); false when there is none. */
  sendToOwnerDm(owner: OwnerConfig, text: string): Promise<boolean>;
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

  async handle(channel: Channel, command: string, chatId: string, senderName: string, args?: string, senderId?: string): Promise<void> {
    // Commands obey the same channel allowlist as inbound messages
    // (Agent.enqueueMessage): check channel+chatId BEFORE resolving, so a
    // disallowed chat can't touch routing state, and drop silently — the
    // message path never replies to chats outside the allowlist.
    if (!this.deps.router.isAllowed(channel.name, chatId)) {
      log.debug({ channel: channel.name, chat: redactChatIdForLog(chatId), command }, "Command blocked at receipt (not in allowlist)");
      return;
    }

    if (this.restoringConfig) {
      await channel.send({ chatId, text: "♻️ Restore is already in progress. Restarting Tomo..." });
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
        await channel.send({ chatId, text: "⚠️ /rewind is only available in an owner's private DM." });
        return;
      }
      const arg = args?.trim() || "1";
      if (!/^[1-9]\d*$/.test(arg) || !Number.isSafeInteger(Number(arg))) {
        await channel.send({ chatId, text: "Usage: /rewind or /rewind <positive integer>" });
        return;
      }
      let rewound: { count: number; preview: string; stoppedTurn?: boolean; droppedMessages?: number; nothingToRewind?: boolean };
      try {
        rewound = await this.deps.rewindSession(dmSessionKeyForIdentity(identity.name), Number(arg));
      } catch (err) {
        log.warn({ err }, "Session rewind failed");
        await channel.send({ chatId, text: `⚠️ Could not rewind: ${shortErrorMessage(err)}` });
        return;
      }
      const dropped = rewound.droppedMessages
        ? ` ${rewound.droppedMessages} message(s) you sent while it ran went with it; resend them if still needed.`
        : "";
      if (rewound.nothingToRewind) {
        await channel.send({ chatId, text: `⏹️ Stopped the turn that was still running; it will send nothing more.${dropped} This conversation had no earlier history to rewind to, so nothing was rewound. Send your request again to continue.` });
        return;
      }
      const target = rewound.preview ? ` ("${rewound.preview}")` : "";
      const moved = rewound.count > Number(arg)
        ? ` That is further back than the ${arg} you asked for: the later message arrived during a tool call, so it went back to the end of the previous complete turn.`
        : "";
      const stopped = rewound.stoppedTurn
        ? ` The turn that was still running was stopped first and will send nothing more.${dropped}`
        : "";
      await channel.send({ chatId, text: `↩️ Context rewound to before the last ${rewound.count} user message(s)${target}.${moved}${stopped} Send an edited request to continue. Chat history is kept; completed actions and file changes are not undone.` });
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
      await channel.send({ chatId, text: "🆕 New session started." });
      return;
    }

    if (command === "model") {
      if (!this.isOwner(channel, senderId)) {
        log.info({ channel: channel.name, chatId, sender: senderName }, "/model refused (sender is not the owner)");
        await channel.send({ chatId, text: !config.owner
          ? "⚠️ No owner is configured, so /model is locked. On the machine running Tomo, run `tomo config` and set yourself as the owner (bind your handle on this channel), then try again."
          : "⚠️ Only the owner can change the model." });
        return;
      }
      const arg = args?.trim();
      if (!arg) {
        const current = this.deps.modelOverrides.get(key) ?? config.model;
        const lines = [`🧠 Current: ${current}`, "", "Switch with: /model <name>", ""];
        for (const [shortName, fullName] of Object.entries(MODEL_ALIASES)) {
          const marker = fullName === current ? " (active)" : "";
          lines.push(`  ${shortName} — ${fullName}${marker}`);
        }
        if (config.litellm?.baseUrl) {
          lines.push("");
          lines.push(`LiteLLM gateway models are also accepted, e.g. ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}`);
        }
        lines.push("");
        lines.push(`You can also pass any direct model ID, e.g. ${DEFAULT_MODEL}.`);
        await channel.send({ chatId, text: lines.join("\n") });
        return;
      }

      // No turn-in-flight check here: /model has always switched at once.
      const outcome = switchSessionModel({ modelOverrides: this.deps.modelOverrides,
        closeLiveSession: (sessionKey) => this.deps.closeLiveSession(sessionKey) }, key, arg);
      if (!outcome.ok) {
        await channel.send({ chatId, text: modelRefusalText(outcome.reason, arg, outcome.model ?? arg) });
        return;
      }
      const resolved = outcome.model;
      log.info({ channel: channel.name, chatId, model: resolved }, "Model switched via /model");
      await channel.send({ chatId, text: `🔄 Switched to ${resolved}` });
      return;
    }

    if (command === "restore") {
      if (!this.isOwner(channel, senderId)) {
        log.info({ channel: channel.name, chatId, sender: senderName }, "/restore refused (sender is not the owner)");
        await channel.send({ chatId, text: !config.owner
          ? "⚠️ No owner is configured, so /restore is locked. On the machine running Tomo, run `tomo config` and set yourself as the owner (bind your handle on this channel), then try again."
          : "⚠️ Only the owner can restore config." });
        return;
      }
      await this.restoreConfigAndRestart(channel, chatId, key);
      return;
    }

    if (command === "pet") {
      const store = new PetStore(join(config.tomoHome, "data", "pet.json"));
      let pet = store.load();
      if (!pet) {
        await channel.send({ chatId, text: "🦀 Tomo doesn't have a pet yet. Ask Tomo to hatch one!" });
        return;
      }

      pet = store.tick(pet);
      store.save(pet);

      const ageDays = Math.max(0, Math.floor(
        (Date.now() - new Date(pet.born_at).getTime()) / (24 * 60 * 60 * 1000),
      ));
      const dayLabel = ageDays === 1 ? "day" : "days";
      const lines = [
        `🦀 ${pet.name} the ${pet.species}`,
        `Stage: ${pet.stage} · Age: ${ageDays} ${dayLabel} · Mood: ${store.computeMood(pet)}`,
        `Hunger: ${Math.round(pet.hunger)}/100 · Happiness: ${Math.round(pet.happiness)}/100`,
        `Energy: ${Math.round(pet.energy)}/100 · Health: ${Math.round(pet.health)}/100`,
        `Bond: ${store.effectiveAffection(pet)} · Care mistakes: ${pet.care_mistakes}`,
      ];

      if (pet.sleeping && pet.sleep_until) {
        lines.push(`Sleeping until: ${new Date(pet.sleep_until).toLocaleString()}`);
      } else if (pet.recovering) {
        lines.push("Recovering: yes");
      }

      await channel.send({ chatId, text: lines.join("\n") });
      return;
    }

    if (command === "cost") {
      const logPath = join(config.logsDir, "tomo.log");
      await channel.send({ chatId, text: `💰 ${buildSessionCostReport(key, { logPath })}` });
      return;
    }

    if (command === "usage") {
      // /usage exposes account-wide plan + utilization + scoped caps, so gate it
      // EXACTLY like /login: owner's private DM only, and — unlike /model and
      // /restore — it never falls open when no identities exist (channels
      // default to open, so a bare DM must not read the owner's subscription
      // state). A group is shared, so any member is refused regardless.
      if (isGroupSessionKey(`${channel.name}:${chatId}`)) {
        await channel.send({ chatId, text: "⚠️ /usage is only available in an owner's private DM." });
        return;
      }
      const usageIdentity = this.ownerFor(channel, senderId);
      if (!usageIdentity) {
        log.info({ channel: channel.name, chatId, sender: senderName }, "/usage refused (sender is not the owner)");
        const text = !config.owner
          ? "⚠️ No owner is configured, so /usage is locked. On the machine running Tomo, run `tomo config` and set yourself as the owner (bind your handle on this channel), then try /usage again."
          : "⚠️ Only the owner can view usage.";
        await channel.send({ chatId, text });
        return;
      }
      // Classify gateway routing the same way the SDK does — from the session's
      // effective model, not merely "is a gateway configured".
      const effectiveModel = this.deps.modelOverrides.get(key) ?? config.model;
      await channel.send({
        chatId,
        text: await buildUsageReport({
          authMethod: config.auth.method,
          gatewayActive: litellmRoutesModel(config.litellm, effectiveModel),
          onData: (data) => { void limitsLogFor(config.tomoHome).recordOAuthUsage(data); },
        }),
      });
      return;
    }

    if (command === "status") {
      const model = this.deps.modelOverrides.get(key) ?? config.model;
      const session = this.deps.sessions.get(key);
      const entry = this.deps.sessions.getEntry(key);

      const lines: string[] = [];
      lines.push("📋 Status");
      lines.push("");
      lines.push(`Session: ${key}`);
      lines.push(`Channel: ${channel.name}`);
      const summoned = this.deps.router.getSummonedIdentity(channel.name, chatId);
      if (summoned) lines.push(`Summoned: messages route to dm:${summoned} (/dismiss to hand back)`);
      if (this.deps.pauses.isPaused(`${channel.name}:${chatId}`)) {
        lines.push("Paused: yes — group messages are being ignored (/resume to lift)");
      }
      lines.push(`Model: ${model}`);
      if (config.litellm?.baseUrl) {
        lines.push(`Gateway: LiteLLM (${liteLlmModeLabel(config.litellm.mode)})`);
      }
      lines.push(`Live: ${this.deps.isSessionLive(key) ? "yes" : "no"}`);

      // Count from the transcript file, not session.messages — the in-memory
      // session holds only the recent tail.
      const msgCount = this.deps.sessions.countRecentUserMessages(key);
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
    const arg = args?.trim().toLowerCase() ?? "";
    if (arg !== "" && arg !== "all") {
      await channel.send({ chatId, text: "Usage: /tasks or /tasks all" });
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
      await channel.send({ chatId, text: "Tasks are unavailable: /tasks reads the web UI's Tasks panel, and the web UI is off." });
      return;
    }
    const text = formatTaskList(list, { now, all: arg === "all" });
    if (ownerDm) {
      let sent = false;
      try { sent = await this.deps.sendToOwnerDm(ownerDm, text); } catch (err) {
        log.warn({ err }, "/tasks: could not send the list to the owner's DM");
      }
      await channel.send({ chatId, text: sent ? "Sent to your DM." : "Couldn't reach your DM." });
      return;
    }
    await channel.send({ chatId, text });
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
    const parsed = parseTodoArgs(args);
    if (!parsed) {
      await channel.send({ chatId, text: TODO_USAGE });
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
        await channel.send({ chatId, text: "Only the owner can change todos." });
        return;
      }
    }
    let text: string;
    try {
      const store = this.deps.todoStore?.() ?? new TodoStore();
      text = runTodoCommand(parsed, { store, scopeKey: key, now: Date.now() });
    } catch (err) {
      log.warn({ err }, "/todo failed");
      text = `Todos are unavailable: ${shortErrorMessage(err)}`;
    }
    if (ownerDm) {
      let sent = false;
      try { sent = await this.deps.sendToOwnerDm(ownerDm, text); } catch (err) {
        log.warn({ err }, "/todo: could not send the reply to the owner's DM");
      }
      await channel.send({ chatId, text: sent ? "Sent to your DM." : "Couldn't reach your DM." });
      return;
    }
    await channel.send({ chatId, text });
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
    const rawKey = `${channel.name}:${chatId}`;
    if (!isGroupSessionKey(rawKey)) {
      await channel.send({ chatId, text: `⚠️ /${command} only works in group chats.` });
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
        await channel.send({ chatId, text: "⚠️ No main session is summoned here." });
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
      await channel.send({ chatId, text: "👋 Handed back to this group's own Tomo session." });
      return;
    }

    const identity = this.ownerFor(channel, senderId);
    if (!identity) {
      log.info({ channel: channel.name, chatId, sender: senderName }, "/summon refused (sender is not the owner)");
      await channel.send({ chatId, text: "⚠️ Only the owner can summon the main session." });
      return;
    }

    const already = this.deps.router.getSummonedIdentity(channel.name, chatId);
    if (already) {
      await channel.send({ chatId, text: `⚠️ Main session dm:${already} is already summoned here. /dismiss first to hand back.` });
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
    await channel.send({
      chatId,
      text: `📞 ${ownerDisplayName(identity)}'s main Tomo session is now handling this group. /dismiss hands back to the group's own session${expiryNote ? `; it also hands back automatically after ${config.summonExpiryMinutes}m of inactivity` : ""}.`,
    });
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
    const rawKey = `${channel.name}:${chatId}`;
    if (!isGroupSessionKey(rawKey)) {
      await channel.send({ chatId, text: `⚠️ /${command} only works in group chats.` });
      return;
    }

    if (command === "pause") {
      if (this.deps.pauses.isPaused(rawKey)) {
        await channel.send({ chatId, text: "⚠️ Tomo is already paused here. Send /resume to bring it back." });
        return;
      }
      this.deps.pauses.pause(rawKey, senderName);
      log.info({ channel: channel.name, chatId, sender: senderName }, "Group paused via /pause");
      await channel.send({
        chatId,
        text: "⏸️ Tomo is paused in this group. Messages sent here will be completely ignored (not read, not remembered) until someone sends /resume.",
      });
      return;
    }

    if (!this.deps.pauses.resume(rawKey)) {
      await channel.send({ chatId, text: "⚠️ Tomo isn't paused in this group." });
      return;
    }
    log.info({ channel: channel.name, chatId, sender: senderName }, "Group resumed via /resume");
    await channel.send({
      chatId,
      text: "▶️ Tomo is back. Messages sent while paused were ignored; new messages will be handled normally.",
    });
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
    const rawKey = `${channel.name}:${chatId}`;
    if (isGroupSessionKey(rawKey)) {
      await channel.send({ chatId, text: "⚠️ /login is only available in an owner's private DM." });
      return;
    }

    const identity = this.ownerFor(channel, senderId);
    if (!identity) {
      log.warn({ channel: channel.name, chatId }, "/login refused (sender is not the owner)");
      // /login mutates Claude credentials, so unlike /model and /restore it
      // never falls open when no identities exist — instead point the user at
      // the setup path.
      const text = !config.owner
        ? "⚠️ No owner is configured, so /login is locked. On the machine running Tomo, run `tomo config` and set yourself as the owner (bind your handle on this channel), then try /login again."
        : "⚠️ Only the owner can refresh Claude login.";
      await channel.send({ chatId, text });
      return;
    }

    const arg = args?.trim() ?? "";
    if (arg.toLowerCase() === "cancel") {
      const cancelled = this.claudeLogin.cancel(identity.name);
      await channel.send({
        chatId,
        text: cancelled ? "🔑 Claude login cancelled." : "⚠️ No Claude login is currently waiting.",
      });
      return;
    }

    try {
      if (!arg) {
        const { url, reused } = await this.claudeLogin.start(identity.name);
        await channel.send({
          chatId,
          text: [
            reused ? "🔑 Claude login is already waiting." : "🔑 Claude login started.",
            "",
            url,
            "",
            "Authorize in your browser, then send the returned code here as:",
            "/login <code>",
            "",
            "The request expires after 10 minutes. Use /login cancel to abort it.",
          ].join("\n"),
        });
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
      await channel.send({
        chatId,
        text: completion.verified
          ? "Claude login verified. Restarting Tomo..."
          : [
            "[warning] Claude credentials were saved, but the verification probe failed. Restarting Tomo...",
            completion.verificationError ? `\n${completion.verificationError}` : "",
          ].join(""),
      });
      this.scheduleRestart();
    } catch (err) {
      const detail = shortErrorMessage(err);
      log.warn({ err, identity: identity.name }, "Claude login command failed");
      await channel.send({ chatId, text: `⚠️ [error] Claude login failed: ${detail}` });
    }
  }

  private async handleExternalMcpCommand(
    channel: Channel,
    chatId: string,
    senderId?: string,
    args?: string,
  ): Promise<void> {
    const rawKey = `${channel.name}:${chatId}`;
    if (isGroupSessionKey(rawKey)) {
      await channel.send({ chatId, text: "⚠️ /mcp is only available in an owner's private DM." });
      return;
    }

    const identity = this.ownerFor(channel, senderId);
    if (!identity) {
      log.warn({ channel: channel.name, chatId }, "/mcp refused (sender is not the owner)");
      const text = !config.owner
        ? "⚠️ No owner is configured, so /mcp is locked. On the machine running Tomo, run `tomo config` and set yourself as the owner (bind your handle on this channel), then try /mcp again."
        : "⚠️ Only the owner can inspect or re-authenticate external MCP servers.";
      await channel.send({ chatId, text });
      return;
    }

    const arg = args?.trim() ?? "";
    if (!arg) {
      const sessionKey = dmSessionKeyForIdentity(identity.name);
      const statuses = this.deps.getExternalMcpStatuses(sessionKey);
      if (statuses.length === 0) {
        await channel.send({ chatId, text: "🔌 No external MCP servers are configured." });
        return;
      }
      await channel.send({
        chatId,
        text: ["🔌 External MCP servers", "", ...statuses.map(formatExternalMcpStatus)].join("\n"),
      });
      return;
    }

    const match = /^login\s+(\S+)$/i.exec(arg);
    if (!match) {
      await channel.send({ chatId, text: "⚠️ Usage: /mcp or /mcp login <server>" });
      return;
    }

    const serverName = match[1];
    try {
      const login = await this.deps.startExternalMcpLogin(serverName);
      await channel.send({
        chatId,
        text: [
          login.reused ? `🔑 MCP login for "${serverName}" is already waiting.` : `🔑 MCP login started for "${serverName}".`,
          "",
          login.url,
          "",
          "Complete authorization in your browser, then paste the full localhost redirect URL back into this private DM.",
          "The request expires after 10 minutes. Tomo will attach the server to live sessions after login; if runtime hot-mounting is unavailable, the next session will use it.",
        ].join("\n"),
      });
    } catch (err) {
      log.warn({ err, serverName }, "External MCP login command failed");
      await channel.send({ chatId, text: `⚠️ [error] MCP login failed: ${shortErrorMessage(err)}` });
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
    if (!existsSync(CONFIG_BACKUP_PATH)) {
      await channel.send({ chatId, text: "⚠️ No config backup found at ~/.tomo/config.json.bak." });
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
      await channel.send({ chatId, text: "♻️ Restored config.json from config.json.bak. Restarting Tomo..." });

      this.scheduleRestart();
    } catch (err) {
      log.warn({ err }, "/restore failed");
      await channel.send({ chatId, text: `⚠️ [error] restore failed: ${shortErrorMessage(err)}` });
    }
  }
}

function formatExternalMcpStatus(status: ExternalMcpServerStatus): string {
  const expiry = status.expiresAt !== undefined ? new Date(status.expiresAt).toLocaleString() : undefined;
  const lastError = status.lastError ? ` · last error: ${status.lastError}` : "";
  if (status.state === "auth-pending") {
    return `• ${status.name} — auth pending since ${new Date(status.startedAt ?? Date.now()).toLocaleString()}`;
  }
  if (status.state === "auth-failed") {
    const when = status.lastErrorAt !== undefined ? ` at ${new Date(status.lastErrorAt).toLocaleString()}` : "";
    return `• ${status.name} — auth failed${when}: ${status.lastError ?? "login required"}`;
  }
  if (status.state === "connected") {
    const token = status.oauth ? (expiry ? ` · token valid until ${expiry}` : " · OAuth token has no expiry") : " · no OAuth";
    return `• ${status.name} — connected${token}${lastError}`;
  }
  if (status.authRequired) {
    return `• ${status.name} — not mounted · login required (/mcp login ${status.name})${lastError}`;
  }
  const token = status.oauth ? (expiry ? ` · token valid until ${expiry}` : " · OAuth token ready") : "";
  return `• ${status.name} — not mounted in this session${token}${lastError}`;
}
