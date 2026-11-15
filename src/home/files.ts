import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { ASSET_NAME, MAX_SCENE_BYTES } from "./scene.js";
import { sniffImageType } from "../web/image-type.js";

/**
 * The home's files on disk, read the one careful way both the daemon (scene
 * store, home_check) and the web process (asset route) use:
 *
 *   <workspace>/home/scene.json     the live scene
 *   <workspace>/home/<draft>.json   a draft Tomo checks before replacing it
 *   <workspace>/home/assets/<name>  pictures
 *
 * Nothing is ever followed out of there. `home` and `home/assets` must be
 * real directories at exactly those places (by real path, so neither may be
 * a symlink), every file must be a regular file with a single link (a hard
 * link could alias anything, `memory/private` included), opened with
 * O_NOFOLLOW and read only up to its cap. A name is matched against a closed
 * pattern before it is joined to anything, so `..` and `/` never reach a path.
 *
 * No config, no logger: this module runs in the web process too.
 */

export const HOME_DIR = "home";
export const ASSETS_DIR = "assets";
export const SCENE_FILE = "scene.json";
/** Largest picture served or used. */
export const MAX_ASSET_BYTES = 512 * 1024;
/** Most entries of home/assets/ looked at. */
export const MAX_ASSET_ENTRIES = 256;
/** A file Tomo may name for home_check: a JSON file directly in home/ (never a dot file). */
export const DRAFT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,58}(?:\.[A-Za-z0-9_-]{1,20})*\.json$/;

export const ASSET_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

export type HomeReadError = "missing" | "not_a_file" | "linked" | "too_large" | "outside" | "unreadable";
export type HomeRead = { ok: true; text: string; stat: Stats } | { ok: false; error: HomeReadError };

/**
 * The real path of `<workspace>/home` (or `home/assets`), only if it is a
 * real directory exactly there; undefined otherwise (missing, a symlink, a
 * file, or a workspace that cannot be resolved).
 */
export function homeDirectory(workspaceDir: string, sub?: typeof ASSETS_DIR): string | undefined {
  try {
    const workspace = realpathSync.native(workspaceDir);
    const want = sub ? join(workspace, HOME_DIR, sub) : join(workspace, HOME_DIR);
    const stat = lstatSync(want);
    if (!stat.isDirectory()) return undefined;
    // lstat says it is not a link; realpath confirms no component above moved it.
    return realpathSync.native(want) === want ? want : undefined;
  } catch { return undefined; }
}

/** Reads at most `limit` bytes of an already-opened regular file; refuses more. */
function readOpened(fd: number, limit: number): { text?: Buffer; stat: Stats; error?: HomeReadError } {
  const stat = fstatSync(fd);
  if (!stat.isFile()) return { stat, error: "not_a_file" };
  if (stat.nlink !== 1) return { stat, error: "linked" };
  if (stat.size > limit) return { stat, error: "too_large" };
  const buffer = Buffer.alloc(Math.min(stat.size, limit) + 1);
  let length = 0;
  while (length < buffer.length) {
    const n = readSync(fd, buffer, length, buffer.length - length, null);
    if (n === 0) break;
    length += n;
  }
  if (length > limit) return { stat, error: "too_large" };
  return { text: buffer.subarray(0, length), stat };
}

/**
 * Opens a file without following a link in its last component, then checks
 * that the path still resolves to exactly itself and to the inode that was
 * opened: a directory above it swapped for a link between the containment
 * check and the open is refused (as "linked"), not read.
 */
function openNoFollow(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    const now = lstatSync(path);
    if (realpathSync.native(path) !== path || now.ino !== opened.ino || now.dev !== opened.dev) {
      throw Object.assign(new Error("moved"), { code: "ELOOP" });
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

/**
 * Reads `home/<name>` (the scene, or a draft). `name` must match DRAFT_NAME;
 * anything else reads as outside.
 */
export function readHomeJson(workspaceDir: string, name: string = SCENE_FILE): HomeRead {
  if (!DRAFT_NAME.test(name)) return { ok: false, error: "outside" };
  const home = homeDirectory(workspaceDir);
  if (!home) return { ok: false, error: "missing" };
  const path = join(home, name);
  let fd: number;
  try { fd = openNoFollow(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, error: code === "ENOENT" ? "missing" : code === "ELOOP" || code === "EMLINK" ? "linked" : "unreadable" };
  }
  try {
    const read = readOpened(fd, MAX_SCENE_BYTES);
    if (read.error || !read.text) return { ok: false, error: read.error ?? "unreadable" };
    return { ok: true, text: read.text.toString("utf8"), stat: read.stat };
  } catch { return { ok: false, error: "unreadable" }; }
  finally { closeSync(fd); }
}

/** Plain words for a read error of `home/<name>`, for problems and the tool. */
export function describeHomeReadError(name: string, error: HomeReadError): string {
  switch (error) {
    case "missing": return `home/${name} does not exist; write the scene there (the starter is in the home skill).`;
    case "not_a_file": return `home/${name} is not an ordinary file; replace it with a JSON file.`;
    case "linked": return `home/${name} is a link (symbolic or hard); the home only reads ordinary files, so write the scene as a plain file there.`;
    case "too_large": return `home/${name} is larger than ${MAX_SCENE_BYTES / 1024} KiB; use kinds for repeated things instead of copying them.`;
    case "outside": return `${JSON.stringify(name)} is not a file directly in home/; name a .json file there, like "draft.json".`;
    case "unreadable": return `home/${name} could not be read; check that it is a plain file Tomo can read.`;
  }
}

export interface HomeAsset { name: string; size: number; mtimeMs: number; ino: number }
export interface HomeAssets {
  /** Pictures that can be used: a name ASSET_NAME accepts, an ordinary single-link file, at most MAX_ASSET_BYTES, content of the type its extension says. */
  usable: HomeAsset[];
  /** Files in assets/ that cannot be used, and why (for problems). */
  refused: Map<string, string>;
}

/** SVG by content: text whose first element (after a BOM, an XML declaration, comments, a doctype) is <svg. */
export function looksLikeSvg(head: Buffer): boolean {
  const text = head.toString("utf8").replace(/^\uFEFF/, "");
  if (text.includes("\u0000")) return false;
  const rest = text.replace(/^\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*/i, "");
  return /^<svg[\s>]/i.test(rest);
}

/** The content type of an asset whose bytes agree with its name's extension; undefined when they do not. */
export function assetType(name: string, head: Buffer): string | undefined {
  const ext = /\.([a-z]+)$/.exec(name)?.[1] ?? "";
  const type = ASSET_TYPES[ext];
  if (!type) return undefined;
  if (type === "image/svg+xml") return looksLikeSvg(head) ? type : undefined;
  return sniffImageType(head.subarray(0, 16)) === type ? type : undefined;
}

/** The pictures in home/assets/ (sync; bounded by MAX_ASSET_ENTRIES). */
export function listHomeAssets(workspaceDir: string): HomeAssets {
  const result: HomeAssets = { usable: [], refused: new Map() };
  const dir = homeDirectory(workspaceDir, ASSETS_DIR);
  if (!dir) return result;
  let names: string[];
  try { names = readdirSync(dir).sort().slice(0, MAX_ASSET_ENTRIES); } catch { return result; }
  for (const name of names) {
    if (!ASSET_NAME.test(name)) continue;
    const read = readAsset(dir, name, 4096);
    if ("error" in read) result.refused.set(name, read.error);
    else result.usable.push({ name, size: read.stat.size, mtimeMs: read.stat.mtimeMs, ino: read.stat.ino });
  }
  return result;
}

/**
 * One asset, by name, from the real `home/assets` directory: everything the
 * serving route needs. `headOnly` reads only that many bytes (for listing).
 */
function readAsset(dir: string, name: string, headOnly?: number): { bytes: Buffer; type: string; stat: Stats } | { error: string } {
  let fd: number;
  try { fd = openNoFollow(join(dir, name)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { error: code === "ELOOP" ? "it is a symbolic link; pictures must be ordinary files" : "it cannot be read" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { error: "it is not an ordinary file" };
    if (stat.nlink !== 1) return { error: "it is a hard link; copy the picture in as its own file" };
    if (stat.size > MAX_ASSET_BYTES) return { error: `it is ${Math.ceil(stat.size / 1024)} KiB; a picture can be at most ${MAX_ASSET_BYTES / 1024} KiB` };
    const want = headOnly ? Math.min(headOnly, stat.size) : stat.size;
    const bytes = Buffer.alloc(want);
    let length = 0;
    while (length < want) { const n = readSync(fd, bytes, length, want - length, null); if (n === 0) break; length += n; }
    if (!headOnly && length !== stat.size) return { error: "it changed while being read" };
    const type = assetType(name, bytes.subarray(0, length));
    if (!type) return { error: `its content is not the kind of image its name ends with (.${name.split(".").pop()})` };
    return { bytes: bytes.subarray(0, length), type, stat };
  } catch { return { error: "it cannot be read" }; }
  finally { closeSync(fd); }
}

/** A picture for the browser, or undefined (not found, refused). */
export function readHomeAsset(workspaceDir: string, name: string): { bytes: Buffer; type: string } | undefined {
  if (!ASSET_NAME.test(name)) return undefined;
  const dir = homeDirectory(workspaceDir, ASSETS_DIR);
  if (!dir) return undefined;
  const read = readAsset(dir, name);
  return "error" in read ? undefined : { bytes: read.bytes, type: read.type };
}
