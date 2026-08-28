import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logger.js";
import { documentMimeToExt, MAX_DOCUMENT_BYTES } from "./documentStore.js";

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
 * The crucial difference from the other two stores: the bytes NEVER enter the
 * model's context. A zip is unreadable to the model and a 32 MB binary must
 * not reach the API, so this module persists the file and produces a single
 * short text line naming it and giving its absolute path. Nothing here ever
 * base64-encodes anything.
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
  | "save-failed";

/**
 * What the agent is told about one inbound file. Note the absence of a `data`
 * field — that is the whole point of this path, and adding one would put
 * arbitrary binary back into the context window.
 */
export interface SavedFileNotice {
  /** Sanitized display name (see {@link sanitizeAttachmentFilename}). */
  filename: string;
  /** MIME type as reported by the channel. */
  mimeType: string;
  /** Size of the original attachment in bytes. */
  byteSize: number;
  /** Absolute path on disk. Present iff `status === "saved"`. */
  savedPath?: string;
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

/** Human-readable byte count for the notice line ("4.2 KB", "32.0 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
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
  const head = `${notice.filename} (${notice.mimeType || "unknown type"}, ${formatBytes(notice.byteSize)})`;
  switch (notice.status) {
    case "saved":
      return `${head} saved to ${notice.savedPath}`;
    case "too-large":
      return `${head} NOT saved — over the ${formatBytes(MAX_FILE_BYTES)} limit`;
    case "storage-disabled":
      return `${head} NOT saved — inbound attachment storage is disabled`;
    case "save-failed":
      return `${head} NOT saved — writing it to disk failed`;
  }
}

/**
 * Format the inline `[Sent a file …]` marker for attachments that were stored
 * rather than loaded. The trailing clause is not decoration: without it the
 * agent tends to answer as though it had read the file, when all it has is a
 * path. Returns `""` for an empty list.
 */
export function formatFileMarker(notices: ReadonlyArray<SavedFileNotice>): string {
  if (notices.length === 0) return "";
  const noun = notices.length === 1 ? "a file" : `${notices.length} files`;
  const body = notices.map(describeNotice).join("; ");
  return `[Sent ${noun}: ${body}. Contents not loaded into context — read from the path if you need it]`;
}
