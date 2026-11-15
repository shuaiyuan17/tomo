import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { convertHeicImage, heicHasAlpha } from "../channels/heic.js";
import { sniffImageType } from "./data.js";

/**
 * Images the owner attached in the browser, between upload and send.
 *
 * The web process stages each upload under `<tomoHome>/data/web/uploads/`
 * as `<id>.<ext>` (a random 128-bit id; the type from the file's own leading
 * bytes, never from the browser). Sending a message names the ids; the
 * daemon then TAKES them (read + delete) and files them through the
 * channels' own inbound image store (`memory/incoming-images/…`, the same
 * names and marker as Telegram and iMessage). An upload never sent expires
 * after UPLOAD_TTL_MS and is swept.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_IMAGES = 6;
export const UPLOAD_TTL_MS = 60 * 60 * 1000;
/** Staged uploads kept at once (all sessions, all tabs); past this a new one is refused. */
export const MAX_STAGED_UPLOADS = 64;
export const UPLOAD_ID = /^[a-f0-9]{32}$/;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic" };
const TYPE_OF = Object.fromEntries(Object.entries(EXT).map(([type, ext]) => [ext, type]));

export const uploadsDir = (tomoHome: string) => join(tomoHome, "data", "web", "uploads");

export class UploadError extends Error {
  constructor(readonly code: "not_image" | "too_large" | "upload_limit" | "upload_missing") { super(code); }
}

/** Remove staged uploads older than the TTL. Returns how many remain. */
export function sweepUploads(dir: string, now = Date.now()): number {
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let left = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > UPLOAD_TTL_MS) unlinkSync(path);
      else left++;
    } catch { /* gone already */ }
  }
  return left;
}

/**
 * Web process, before staging: HEIC becomes JPEG (PNG when it has alpha), as
 * the iMessage channel does — the model cannot read HEIC. A failed
 * conversion keeps the original; the daemon's marker then says so.
 */
export async function convertUpload(bytes: Buffer): Promise<Buffer> {
  if (sniffImageType(bytes.subarray(0, 16)) !== "image/heic") return bytes;
  const dir = await mkdtemp(join(tmpdir(), "tomo-web-heic-"));
  try {
    const source = join(dir, "upload.heic");
    await writeFile(source, bytes, { mode: 0o600 });
    const out = await convertHeicImage(source, (await heicHasAlpha(source)) === true ? "png" : "jpeg");
    if (!out) return bytes;
    try { return await readFile(out); } finally { await rm(out, { force: true }); }
  } catch { return bytes; }
  finally { await rm(dir, { recursive: true, force: true }); }
}

/** Web process: check and stage one upload. */
export function stageUpload(dir: string, bytes: Buffer, now = Date.now()): { uploadId: string; type: string; size: number } {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadError("too_large");
  const type = sniffImageType(bytes.subarray(0, 16));
  if (!type) throw new UploadError("not_image");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (sweepUploads(dir, now) >= MAX_STAGED_UPLOADS) throw new UploadError("upload_limit");
  const uploadId = randomBytes(16).toString("hex");
  writeFileSync(join(dir, `${uploadId}.${EXT[type]}`), bytes, { flag: "wx", mode: 0o600 });
  return { uploadId, type, size: bytes.length };
}

/** Web process: drop a staged upload the owner removed (× on its thumbnail). */
export function discardUpload(dir: string, uploadId: string): void {
  if (!UPLOAD_ID.test(uploadId)) return;
  for (const ext of Object.values(EXT)) { try { unlinkSync(join(dir, `${uploadId}.${ext}`)); } catch { /* not this one */ } }
}

/**
 * Daemon: read one staged upload WITHOUT removing it (it goes only once the
 * message that names it is durably recorded — see removeUpload). Undefined
 * when the id is malformed, unknown, expired, or no longer an image by its bytes.
 */
export function readUpload(dir: string, uploadId: string, now = Date.now()): { bytes: Buffer; type: string } | undefined {
  if (!UPLOAD_ID.test(uploadId)) return undefined;
  for (const ext of Object.values(EXT)) {
    let fd: number;
    try { fd = openSync(join(dir, `${uploadId}.${ext}`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { continue; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_UPLOAD_BYTES || now - stat.mtimeMs > UPLOAD_TTL_MS) return undefined;
      const bytes = readFileSync(fd);
      const type = sniffImageType(bytes.subarray(0, 16));
      return type && type === TYPE_OF[ext] ? { bytes, type } : undefined;
    } finally { closeSync(fd); }
  }
  return undefined;
}

/** Daemon: remove staged uploads once their message is recorded. */
export function removeUploads(dir: string, uploadIds: readonly string[]): void {
  for (const id of uploadIds) discardUpload(dir, id);
}

/**
 * Daemon: CLAIM every upload of one message, atomically per file — each is
 * renamed to `<name>.claim-<tag>` (a rename either happens or not, so two
 * messages naming one upload cannot both get it) — then read and checked
 * (unexpired, an image). Every id is checked before any is used: a
 * duplicate, a missing or a bad one releases the claims taken so far and
 * answers undefined, leaving every upload as it was. `release` puts the
 * files back (the message was not recorded: the page may retry the ids);
 * `finalize` removes them (it was).
 */
/**
 * Daemon start: claims a crash left behind (claimed, receipt maybe not
 * written). A claim whose request has a receipt was recorded — its staged
 * copy is no longer needed and goes. Any other goes back to staging under
 * its original upload id, so the page can send it again. Returns how many
 * were put back.
 */
export function recoverClaims(dir: string, recorded: (requestId: string) => boolean): number {
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let restored = 0;
  for (const name of names) {
    const match = /^([a-f0-9]{32}\.[a-z]+)\.claim-([A-Za-z0-9-]{1,64})$/.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    try {
      if (recorded(match[2])) unlinkSync(path);
      else { renameSync(path, join(dir, match[1])); restored++; }
    } catch { /* raced */ }
  }
  return restored;
}

export interface UploadClaim { files: Array<{ id: string; bytes: Buffer; type: string }>; release(): void; finalize(): void }
export function claimUploads(dir: string, uploadIds: readonly string[], tag: string, now = Date.now()): UploadClaim | undefined {
  if (new Set(uploadIds).size !== uploadIds.length || !/^[A-Za-z0-9-]{1,64}$/.test(tag)) return undefined;
  const claimed: Array<{ id: string; from: string; to: string; ext: string }> = [];
  const release = () => { for (const c of claimed.splice(0)) { try { renameSync(c.to, c.from); } catch { /* swept */ } } };
  for (const id of uploadIds) {
    if (!UPLOAD_ID.test(id)) { release(); return undefined; }
    let got = false;
    for (const ext of Object.values(EXT)) {
      const from = join(dir, `${id}.${ext}`);
      const to = `${from}.claim-${tag}`;
      try { renameSync(from, to); } catch { continue; }
      claimed.push({ id, from, to, ext });
      got = true;
      break;
    }
    if (!got) { release(); return undefined; }
  }
  const files: UploadClaim["files"] = [];
  for (const c of claimed) {
    let fd: number | undefined;
    try {
      fd = openSync(c.to, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_UPLOAD_BYTES || now - stat.mtimeMs > UPLOAD_TTL_MS) throw new Error("bad");
      const bytes = readFileSync(fd);
      const type = sniffImageType(bytes.subarray(0, 16));
      if (!type || type !== TYPE_OF[c.ext]) throw new Error("bad");
      files.push({ id: c.id, bytes, type });
    } catch { release(); return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return { files, release, finalize: () => { for (const c of claimed.splice(0)) { try { unlinkSync(c.to); } catch { /* gone */ } } } };
}
