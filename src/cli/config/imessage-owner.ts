import { extractImessageIdentifier, normalizeImessageHandle } from "../../sessions/keys.js";

/**
 * Setup-time validation of the handle the owner texts Tomo from. The result
 * is stored already normalized (see normalizeImessageHandle), so what config
 * holds is exactly what chat.db reports.
 *
 * - `ok`: a usable handle, possibly with a note about what was changed.
 * - `confirm`: a usable handle that needs a yes/no first (a 10-digit number
 *   with no country code is assumed to be +1 only when the user says so).
 * - `error`: not usable; ask again.
 */
export type ImessageHandleCheck =
  | { kind: "ok"; handle: string; note?: string }
  | { kind: "confirm"; handle: string; question: string }
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
    };
  }
  return {
    kind: "error",
    error: "Include the country code with a leading +, for example +44 20 7946 0000.",
  };
}

/** The slice of @clack/prompts the flows here use, so tests can drive them. */
export interface PromptPort {
  text(opts: { message: string; placeholder?: string }): Promise<string | symbol>;
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
  | { kind: "handle"; handle: string }
  /** The user explicitly confirmed leaving iMessage DMs ignored for now. */
  | { kind: "skipped" }
  | { kind: "cancelled" };

/**
 * Ask for the owner's iMessage handle until there is a valid one, or the user
 * EXPLICITLY confirms going without (a blank answer alone is not enough:
 * without a handle every iMessage DM is ignored, and that must be a choice).
 */
export async function promptImessageOwnerHandle(prompts: PromptPort): Promise<OwnerHandlePromptResult> {
  for (;;) {
    const answer = await prompts.text({
      message: "Your phone number or Apple ID email — the one you'll text Tomo from. Only this sender will be answered.",
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
    const check = checkImessageOwnerHandle(raw);
    if (check.kind === "error") {
      prompts.log.warn(check.error);
      continue;
    }
    if (check.kind === "confirm") {
      const yes = await prompts.confirm({ message: check.question, initialValue: true });
      if (prompts.isCancel(yes)) return { kind: "cancelled" };
      if (yes !== true) {
        prompts.log.info("Enter the number with its country code, starting with +.");
        continue;
      }
      return { kind: "handle", handle: check.handle };
    }
    if (check.note) prompts.log.info(check.note);
    return { kind: "handle", handle: check.handle };
  }
}

type IdentityShape = { name: string; channels: Record<string, string>; replyPolicy?: string };

/**
 * Channels → iMessage → Enable. Enabling must not finish without an owner
 * handle unless the user explicitly confirms leaving iMessage DMs ignored:
 * DM admission fails closed, so an unbound channel answers nobody.
 *
 * The handle is bound to the owner identity (created as "owner" when there
 * is none; picked from a list when there are several). Mutates `cfg`; the
 * caller saves it. Returns false when the user cancelled (nothing changed).
 */
export async function enableImessageWithOwner(cfg: Record<string, unknown>, prompts: PromptPort): Promise<boolean> {
  const identities = (Array.isArray(cfg.identities) ? cfg.identities : []) as IdentityShape[];
  const bound = identities.find((id) => typeof id.channels?.imessage === "string" && id.channels.imessage !== "");
  let handle: string | undefined;
  let target: IdentityShape | undefined;

  if (!bound) {
    if (identities.length > 1) {
      const picked = await prompts.select({
        message: "Which identity is you (the owner)?",
        options: identities.map((id, i) => ({ value: String(i), label: id.name })),
      });
      if (prompts.isCancel(picked)) return false;
      target = identities[Number(picked)];
    } else {
      target = identities[0];
    }
    const result = await promptImessageOwnerHandle(prompts);
    if (result.kind === "cancelled") return false;
    if (result.kind === "handle") handle = result.handle;
  }

  const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
  if (!channels.imessage) channels.imessage = {};
  channels.imessage.provider = "imsg";
  cfg.channels = channels;

  if (bound) {
    prompts.log.success(`iMessage enabled. DMs from ${bound.channels.imessage} (owner "${bound.name}") will be answered; all other DMs are ignored.`);
    return true;
  }
  if (handle === undefined) {
    prompts.log.warn("iMessage enabled with no owner handle: every iMessage DM will be ignored until you add one (`tomo config` → Channels → iMessage → Enable, or bind it to your identity).");
    return true;
  }
  if (!target) {
    target = { name: "owner", channels: {}, replyPolicy: "last-active" };
    identities.push(target);
  }
  target.channels = { ...(target.channels ?? {}), imessage: handle };
  cfg.identities = identities;
  prompts.log.success(`iMessage enabled. Only DMs from ${handle} (owner "${target.name}") will be answered.`);
  return true;
}
