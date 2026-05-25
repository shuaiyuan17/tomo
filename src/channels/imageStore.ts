import { execFile } from "node:child_process";
import { open, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "../logger.js";

const execFileP = promisify(execFile);

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
 * Format the inline `[Sent an image …]` marker prepended to the user-visible
 * text of an image-bearing channel message. `intendedCount` is the number of
 * image attachments the channel observed (regardless of download success);
 * `savedPaths` lists absolute disk paths for images that were also persisted
 * locally. Returns `""` when `intendedCount === 0`.
 */
export function formatImageMarker(intendedCount: number, savedPaths: string[]): string {
  if (intendedCount <= 0) return "";
  const noun = intendedCount === 1 ? "an image" : `${intendedCount} images`;
  if (savedPaths.length === 0) return `[Sent ${noun}]`;
  return `[Sent ${noun}, saved to: ${savedPaths.join(", ")}]`;
}

/**
 * Locate the EXIF Orientation tag (0x0112) in a JPEG buffer.
 *
 * iPhone photos forwarded through iMessage/BlueBubbles preserve the original
 * orientation tag without baking the rotation into pixels. Without normalization,
 * a portrait-shot photo (orientation=6) appears sideways to downstream readers
 * that don't honor EXIF — including LLMs reading attached images.
 *
 * Returns the orientation value, the byte offset of the 16-bit value, and the
 * byte order ("BE" for big-endian / Motorola, "LE" for little-endian / Intel),
 * or `null` if no orientation tag is present.
 *
 * Exported for testing; channels should prefer {@link saveInboundImage}.
 */
export function findExifOrientation(
  buffer: Buffer,
): { orientation: number; valueOffset: number; endian: "BE" | "LE" } | null {
  // Must be a JPEG (SOI marker FF D8)
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let i = 2;
  while (i + 4 <= buffer.length) {
    if (buffer[i] !== 0xff) return null;
    const marker = buffer[i + 1];
    // SOS (0xDA) or end — stop scanning
    if (marker === 0xda || marker === 0xd9) return null;
    // Standalone markers without length
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const segSize = buffer.readUInt16BE(i + 2);
    if (segSize < 2 || i + 2 + segSize > buffer.length) return null;

    // APP1 with EXIF identifier
    if (marker === 0xe1 && buffer.slice(i + 4, i + 8).toString("ascii") === "Exif") {
      const tiff = i + 10; // skip "Exif\0\0"
      if (tiff + 8 > buffer.length) return null;
      const byteOrder = buffer.slice(tiff, tiff + 2).toString("ascii");
      const endian: "BE" | "LE" = byteOrder === "MM" ? "BE" : "LE";
      const readU16 = (off: number) => endian === "BE" ? buffer.readUInt16BE(off) : buffer.readUInt16LE(off);
      const readU32 = (off: number) => endian === "BE" ? buffer.readUInt32BE(off) : buffer.readUInt32LE(off);

      // Validate magic 42
      if (readU16(tiff + 2) !== 0x002a) return null;
      const ifd0Offset = readU32(tiff + 4);
      const ifd0 = tiff + ifd0Offset;
      if (ifd0 + 2 > buffer.length) return null;
      const nEntries = readU16(ifd0);
      const entriesEnd = ifd0 + 2 + nEntries * 12;
      if (entriesEnd > buffer.length) return null;

      for (let j = 0; j < nEntries; j++) {
        const entry = ifd0 + 2 + j * 12;
        const tag = readU16(entry);
        if (tag === 0x0112) {
          // Orientation: SHORT (type 3), count 1; value lives in the first 2 bytes
          // of the value/offset field (entry + 8).
          const valueOffset = entry + 8;
          const value = readU16(valueOffset);
          return { orientation: value, valueOffset, endian };
        }
      }
      return null;
    }

    i += 2 + segSize;
  }
  return null;
}

/**
 * Map an EXIF Orientation value to the sips arguments needed to bake the
 * rotation/flip into the pixel data. Returns `null` for value 1 (no-op) or
 * unsupported values.
 *
 * EXIF orientation reference:
 *   1: normal               (no-op)
 *   2: flip horizontal
 *   3: rotate 180°
 *   4: flip vertical
 *   5: transpose            (rotate 90° CCW + flip horizontal)
 *   6: rotate 90° CW
 *   7: transverse           (rotate 90° CW + flip horizontal)
 *   8: rotate 90° CCW
 */
function orientationToSipsArgs(orientation: number): string[] | null {
  switch (orientation) {
    case 1: return null;
    case 2: return ["-f", "horizontal"];
    case 3: return ["-r", "180"];
    case 4: return ["-f", "vertical"];
    case 5: return ["-r", "90", "-f", "horizontal"];
    case 6: return ["-r", "90"];
    case 7: return ["-r", "90", "-f", "vertical"];
    case 8: return ["-r", "270"];
    default: return null;
  }
}

/**
 * Normalize EXIF orientation on a saved JPEG: rotate/flip pixels to match the
 * Orientation tag, then patch the tag to 1 so EXIF-aware readers don't
 * double-rotate. macOS-only (uses `sips`). No-op for non-JPEG or missing tag.
 *
 * Never throws — errors are logged and the file is left as-is.
 */
export async function normalizeJpegOrientation(path: string): Promise<void> {
  const lower = path.toLowerCase();
  if (!lower.endsWith(".jpg") && !lower.endsWith(".jpeg")) return;

  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(path, "r+");
    // 64KB is enough for the EXIF header on every iPhone photo I've seen.
    const head = Buffer.alloc(65536);
    const { bytesRead } = await fd.read(head, 0, head.length, 0);
    const headSlice = head.slice(0, bytesRead);

    const found = findExifOrientation(headSlice);
    if (!found || found.orientation === 1) return;

    const sipsArgs = orientationToSipsArgs(found.orientation);
    if (!sipsArgs) {
      log.warn({ path, orientation: found.orientation }, "Unsupported EXIF orientation; leaving file as-is");
      return;
    }

    // Close fd before sips mutates the file in place, then reopen to patch the tag.
    await fd.close();
    fd = null;
    await execFileP("sips", [...sipsArgs, path]);

    // Patch the orientation field to 1. The offset is stable across sips
    // re-encode in practice (sips preserves EXIF byte layout), but we re-parse
    // to be safe in case the segment shifted.
    fd = await open(path, "r+");
    const head2 = Buffer.alloc(65536);
    const { bytesRead: br2 } = await fd.read(head2, 0, head2.length, 0);
    const reFound = findExifOrientation(head2.slice(0, br2));
    if (reFound) {
      const patch = Buffer.alloc(2);
      if (reFound.endian === "BE") patch.writeUInt16BE(1, 0);
      else patch.writeUInt16LE(1, 0);
      await fd.write(patch, 0, 2, reFound.valueOffset);
    }
    log.info({ path, fromOrientation: found.orientation }, "Normalized JPEG orientation");
  } catch (err) {
    log.error({ err, path }, "Failed to normalize JPEG orientation");
  } finally {
    if (fd) await fd.close().catch(() => undefined);
  }
}

/**
 * Save an inbound image to disk. Never throws — errors are logged and the
 * function returns `null` so the message flow can continue unimpeded.
 *
 * For JPEGs, EXIF Orientation is normalized into the pixel data so downstream
 * readers (LLMs, image viewers without EXIF support) see the right side up.
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
    // Best-effort EXIF orientation normalization (JPEG only, macOS-only).
    // Never throws — failures leave the original file on disk.
    await normalizeJpegOrientation(fullPath);
    return fullPath;
  } catch (err) {
    log.error({ err, mimeType, bytes: buffer.length }, "Failed to save inbound image");
    return null;
  }
}
