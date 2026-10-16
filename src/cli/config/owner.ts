import * as p from "@clack/prompts";
import { CronStore, CronStoreReadError } from "../../cron/store.js";
import { cronStoreErrorMessage } from "../cron-errors.js";
import { ownerSessionKey } from "../../owner.js";
import { loadConfig, saveConfig } from "./shared.js";
import {
  addOwnerHandles,
  convertLegacyIdentities,
  currentOwner,
  ensureOwnerBlock,
  promptImessageOwnerHandles,
  promptTelegramUserId,
  removeOwnerHandle,
  setOwnerDisplayName,
  type PromptPort,
} from "./owner-setup.js";

/** @clack/prompts behind the small port the owner flows are tested through. */
export const clackPrompts: PromptPort = {
  text: (opts) => p.text(opts) as Promise<string | symbol>,
  confirm: (opts) => p.confirm(opts),
  select: (opts) => p.select(opts) as Promise<string | symbol>,
  isCancel: (value: unknown): value is symbol => p.isCancel(value),
  log: { info: (m) => p.log.info(m), warn: (m) => p.log.warn(m), success: (m) => p.log.success(m) },
};

/**
 * `tomo config` → Owner. Replaces the old Identities menu.
 *
 * The owner's `name` is shown read-only: it IS the session id (`dm:<name>`),
 * and renaming it would orphan the session, its transcripts, cron jobs and
 * model override. There is deliberately no rename and no "remove owner"
 * action — the old Identities "Remove" path rewrote the owner's cron jobs off
 * the dm: key, which is exactly the data loss this menu must never cause.
 */
export async function configOwner(): Promise<void> {
  for (;;) {
    const cfg = loadConfig();
    const { owner, fromLegacy } = currentOwner(cfg);
    const hasLegacy = Array.isArray(cfg.identities) && cfg.identities.length > 0;

    if (!owner) {
      p.log.warn("No owner is set, so every DM is ignored.");
      const name = await p.text({
        message: "Your name (first word becomes your session id)",
        placeholder: "e.g. alex",
      });
      if (p.isCancel(name)) return;
      const ownerName = String(name ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "owner";
      ensureOwnerBlock(cfg, ownerName);
      setOwnerDisplayName(cfg, String(name ?? ""));
      saveConfig(cfg);
      p.log.success(`Owner created. Your session id: dm:${ownerName} (it never changes). Now add your Telegram ID and/or iMessage handle.`);
      continue;
    }

    p.log.message([
      `Name / session id: ${owner.name}  →  ${ownerSessionKey(owner)}  (read-only)`,
      `Display name:      ${owner.displayName ?? "(none)"}`,
      `Telegram IDs:      ${owner.telegram.join(", ") || "(none — Telegram DMs are ignored)"}`,
      `iMessage handles:  ${owner.imessage.join(", ") || "(none — iMessage DMs are ignored)"}`,
      ...(fromLegacy ? ["", "Read from the legacy `identities` block; any change writes an `owner` block."] : []),
    ].join("\n"));

    const options: Array<{ value: string; label: string; hint?: string }> = [
      { value: "display", label: "Display name", hint: "what Tomo calls you; does not change the session" },
      { value: "telegram", label: "Telegram user IDs", hint: `${owner.telegram.length} bound` },
      { value: "imessage", label: "iMessage handles", hint: `${owner.imessage.length} bound` },
    ];
    if (hasLegacy) {
      options.push({ value: "convert", label: "Convert legacy identities → owner", hint: "config only; sessions untouched" });
    }
    options.push({ value: "back", label: "Back" });

    const choice = await p.select({ message: "Owner", options });
    if (p.isCancel(choice) || choice === "back") return;

    if (choice === "display") {
      const value = await p.text({ message: "Display name (blank to clear)", initialValue: owner.displayName ?? "" });
      if (p.isCancel(value)) continue;
      setOwnerDisplayName(cfg, String(value ?? ""));
      saveConfig(cfg);
      p.log.success("Display name saved");
    }

    if (choice === "telegram" || choice === "imessage") {
      await editHandles(cfg, choice);
    }

    if (choice === "convert") {
      await convertWithConfirmation(cfg);
    }
  }
}

async function editHandles(cfg: Record<string, unknown>, channel: "telegram" | "imessage"): Promise<void> {
  const { owner } = currentOwner(cfg);
  const current = owner?.[channel] ?? [];
  const action = await p.select({
    message: channel === "telegram" ? "Telegram user IDs" : "iMessage handles",
    options: [
      { value: "add", label: "Add" },
      ...current.map((value) => ({ value: `remove:${value}`, label: value, hint: "select to remove" })),
      { value: "back", label: "Back" },
    ],
  });
  if (p.isCancel(action) || action === "back") return;
  if (action === "add") {
    if (channel === "telegram") {
      const id = await promptTelegramUserId(clackPrompts);
      if (id === null) return;
      addOwnerHandles(cfg, "telegram", [id]);
    } else {
      const result = await promptImessageOwnerHandles(clackPrompts);
      if (result.kind !== "handles") return;
      addOwnerHandles(cfg, "imessage", result.handles);
    }
    saveConfig(cfg);
    p.log.success("Saved");
    return;
  }
  const value = String(action).slice("remove:".length);
  const ok = await p.confirm({
    message: `Remove ${value}? DMs from it will be ignored. The owner session itself is not touched.`,
    initialValue: false,
  });
  if (p.isCancel(ok) || !ok) return;
  removeOwnerHandle(cfg, channel, value);
  saveConfig(cfg);
  p.log.success(`Removed ${value}`);
}

async function convertWithConfirmation(cfg: Record<string, unknown>): Promise<void> {
  const { owner } = currentOwner(cfg);
  if (!owner) return;
  const ok = await p.confirm({
    message: `Write an \`owner\` block for "${owner.name}" (${ownerSessionKey(owner)}) and remove \`identities\` from config? A backup is kept; no session, transcript or cron job is changed.`,
    initialValue: true,
  });
  if (p.isCancel(ok) || !ok) return;
  const result = convertLegacyIdentities(cfg);
  if (!result) return;
  saveConfig(cfg);
  p.log.success(`Converted. Owner "${result.owner.name}" keeps ${ownerSessionKey(result.owner)}.`);
  if (result.otherKeys.length === 0) return;

  // The other identities' sessions stay on disk exactly as they were. Their
  // cron jobs would keep firing into those sessions; offer to DISABLE them
  // (never re-key them onto another session).
  let store: CronStore;
  let jobs;
  try {
    store = new CronStore();
    jobs = store.list().filter((job) => job.enabled && result.otherKeys.includes(job.sessionKey));
  } catch (err) {
    if (err instanceof CronStoreReadError) { p.log.warn(cronStoreErrorMessage(err)); return; }
    throw err;
  }
  p.log.info(`Former identities' sessions are left untouched: ${result.otherKeys.join(", ")}. Their DMs are no longer answered.`);
  if (jobs.length === 0) return;
  const disable = await p.confirm({
    message: `${jobs.length} enabled cron job(s) still run in those sessions (${jobs.map((j) => j.name).join(", ")}). Disable them? (They are kept and can be re-enabled.)`,
    initialValue: false,
  });
  if (p.isCancel(disable) || !disable) return;
  for (const job of jobs) store.setEnabled(job.id, false);
  p.log.success(`Disabled ${jobs.length} job(s).`);
}
