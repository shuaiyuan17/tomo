import { ownerLocale, ownerT, type Locale, type OwnerText } from "../i18n/index.js";

/** CLI error frames do not always include an HTTP status code. */
export function isSafeguardError(text: string): boolean {
  return /^API Error: [^\r\n]+['’]s safeguards flagged this message\b/i.test(text.trim());
}

/** `text`, plus the /rewind hint when it is a safeguard refusal (English: the shape the pending error note keeps). */
export function withRecoveryHint(text: string): string {
  return formatVisibleError("bare", text, "en");
}

/** Which turn's error a chat sees: a reply, a cron job, a continuity heartbeat; `bare` has no prefix. */
export type VisibleErrorKind = "reply" | "cron" | "continuity" | "bare";

/**
 * The error line a chat is shown when a turn fails: a fixed prefix, the
 * error detail as it came (the CLI's or the API's own words), and for a
 * safeguard refusal the /rewind hint. `locale` "en" is also the pending
 * error note the model reads next turn.
 */
export function formatVisibleError(kind: VisibleErrorKind, detail: string, locale: Locale = ownerLocale()): OwnerText {
  const t = ownerT("notices", locale);
  const error = isSafeguardError(detail) ? t("error.rewindHint", { error: detail }) : detail;
  switch (kind) {
    case "reply": return t("error.prefix", { error });
    case "cron": return t("error.cron", { error });
    case "continuity": return t("error.continuity", { error });
    case "bare": return t("error.bare", { error });
  }
}

/**
 * Coarse error class for an owner notice (see owner-error-notice.ts). Matched
 * on the strings the CLI actually emits; anything unrecognised is "other".
 */
export type TurnErrorClass = "safeguard" | "auth" | "usage-limit" | "other";

export function classifyTurnError(text: string): TurnErrorClass {
  const trimmed = text.trim();
  if (isSafeguardError(trimmed)) return "safeguard";
  if (/^Failed to authenticate\b|authentication_error|OAuth token (?:has )?expired|Invalid API key|Please run \/login|^API Error: 401\b/i.test(trimmed)) {
    return "auth";
  }
  if (/^You['’]ve hit (?:your )?(?:session )?limit\b/i.test(trimmed)) return "usage-limit";
  return "other";
}
