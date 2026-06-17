import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Channel } from "../channels/types.js";
import { config, CONFIG_BACKUP_PATH, CONFIG_PATH, RESTART_REASON_FILE } from "../config.js";
import { backupFileIfExistsSync, writeJsonAtomicSync } from "../fs-utils.js";
import type { IdentityRouter } from "../router.js";
import type { SessionStore } from "../sessions/index.js";
import { isGroupSessionKey } from "../sessions/keys.js";
import { MODEL_ALIASES, isLiteLlmProviderModel, modelHelpText, resolveModelName } from "../models.js";
import {
  CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
  CHATGPT_SUBSCRIPTION_MODE,
  isChatGptSubscriptionModel,
  liteLlmModeLabel,
} from "../litellm.js";
import { log } from "../logger.js";
import { PetStore } from "../mcp/pet-store.js";

/** Back up ~/.tomo/config.json before a programmatic rewrite. */
export function backupConfigFile(): void {
  mkdirSync(dirname(CONFIG_BACKUP_PATH), { recursive: true });
  backupFileIfExistsSync(CONFIG_PATH, CONFIG_BACKUP_PATH);
}

export interface ChatCommandDeps {
  router: IdentityRouter;
  sessions: SessionStore;
  /** Shared with the Agent — per-session model overrides read at session create time. */
  modelOverrides: Map<string, string>;
  closeLiveSession(key: string): void;
  isSessionLive(key: string): boolean;
  queuePendingNote(sessionKey: string, note: string): void;
}

/**
 * Handles slash commands typed in chat (/new, /model, /status, /pet, /restore).
 * Wired to Channel.onCommand by the Agent.
 */
export class ChatCommandHandler {
  private restoringConfig = false;

  constructor(private readonly deps: ChatCommandDeps) {}

  /** True once /restore has begun — the Agent drops inbound messages until restart. */
  get isRestoring(): boolean {
    return this.restoringConfig;
  }

  async handle(channel: Channel, command: string, chatId: string, senderName: string, args?: string, senderId?: string): Promise<void> {
    const { sessionKey: key } = this.deps.router.resolve(channel.name, chatId, false);

    if (this.restoringConfig) {
      await channel.send({ chatId, text: "Restore is already in progress. Restarting Tomo..." });
      return;
    }

    if (command === "summon" || command === "dismiss") {
      await this.handleSummonCommand(channel, command, chatId, senderName, senderId);
      return;
    }

    if (command === "new") {
      this.deps.closeLiveSession(key);
      this.deps.sessions.clearSdkSessionId(key);
      log.info({ channel: channel.name, chatId, sender: senderName }, "New session started via /new");
      await channel.send({ chatId, text: "New session started." });
      return;
    }

    if (command === "model") {
      const arg = args?.trim();
      if (!arg) {
        const current = this.deps.modelOverrides.get(key) ?? config.model;
        const lines = [`Current: ${current}`, "", "Switch with: /model <name>", ""];
        for (const [shortName, fullName] of Object.entries(MODEL_ALIASES)) {
          const marker = fullName === current ? " (active)" : "";
          lines.push(`  ${shortName} — ${fullName}${marker}`);
        }
        if (config.litellm?.baseUrl) {
          lines.push("");
          lines.push(`LiteLLM gateway models are also accepted, e.g. ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}`);
        }
        await channel.send({ chatId, text: lines.join("\n") });
        return;
      }

      const resolved = resolveModelName(arg);
      if (!resolved) {
        await channel.send({ chatId, text: `Unknown model "${arg}". Use ${modelHelpText()}.` });
        return;
      }
      if (isLiteLlmProviderModel(resolved)) {
        if (!config.litellm?.baseUrl) {
          await channel.send({
            chatId,
            text: `"${resolved}" needs a LiteLLM gateway. Run \`tomo config\` → LiteLLM gateway to set one up first.`,
          });
          return;
        }
        if (config.litellm.mode === CHATGPT_SUBSCRIPTION_MODE && !isChatGptSubscriptionModel(resolved)) {
          await channel.send({
            chatId,
            text: `The configured ChatGPT subscription gateway only routes chatgpt/* models, e.g. ${CHATGPT_SUBSCRIPTION_DEFAULT_MODEL}.`,
          });
          return;
        }
      }
      this.deps.modelOverrides.set(key, resolved);
      this.persistModelOverride(key, resolved);
      // Model changes require a fresh SDK child process, but keep the SDK
      // session ID so continuity survives switching between Claude and LiteLLM.
      // getOrCreateLiveSession repairs provider-specific JSONL quirks before
      // resuming.
      this.deps.closeLiveSession(key);
      log.info({ channel: channel.name, chatId, model: resolved }, "Model switched via /model");
      await channel.send({ chatId, text: `Switched to ${resolved}` });
      return;
    }

    if (command === "restore") {
      await this.restoreConfigAndRestart(channel, chatId);
      return;
    }

    if (command === "pet") {
      const store = new PetStore(join(config.tomoHome, "data", "pet.json"));
      let pet = store.load();
      if (!pet) {
        await channel.send({ chatId, text: "Tomo doesn't have a pet yet. Ask Tomo to hatch one!" });
        return;
      }

      pet = store.tick(pet);
      store.save(pet);

      const ageDays = Math.max(0, Math.floor(
        (Date.now() - new Date(pet.born_at).getTime()) / (24 * 60 * 60 * 1000),
      ));
      const dayLabel = ageDays === 1 ? "day" : "days";
      const lines = [
        `🐾 ${pet.name} the ${pet.species}`,
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

    if (command === "status") {
      const model = this.deps.modelOverrides.get(key) ?? config.model;
      const session = this.deps.sessions.get(key);
      const entry = this.deps.sessions.getEntry(key);

      const lines: string[] = [];
      lines.push(`Session: ${key}`);
      lines.push(`Channel: ${channel.name}`);
      const summoned = this.deps.router.getSummonedIdentity(channel.name, chatId);
      if (summoned) lines.push(`Summoned: messages route to dm:${summoned} (/dismiss to hand back)`);
      lines.push(`Model: ${model}`);
      if (config.litellm?.baseUrl) {
        lines.push(`Gateway: LiteLLM (${liteLlmModeLabel(config.litellm.mode)})`);
      }
      lines.push(`Live: ${this.deps.isSessionLive(key) ? "yes" : "no"}`);

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
      await channel.send({ chatId, text: `/${command} only works in group chats.` });
      return;
    }
    if (!this.deps.router.isAllowed(channel.name, chatId)) {
      log.debug({ channel: channel.name, chatId }, `/${command} blocked (group not in allowlist)`);
      return;
    }

    const groupLabel = this.deps.sessions.getEntry(rawKey)?.chatTitle ?? rawKey;

    if (command === "dismiss") {
      const summoned = this.deps.router.getSummonedIdentity(channel.name, chatId);
      if (!summoned) {
        await channel.send({ chatId, text: "No main session is summoned here." });
        return;
      }
      this.deps.router.dismissGroup(channel.name, chatId);
      this.deps.queuePendingNote(
        `dm:${summoned}`,
        `[System: You have been dismissed from the group "${groupLabel}" — its messages no longer reach this session, and the group's own Tomo session has taken back over.]`,
      );
      await channel.send({ chatId, text: "Handed back to this group's own Tomo session." });
      return;
    }

    const identity = senderId ? this.deps.router.identityForSender(channel.name, senderId) : undefined;
    if (!identity) {
      log.info({ channel: channel.name, chatId, sender: senderName }, "/summon refused (sender is not a configured identity)");
      await channel.send({ chatId, text: "Only the owner of a configured identity can summon their main session." });
      return;
    }

    const already = this.deps.router.getSummonedIdentity(channel.name, chatId);
    if (already) {
      await channel.send({ chatId, text: `Main session dm:${already} is already summoned here. /dismiss first to hand back.` });
      return;
    }

    this.deps.router.summonGroup(channel.name, chatId, identity.name);
    const expiryNote = config.summonExpiryMinutes > 0
      ? ` or after ${config.summonExpiryMinutes} minutes of group inactivity`
      : "";
    this.deps.queuePendingNote(
      `dm:${identity.name.toLowerCase()}`,
      `[System: ${identity.name} summoned you into the group chat "${groupLabel}" (${rawKey}). Until dismissed${expiryNote}, messages from that group arrive in this session tagged [group ...] with the sender's name. To reply in the group, call send_message with mode "direct" and target "${rawKey}" — compose the reply yourself, with your context. Plain text you output goes to ${identity.name}'s private DM, not the group. Everyone in the group can read what you send it — keep private memory and DM context out of group-facing messages.]`,
    );
    log.info({ channel: channel.name, chatId, identity: identity.name, sender: senderName }, "Group summoned via /summon");
    await channel.send({
      chatId,
      text: `${identity.name}'s main Tomo session is now handling this group. /dismiss hands back to the group's own session${expiryNote ? `; it also hands back automatically after ${config.summonExpiryMinutes}m of inactivity` : ""}.`,
    });
  }

  private persistModelOverride(key: string, model: string): void {
    config.sessionModelOverrides[key] = model;

    const cfg = existsSync(CONFIG_PATH)
      ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>
      : {};
    const overrides = (cfg.sessionModelOverrides ?? {}) as Record<string, string>;
    overrides[key] = model;
    cfg.sessionModelOverrides = overrides;

    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    backupConfigFile();
    writeJsonAtomicSync(CONFIG_PATH, cfg);
  }

  private async restoreConfigAndRestart(channel: Channel, chatId: string): Promise<void> {
    if (!existsSync(CONFIG_BACKUP_PATH)) {
      await channel.send({ chatId, text: "No config backup found at ~/.tomo/config.json.bak." });
      return;
    }

    try {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      copyFileSync(CONFIG_BACKUP_PATH, CONFIG_PATH);

      const reason = "Restored ~/.tomo/config.json from ~/.tomo/config.json.bak";
      mkdirSync(dirname(RESTART_REASON_FILE), { recursive: true });
      writeFileSync(RESTART_REASON_FILE, reason, "utf-8");

      this.restoringConfig = true;
      await channel.send({ chatId, text: "Restored config.json from config.json.bak. Restarting Tomo..." });

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
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await channel.send({ chatId, text: `[error] restore failed: ${detail}` });
    }
  }
}
