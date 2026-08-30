import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "../logger.js";
import { SIPS_TIMEOUT_MS } from "./heic.js";

const execFileP = promisify(execFile);

export interface ImageSaveMeta {
  /** Logical session or chat identifier (e.g. "dm_shuai", "tg_12345"). */
  sessionKey?: string;
  /** Upstream attachment identifier (iMessage/chat.db guid, Telegram file_id, etc.). */
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
export function formatImageMarker(intendedCount: number, savedPaths: string[], unconvertedCount = 0): string {
  if (intendedCount <= 0) return "";
  const noun = intendedCount === 1 ? "an image" : `${intendedCount} images`;
  const head = savedPaths.length === 0
    ? `[Sent ${noun}`
    : `[Sent ${noun}, saved to: ${savedPaths.join(", ")}`;
  return `${head}${formatUnconvertedNote(unconvertedCount)}]`;
}

/**
 * Trailing clause for images whose HEIC→JPEG/PNG conversion failed (sips
 * missing, non-zero exit, or — the case this was added for — a `sips` that
 * hung and was killed at its deadline).
 *
 * Say it out loud rather than delivering silence: the fallback attaches the
 * ORIGINAL bytes, and the harness image reader cannot display HEIC, so without
 * this the agent receives an image it cannot see and no reason why. The
 * alternative — waiting for the conversion — is what wedged the inbound FIFO.
 */
function formatUnconvertedNote(unconvertedCount: number): string {
  if (unconvertedCount <= 0) return "";
  const subject = unconvertedCount === 1
    ? "1 attachment could not be converted"
    : `${unconvertedCount} attachments could not be converted`;
  return `; ${subject} from HEIC — the original bytes are attached and may not be readable`;
}

/**
 * Sticker sibling of {@link formatImageMarker} — the iMessage counterpart of
 * the Telegram channel's `describeSticker`. A sticker arriving as a bare
 * "[Sent an image]" is indistinguishable from a photo, which buries the
 * expressive act; naming it lets the agent react to it as a sticker and, via
 * the resend hint, send the saved copy back as a native sticker later
 * (`STICKER:<path>` accepts a local image path on the iMessage channel).
 * The hint is only offered when a copy was actually persisted.
 */
export function formatStickerMarker(intendedCount: number, savedPaths: string[], unconvertedCount = 0): string {
  if (intendedCount <= 0) return "";
  const noun = intendedCount === 1 ? "a sticker" : `${intendedCount} stickers`;
  const note = formatUnconvertedNote(unconvertedCount);
  if (savedPaths.length === 0) return `[Sent ${noun}${note}]`;
  return `[Sent ${noun}, saved to: ${savedPaths.join(", ")}${note}; resend with STICKER:<saved path>]`;
}

/**
 * Locate the EXIF Orientation tag (0x0112) in a JPEG buffer.
 *
 * iPhone photos forwarded through iMessage preserve the original
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
 * Patch the EXIF Orientation tag in a JPEG buffer to 1 (in place).
 * Returns true if a tag was found and patched, false otherwise.
 */
function patchOrientationToOne(buffer: Buffer): boolean {
  const found = findExifOrientation(buffer);
  if (!found) return false;
  if (found.endian === "BE") buffer.writeUInt16BE(1, found.valueOffset);
  else buffer.writeUInt16LE(1, found.valueOffset);
  return true;
}

/**
 * Normalize EXIF Orientation on a JPEG buffer: rotate/flip pixels to match
 * the Orientation tag, then patch the tag to 1 so EXIF-aware readers don't
 * double-rotate. macOS-only (uses `sips`). Returns the original buffer
 * unchanged for non-JPEG mime types, orientation=1, or on any failure.
 *
 * Run before either base64-encoding the image for the model or saving it to
 * disk — both code paths must see the same normalized bytes, otherwise the
 * model sees a sideways image even when the saved file looks right.
 *
 * Never throws.
 */
export async function normalizeJpegBuffer(buffer: Buffer, mimeType: string): Promise<Buffer> {
  const mt = mimeType.toLowerCase();
  if (mt !== "image/jpeg" && mt !== "image/jpg") return buffer;

  const found = findExifOrientation(buffer);
  if (!found || found.orientation === 1) return buffer;

  const sipsArgs = orientationToSipsArgs(found.orientation);
  if (!sipsArgs) {
    log.warn({ orientation: found.orientation, bytes: buffer.length }, "Unsupported EXIF orientation; passing buffer through");
    return buffer;
  }

  const tmpPath = join(tmpdir(), `tomo-norm-${randomUUID()}.jpg`);
  let deadline: NodeJS.Timeout | undefined;
  try {
    await writeFile(tmpPath, buffer);
    // This runs on the inbound FIFO too, so an unbounded `sips` here stalls
    // every subsequent message and hangs `quiesce()`. `timeout` makes Node
    // kill the child; the racing deadline makes the AWAIT bounded even if the
    // child cannot be killed, which is the part that actually protects the
    // FIFO. Either way the catch below returns the original bytes.
    await Promise.race([
      execFileP("sips", [...sipsArgs, tmpPath], { timeout: SIPS_TIMEOUT_MS, killSignal: "SIGKILL" }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`sips orientation normalize did not exit within ${SIPS_TIMEOUT_MS + 5_000}ms`)),
          SIPS_TIMEOUT_MS + 5_000,
        );
        deadline.unref?.();
      }),
    ]);
    const rotated = await readFile(tmpPath);
    patchOrientationToOne(rotated);
    log.info({ fromOrientation: found.orientation, bytes: rotated.length }, "Normalized JPEG buffer orientation");
    return rotated;
  } catch (err) {
    log.error({ err, orientation: found.orientation }, "Failed to normalize JPEG buffer; returning original");
    return buffer;
  } finally {
    if (deadline) clearTimeout(deadline);
    await unlink(tmpPath).catch(() => undefined);
  }
}

/**
 * Save an inbound image to disk. The caller should pass an already-normalized
 * buffer (see {@link normalizeJpegBuffer}); this function does not normalize
 * because the base64 payload sent to the model must match what's on disk, and
 * the channel layer is the only place that sees both sides of the split.
 *
 * Never throws — errors are logged and `null` is returned so the message flow
 * can continue unimpeded.
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
