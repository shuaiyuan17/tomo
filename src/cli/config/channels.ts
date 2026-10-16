import * as p from "@clack/prompts";
import { loadConfig, saveConfig } from "./shared.js";
import { currentOwner, enableImessageWithOwner } from "./owner-setup.js";
import { clackPrompts } from "./owner.js";
import { isDmAllowlistEntry } from "../../owner.js";

function imessageOwnerHandle(cfg: Record<string, unknown>): string | undefined {
  return currentOwner(cfg).owner?.imessage[0];
}

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
      hint: tgToken ? `configured | ${tgAllow.filter((id) => !isDmAllowlistEntry("telegram", id)).length} group(s)` : "not configured",
    });

    // `channels.imessage.provider` is a single-valued opt-in: "imsg" enables
    // the channel, absent leaves it off. It stays a named provider rather than
    // a boolean so existing config files need no migration.
    const imEnabled = channels.imessage?.provider === "imsg";
    const imAllow = (channels.imessage?.allowlist ?? []) as string[];
    options.push({
      value: "imessage",
      label: "iMessage",
      hint: imEnabled ? `imsg | ${imAllow.filter((id) => !isDmAllowlistEntry("imessage", id)).length} group(s)` : "not configured",
    });

    options.push({ value: "back", label: "Back" });

    const choice = await p.select({ message: "Channels", options });
    if (p.isCancel(choice) || choice === "back") break;

    if (choice === "telegram") {
      const action = await p.select({
        message: "Telegram",
        options: [
          { value: "token", label: "Bot token", hint: tgToken ? "(set)" : "not set" },
          { value: "allowlist", label: "Groups", hint: "activated group chats" },
          { value: "back", label: "Back" },
        ],
      });
      if (p.isCancel(action) || action === "back") continue;

      if (action === "token") {
        // p.password, not p.text, and no initialValue: pre-filling rendered
        // the whole token on screen and into terminal scrollback, where
        // anyone who can read it can impersonate the bot. auth.ts and
        // litellm.ts already do it this way — display "(set)", never the
        // value, and treat a blank answer as "keep what's there".
        const token = await p.password({
          message: tgToken
            ? "Telegram bot token (set — leave blank to keep existing)"
            : "Telegram bot token",
        });
        if (p.isCancel(token)) continue;
        const entered = String(token ?? "").trim();
        if (!entered && !tgToken) {
          p.log.warn("No token entered; leaving Telegram unconfigured.");
          continue;
        }
        if (!entered) continue;
        if (!channels.telegram) channels.telegram = {};
        channels.telegram.token = entered;
        cfg.channels = channels;
        saveConfig(cfg);
        p.log.success("Telegram token saved");
      }

      if (action === "allowlist") {
        await manageAllowlist(cfg, channels, "telegram");
      }
    }

    if (choice === "imessage") {
      const ownerHandle = imessageOwnerHandle(cfg);
      const action = await p.select({
        message: "iMessage",
        options: [
          {
            value: "toggle",
            label: imEnabled ? "Disable iMessage" : "Enable iMessage",
            hint: imEnabled ? "provider: imsg" : "imsg CLI — needs Full Disk Access",
          },
          ...(imEnabled && !ownerHandle
            ? [{ value: "owner", label: "Set your iMessage handle", hint: "none — every iMessage DM is ignored" }]
            : []),
          { value: "imsg", label: "imsg CLI settings", hint: (channels.imessage?.cliPath as string) ?? "imsg (PATH)" },
          { value: "allowlist", label: "Groups", hint: "activated group chats" },
          { value: "back", label: "Back" },
        ],
      });
      if (p.isCancel(action) || action === "back") continue;

      // One backend, so this is a toggle rather than a picker: writing the
      // provider key enables the channel, removing it turns iMessage off.
      if (action === "toggle" && imEnabled) {
        delete channels.imessage.provider;
        cfg.channels = channels;
        saveConfig(cfg);
        p.log.success("iMessage disabled");
      }

      // Enabling asks for the owner's handle: DM admission fails closed, so
      // without one every iMessage DM is ignored — allowed only as an
      // explicit choice.
      if ((action === "toggle" && !imEnabled) || action === "owner") {
        if (await enableImessageWithOwner(cfg, clackPrompts)) {
          saveConfig(cfg);
          if (action === "toggle") p.log.info("imsg CLI — Tomo needs Full Disk Access.");
        }
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

/** Is this a group id on the channel (what the allowlist is for)? */
export function isGroupAllowlistEntry(channelName: string, id: string): boolean {
  const value = id.trim();
  if (channelName === "telegram") return /^-\d+$/.test(value);
  if (channelName === "imessage") return value.includes(";+;") || /^chat[0-9a-z]+$/i.test(value);
  return false;
}

/**
 * Channels → <channel> → Groups. The allowlist lists ACTIVATED GROUPS only:
 * DMs are answered for the owner's handles (`tomo config` → Owner) and for
 * nobody else, so a DM entry here is ignored and shown as such. Sending the
 * group secret in a group adds it here too.
 */
async function manageAllowlist(
  cfg: Record<string, unknown>,
  channels: Record<string, Record<string, unknown>>,
  channelName: string,
): Promise<void> {
  if (!channels[channelName]) channels[channelName] = {};
  const ch = channels[channelName];
  const allowlist = ((ch.allowlist ?? []) as unknown[]).map(String); // working copy

  for (;;) {
    const options: Array<{ value: string; label: string; hint?: string }> = [];

    if (allowlist.length === 0) {
      p.log.info("No group is activated on this channel. Send the group secret in a group (`tomo config` → Group chats), or add its ID here.");
    }
    for (let i = 0; i < allowlist.length; i++) {
      const dm = isDmAllowlistEntry(channelName, allowlist[i]);
      options.push({
        value: `remove:${i}`,
        label: allowlist[i],
        hint: dm ? "ignored: a DM entry (only the owner's DMs are answered) — select to remove" : "select to remove",
      });
    }

    options.push({ value: "add", label: "Add group" });
    options.push({ value: "back", label: "Back" });

    const choice = await p.select({
      message: `Activated groups on ${channelName}`,
      options,
    });
    if (p.isCancel(choice) || choice === "back") break;

    if (choice === "add") {
      p.log.info(channelName === "telegram"
        ? "A Telegram group ID is negative, e.g. -1001234567890."
        : "An iMessage group chat GUID, e.g. any;+;chat0123456789.");
      const id = await p.text({ message: "Group ID", placeholder: channelName === "telegram" ? "-1001234567890" : "any;+;chat0123456789" });
      if (p.isCancel(id)) continue;
      const val = String(id ?? "").trim();
      if (!val) continue;
      if (!isGroupAllowlistEntry(channelName, val)) {
        p.log.warn("That is not a group ID. To be answered in DMs, add your handle under `tomo config` → Owner.");
        continue;
      }
      if (!allowlist.includes(val)) {
        allowlist.push(val);
        ch.allowlist = allowlist;
        cfg.channels = channels;
        saveConfig(cfg);
        p.log.success(`Added ${val}`);
      }
    }

    if (typeof choice === "string" && choice.startsWith("remove:")) {
      const idx = Number(choice.slice(7));
      const removed = allowlist.splice(idx, 1)[0];
      ch.allowlist = allowlist;
      cfg.channels = channels;
      saveConfig(cfg);
      p.log.success(`Removed ${removed}`);
    }
  }
}
