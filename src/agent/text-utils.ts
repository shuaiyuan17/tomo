export function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text);
}

export const MEDIA_RE = /\bMEDIA:\s*"?([^\n"]+)"?/gi;

export function extractMedia(text: string): { cleanText: string; mediaPaths: string[] } {
  const mediaPaths: string[] = [];
  const cleanText = text.replace(MEDIA_RE, (_match, path) => {
    mediaPaths.push(path.trim());
    return "";
  }).trim();
  return { cleanText, mediaPaths };
}
