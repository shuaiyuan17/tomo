/**
 * Attachment markers tomo writes into transcripts for things sent from a
 * messaging channel (see src/channels/imageStore.ts, documentStore.ts,
 * fileStore.ts), e.g.
 *   [Sent an image, saved to: /…/memory/incoming-images/2026-11-14/123533_….png]
 *   [Sent 2 images, saved to: /a.png, /b.jpg; 1 still downloading — will follow …]
 *   [Sent a sticker, saved to: /…png; resend with STICKER:<saved path>]
 *   [Sent a document, saved to: /…/incoming-documents/…pdf]
 *   [Sent a file: name.zip — saved to /…; … Contents not attached …]
 * The UI shows images as thumbnails and other attachments as a named chip,
 * never the raw path.
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "images"; paths: string[]; sticker: boolean; missing: number; more: number }
  | { kind: "attachment"; label: string; names: string[] }
  /** Pictures the agent sent, by outgoing-store id; null: no longer available. */
  | { kind: "sent"; ids: (string | null)[] };

/** Thumbnails shown per message; the rest are counted as "+N more". */
export const MAX_IMAGES = 20;
const MARKER = /\[Sent (an image|a sticker|\d+ images|\d+ stickers|a document|\d+ documents|a file|\d+ files)([^\]]*)\]/g;
const count = (noun: string) => (/^\d+/.test(noun) ? Number.parseInt(noun, 10) : 1);
const fileName = (path: string) => path.replace(/^.*\//, "");

function savedPaths(rest: string): string[] {
  const match = /saved to:? ([^;]+?)(?:;|$|\s—|\. )/.exec(rest);
  if (!match) return [];
  return match[1].split(/,\s+/).map((p) => p.trim()).filter((p) => p.startsWith("/") || p.startsWith("~"));
}

/** Split a message into text and attachment parts (text keeps its own line breaks). */
export function splitAttachments(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  let shown = 0;
  for (const match of content.matchAll(MARKER)) {
    const [whole, noun, rest] = match;
    const before = content.slice(last, match.index);
    if (before.trim()) parts.push({ kind: "text", text: before });
    last = match.index! + whole.length;
    if (/image|sticker/.test(noun)) {
      const all = savedPaths(rest);
      const paths = all.slice(0, Math.max(0, MAX_IMAGES - shown));
      shown += paths.length;
      const missing = Math.min(Math.max(0, count(noun) - all.length), Math.max(0, MAX_IMAGES - shown));
      shown += missing;
      parts.push({ kind: "images", paths, sticker: noun.includes("sticker"), missing, more: Math.max(0, count(noun) - paths.length - missing) });
    } else if (/document/.test(noun)) {
      parts.push({ kind: "attachment", label: count(noun) > 1 ? `${count(noun)} documents` : "Document", names: savedPaths(rest).map(fileName) });
    } else {
      const names = [...rest.matchAll(/(?:^:\s*|;\s*)([^;—]+?)\s+—/g)].map((m) => m[1].trim()).filter(Boolean);
      parts.push({ kind: "attachment", label: count(noun) > 1 ? `${count(noun)} files` : "File", names });
    }
  }
  const after = content.slice(last);
  if (after.trim() || !parts.length) parts.push({ kind: "text", text: parts.length ? after.replace(/^\s+/, "") : after });
  return parts;
}

/**
 * The server rewrites each picture the agent sent (`MEDIA:<path>`,
 * `STICKER:<path>`) to `MEDIA:web:<id>` — or `MEDIA:web:gone` when it was
 * never filed (an older message, another channel's turn). Consecutive ones
 * form one row of thumbnails; the text between is parsed as usual.
 */
export const SENT_TOKEN = /MEDIA:web:([a-f0-9]{32}|gone)\b/g;
export function splitMessage(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let run: (string | null)[] | null = null;
  let last = 0;
  const flush = () => { if (run) parts.push({ kind: "sent", ids: run }); run = null; };
  const text = (chunk: string) => {
    if (!chunk.trim()) return;
    flush();
    parts.push(...splitAttachments(chunk.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "")));
  };
  for (const match of content.matchAll(SENT_TOKEN)) {
    text(content.slice(last, match.index));
    (run ??= []).push(match[1] === "gone" ? null : match[1]);
    last = match.index! + match[0].length;
  }
  if (!parts.length && !run) return splitAttachments(content);
  text(content.slice(last));
  flush();
  return parts;
}
