export function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text);
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
