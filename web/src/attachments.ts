import { i18n } from "./i18n/index.js";
/**
 * Attachment markers tomo writes into transcripts for things sent from a
 * messaging channel (see src/channels/imageStore.ts, documentStore.ts,
 * fileStore.ts), e.g.
 *   [Sent an image, saved to: /…/memory/incoming-images/2026-11-14/123533_….png]
 *   [Sent 2 images, saved to: /a.png, /b.jpg; 1 still downloading — will follow …]
 *   [Sent a sticker, saved to: /…png; resend with STICKER:<saved path>]
 *   [Sent a document, saved to: /…/incoming-documents/…pdf]
 *   [Sent a file: notes.md (text/markdown, 1.2 KB) saved to /…/incoming-files/…; … Contents not attached …]
 *   [Sent a file: name.zip — saved to /…; … Contents not attached …]   (older form)
 * The UI shows images as thumbnails and other attachments as a named chip,
 * never the raw path.
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "images"; paths: string[]; sticker: boolean; missing: number; more: number }
  /** `files`: each file's name and size, where the marker gives them (shown as a card each). */
  | { kind: "attachment"; label: string; names: string[]; files?: Array<{ name: string; size?: string }> }
  /** Pictures the agent sent, by outgoing-store id; null: no longer available. */
  | { kind: "sent"; ids: (string | null)[] }
  /** Files (not pictures) the agent sent, by outgoing-store id: a download card each. */
  | { kind: "sentFiles"; files: SentFile[] };
export interface SentFile { id: string; name: string; size: number }

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
      parts.push({ kind: "attachment", label: i18n.t("chat:file.documents", { count: count(noun) }), names: savedPaths(rest).map(fileName) });
    } else {
      // fileStore's notice: "<name> (<type>, <size>) saved to …" — the name is sanitised to [A-Za-z0-9._-].
      const files = [...rest.matchAll(/(?:^:\s*|;\s*)([A-Za-z0-9._-]+) \((?:[^()]*), ([^(),]+)\)/g)].map((m) => ({ name: m[1], size: m[2].trim() }));
      const names = files.length ? files.map((file) => file.name)
        : [...rest.matchAll(/(?:^:\s*|;\s*)([^;—]+?)\s+—/g)].map((m) => m[1].trim()).filter(Boolean);
      parts.push({ kind: "attachment", label: i18n.t("chat:file.files", { count: count(noun) }), names, ...(files.length ? { files } : {}) });
    }
  }
  const after = content.slice(last);
  if (after.trim() || !parts.length) parts.push({ kind: "text", text: parts.length ? after.replace(/^\s+/, "") : after });
  return parts;
}

/**
 * The server rewrites each picture the agent sent (`MEDIA:<path>`,
 * `STICKER:<path>`) to `MEDIA:web:<id>`, any other file to
 * `MEDIA:web:file:<id>:<bytes>:<name>` — or `MEDIA:web:gone` when it was
 * never filed (an older message). Consecutive pictures form one row of
 * thumbnails, consecutive files one row of cards; the text between is parsed
 * as usual. (Every MEDIA: tag of a message is rewritten, so the model cannot
 * write a token of its own.)
 */
export const SENT_TOKEN = /MEDIA:web:(?:([a-f0-9]{32})|gone|file:([a-f0-9]{32}):(\d{1,12}):([A-Za-z0-9._-]{1,120}))(?![A-Za-z0-9_-])/g;
export function splitMessage(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let run: MessagePart & { kind: "sent" | "sentFiles" } | null = null;
  let last = 0;
  const flush = () => { if (run) parts.push(run); run = null; };
  const text = (chunk: string) => {
    if (!chunk.trim()) return;
    flush();
    parts.push(...splitAttachments(chunk.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "")));
  };
  for (const match of content.matchAll(SENT_TOKEN)) {
    text(content.slice(last, match.index));
    last = match.index! + match[0].length;
    if (match[2]) {
      if (run?.kind !== "sentFiles") { flush(); run = { kind: "sentFiles", files: [] }; }
      run.files.push({ id: match[2], size: Number(match[3]), name: match[4] });
    } else {
      if (run?.kind !== "sent") { flush(); run = { kind: "sent", ids: [] }; }
      run.ids.push(match[1] ?? null);
    }
  }
  if (!parts.length && !run) return splitAttachments(content);
  text(content.slice(last));
  flush();
  return parts;
}

/** Shown in place when the file's text is small enough: by its name (the store keeps no type). */
export const PREVIEW_LIMIT = 512 * 1024;
const TEXT_NAME = /\.(?:md|markdown|txt|text|log|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|s?js|mjs|cjs|tsx?|jsx|py|rb|go|rs|swift|kt|java|c|h|cc|cpp|hpp|m|sh|zsh|bash|sql|diff|patch|env\.example|conf)$/i;
export function isPreviewable(file: { name: string; size: number }): boolean {
  return file.size <= PREVIEW_LIMIT && TEXT_NAME.test(file.name);
}
