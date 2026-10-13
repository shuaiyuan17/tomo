/** CLI error frames do not always include an HTTP status code. */
export function isSafeguardError(text: string): boolean {
  return /^API Error: [^\r\n]+['’]s safeguards flagged this message\b/i.test(text.trim());
}

export function withRecoveryHint(text: string): string {
  if (!isSafeguardError(text)) return text;
  return `${text}\n\nIn your owner DM, use /rewind to return to before the last user message, or /rewind N to go back further, then send an edited request. This changes conversation context only; completed actions are not undone.`;
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
