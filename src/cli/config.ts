import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { SessionStore } from "../sessions/store.js";

const TOMO_HOME = join(homedir(), ".tomo");
const CONFIG_PATH = join(TOMO_HOME, "config.json");
const SESSIONS_DIR = join(TOMO_HOME, "data", "sessions");

const MODELS: Record<string, string> = {
  "sonnet": "claude-sonnet-4-6",
  "sonnet-1m": "claude-sonnet-4-6[1m]",
  "opus": "claude-opus-4-6",
  "opus-1m": "claude-opus-4-6[1m]",
  "haiku": "claude-haiku-4-5",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6 (fast)",
  "claude-sonnet-4-6[1m]": "Sonnet 4.6 1M (fast, Max Plan only)",
  "claude-opus-4-6": "Opus 4.6 (most capable)",
  "claude-opus-4-6[1m]": "Opus 4.6 1M (most capable, Max Plan only)",
  "claude-haiku-4-5": "Haiku 4.5 (cheapest)",
};

// --- Config file helpers ---

function loadConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}

// --- Main menu ---

export const configCommand = new Command("config")
  .description("Interactive configuration")
  .action(async () => {
    p.intro("Tomo Configuration");

    if (!existsSync(CONFIG_PATH)) {
      p.log.error("No config found. Run `tomo init` first.");
      p.outro("");
      return;
    }

    for (;;) {
      const choice = await p.select({
        message: "What would you like to configure?",
        options: [
          { value: "model", label: "Model", hint: "set default model" },
          { value: "channels", label: "Channels", hint: "manage channel connections" },
          { value: "identities", label: "Identities", hint: "bind DMs across channels" },
          { value: "groups", label: "Group chats", hint: "activation secret" },
          { value: "sessions", label: "Sessions", hint: "view and configure sessions" },
          { value: "exit", label: "Exit" },
        ],
      });

      if (p.isCancel(choice) || choice === "exit") break;

      if (choice === "model") await configModel();
      if (choice === "channels") await configChannels();
      if (choice === "identities") await configIdentities();
      if (choice === "groups") await configGroups();
      if (choice === "sessions") await configSessions();
    }

    p.outro("Restart tomo for changes to take effect.");
  });

// --- Model ---

async function configModel(): Promise<void> {
  const cfg = loadConfig();
  const current = (cfg.model as string) ?? "claude-sonnet-4-6[1m]";
  p.log.info(`Current default: ${modelLabel(current)}`);

  const choice = await p.select({
    message: "Select default model",
    options: Object.entries(MODELS).map(([short, full]) => ({
      value: full,
      label: `${short} — ${modelLabel(full)}`,
      hint: full === current ? "current" : undefined,
    })),
  });

  if (p.isCancel(choice)) return;

  cfg.model = choice;
  saveConfig(cfg);
  p.log.success(`Default model set to ${modelLabel(choice as string)}`);
}

// --- Channels ---

async function configChannels(): Promise<void> {
  const cfg = loadConfig();
  const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;

  for (;;) {
    const options: Array<{ value: string; label: string; hint?: string }> = [];

    const tgToken = channels.telegram?.token as string | undefined;
    const tgAllow = (channels.telegram?.allowlist ?? []) as string[];
    options.push({
      value: "telegram",
      label: "Telegram",
      hint: tgToken ? `configured | ${tgAllow.length} allowed` : "not configured",
    });

    const imUrl = channels.imessage?.url as string | undefined;
    const imAllow = (channels.imessage?.allowlist ?? []) as string[];
    options.push({
      value: "imessage",
      label: "iMessage (BlueBubbles)",
      hint: imUrl ? `configured | ${imAllow.length} allowed` : "not configured",
    });

    options.push({ value: "back", label: "Back" });

    const choice = await p.select({ message: "Channels", options });
    if (p.isCancel(choice) || choice === "back") break;

    if (choice === "telegram") {
      const action = await p.select({
        message: "Telegram",
        options: [
          { value: "token", label: "Bot token", hint: tgToken ? `${(tgToken).slice(0, 8)}...` : "not set" },
          { value: "allowlist", label: "Allowlist", hint: `${tgAllow.length} user(s)` },
          { value: "back", label: "Back" },
        ],
      });
      if (p.isCancel(action) || action === "back") continue;

      if (action === "token") {
        const token = await p.text({
          message: "Telegram bot token",
          placeholder: "123456:ABC-DEF...",
          initialValue: (channels.telegram?.token as string) ?? "",
        });
        if (p.isCancel(token)) continue;
        if (!channels.telegram) channels.telegram = {};
        channels.telegram.token = (token as string).trim();
        cfg.channels = channels;
        saveConfig(cfg);
        p.log.success("Telegram token saved");
      }

      if (action === "allowlist") {
        await manageAllowlist(cfg, channels, "telegram");
      }
    }

    if (choice === "imessage") {
      const action = await p.select({
        message: "iMessage (BlueBubbles)",
        options: [
          { value: "connection", label: "Connection settings", hint: imUrl ?? "not set" },
          { value: "allowlist", label: "Allowlist", hint: `${imAllow.length} user(s)` },
          { value: "back", label: "Back" },
        ],
      });
      if (p.isCancel(action) || action === "back") continue;

      if (action === "connection") {
        const url = await p.text({
          message: "BlueBubbles server URL",
          placeholder: "http://localhost:1234",
          initialValue: (channels.imessage?.url as string) ?? "",
        });
        if (p.isCancel(url)) continue;

        const password = await p.text({
          message: "BlueBubbles password",
          initialValue: (channels.imessage?.password as string) ?? "",
        });
        if (p.isCancel(password)) continue;

        const port = await p.text({
          message: "Webhook port (tomo listens on this for incoming messages)",
          placeholder: "3100",
          initialValue: (channels.imessage?.webhookPort as string) ?? "3100",
        });
        if (p.isCancel(port)) continue;

        if (!channels.imessage) channels.imessage = {};
        channels.imessage.url = (url as string).trim();
        channels.imessage.password = (password as string).trim();
        channels.imessage.webhookPort = (port as string).trim();
        cfg.channels = channels;
        saveConfig(cfg);
        p.log.success("iMessage (BlueBubbles) saved");
      }

      if (action === "allowlist") {
        await manageAllowlist(cfg, channels, "imessage");
      }
    }
  }
}

// --- Group chats ---

async function configGroups(): Promise<void> {
  const cfg = loadConfig();
  const secret = cfg.groupSecret as string | null | undefined;

  if (!secret) {
    p.log.info("Group chat support is disabled (no secret configured).");
    const enable = await p.confirm({ message: "Enable group chat support?" });
    if (p.isCancel(enable) || !enable) return;

    const { randomBytes } = await import("node:crypto");
    const newSecret = `tomo-${randomBytes(4).toString("hex")}`;
    cfg.groupSecret = newSecret;
    saveConfig(cfg);
    p.log.success("Group chat enabled!");
    p.log.message([
      "Send this secret in any group chat to activate Tomo there:",
      "",
      `  ${newSecret}`,
      "",
      "Tomo will confirm and start listening in that group.",
    ].join("\n"));
    return;
  }

  p.log.message([
    "Group chat is enabled. Send this secret in a group to activate Tomo:",
    "",
    `  ${secret}`,
  ].join("\n"));

  const action = await p.select({
    message: "Group chat settings",
    options: [
      { value: "regenerate", label: "Regenerate secret" },
      { value: "disable", label: "Disable group chat" },
      { value: "back", label: "Back" },
    ],
  });
  if (p.isCancel(action) || action === "back") return;

  if (action === "regenerate") {
    const { randomBytes } = await import("node:crypto");
    const newSecret = `tomo-${randomBytes(4).toString("hex")}`;
    cfg.groupSecret = newSecret;
    saveConfig(cfg);
    p.log.success(`New secret: ${newSecret}`);
    p.log.warn("Existing groups stay active. New groups need the new secret.");
  }

  if (action === "disable") {
    const confirm = await p.confirm({ message: "Disable group chat? Existing activated groups will stop working." });
    if (p.isCancel(confirm) || !confirm) return;
    delete cfg.groupSecret;
    saveConfig(cfg);
    p.log.success("Group chat disabled");
  }
}

// --- Identities ---

async function configIdentities(): Promise<void> {
  const cfg = loadConfig();
  const identities = (cfg.identities ?? []) as Array<{
    name: string;
    channels: Record<string, string>;
    replyPolicy: string;
  }>;
  const channels = (cfg.channels ?? {}) as Record<string, Record<string, string>>;
  const configuredChannels = Object.keys(channels).filter((ch) => {
    if (ch === "telegram") return !!channels.telegram?.token;
    if (ch === "imessage") return !!channels.imessage?.url;
    return true;
  });

  for (;;) {
    const options: Array<{ value: string; label: string; hint?: string }> = [];

    for (let i = 0; i < identities.length; i++) {
      const id = identities[i];
      const bindings = Object.entries(id.channels).map(([ch, cid]) => `${ch}:${cid}`).join(", ");
      options.push({
        value: `edit:${i}`,
        label: id.name,
        hint: `${bindings} | reply: ${id.replyPolicy}`,
      });
    }

    options.push({ value: "add", label: "Add new identity" });
    options.push({ value: "back", label: "Back" });

    const choice = await p.select({ message: "Identities", options });
    if (p.isCancel(choice) || choice === "back") break;

    if (choice === "add") {
      const name = await p.text({
        message: "Identity name (e.g. your first name)",
        placeholder: "shuai",
      });
      if (p.isCancel(name)) continue;

      const identity: { name: string; channels: Record<string, string>; replyPolicy: string } = {
        name: (name as string).trim(),
        channels: {},
        replyPolicy: "last-active",
      };

      for (const ch of configuredChannels) {
        const chatId = await pickChatId(ch);
        if (chatId === null) break;
        if (chatId) identity.channels[ch] = chatId;
      }

      if (Object.keys(identity.channels).length === 0) {
        p.log.warn("No channels bound, skipping");
        continue;
      }

      const policy = await p.select({
        message: "Reply policy",
        options: [
          { value: "last-active", label: "Last active", hint: "reply on whichever channel you last used" },
          ...configuredChannels.map((ch) => ({ value: ch, label: `Always ${ch}` })),
        ],
      });
      if (p.isCancel(policy)) continue;
      identity.replyPolicy = policy as string;

      identities.push(identity);
      cfg.identities = identities;
      saveConfig(cfg);
      p.log.success(`Identity "${identity.name}" created`);
    }

    if (typeof choice === "string" && (choice as string).startsWith("edit:")) {
      const idx = Number((choice as string).slice(5));
      const id = identities[idx];

      const action = await p.select({
        message: `Identity: ${id.name}`,
        options: [
          { value: "bindings", label: "Edit channel bindings" },
          { value: "policy", label: "Change reply policy", hint: `current: ${id.replyPolicy}` },
          { value: "remove", label: "Remove identity" },
          { value: "back", label: "Back" },
        ],
      });
      if (p.isCancel(action) || action === "back") continue;

      if (action === "bindings") {
        for (const ch of configuredChannels) {
          const chatId = await pickChatId(ch, id.channels[ch]);
          if (chatId === null) break;
          if (chatId) {
            id.channels[ch] = chatId;
          } else {
            delete id.channels[ch];
          }
        }
        cfg.identities = identities;
        saveConfig(cfg);
        p.log.success("Bindings updated");
      }

      if (action === "policy") {
        const policy = await p.select({
          message: "Reply policy",
          options: [
            { value: "last-active", label: "Last active", hint: "reply on whichever channel you last used" },
            ...configuredChannels.map((ch) => ({
              value: ch,
              label: `Always ${ch}`,
              hint: ch === id.replyPolicy ? "current" : undefined,
            })),
          ],
        });
        if (p.isCancel(policy)) continue;
        id.replyPolicy = policy as string;
        cfg.identities = identities;
        saveConfig(cfg);
        p.log.success(`Reply policy set to "${policy}"`);
      }

      if (action === "remove") {
        const confirm = await p.confirm({ message: `Remove identity "${id.name}"?` });
        if (p.isCancel(confirm) || !confirm) continue;
        identities.splice(idx, 1);
        cfg.identities = identities;
        saveConfig(cfg);
        p.log.success(`Identity "${id.name}" removed`);
      }
    }
  }
}

// --- Sessions ---

async function configSessions(): Promise<void> {
  const store = new SessionStore(SESSIONS_DIR, 0);
  const entries = store.listAllSessions().filter((e) => e.unlinkedAt === null);
  const cfg = loadConfig();
  const overrides = (cfg.sessionModelOverrides ?? {}) as Record<string, string>;

  if (entries.length === 0) {
    p.log.info("No active sessions.");
    return;
  }

  for (;;) {
    const options: Array<{ value: string; label: string; hint?: string }> = entries.map((e) => {
      const model = overrides[e.channelKey];
      const hint = model ? `model: ${modelLabel(model)}` : `queries: ${e.stats?.totalQueries ?? 0}`;
      return { value: e.channelKey, label: e.channelKey, hint };
    });
    options.push({ value: "back", label: "Back" });

    const choice = await p.select({ message: "Sessions", options });
    if (p.isCancel(choice) || choice === "back") break;

    const key = choice as string;
    const entry = entries.find((e) => e.channelKey === key);
    if (!entry) continue;

    const currentModel = overrides[key];
    const s = entry.stats;
    const pct = s && s.contextMax > 0 ? Math.round((s.contextUsed / s.contextMax) * 100) : 0;

    p.log.info([
      `Session: ${key}`,
      `  SDK ID:   ${entry.sdkSessionId}`,
      `  Queries:  ${s?.totalQueries ?? 0}`,
      `  Cost:     $${(s?.totalCostUsd ?? 0).toFixed(4)}`,
      `  Context:  ${s?.contextUsed ?? 0}/${s?.contextMax ?? 0} (${pct}%)`,
      `  Model:    ${currentModel ? modelLabel(currentModel) : "(default)"}`,
    ].join("\n"));

    const action = await p.select({
      message: `Configure ${key}`,
      options: [
        { value: "model", label: "Set model override", hint: currentModel ? modelLabel(currentModel) : "using default" },
        { value: "clear-model", label: "Clear model override" },
        { value: "clear-session", label: "Clear session (start fresh)" },
        { value: "back", label: "Back" },
      ],
    });
    if (p.isCancel(action) || action === "back") continue;

    if (action === "model") {
      const model = await p.select({
        message: "Select model for this session",
        options: Object.entries(MODELS).map(([short, full]) => ({
          value: full,
          label: `${short} — ${modelLabel(full)}`,
          hint: full === currentModel ? "current" : undefined,
        })),
      });
      if (p.isCancel(model)) continue;
      overrides[key] = model as string;
      cfg.sessionModelOverrides = overrides;
      saveConfig(cfg);
      p.log.success(`Model for ${key} set to ${modelLabel(model as string)}`);
    }

    if (action === "clear-model") {
      delete overrides[key];
      cfg.sessionModelOverrides = overrides;
      saveConfig(cfg);
      p.log.success(`Model override cleared for ${key}`);
    }

    if (action === "clear-session") {
      const confirm = await p.confirm({ message: `Clear session "${key}"? This will start a new conversation.` });
      if (p.isCancel(confirm) || !confirm) continue;
      store.clearSdkSessionId(key);
      delete overrides[key];
      cfg.sessionModelOverrides = overrides;
      saveConfig(cfg);
      p.log.success(`Session "${key}" cleared`);
    }
  }
}

// --- Chat ID picker ---

/** Pick a chat ID for a channel — shows existing sessions as selectable options, with fallback to manual input. Returns null if cancelled, empty string to skip. */
// --- Allowlist management ---

async function manageAllowlist(
  cfg: Record<string, unknown>,
  channels: Record<string, Record<string, unknown>>,
  channelName: string,
): Promise<void> {
  if (!channels[channelName]) channels[channelName] = {};
  const ch = channels[channelName];
  const allowlist = ((ch.allowlist ?? []) as string[]).slice(); // working copy

  for (;;) {
    const options: Array<{ value: string; label: string; hint?: string }> = [];

    if (allowlist.length === 0) {
      p.log.warn("Allowlist is empty — no one can DM this channel (except identity-bound users).");
    } else {
      for (let i = 0; i < allowlist.length; i++) {
        options.push({ value: `remove:${i}`, label: allowlist[i], hint: "select to remove" });
      }
    }

    options.push({ value: "add", label: "Add user" });
    options.push({ value: "back", label: "Back" });

    const choice = await p.select({
      message: `Allowlist for ${channelName} (${allowlist.length} user${allowlist.length === 1 ? "" : "s"})`,
      options,
    });
    if (p.isCancel(choice) || choice === "back") break;

    if (choice === "add") {
      const placeholder = channelName === "telegram"
        ? "Telegram user ID (e.g. 123456789)"
        : "Chat GUID (e.g. iMessage;-;+15551234567)";
      const hint = channelName === "telegram"
        ? "Find your ID: message @userinfobot on Telegram"
        : "The chat GUID from BlueBubbles";

      p.log.info(hint);
      const id = await p.text({ message: "User/chat ID to allow", placeholder });
      if (p.isCancel(id)) continue;
      const val = (id as string).trim();
      if (val && !allowlist.includes(val)) {
        allowlist.push(val);
        ch.allowlist = allowlist;
        cfg.channels = channels;
        saveConfig(cfg);
        p.log.success(`Added ${val}`);
      }
    }

    if (typeof choice === "string" && (choice as string).startsWith("remove:")) {
      const idx = Number((choice as string).slice(7));
      const removed = allowlist.splice(idx, 1)[0];
      ch.allowlist = allowlist;
      cfg.channels = channels;
      saveConfig(cfg);
      p.log.success(`Removed ${removed}`);
    }
  }
}

// --- Chat ID picker ---

async function pickChatId(channelName: string, currentValue?: string): Promise<string | null> {
  const store = new SessionStore(SESSIONS_DIR, 20);
  const allSessions = store.listAllSessions().filter((e) => e.unlinkedAt === null);

  // Find sessions for this channel (non-group DMs)
  const prefix = `${channelName}:`;
  const channelSessions = allSessions.filter((e) => {
    if (!e.channelKey.startsWith(prefix)) return false;
    // Skip group sessions (contain ;+; for iMessage groups, or negative IDs for Telegram groups)
    const chatId = e.channelKey.slice(prefix.length);
    if (chatId.includes(";+;")) return false;
    if (chatId.startsWith("-")) return false;
    return true;
  });

  if (channelSessions.length === 0) {
    // No sessions — fall back to manual input
    const chatId = await p.text({
      message: `Chat ID for ${channelName}`,
      placeholder: channelName === "telegram" ? "e.g. 123456789" : "e.g. iMessage;-;+15551234567",
      initialValue: currentValue ?? "",
    });
    if (p.isCancel(chatId)) return null;
    return (chatId as string).trim();
  }

  // Build options from existing sessions with last message preview
  const options: Array<{ value: string; label: string; hint?: string }> = [];

  for (const entry of channelSessions) {
    const chatId = entry.channelKey.slice(prefix.length);
    const session = store.get(entry.channelKey);
    const lastMsg = [...session.messages].reverse().find((m) => m.role === "user");
    const preview = lastMsg
      ? `${lastMsg.senderName ?? "user"}: ${lastMsg.content.slice(0, 50)}${lastMsg.content.length > 50 ? "..." : ""}`
      : `${entry.stats?.totalQueries ?? 0} queries`;
    const isCurrent = chatId === currentValue;

    options.push({
      value: chatId,
      label: `${chatId}${isCurrent ? " (current)" : ""}`,
      hint: preview,
    });
  }

  options.push({ value: "__manual__", label: "Enter manually" });
  options.push({ value: "__skip__", label: "Skip" });

  const choice = await p.select({ message: `Chat ID for ${channelName}`, options });
  if (p.isCancel(choice)) return null;

  if (choice === "__skip__") return "";

  if (choice === "__manual__") {
    const chatId = await p.text({
      message: `Chat ID for ${channelName}`,
      placeholder: channelName === "telegram" ? "e.g. 123456789" : "e.g. iMessage;-;+15551234567",
      initialValue: currentValue ?? "",
    });
    if (p.isCancel(chatId)) return null;
    return (chatId as string).trim();
  }

  return choice as string;
}
