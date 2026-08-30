import { join } from "node:path";
import { log } from "../logger.js";
import { writeWithoutOverwrite } from "./attachment-write.js";

export interface DocumentSaveMeta {
  /** Logical session or chat identifier (e.g. "dm_shuai", "tg_12345"). */
  sessionKey?: string;
  /** Upstream attachment identifier (iMessage/chat.db guid, Telegram file_id, etc.). */
  guid?: string;
  /** Original filename if provided by the channel. */
  filename?: string;
  /** When the document was received. Defaults to now. */
  timestamp?: Date;
}

/**
 * Maximum supported document size (bytes). Anthropic's PDF input cap is 32 MB
 * (per request), so attachments larger than this would round-trip the bytes
 * just to be rejected by the API. We reject early to keep memory and disk
 * usage bounded.
 */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/**
 * MIME types we ingest as `document` attachments and forward to Claude as
 * Anthropic API document content blocks. Currently scoped to PDF; other text
 * formats can be added as the API support widens.
 */
export const SUPPORTED_DOCUMENT_MIME_TYPES: ReadonlyArray<string> = [
  "application/pdf",
];

export function isSupportedDocumentMime(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return SUPPORTED_DOCUMENT_MIME_TYPES.includes(mimeType.toLowerCase());
}

/** Map a MIME type to a filesystem extension (no leading dot). Falls back to "bin". */
/**
 * Longest extension we will derive from a MIME subtype.
 *
 * The subtype is sender-controlled and unbounded: `text/` + 100 KB of letters
 * survives the `[^a-z0-9]` strip intact, and the result is used both as an
 * on-disk filename component and — via `sanitizeAttachmentFilename`'s fallback
 * — inside the notice shown to the model. Sixteen clears every real extension
 * (`json`, `yaml`, `xml`, `sqlite3`) with room to spare.
 */
export const MAX_MIME_EXT_LENGTH = 16;

export function documentMimeToExt(mimeType: string | undefined): string {
  if (!mimeType) return "bin";
  const m = mimeType.toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m === "text/plain") return "txt";
  if (m === "text/markdown") return "md";
  if (m === "text/csv") return "csv";
  if (m === "application/json") return "json";
  // Fall back to subtype for application/* and text/*
  if (m.startsWith("application/") || m.startsWith("text/")) {
    const sub = m.split("/")[1] ?? "";
    return sub.replace(/[^a-z0-9]/g, "").slice(0, MAX_MIME_EXT_LENGTH) || "bin";
  }
  return "bin";
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function localDateFolder(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTimeStamp(d: Date): string {
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitize(part: string | undefined, fallback: string): string {
  if (!part) return fallback;
  const cleaned = part.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : fallback;
}

function shortGuid(guid: string | undefined): string {
  if (!guid) return "unknown";
  const compact = guid.replace(/-/g, "");
  return compact.slice(0, 8) || "unknown";
}

/**
 * Sanitize a user-supplied filename to a safe basename (no extension, no path
 * traversal). Returns null if nothing usable remains.
 */
function sanitizeFilenameStem(filename: string | undefined): string | null {
  if (!filename) return null;
  const base = filename.replace(/^.*[\\/]/, "");
  // Strip extension
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const cleaned = stem.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Build the absolute destination path for an inbound document.
 *
 * Pattern: `{baseDir}/memory/incoming-documents/YYYY-MM-DD/HHMMSS_{session}_{guid8}[_name].{ext}`
 *
 * Exported for testing; channels should prefer {@link saveInboundDocument}.
 */
export function buildDocumentPath(
  baseDir: string,
  mimeType: string,
  meta: DocumentSaveMeta,
): { dir: string; filename: string; fullPath: string } {
  const ts = meta.timestamp ?? new Date();
  const dir = join(baseDir, "memory", "incoming-documents", localDateFolder(ts));
  const session = sanitize(meta.sessionKey, "session");
  const guid = sanitize(shortGuid(meta.guid), "unknown");
  const ext = documentMimeToExt(mimeType);
  const stem = sanitizeFilenameStem(meta.filename);
  const namePart = stem ? `_${stem}` : "";
  const filename = `${localTimeStamp(ts)}_${session}_${guid}${namePart}.${ext}`;
  return { dir, filename, fullPath: join(dir, filename) };
}

/**
 * Format the inline `[Sent a document …]` marker prepended to the user-visible
 * text of a document-bearing channel message. `intendedCount` is the number of
 * document attachments the channel observed (regardless of download success);
 * `savedPaths` lists absolute disk paths for documents that were also persisted
 * locally. Returns `""` when `intendedCount === 0`.
 */
export function formatDocumentMarker(intendedCount: number, savedPaths: string[]): string {
  if (intendedCount <= 0) return "";
  const noun = intendedCount === 1 ? "a document" : `${intendedCount} documents`;
  if (savedPaths.length === 0) return `[Sent ${noun}]`;
  return `[Sent ${noun}, saved to: ${savedPaths.join(", ")}]`;
}

/**
 * Read a `fetch` response body into a Buffer with a hard size cap. Returns
 * `null` if the body grows past `maxBytes` before completing — chunks are
 * accumulated only up to the cap, so a malicious or mis-declared payload
 * cannot exhaust memory before we notice. Cancels the underlying stream on
 * cap-hit so the socket is freed promptly.
 *
 * Use this in addition to (not instead of) any pre-download size hint
 * checks (e.g. Telegram's `file_size`, an attachment row's declared byte
 * size, HTTP `Content-Length`); those hints can be missing or wrong.
 */
export async function readBodyWithCap(
  res: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  if (!res.body) {
    // No streaming body — fall back to arrayBuffer with a post-check.
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* best-effort */ }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
}

/**
 * Save an inbound document to disk. Never throws — errors are logged and the
 * function returns `null` so the message flow can continue unimpeded.
 *
 * @returns the absolute path written, or `null` on failure.
 */
export async function saveInboundDocument(
  buffer: Buffer,
  mimeType: string,
  meta: DocumentSaveMeta,
  baseDir: string,
): Promise<string | null> {
  try {
    const { dir, filename } = buildDocumentPath(baseDir, mimeType, meta);
    // Same reasoning as imageStore: the destination name is deterministic and
    // therefore collidable, so the write must never overwrite. The path
    // returned is the path written, not the path attempted.
    const written = await writeWithoutOverwrite(dir, filename, buffer);
    if (!written) {
      log.error({ dir, filename }, "Gave up finding a free filename for inbound document");
      return null;
    }
    log.info(
      { path: written, bytes: buffer.length, mimeType },
      "Saved inbound document",
    );
    return written;
  } catch (err) {
    log.error({ err, mimeType, bytes: buffer.length }, "Failed to save inbound document");
    return null;
  }
}
