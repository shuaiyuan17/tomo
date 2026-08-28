import * as p from "@clack/prompts";
import { loadConfig, saveConfig } from "./shared.js";

export async function configChannels(): Promise<void> {
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

    // `channels.imessage.provider` is a single-valued opt-in: "imsg" enables
    // the channel, absent leaves it off. It stays a named provider rather than
    // a boolean so existing config files need no migration.
    const imEnabled = channels.imessage?.provider === "imsg";
    const imAllow = (channels.imessage?.allowlist ?? []) as string[];
    options.push({
      value: "imessage",
      label: "iMessage",
      hint: imEnabled ? `imsg | ${imAllow.length} allowed` : "not configured",
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
        message: "iMessage",
        options: [
          {
            value: "toggle",
            label: imEnabled ? "Disable iMessage" : "Enable iMessage",
            hint: imEnabled ? "provider: imsg" : "imsg CLI — needs Full Disk Access",
          },
          { value: "imsg", label: "imsg CLI settings", hint: (channels.imessage?.cliPath as string) ?? "imsg (PATH)" },
          { value: "allowlist", label: "Allowlist", hint: `${imAllow.length} user(s)` },
          { value: "back", label: "Back" },
        ],
      });
      if (p.isCancel(action) || action === "back") continue;

      // One backend, so this is a toggle rather than a picker: writing the
      // provider key enables the channel, removing it turns iMessage off.
      if (action === "toggle") {
        if (!channels.imessage) channels.imessage = {};
        if (imEnabled) delete channels.imessage.provider;
        else channels.imessage.provider = "imsg";
        cfg.channels = channels;
        saveConfig(cfg);
        p.log.success(imEnabled
          ? "iMessage disabled"
          : "iMessage enabled (imsg CLI — Tomo needs Full Disk Access)");
      }

      if (action === "imsg") {
        const cliPath = await p.text({
          message: "imsg binary path (empty = resolve \"imsg\" from PATH)",
          placeholder: "/opt/homebrew/bin/imsg",
          initialValue: (channels.imessage?.cliPath as string) ?? "",
        });
        if (p.isCancel(cliPath)) continue;
        if (!channels.imessage) channels.imessage = {};
        const trimmed = (cliPath as string).trim();
        if (trimmed) channels.imessage.cliPath = trimmed;
        else delete channels.imessage.cliPath;
        cfg.channels = channels;
        saveConfig(cfg);
        p.log.success("imsg CLI settings saved");
      }

      if (action === "allowlist") {
        await manageAllowlist(cfg, channels, "imessage");
      }
    }
  }
}

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
        : "Phone number or email (e.g. +15551234567)";
      const hint = channelName === "telegram"
        ? "Find your ID: message @userinfobot on Telegram"
        : "A phone number/email, or a chat.db chat GUID (iMessage;-;+1555…, any;+;<hex>)";

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
