import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logger.js";

export interface ImageSaveMeta {
  /** Logical session or chat identifier (e.g. "dm_shuai", "tg_12345"). */
  sessionKey?: string;
  /** Upstream attachment identifier (BlueBubbles guid, Telegram file_id, etc.). */
  guid?: string;
  /** When the image was received. Defaults to now. */
  timestamp?: Date;
}

/** Map a MIME type to a filesystem extension (no leading dot). Falls back to "bin". */
export function mimeToExt(mimeType: string | undefined): string {
  if (!mimeType) return "bin";
  const m = mimeType.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/gif") return "gif";
  if (m === "image/webp") return "webp";
  if (m === "image/heic") return "heic";
  if (m === "image/heif") return "heif";
  if (m === "image/bmp") return "bmp";
  if (m === "image/tiff") return "tiff";
  // Generic image/<subtype> → use <subtype>
  if (m.startsWith("image/")) return m.slice(6).replace(/[^a-z0-9]/g, "") || "bin";
  return "bin";
}

/** Zero-padded date/time parts in local timezone. */
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
  // Strip dashes for compactness; first 8 chars is enough to disambiguate within a second.
  const compact = guid.replace(/-/g, "");
  return compact.slice(0, 8) || "unknown";
}

/**
 * Build the absolute destination path for an inbound image.
 *
 * Pattern: `{baseDir}/memory/incoming-images/YYYY-MM-DD/HHMMSS_{session}_{guid8}.{ext}`
 *
 * Exported for testing; channels should prefer {@link saveInboundImage}.
 */
export function buildImagePath(
  baseDir: string,
  mimeType: string,
  meta: ImageSaveMeta,
): { dir: string; filename: string; fullPath: string } {
  const ts = meta.timestamp ?? new Date();
  const dir = join(baseDir, "memory", "incoming-images", localDateFolder(ts));
  const session = sanitize(meta.sessionKey, "session");
  const guid = sanitize(shortGuid(meta.guid), "unknown");
  const ext = mimeToExt(mimeType);
  const filename = `${localTimeStamp(ts)}_${session}_${guid}.${ext}`;
  return { dir, filename, fullPath: join(dir, filename) };
}

/**
 * Save an inbound image to disk. Never throws — errors are logged and the
 * function returns `null` so the message flow can continue unimpeded.
 *
 * @returns the absolute path written, or `null` on failure.
 */
export async function saveInboundImage(
  buffer: Buffer,
  mimeType: string,
  meta: ImageSaveMeta,
  baseDir: string,
): Promise<string | null> {
  try {
    const { dir, fullPath } = buildImagePath(baseDir, mimeType, meta);
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, buffer);
    log.info(
      { path: fullPath, bytes: buffer.length, mimeType },
      "Saved inbound image",
    );
    return fullPath;
  } catch (err) {
    log.error({ err, mimeType, bytes: buffer.length }, "Failed to save inbound image");
    return null;
  }
}
