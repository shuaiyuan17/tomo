import * as p from "@clack/prompts";
import { SessionStore } from "../../sessions/store.js";
import { CronStore } from "../../cron/store.js";
import { loadConfig, saveConfig, SESSIONS_DIR, SDK_SESSIONS_DIR } from "./shared.js";

export async function configIdentities(): Promise<void> {
  const cfg = loadConfig();
  const identities = (cfg.identities ?? []) as Array<{
    name: string;
    channels: Record<string, string>;
    replyPolicy: string;
  }>;
  const channels = (cfg.channels ?? {}) as Record<string, Record<string, string>>;
  const configuredChannels = Object.keys(channels).filter((ch) => {
    if (ch === "telegram") return !!channels.telegram?.token;
    if (ch === "imessage") return channels.imessage?.provider === "imsg";
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

      const moved = migrateCronJobsToIdentity(identity);
      if (moved > 0) {
        p.log.success(`Moved ${moved} cron job(s) to dm:${identity.name.toLowerCase()}`);
      }

      await resolveUnifiedSession(identity);
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

        const moved = migrateCronJobsToIdentity(id);
        if (moved > 0) {
          p.log.success(`Moved ${moved} cron job(s) to dm:${id.name.toLowerCase()}`);
        }

        await resolveUnifiedSession(id);
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

        const restored = restoreCronJobsFromIdentity(id);

        identities.splice(idx, 1);
        cfg.identities = identities;
        saveConfig(cfg);
        p.log.success(`Identity "${id.name}" removed`);
        if (restored.count > 0) {
          p.log.success(`Moved ${restored.count} cron job(s) back to ${restored.fallbackKey}`);
        }
      }
    }
  }
}

/**
 * Rewrite cron jobs keyed on any of this identity's raw per-channel session keys
 * to the unified dm:<name> key. Returns total jobs rewritten.
 */
function migrateCronJobsToIdentity(identity: {
  name: string;
  channels: Record<string, string>;
}): number {
  const cronStore = new CronStore();
  const unified = `dm:${identity.name.toLowerCase()}`;
  let total = 0;
  for (const [ch, chatId] of Object.entries(identity.channels)) {
    total += cronStore.rewriteSessionKey(`${ch}:${chatId}`, unified);
  }
  return total;
}

/**
 * Reverse of migrateCronJobsToIdentity: move cron jobs from dm:<name> back to
 * a concrete per-channel session key, picking the first bound channel as the
 * fallback. Returns the rewrite count and the fallback key used.
 */
function restoreCronJobsFromIdentity(identity: {
  name: string;
  channels: Record<string, string>;
}): { count: number; fallbackKey: string | null } {
  const entries = Object.entries(identity.channels);
  if (entries.length === 0) return { count: 0, fallbackKey: null };

  const [ch, chatId] = entries[0];
  const fallbackKey = `${ch}:${chatId}`;
  const cronStore = new CronStore();
  const count = cronStore.rewriteSessionKey(
    `dm:${identity.name.toLowerCase()}`,
    fallbackKey,
  );
  return { count, fallbackKey };
}

/**
 * After an identity is created or its bindings change, decide what happens to
 * any pre-existing per-channel sessions that are now bound to this identity.
 * - 0 candidates: nothing to do.
 * - 1 candidate: migrate silently into dm:<name>.
 * - 2+ candidates: prompt the user to pick one (or start fresh). The non-chosen
 *   sessions are explicitly unlinked, which puts them in the 30-day retention
 *   window so they can be revisited via `tomo sessions list`.
 * No-ops if dm:<name> already has an active session.
 */
async function resolveUnifiedSession(identity: {
  name: string;
  channels: Record<string, string>;
}): Promise<void> {
  const store = new SessionStore(SESSIONS_DIR, 0, SDK_SESSIONS_DIR);
  const unifiedKey = `dm:${identity.name.toLowerCase()}`;

  if (store.getSdkSessionId(unifiedKey)) return; // already unified

  const candidates: Array<{ oldKey: string; channel: string; queries: number; lastActiveAt: number }> = [];
  for (const [ch, chatId] of Object.entries(identity.channels)) {
    const oldKey = `${ch}:${chatId}`;
    const entry = store.getEntry(oldKey);
    if (!entry) continue;
    candidates.push({
      oldKey,
      channel: ch,
      queries: entry.stats?.totalQueries ?? 0,
      lastActiveAt: entry.lastActiveAt,
    });
  }

  if (candidates.length === 0) return;

  if (candidates.length === 1) {
    store.migrateSessionKey(candidates[0].oldKey, unifiedKey);
    p.log.success(`Adopted ${candidates[0].oldKey} as ${unifiedKey}`);
    return;
  }

  p.log.warn(`Found ${candidates.length} existing sessions bound to "${identity.name}".`);
  p.log.info("Unlinked sessions stay recoverable for 30 days — see `tomo sessions list`.");

  const choice = await p.select({
    message: `Which session should become ${unifiedKey}?`,
    options: [
      ...candidates.map((c) => ({
        value: c.oldKey,
        label: c.oldKey,
        hint: `${c.queries} queries, last used ${formatAge(Date.now() - c.lastActiveAt)} ago`,
      })),
      { value: "__fresh__", label: "Start fresh", hint: "unlink all candidates, begin a new unified session" },
    ],
  });

  if (p.isCancel(choice)) {
    p.log.warn(`Skipped. ${unifiedKey} will stay unresolved until you revisit this in \`tomo config\`.`);
    return;
  }

  if (choice === "__fresh__") {
    for (const c of candidates) store.clearSdkSessionId(c.oldKey);
    p.log.success(`Unlinked ${candidates.length} session(s). ${unifiedKey} will start fresh on next message.`);
    return;
  }

  store.migrateSessionKey(choice as string, unifiedKey);
  for (const c of candidates) {
    if (c.oldKey !== choice) store.clearSdkSessionId(c.oldKey);
  }
  p.log.success(`Adopted ${choice} as ${unifiedKey}. ${candidates.length - 1} other session(s) unlinked.`);
}

function formatAge(ms: number): string {
  if (ms < 0) return "0s";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Pick a chat ID for a channel — shows existing sessions as selectable options, with fallback to manual input. Returns null if cancelled, empty string to skip. */
async function pickChatId(channelName: string, currentValue?: string): Promise<string | null> {
  const store = new SessionStore(SESSIONS_DIR, 20, SDK_SESSIONS_DIR);
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
      placeholder: channelName === "telegram" ? "e.g. 123456789" : "e.g. +15551234567",
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
      placeholder: channelName === "telegram" ? "e.g. 123456789" : "e.g. +15551234567",
      initialValue: currentValue ?? "",
    });
    if (p.isCancel(chatId)) return null;
    return (chatId as string).trim();
  }

  return choice as string;
}
