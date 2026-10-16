import { extractImessageIdentifier, normalizeImessageHandle } from "../../sessions/keys.js";
import { ownerSessionKey, resolveOwner, type LegacyIdentity, type OwnerConfig } from "../../owner.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Setup-time validation of a handle the owner texts Tomo from. The result is
 * stored already normalized (see normalizeImessageHandle), so what config
 * holds is exactly what chat.db reports.
 *
 * - `ok`: a usable handle, possibly with a note about what was changed.
 * - `confirm`: a usable handle that needs a yes/no first (a 10-digit number
 *   with no country code is assumed to be +1 only when the user says so).
 * - `error`: not usable; ask again.
 */
export type ImessageHandleCheck =
  | { kind: "ok"; handle: string; note?: string }
  /** `defaultYes`: what Enter means. Only the unambiguous 10-digit US/Canada
   *  shape defaults to yes; an 11-digit number starting with 1 (every Chinese
   *  mobile looks like that) defaults to no. */
  | { kind: "confirm"; handle: string; question: string; defaultYes: boolean }
  | { kind: "error"; error: string };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_CHARS_RE = /^\+?[\d\s().-]+$/;

export function checkImessageOwnerHandle(raw: string): ImessageHandleCheck {
  let value = raw.trim();
  if (!value) return { kind: "error", error: "Enter a phone number or an Apple ID email." };
  if (value.includes(";+;")) {
    return { kind: "error", error: "That is a group chat ID, not your handle. Enter the phone number or email you text from." };
  }
  let note: string | undefined;
  if (value.includes(";-;")) {
    const reduced = extractImessageIdentifier(value)?.trim();
    if (!reduced) return { kind: "error", error: "That chat ID has no handle in it." };
    note = `Using the handle from that chat ID: ${normalizeImessageHandle(reduced)}`;
    value = reduced;
  }
  if (value.includes("@")) {
    if (!EMAIL_RE.test(value)) return { kind: "error", error: "That email address does not look valid." };
    return { kind: "ok", handle: value.toLowerCase(), ...(note ? { note } : {}) };
  }
  if (!PHONE_CHARS_RE.test(value)) {
    return { kind: "error", error: "Use a phone number (digits, optionally with +, spaces, dashes, parentheses) or an email." };
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    return { kind: "error", error: "A phone number has 8 to 15 digits, including the country code." };
  }
  if (value.startsWith("+")) return { kind: "ok", handle: `+${digits}`, ...(note ? { note } : {}) };
  if (digits.length === 10) {
    return {
      kind: "confirm",
      handle: `+1${digits}`,
      question: `No country code given. Use +1${digits} (US/Canada)?`,
      defaultYes: true,
    };
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    // Ambiguous: a NANP number with its country code, OR an 11-digit
    // national number elsewhere (a Chinese mobile "150 1234 5678"). Never
    // assume — guessing wrong hands owner access to a stranger.
    return {
      kind: "confirm",
      handle: `+${digits}`,
      question: `No "+" given. Is +${digits} a US/Canada number? (If not, answer no and enter it with its country code, e.g. +86 150 1234 5678.)`,
      defaultYes: false,
    };
  }
  return {
    kind: "error",
    error: "Include the country code with a leading +, for example +44 20 7946 0000.",
  };
}

/** A Telegram user id: digits only (a DM's chat id is the user's id). */
export function checkTelegramUserId(raw: string): { kind: "ok"; id: string } | { kind: "error"; error: string } {
  const value = raw.trim();
  if (!value) return { kind: "error", error: "User ID is required." };
  if (value.startsWith("-")) return { kind: "error", error: "That is a group ID. Enter your own numeric user ID (message @userinfobot)." };
  if (!/^\d+$/.test(value)) return { kind: "error", error: "User ID should be a number (message @userinfobot to find it)." };
  return { kind: "ok", id: value };
}

/**
 * The owner's session id, from the name they gave. First word, lowercased —
 * the rule `tomo init` has always used, so re-running setup derives the same
 * key — falling back to "owner".
 */
export function deriveOwnerName(userName: string): string {
  const first = userName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return first || "owner";
}

// ---------------------------------------------------------------------------
// Prompt port
// ---------------------------------------------------------------------------

/** The slice of @clack/prompts the flows here use, so tests can drive them. */
export interface PromptPort {
  text(opts: { message: string; placeholder?: string; initialValue?: string }): Promise<string | symbol>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
  select(opts: { message: string; options: Array<{ value: string; label: string; hint?: string }> }): Promise<string | symbol>;
  isCancel(value: unknown): value is symbol;
  log: {
    info(message: string): void;
    warn(message: string): void;
    success(message: string): void;
  };
}

export type OwnerHandlePromptResult =
  | { kind: "handles"; handles: string[] }
  /** The user explicitly confirmed leaving iMessage DMs ignored for now. */
  | { kind: "skipped" }
  | { kind: "cancelled" };

/**
 * Ask for the owner's iMessage handle(s) — comma-separated — until every entry
 * is valid, or the user EXPLICITLY confirms going without (a blank answer
 * alone is not enough: with no handle every iMessage DM is ignored, and that
 * must be a choice).
 */
export async function promptImessageOwnerHandles(prompts: PromptPort): Promise<OwnerHandlePromptResult> {
  for (;;) {
    const answer = await prompts.text({
      message: "Your phone number or Apple ID email — the one you'll text Tomo from. Only this sender will be answered. (Several: separate with commas.)",
      placeholder: "+15555550123 or you@example.com (leave blank to skip)",
    });
    if (prompts.isCancel(answer)) return { kind: "cancelled" };
    const raw = String(answer ?? "").trim();
    if (!raw) {
      const skip = await prompts.confirm({
        message: "Continue without an owner handle? Every iMessage DM will be ignored until you add one.",
        initialValue: false,
      });
      if (prompts.isCancel(skip)) return { kind: "cancelled" };
      if (skip === true) return { kind: "skipped" };
      continue;
    }
    const handles: string[] = [];
    let retry = false;
    for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const check = checkImessageOwnerHandle(part);
      if (check.kind === "error") {
        prompts.log.warn(`${part}: ${check.error}`);
        retry = true;
        break;
      }
      if (check.kind === "confirm") {
        const yes = await prompts.confirm({ message: check.question, initialValue: check.defaultYes });
        if (prompts.isCancel(yes)) return { kind: "cancelled" };
        if (yes !== true) {
          prompts.log.info("Enter the number with its country code, starting with +.");
          retry = true;
          break;
        }
        handles.push(check.handle);
        continue;
      }
      if (check.note) prompts.log.info(check.note);
      handles.push(check.handle);
    }
    if (retry) continue;
    return { kind: "handles", handles: [...new Set(handles)] };
  }
}

/** Ask for a Telegram user id until it is valid. Null when cancelled. */
export async function promptTelegramUserId(prompts: PromptPort): Promise<string | null> {
  for (;;) {
    const answer = await prompts.text({ message: "Your Telegram user ID", placeholder: "e.g. 123456789 (message @userinfobot to find it)" });
    if (prompts.isCancel(answer)) return null;
    const check = checkTelegramUserId(String(answer ?? ""));
    if (check.kind === "ok") return check.id;
    prompts.log.warn(check.error);
  }
}

// ---------------------------------------------------------------------------
// Config edits (pure on the raw config object; callers save)
// ---------------------------------------------------------------------------

type RawConfig = Record<string, unknown>;

function rawAllowlists(cfg: RawConfig): Record<string, string[] | undefined> {
  const channels = (cfg.channels ?? {}) as Record<string, { allowlist?: unknown }>;
  return Object.fromEntries(Object.entries(channels).map(([name, ch]) => [
    name,
    Array.isArray(ch?.allowlist) ? (ch.allowlist as unknown[]).map(String) : undefined,
  ]));
}

function legacyIdentities(cfg: RawConfig): LegacyIdentity[] {
  if (!Array.isArray(cfg.identities)) return [];
  return (cfg.identities as unknown[]).filter((id): id is LegacyIdentity =>
    typeof id === "object" && id !== null && typeof (id as LegacyIdentity).name === "string"
    && (id as LegacyIdentity).name.trim() !== "" && typeof (id as LegacyIdentity).channels === "object");
}

/**
 * The owner as the daemon would resolve it from this file (owner block,
 * legacy identities, or the single-DM-allowlist adoption). Read-only.
 */
export function currentOwner(cfg: RawConfig): { owner: OwnerConfig | undefined; fromLegacy: boolean } {
  const webOwner = (cfg.web as { ownerIdentity?: unknown } | undefined)?.ownerIdentity;
  const r = resolveOwner({
    owner: cfg.owner,
    identities: legacyIdentities(cfg),
    webOwnerIdentity: typeof webOwner === "string" ? webOwner : undefined,
    allowlists: rawAllowlists(cfg),
  });
  return { owner: r.owner, fromLegacy: r.owner !== undefined && r.source !== "owner" };
}

/** Write an owner into the file as an `owner` block (never `identities`). */
function writeOwner(cfg: RawConfig, owner: OwnerConfig): void {
  cfg.owner = {
    name: owner.name,
    ...(owner.displayName ? { displayName: owner.displayName } : {}),
    telegram: owner.telegram,
    imessage: owner.imessage,
  };
}

/**
 * Make sure the file has an `owner` block, and return it. An owner the
 * daemon already derives from legacy `identities` is written out as-is (same
 * name, so the same session); `identities` itself is left in place — only the
 * explicit Convert action removes it. With no owner at all, `name` is used.
 */
export function ensureOwnerBlock(cfg: RawConfig, name: string): OwnerConfig {
  const { owner } = currentOwner(cfg);
  const result = owner ?? { name, telegram: [], imessage: [] };
  writeOwner(cfg, result);
  return result;
}

export function addOwnerHandles(cfg: RawConfig, channel: "telegram" | "imessage", values: string[]): OwnerConfig {
  const owner = ensureOwnerBlock(cfg, "owner");
  const next = channel === "imessage" ? values.map(normalizeImessageHandle) : values.map((v) => v.trim());
  owner[channel] = [...new Set([...owner[channel], ...next])];
  writeOwner(cfg, owner);
  return owner;
}

export function removeOwnerHandle(cfg: RawConfig, channel: "telegram" | "imessage", value: string): OwnerConfig {
  const owner = ensureOwnerBlock(cfg, "owner");
  owner[channel] = owner[channel].filter((v) => v !== value);
  writeOwner(cfg, owner);
  return owner;
}

export function setOwnerDisplayName(cfg: RawConfig, displayName: string): OwnerConfig {
  const owner = ensureOwnerBlock(cfg, "owner");
  const trimmed = displayName.trim();
  if (trimmed) owner.displayName = trimmed;
  else delete owner.displayName;
  writeOwner(cfg, owner);
  return owner;
}

/**
 * Convert legacy `identities` into an `owner` block — config only, nothing
 * under the data dir changes. The owner is exactly the one the daemon already
 * uses (`web.ownerIdentity`, else the first identity), so the session key does
 * not move. Returns the other identities' `dm:` keys, whose sessions are left
 * untouched (the caller may offer to disable their cron jobs).
 */
export function convertLegacyIdentities(cfg: RawConfig): { owner: OwnerConfig; otherKeys: string[] } | undefined {
  const identities = legacyIdentities(cfg);
  if (identities.length === 0) return undefined;
  const { owner } = currentOwner(cfg);
  if (!owner) return undefined;
  writeOwner(cfg, owner);
  delete cfg.identities;
  const otherKeys = identities
    .map((id) => ownerSessionKey(id))
    .filter((key) => key !== ownerSessionKey(owner));
  return { owner, otherKeys: [...new Set(otherKeys)] };
}

/**
 * Channels → iMessage → Enable. Enabling must not finish without an owner
 * handle unless the user explicitly confirms leaving iMessage DMs ignored:
 * DM admission fails closed, so an unbound channel answers nobody.
 *
 * The handle is written to `owner.imessage`. Mutates `cfg`; the caller saves
 * it. Returns false when the user cancelled (nothing changed).
 */
export async function enableImessageWithOwner(cfg: RawConfig, prompts: PromptPort): Promise<boolean> {
  const { owner: existing } = currentOwner(cfg);
  let handles: string[] = [];
  if (!existing || existing.imessage.length === 0) {
    const result = await promptImessageOwnerHandles(prompts);
    if (result.kind === "cancelled") return false;
    if (result.kind === "handles") handles = result.handles;
  }

  const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
  if (!channels.imessage) channels.imessage = {};
  channels.imessage.provider = "imsg";
  cfg.channels = channels;

  if (existing && existing.imessage.length > 0) {
    prompts.log.success(`iMessage enabled. DMs from ${existing.imessage.join(", ")} (owner "${existing.name}") will be answered; all other DMs are ignored.`);
    return true;
  }
  if (handles.length === 0) {
    prompts.log.warn("iMessage enabled with no owner handle: every iMessage DM will be ignored until you add one (`tomo config` → Owner).");
    return true;
  }
  const owner = addOwnerHandles(cfg, "imessage", handles);
  prompts.log.success(`iMessage enabled. Only DMs from ${owner.imessage.join(", ")} (owner "${owner.name}", session ${ownerSessionKey(owner)}) will be answered.`);
  return true;
}
