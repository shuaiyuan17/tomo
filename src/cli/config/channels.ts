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
