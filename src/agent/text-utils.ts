export function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text);
}

/**
 * Peel trailing bare-NO_REPLY blocks off a joined multi-block response.
 *
 * Non-streaming turns (cron, continuity) collect every text block from the
 * whole turn into one string, blocks joined by "\n" (see LiveSession's
 * `result` handler) — they have no per-block delivery, unlike stream turns'
 * makeBlockHandler. Without this, a trailing NO_REPLY block combined with
 * embeddedSilentMatcher's `.includes("NO_REPLY")` check silences the ENTIRE
 * response, dropping any earlier substantive text along with it (#222).
 * Only trailing lines are inspected: blocks are pre-trimmed before joining, so
 * a NO_REPLY block never has interior newlines, and this can't false-positive
 * on earlier prose that merely mentions NO_REPLY inline.
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
