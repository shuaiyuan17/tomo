import { spawn, type ChildProcess } from "node:child_process";
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

/**
 * Hard deadline on a `sips` conversion. Every `sips` here runs on the inbound
 * FIFO (`handleRpcPayload → watchChain → … → normalizeHeicImage`), so a `sips`
 * that never exits does not merely lose one photo: `watchChain` is strict FIFO,
 * so no further inbound message in ANY chat is dispatched, and `quiesce()` —
 * literally `await this.watchChain` — never returns, so shutdown hangs too. One
 * malformed HEIC was a permanent inbound DoS plus an unkillable daemon.
 *
 * 30s is far beyond a real conversion (tens of ms for a phone photo) and well
 * inside a user's patience for a reply.
 */
export const SIPS_TIMEOUT_MS = 30_000;

/**
 * Shorter deadline for the alpha probe: `sips -g hasAlpha` reads metadata
 * only, so it has no legitimate reason to take seconds, and its result is
 * optional (null just means "assume no alpha").
 */
export const SIPS_PROBE_TIMEOUT_MS = 10_000;

/** Grace between SIGTERM and SIGKILL when a `sips` overruns its deadline. */
const SIPS_KILL_GRACE_MS = 2_000;

/**
 * Arm a deadline on a spawned `sips`. Returns a disarm function to call once
 * the child settles normally.
 *
 * On expiry: `onTimeout()` fires FIRST and is expected to settle the caller's
 * promise, then the child is SIGTERMed and SIGKILLed after a grace. The order
 * is the point — settling must not be conditional on the child actually dying.
 * A process wedged where signals cannot reach it would otherwise leave the
 * promise pending forever, which is precisely the failure being fixed.
 *
 * Both timers are `unref`'d, so the DEADLINE never holds the daemon open by
 * itself. That is not the same as "nothing holds it": the `ChildProcess`
 * handle is ref'd and keeps the event loop alive until the child exits, which
 * is precisely why the SIGTERM/SIGKILL escalation matters. The bound on how
 * long a `sips` can hold the daemon open is `timeoutMs + SIPS_KILL_GRACE_MS`.
 */
function armSipsDeadline(child: ChildProcess, timeoutMs: number, onTimeout: () => void): () => void {
  let fired = false;
  const termTimer = setTimeout(() => {
    fired = true;
    onTimeout();
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    const killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, SIPS_KILL_GRACE_MS);
    killTimer.unref?.();
  }, timeoutMs);
  termTimer.unref?.();

  return () => {
    // Once the deadline has fired, disarming must NOT cancel the escalation.
    // `onTimeout` settles the caller's promise immediately (that is the whole
    // point), and the disarm that follows would otherwise clear the pending
    // SIGKILL — leaving the very `sips` that ignored SIGTERM alive forever.
    if (fired) return;
    clearTimeout(termTimer);
  };
}

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
export function heicHasAlpha(
  srcPath: string,
  timeoutMs: number = SIPS_PROBE_TIMEOUT_MS,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let disarm = () => {};
    const done = (result: boolean | null) => {
      if (settled) return;
      settled = true;
      disarm();
      resolve(result);
    };

    const child = spawn("sips", ["-g", "hasAlpha", srcPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    disarm = armSipsDeadline(child, timeoutMs, () => {
      log.error({ srcPath, timeoutMs }, "sips hasAlpha probe timed out; killing it and assuming no alpha");
      done(null);
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
 *
 * Bounded by `timeoutMs` (overridable only so tests need not wait 30s). On
 * expiry the promise resolves `null` immediately and the child is SIGTERMed,
 * then SIGKILLed after a grace — settling is deliberately NOT conditional on
 * the child dying.
 */
export function convertHeicImage(
  srcPath: string,
  format: HeicTargetFormat,
  timeoutMs: number = SIPS_TIMEOUT_MS,
): Promise<string | null> {
  const outPath = join(tmpdir(), `tomo-heic-${randomUUID()}.${format === "png" ? "png" : "jpg"}`);
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    let disarm = () => {};
    const done = (result: string | null) => {
      if (settled) return;
      settled = true;
      disarm();
      resolve(result);
    };
    // On any failure the caller only receives `null` and can't clean up, so a
    // partial/corrupt tomo-heic-*.jpg left behind by a non-zero sips exit (or a
    // spawn error) would leak. Unlink it here, best-effort; ENOENT is fine.
    //
    // ORDER MATTERS: settle FIRST, then unlink. `unlink` is an unbounded async
    // fs call, and this function is what the timeout path calls — resolving
    // behind it would put an fs operation on the critical path of the very
    // deadline that exists to keep the inbound FIFO moving. The unlink is
    // fire-and-forget.
    const scrubOutput = () => { void unlink(outPath).catch(() => undefined); };
    const failWithCleanup = () => {
      done(null);
      scrubOutput();
    };

    const child = spawn("sips", ["-s", "format", format, srcPath, "--out", outPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    // A timeout is a conversion failure like any other: the caller keeps the
    // original bytes and the message is delivered with a note, rather than the
    // whole inbound FIFO stalling behind one attachment.
    disarm = armSipsDeadline(child, timeoutMs, () => {
      log.error(
        { srcPath, format, timeoutMs },
        "sips HEIC conversion timed out; killing it and keeping original attachment",
      );
      failWithCleanup();
    });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      log.error({ err, srcPath, format }, "sips HEIC conversion spawn failed; keeping original attachment");
      failWithCleanup();
    });
    child.on("exit", (code) => {
      // A child killed at the deadline exits LATER than the scrub above, and
      // may have created or rewritten outPath in between (it had up to
      // SIPS_KILL_GRACE_MS still running). `settled` makes `done` a no-op by
      // then, so scrub again unconditionally — otherwise every timed-out
      // conversion can leak a tomo-heic-*.jpg into the temp dir.
      if (settled) {
        scrubOutput();
        return;
      }
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
