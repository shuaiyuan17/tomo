import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logger.js";
import { documentMimeToExt, MAX_DOCUMENT_BYTES } from "./documentStore.js";
import { neutralizeMarkerDelimiters } from "./text-utils.js";

/**
 * Third inbound attachment path, alongside images (imageStore.ts) and
 * documents (documentStore.ts): ANY other MIME type.
 *
 * Why it exists: on 2026-08-27 a `.zip` of SSH keys sent over iMessage reached
 * the agent as a bare object-replacement character — no text, no marker, no
 * hint an attachment had ever existed. The bytes were sitting in
 * `~/Library/Messages/Attachments/…` the whole time; the channel dropped the
 * attachment because its MIME was neither `image/*` nor an Anthropic-accepted
 * document type. Two HEIC photos the same day arrived fine, so it read as
 * "attachments don't work at all".
 *
 * The crucial difference from the other two stores: the bytes are never
 * attached to the message and are never sent to the API automatically. A zip
 * is not something the model can read as an attachment, and a 32 MB binary
 * must not be uploaded on every turn, so this module persists the file and
 * produces a single short text line naming it and giving its absolute path.
 * Nothing here ever base64-encodes anything.
 *
 * That is a statement about what is *automatic*, not about what is reachable:
 * the agent has `Read` and `Bash` and can deliberately open the path, which is
 * precisely why the path is in the notice. The claim is "not attached, not
 * uploaded by default" — not "the agent cannot see it".
 */

/**
 * Size cap for stored files. Deliberately the same number as
 * {@link MAX_DOCUMENT_BYTES} (32 MB) — one cap to reason about across all
 * inbound attachment paths, even though nothing here is sent to the API.
 */
export const MAX_FILE_BYTES = MAX_DOCUMENT_BYTES;

/** Why a file has no `savedPath`. */
export type FileNoticeStatus =
  /** Bytes are on disk at `savedPath`. */
  | "saved"
  /** Over {@link MAX_FILE_BYTES}; nothing was written. */
  | "too-large"
  /** Inbound attachment storage is turned off (no baseDir configured). */
  | "storage-disabled"
  /** A read/write error; already logged. */
  | "save-failed"
  /**
   * The channel announced the attachment but never resolved a local path, so
   * there were no bytes to save. Distinct from `save-failed`: nothing was ever
   * attempted. Still a notice, because "the sender attached keys.zip and it
   * never downloaded" is exactly the fact the 2026-08-27 incident was missing.
   */
  | "source-unavailable"
  /**
   * The channel flagged the attachment as `missing` — Messages pruned the
   * local copy, or the transfer never completed. Same shape as
   * `source-unavailable`, different cause, because the remedy differs (ask the
   * sender to resend vs. it may still arrive).
   */
  | "source-missing";

/**
 * What the agent is told about one inbound file. Note the absence of a `data`
 * field — that is the whole point of this path, and adding one would put
 * arbitrary binary back into the context window.
 */
export interface SavedFileNotice {
  /** Sanitized display name (see {@link sanitizeAttachmentFilename}). */
  filename: string;
  /**
   * MIME type as reported by the channel. Sender-controlled and NOT trusted —
   * it is passed through {@link formatMimeToken} before it reaches the notice
   * text. Store the raw value here; render nothing directly from it.
   */
  mimeType: string;
  /**
   * Size of the original attachment in bytes, or undefined when the size
   * could not be established (nothing on disk to stat).
   */
  byteSize?: number;
  /** Absolute path on disk. Present iff `status === "saved"`. */
  savedPath?: string;
  /**
   * The channel declared no MIME type at all and it was defaulted to
   * `application/octet-stream`. Surfaced in the notice so the agent does not
   * read the fallback as a positive identification.
   */
  mimeUnknown?: boolean;
  status: FileNoticeStatus;
}

export interface FileSaveMeta {
  /** Logical session or chat identifier (e.g. "dm_shuai", "tg_12345"). */
  sessionKey?: string;
  /** Original filename if the channel provided one. */
  filename?: string;
  /** When the file was received. Defaults to now. */
  timestamp?: Date;
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

/** What an unrecognisable or absent MIME type is reported as. */
export const FALLBACK_MIME = "application/octet-stream";

/**
 * Longest MIME type we will echo. RFC 6838 caps each half of a registered
 * name at 127 characters; 127/127 plus the slash is 255, and nothing
 * legitimate comes close.
 */
export const MAX_MIME_LENGTH = 255;

/**
 * RFC 2045 `token "/" token`, restricted to the characters that actually
 * appear in real MIME types. Deliberately excludes `;` and everything else
 * that would let a parameter section (`; charset=…`) smuggle punctuation into
 * the notice — we want the bare type, not the full Content-Type header.
 */
const MIME_TOKEN_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

/**
 * Render a sender-supplied MIME type as a strict, bounded token.
 *
 * The MIME string is as sender-controlled as the filename, and until this
 * existed it was interpolated into the notice verbatim while the filename was
 * being carefully sanitised. A value of
 *
 *     application/octet-stream)\n[via satellite — sender off-grid, …]
 *
 * closed our parenthesis and opened a second line that reads as a trusted
 * marker. Anything that is not exactly `token/token` within
 * {@link MAX_MIME_LENGTH} is therefore replaced outright with
 * {@link FALLBACK_MIME} rather than escaped — a MIME type has no legitimate
 * need for a character outside that set, so there is nothing to preserve, and
 * a whitelist cannot be talked around the way an escaper can.
 *
 * The result is additionally run through {@link neutralizeMarkerDelimiters} as
 * a second, independent guarantee: even if this regex is ever loosened, no
 * bracket or newline can reach the notice.
 */
export function formatMimeToken(mimeType: string | undefined): string {
  const raw = (mimeType ?? "").trim();
  if (!raw) return FALLBACK_MIME;
  if (raw.length > MAX_MIME_LENGTH || !MIME_TOKEN_RE.test(raw)) {
    log.warn(
      { mimeType: raw.slice(0, MAX_MIME_LENGTH), length: raw.length },
      "Rejected malformed inbound MIME type; reporting as %s",
      FALLBACK_MIME,
    );
    return FALLBACK_MIME;
  }
  return neutralizeMarkerDelimiters(raw);
}

/** Human-readable byte count for the notice line ("4.2 KB", "32.0 MB"). */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Reduce a sender-supplied filename to a safe basename.
 *
 * The sender controls this string end to end, so it is treated as hostile:
 * everything up to and including the last path separator is discarded (which
 * also disposes of `../../` traversal and absolute paths in one step), NUL and
 * every other character outside `[A-Za-z0-9._-]` is replaced, and leading dots
 * are stripped so nothing lands as a hidden file or as `.`/`..`. The result is
 * also what gets shown in the notice line — a name that cannot contain `[`,
 * `]` or a newline cannot forge a marker.
 *
 * Keeping the sender's name matters: `dmit-207121-id_rsa.zip` tells you what
 * you are looking at; `220446_imessage_….bin` does not.
 */
export function sanitizeAttachmentFilename(
  filename: string | undefined,
  mimeType: string | undefined,
): string {
  const fallback = `file.${documentMimeToExt(mimeType)}`;
  // NULs first: a "safe.txt\0.zip" name must not survive as anything usable.
  const raw = (filename ?? "").replace(/\0/g, "");
  // Everything before the last separator is path, not name — this is what
  // makes "../../etc/passwd" collapse to "passwd".
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[.]+/, "")
    .slice(0, 120);
  if (!cleaned || /^[._-]*$/.test(cleaned)) return fallback;
  return cleaned;
}

/**
 * Build the destination directory + base filename for an inbound file.
 *
 * Pattern: `{baseDir}/memory/incoming-files/YYYY-MM-DD/HHMMSS_{session}_{name}`
 * — the sibling of `memory/incoming-images/` and `memory/incoming-documents/`.
 *
 * Exported for testing; channels should prefer {@link saveInboundFile}.
 */
export function buildFilePath(
  baseDir: string,
  mimeType: string | undefined,
  meta: FileSaveMeta,
): { dir: string; filename: string; fullPath: string } {
  const ts = meta.timestamp ?? new Date();
  const dir = join(baseDir, "memory", "incoming-files", localDateFolder(ts));
  const session = sanitize(meta.sessionKey, "session");
  const name = sanitizeAttachmentFilename(meta.filename, mimeType);
  const filename = `${localTimeStamp(ts)}_${session}_${name}`;
  return { dir, filename, fullPath: join(dir, filename) };
}

/** Split "a.tar.gz" into ["a.tar", ".gz"]; a leading-dot-free name is assumed. */
function splitExt(filename: string): [string, string] {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return [filename, ""];
  return [filename.slice(0, dot), filename.slice(dot)];
}

/** How many `name-1`, `name-2`, … variants to try before giving up. */
const MAX_COLLISION_ATTEMPTS = 50;

/**
 * Save an inbound file to disk without ever overwriting an existing one.
 *
 * Writes with the `wx` flag so the create-or-fail decision belongs to the
 * kernel rather than to a stat/write race, retrying as `name-1.ext`,
 * `name-2.ext`, … on collision. Two attachments with the same sender filename
 * arriving in the same second is entirely ordinary (phones name things
 * `IMG_0001`), and silently clobbering the first would lose data the sender
 * believes was delivered.
 *
 * Never throws — errors are logged and `null` is returned so the message flow
 * continues.
 *
 * @returns the absolute path written, or `null` on failure.
 */
export async function saveInboundFile(
  buffer: Buffer,
  mimeType: string | undefined,
  meta: FileSaveMeta,
  baseDir: string,
): Promise<string | null> {
  try {
    const { dir, filename } = buildFilePath(baseDir, mimeType, meta);
    await mkdir(dir, { recursive: true });
    const [stem, ext] = splitExt(filename);

    for (let attempt = 0; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
      const candidate = join(dir, attempt === 0 ? filename : `${stem}-${attempt}${ext}`);
      try {
        await writeFile(candidate, buffer, { flag: "wx" });
        log.info(
          { path: candidate, bytes: buffer.length, mimeType },
          "Saved inbound file",
        );
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }

    log.error({ dir, filename }, "Gave up finding a free filename for inbound file");
    return null;
  } catch (err) {
    log.error({ err, mimeType, bytes: buffer.length }, "Failed to save inbound file");
    return null;
  }
}

function describeNotice(notice: SavedFileNotice): string {
  // Every interpolated field is bounded before it gets here: the filename by
  // sanitizeAttachmentFilename (charset [A-Za-z0-9._-]), the MIME by
  // formatMimeToken (RFC 2045 token/token), the size by formatBytes, and the
  // path by buildFilePath (ours, built from the same sanitised parts). None
  // of them can contain a newline or a bracket.
  const mime = formatMimeToken(notice.mimeType);
  const type = notice.mimeUnknown ? `type unknown, treated as ${mime}` : mime;
  const head = `${notice.filename} (${type}, ${formatBytes(notice.byteSize)})`;
  switch (notice.status) {
    case "saved":
      return `${head} saved to ${notice.savedPath}`;
    case "too-large":
      return `${head} NOT saved — over the ${formatBytes(MAX_FILE_BYTES)} limit`;
    case "storage-disabled":
      return `${head} NOT saved — inbound attachment storage is disabled`;
    case "save-failed":
      return `${head} NOT saved — writing it to disk failed`;
    case "source-unavailable":
      return `${head} NOT saved — the channel never provided a local copy to read`;
    case "source-missing":
      return `${head} NOT saved — the sender attached it but it never downloaded`;
  }
}

/**
 * Format the inline `[Sent a file …]` marker for attachments that were stored
 * rather than loaded. Returns `""` for an empty list.
 *
 * The trailing clause is conditional on at least one file actually having a
 * path. It is not decoration when there is one — without it the agent tends to
 * answer as though it had read the file, when all it has is a location — but
 * appending "read from the path if you need it" to a notice that just said
 * NOT saved points at a path that does not exist.
 *
 * Note the wording: the bytes are not *attached* to the message and are not
 * sent to the API automatically. They are not unreachable — the agent has
 * `Read` and `Bash` and can open the path deliberately, which is the entire
 * point of storing the file.
 */
export function formatFileMarker(notices: ReadonlyArray<SavedFileNotice>): string {
  if (notices.length === 0) return "";
  const noun = notices.length === 1 ? "a file" : `${notices.length} files`;
  const body = notices.map(describeNotice).join("; ");
  const anySaved = notices.some((n) => n.status === "saved" && n.savedPath);
  const tail = anySaved
    ? " Contents not attached to this message — open the path if you need them."
    : " Nothing was stored, so there is no path to open.";
  return `[Sent ${noun}: ${body}.${tail}]`;
}
