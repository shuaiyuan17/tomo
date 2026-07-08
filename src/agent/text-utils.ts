export function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text);
}

/**
 * Peel trailing bare-NO_REPLY lines off a response and report whether any
 * were present.
 *
 * Only trailing lines are inspected, so prose that merely mentions NO_REPLY
 * inline (mid-line or followed by more text) never trips the flag (#222).
 * Consumers differ in what they do with the result: delivery paths treat
 * `hadTrailingNoReply` as "suppress the whole thing" (trailing NO_REPLY marks
 * the response as not-for-the-channel — owner decision 2026-07-08), while the
 * watch TUI shows `visible` so housekeeping narration stays readable locally.
 */
export function stripTrailingNoReply(response: string): { visible: string; hadTrailingNoReply: boolean } {
  const lines = response.split("\n");
  let hadTrailingNoReply = false;

  while (lines.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    if (!isSilentReply(lines[lines.length - 1] ?? "")) break;
    lines.pop();
    hadTrailingNoReply = true;
  }

  return {
    visible: hadTrailingNoReply ? lines.join("\n").trim() : response,
    hadTrailingNoReply,
  };
}

/**
 * True iff the text's final non-empty line(s) are bare NO_REPLY — i.e. the
 * response is marked as not-for-the-channel and should be suppressed whole.
 * Inline mentions of NO_REPLY (mid-line, or followed by more prose) return
 * false; so does an empty/whitespace-only string.
 */
export function endsWithTrailingNoReply(text: string): boolean {
  return stripTrailingNoReply(text).hadTrailingNoReply;
}

export const MEDIA_RE = /\bMEDIA:\s*(?:"([^"\n]+)"|([^\s\n"]+))/gi;
export const STICKER_RE = /\bSTICKER:\s*(?:"([^"\n]+)"|([^\s\n"]+))/gi;
export const ATTACHMENT_TAG_RE = /\b(?:MEDIA|STICKER):\s*(?:"[^"\n]+"|[^\s\n"]+)/gi;

export function extractMedia(text: string): { cleanText: string; mediaPaths: string[] } {
  const mediaPaths: string[] = [];
  const cleanText = text.replace(MEDIA_RE, (_match, quotedPath, unquotedPath) => {
    mediaPaths.push(String(quotedPath ?? unquotedPath).trim());
    return "";
  }).trim();
  return { cleanText, mediaPaths };
}

export function extractAttachments(text: string): { cleanText: string; mediaPaths: string[]; stickerIds: string[] } {
  const mediaPaths: string[] = [];
  const stickerIds: string[] = [];
  const withoutMedia = text.replace(MEDIA_RE, (_match, quotedPath, unquotedPath) => {
    mediaPaths.push(String(quotedPath ?? unquotedPath).trim());
    return "";
  });
  const cleanText = withoutMedia.replace(STICKER_RE, (_match, quotedId, unquotedId) => {
    stickerIds.push(String(quotedId ?? unquotedId).trim());
    return "";
  }).trim();
  return { cleanText, mediaPaths, stickerIds };
}
