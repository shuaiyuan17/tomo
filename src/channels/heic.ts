import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";

/**
 * HEIC/HEIF normalization for inbound iMessage attachments.
 *
 * The imsg channel asks the CLI to convert attachments (`convert_attachments:
 * true`), but that conversion is not reliable — it emits a converted JPEG for
 * some rows (observed on a DM photo) while leaving others as raw HEIC (observed
 * on group photos on 2026-07-07). The harness image reader can't display HEIC,
 * so any un-converted HEIC lands unreadable. This module is the channel-side
 * fallback: detect HEIC by mime, extension, or magic bytes and convert with
 * macOS `sips` so the image lands as JPEG regardless of DM vs group.
 */

const HEIC_MIME_RE = /^image\/(heic|heif)(-sequence)?$/i;

/** True for the HEIC/HEIF image mime types (incl. the `-sequence` variants). */
export function isHeicMimeType(mime: string | undefined): boolean {
  return typeof mime === "string" && HEIC_MIME_RE.test(mime.trim());
}

/** True when the path ends in a HEIC/HEIF extension (case-insensitive). */
export function hasHeicExtension(path: string): boolean {
  return /\.(heic|heif)$/i.test(path);
}

// ISO-BMFF `ftyp` brands that mark a HEIF/HEIC still image or sequence. iPhone
// captures typically advertise major brand `heic` with compatible brands
// `mif1`/`miaf`/... ; screenshots and Live Photos can lead with `mif1`/`msf1`.
const HEIC_BRANDS = new Set([
  "heic", "heix", "heim", "heis",
  "hevc", "hevx", "hevm", "hevs",
  "mif1", "msf1", "heif",
]);

/**
 * Sniff HEIF/HEIC from the leading bytes of a file. The ISO base-media `ftyp`
 * box lives at offset 4 (`....ftyp<major_brand><minor_version><compat...>`);
 * we match the major brand and every compatible brand against the HEIF set so
 * a mislabeled or extension-less attachment is still caught.
 */
export function sniffHeic(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer.toString("ascii", 4, 8) !== "ftyp") return false;

  const major = buffer.toString("ascii", 8, 12).trim().toLowerCase();
  if (HEIC_BRANDS.has(major)) return true;

  // Compatible brands run from offset 16 up to the ftyp box size.
  const boxSize = buffer.readUInt32BE(0);
  const end = Math.min(boxSize >= 16 ? boxSize : buffer.length, buffer.length);
  for (let off = 16; off + 4 <= end; off += 4) {
    const brand = buffer.toString("ascii", off, off + 4).trim().toLowerCase();
    if (HEIC_BRANDS.has(brand)) return true;
  }
  return false;
}

/** True when an attachment should be treated as HEIC by any available signal. */
export function looksLikeHeic(mime: string | undefined, filePath: string, buffer: Buffer): boolean {
  return isHeicMimeType(mime) || hasHeicExtension(filePath) || sniffHeic(buffer);
}

/**
 * Convert a HEIC/HEIF file to JPEG via macOS `sips`, returning the path to a
 * freshly written temp `.jpg` (caller reads then unlinks it), or `null` on any
 * failure. Spawned with an args array (never a shell string) and never throws —
 * a failed convert must leave the caller free to fall back to the original.
 */
export function convertHeicToJpeg(srcPath: string): Promise<string | null> {
  const outPath = join(tmpdir(), `tomo-heic-${randomUUID()}.jpg`);
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const done = (result: string | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn("sips", ["-s", "format", "jpeg", srcPath, "--out", outPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      log.error({ err, srcPath }, "sips HEIC->JPEG spawn failed; keeping original attachment");
      done(null);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        log.info({ srcPath, outPath }, "Converted HEIC attachment to JPEG");
        done(outPath);
      } else {
        log.error({ srcPath, code, stderr: stderr.trim().slice(0, 200) }, "sips HEIC->JPEG failed; keeping original attachment");
        done(null);
      }
    });
  });
}
