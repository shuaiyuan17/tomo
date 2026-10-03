/** CLI error frames do not always include an HTTP status code. */
export function isSafeguardError(text: string): boolean {
  return /^API Error: [^\r\n]+['’]s safeguards flagged this message\b/i.test(text.trim());
}

export function withRecoveryHint(text: string): string {
  if (!isSafeguardError(text)) return text;
  return `${text}\n\nIn your owner DM, use /rewind to return to before the last user message, or /rewind N to go back further, then send an edited request. This changes conversation context only; completed actions are not undone.`;
}
