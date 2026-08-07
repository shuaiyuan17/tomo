import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
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
 * macOS `sips` regardless of DM vs group. The target format is the caller's
 * choice: PNG when the source carries alpha (iMessage stickers arrive as
 * transparent HEIC; a JPEG rendition flattens the transparency to a solid
 * background), JPEG for ordinary photos.
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

/** Output formats the HEIC converter can target. */
export type HeicTargetFormat = "jpeg" | "png";

/**
 * Probe whether an image file carries an alpha channel, via `sips -g
 * hasAlpha`. Returns `true`/`false` on a clean probe, `null` on any failure
 * (sips missing, unreadable file, unparseable output) — the caller decides
 * what "unknown" means for its context. Never throws.
 *
 * Why it matters: JPEG cannot carry alpha, so converting a transparent HEIC
 * (an iMessage sticker, a cut-out subject) to JPEG silently flattens the
 * transparent background to a solid color. The probe lets the converter pick
 * PNG for exactly those files without paying PNG's size cost on ordinary
 * photos.
 */
export function heicHasAlpha(srcPath: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (result: boolean | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn("sips", ["-g", "hasAlpha", srcPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (err) => {
      log.warn({ err, srcPath }, "sips hasAlpha probe spawn failed");
      done(null);
    });
    child.on("exit", (code) => {
      if (code !== 0) return done(null);
      const match = /hasAlpha:\s*(yes|no)/i.exec(stdout);
      if (!match) {
        log.warn({ srcPath, stdout: stdout.trim().slice(0, 200) }, "sips hasAlpha probe output unparseable");
        return done(null);
      }
      done(match[1].toLowerCase() === "yes");
    });
  });
}

/**
 * Convert a HEIC/HEIF file to JPEG or PNG via macOS `sips`, returning the
 * path to a freshly written temp file (caller reads then unlinks it), or
 * `null` on any failure. The caller picks the target format — PNG when the
 * source carries alpha (JPEG would flatten it), JPEG otherwise. Spawned with
 * an args array (never a shell string) and never throws — a failed convert
 * must leave the caller free to fall back to the original.
 */
export function convertHeicImage(srcPath: string, format: HeicTargetFormat): Promise<string | null> {
  const outPath = join(tmpdir(), `tomo-heic-${randomUUID()}.${format === "png" ? "png" : "jpg"}`);
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const done = (result: string | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    // On any failure the caller only receives `null` and can't clean up, so a
    // partial/corrupt tomo-heic-*.jpg left behind by a non-zero sips exit (or a
    // spawn error) would leak. Unlink it here (best-effort; ENOENT is fine)
    // before resolving null.
    const failWithCleanup = () => {
      unlink(outPath).catch(() => undefined).finally(() => done(null));
    };

    const child = spawn("sips", ["-s", "format", format, srcPath, "--out", outPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      log.error({ err, srcPath, format }, "sips HEIC conversion spawn failed; keeping original attachment");
      failWithCleanup();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        log.info({ srcPath, outPath, format }, "Converted HEIC attachment");
        done(outPath);
      } else {
        log.error({ srcPath, code, format, stderr: stderr.trim().slice(0, 200) }, "sips HEIC conversion failed; keeping original attachment");
        failWithCleanup();
      }
    });
  });
}
