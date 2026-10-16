import { z } from "zod";
import {
  dmSessionKeyForIdentity,
  isGroupSessionKey,
  matchesChannelBinding,
  normalizeImessageHandle,
} from "./sessions/keys.js";

/**
 * The one person Tomo works for. Every owner DM, on every channel, routes to
 * one session: `dm:<name lowercased>` (see `ownerSessionKey`).
 *
 * `name` IS THE SESSION ID. It is the same derivation the old per-identity
 * key used (`dmSessionKeyForIdentity`), which is what lets an install that
 * had one identity keep its exact session, transcripts, cron jobs, model
 * override and web conversation id with no file renamed. So it is immutable
 * in practice: `tomo config` never rewrites it. What the owner wants to be
 * called goes in `displayName`.
 */
export interface OwnerConfig {
  name: string;
  displayName?: string;
  /** Telegram user ids (a DM's chat id is the user id). */
  telegram: string[];
  /** iMessage handles, stored in normalizeImessageHandle form. */
  imessage: string[];
}

/** Provider channels an owner can be bound on. */
export const OWNER_CHANNELS = ["telegram", "imessage"] as const;
export type OwnerChannel = typeof OWNER_CHANNELS[number];

/** Legacy `identities[]` entry, still read (forever) to derive the owner. */
export interface LegacyIdentity {
  name: string;
  channels: Record<string, string>;
  replyPolicy?: string;
}

const idList = z
  .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
  .transform((v) => (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter((x) => x !== ""));

export const ownerSchema = z.object({
  name: z.string().trim().min(1, "expected a non-empty name"),
  displayName: z.string().trim().min(1).optional(),
  telegram: idList.optional(),
  imessage: idList.optional(),
  // Accepted and ignored: replies always go to the last-active channel.
  replyPolicy: z.unknown().optional(),
}).loose();

/** The session key every owner DM routes to. */
export function ownerSessionKey(owner: Pick<OwnerConfig, "name">): string {
  return dmSessionKeyForIdentity(owner.name);
}

/** What to call the owner in prose: `displayName`, else `name`. */
export function ownerDisplayName(owner: Pick<OwnerConfig, "name" | "displayName">): string {
  return owner.displayName ?? owner.name;
}

/** The owner's handles on a channel (empty for an unknown channel). */
export function ownerBindings(owner: OwnerConfig | undefined, channelName: string): string[] {
  if (!owner) return [];
  if (channelName === "telegram") return owner.telegram;
  if (channelName === "imessage") return owner.imessage;
  return [];
}

/**
 * Is this chat id (a DM) or sender id one of the owner's handles on the
 * channel? Group ids never are. iMessage compares through the shared handle
 * normaliser, so formatting drift cannot break the match.
 */
export function isOwnerHandle(owner: OwnerConfig | undefined, channelName: string, id: string | undefined): boolean {
  if (!owner || !id) return false;
  if (isGroupSessionKey(`${channelName}:${id}`)) return false;
  return ownerBindings(owner, channelName).some((bound) => matchesChannelBinding(channelName, id, bound));
}

/**
 * Does an allowlist entry name a person (a DM) rather than a group? Telegram:
 * a positive numeric user id. iMessage: a phone number, an email, or a DM
 * chat GUID. A bare group identifier ("chat123…") is NOT a DM entry — old
 * allowlists use that form for groups.
 */
export function isDmAllowlistEntry(channelName: string, id: string): boolean {
  const value = id.trim();
  if (channelName === "telegram") return /^\d+$/.test(value);
  if (channelName === "imessage") {
    if (value.includes(";+;")) return false;
    if (value.includes(";-;")) return true;
    return value.includes("@") || /^\+?[\d\s().-]+$/.test(value);
  }
  return false;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeOwner(raw: { name: string; displayName?: string; telegram?: string[]; imessage?: string[] }): OwnerConfig {
  return {
    name: raw.name.trim(),
    ...(raw.displayName ? { displayName: raw.displayName } : {}),
    telegram: dedupe((raw.telegram ?? []).map((t) => t.trim()).filter(Boolean)),
    imessage: dedupe((raw.imessage ?? []).map(normalizeImessageHandle).filter(Boolean)),
  };
}

function ownerFromIdentity(identity: LegacyIdentity): OwnerConfig {
  const telegram = identity.channels.telegram;
  const imessage = identity.channels.imessage;
  return normalizeOwner({
    name: identity.name,
    telegram: telegram ? [telegram] : [],
    imessage: imessage ? [imessage] : [],
  });
}

export type OwnerSource =
  | "owner"
  | "identity"
  | "identities-picked"
  | "allowlist-adopted"
  | "none";

export interface OwnerNotice {
  level: "info" | "warn";
  message: string;
}

export interface OwnerResolution {
  owner: OwnerConfig | undefined;
  source: OwnerSource;
  /** Owner-facing startup notices (the daemon logs them once). */
  notices: OwnerNotice[];
  /** Invalid `owner` block (a configIssues entry). */
  issues: string[];
}

/** Channel allowlists as config holds them, for the legacy adoption rule. */
export type RawAllowlists = Record<string, string[] | undefined>;

/**
 * Who the owner is, from a config file. Never touches data; the result is a
 * pure function of config, so an old file is always read the same way.
 *
 * 1. `owner` present (and valid): use it. `identities`, if also present, is
 *    ignored with an info notice.
 * 2. Exactly one identity: it IS the owner — same name, so the same
 *    `dm:<name>` key, with its Telegram id and iMessage handle as bindings.
 * 3. Several identities: the one `web.ownerIdentity` names, else the first,
 *    with a loud warning. The others' DMs are no longer answered; their
 *    sessions, transcripts and cron jobs are left exactly where they are.
 * 4. No owner and no identities, and the channel allowlists hold exactly ONE
 *    DM entry in total: that entry is adopted as the owner, named "owner".
 *    This is the shape `tomo init` wrote before it seeded an identity ("your
 *    Telegram user ID … so only you can message the bot"); without the rule
 *    that owner would be locked out on upgrade. With more than one DM entry
 *    nothing is guessed.
 * 5. Otherwise there is no owner: every DM is ignored, with a warning.
 */
export function resolveOwner(input: {
  owner: unknown;
  identities: LegacyIdentity[];
  webOwnerIdentity?: string;
  allowlists?: RawAllowlists;
}): OwnerResolution {
  const notices: OwnerNotice[] = [];
  const issues: string[] = [];

  if (input.owner !== undefined && input.owner !== null) {
    const parsed = ownerSchema.safeParse(input.owner);
    if (parsed.success) {
      if (input.identities.length > 0) {
        notices.push({ level: "info", message: "Config has both `owner` and the legacy `identities`; `identities` is ignored." });
      }
      return { owner: normalizeOwner(parsed.data), source: "owner", notices, issues };
    }
    const detail = parsed.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ");
    issues.push(`owner: ${detail}`);
  }

  if (input.identities.length === 1) {
    return { owner: ownerFromIdentity(input.identities[0]), source: "identity", notices, issues };
  }

  if (input.identities.length > 1) {
    const wanted = input.webOwnerIdentity?.toLowerCase();
    const named = wanted !== undefined
      ? input.identities.find((id) => id.name.toLowerCase() === wanted)
      : undefined;
    const picked = named ?? input.identities[0];
    const others = input.identities.filter((id) => id !== picked).map((id) => id.name);
    notices.push({
      level: "warn",
      message:
        `${input.identities.length} identities are configured, but Tomo now has a single owner. Using "${picked.name}" `
        + `(${named ? "named by web.ownerIdentity" : "the first identity"}) as the owner. DMs from ${others.map((n) => `"${n}"`).join(", ")} `
        + "are no longer answered; their sessions, transcripts and cron jobs are left untouched. Run `tomo config` → Owner to review.",
    });
    return { owner: ownerFromIdentity(picked), source: "identities-picked", notices, issues };
  }

  const dmEntries: Array<{ channel: OwnerChannel; id: string }> = [];
  for (const channel of OWNER_CHANNELS) {
    for (const id of input.allowlists?.[channel] ?? []) {
      if (isDmAllowlistEntry(channel, id)) dmEntries.push({ channel, id });
    }
  }
  if (dmEntries.length === 1) {
    const [{ channel, id }] = dmEntries;
    notices.push({
      level: "warn",
      message:
        `No owner is configured; adopting the only DM entry in channels.${channel}.allowlist as the owner "owner". `
        + "Run `tomo config` → Owner to confirm or change it.",
    });
    return {
      owner: normalizeOwner({ name: "owner", [channel]: [id] }),
      source: "allowlist-adopted",
      notices,
      issues,
    };
  }

  notices.push({
    level: "warn",
    message: "No owner is configured, so every DM is ignored. Run `tomo config` → Owner to set who Tomo works for.",
  });
  return { owner: undefined, source: "none", notices, issues };
}

/**
 * DM entries in a channel allowlist that are not the owner. The allowlist
 * governs groups only, so these are ignored; the daemon says so once at
 * startup. The owner's own handle listed there is harmless and not reported.
 */
export function ignoredAllowlistDmEntries(owner: OwnerConfig | undefined, allowlists: RawAllowlists): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [channel, list] of Object.entries(allowlists)) {
    for (const id of list ?? []) {
      if (!isDmAllowlistEntry(channel, id)) continue;
      if (isOwnerHandle(owner, channel, id)) continue;
      out[channel] = (out[channel] ?? 0) + 1;
    }
  }
  return out;
}
