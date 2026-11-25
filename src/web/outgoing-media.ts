import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { sniffImageType } from "./image-type.js";
import { MEDIA_RE, STICKER_RE } from "../agent/text-utils.js";
import { MAX_FILE_BYTES, sanitizeAttachmentFilename } from "../channels/fileStore.js";

/**
 * Images the agent SENT, as the web UI shows them (`MEDIA:<path>` /
 * a path `STICKER:<path>` in a reply). The path is the model's: it can name
 * anything, and a /tmp file is soon gone. So at delivery the web channel
 * COPIES the picture into this store (`<workspace>/memory/outgoing-images/`),
 * under a random id, and records which turn named which path. The browser
 * only ever asks by id; history replaces each tag with the id it was filed
 * under, or with "gone" (an older message, another channel's turn, a refused
 * file) — never the path.
 *
 * Filed only: a regular file outside memory/private (the P0-2 guard, #464).
 * A picture (leading bytes PNG/JPEG/GIF/WebP/HEIC) of at most
 * MAX_OUTGOING_BYTES is shown as one; any other file (a .md, a .pdf, a .zip)
 * of at most MAX_OUTGOING_FILE_BYTES is filed as `<id>.bin` under its
 * sanitised name and shown as a file card. Its bytes are only ever served
 * as a download (application/octet-stream), never rendered by the browser.
 *
 * Filed by the web outlet for a web turn, and (mirrorMedia, channels/web.ts)
 * for a picture or file the owner's conversation delivered on another
 * channel, so the web history shows it too.
 */
export const MAX_OUTGOING_BYTES = 15 * 1024 * 1024;
/** Non-image files: the channels' own inbound file cap (channels/fileStore.ts). */
export const MAX_OUTGOING_FILE_BYTES = MAX_FILE_BYTES;
const ID = /^[a-f0-9]{32}$/;
/** The store's type for a file that is not a picture. */
export const OUTGOING_FILE_TYPE = "application/octet-stream";
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", [OUTGOING_FILE_TYPE]: "bin" };
/**
 * The history token a tag is rewritten to: `MEDIA:web:<id>` (a picture),
 * `MEDIA:web:file:<id>:<bytes>:<name>` (any other file; the name is
 * sanitised to [A-Za-z0-9._-]) or `MEDIA:web:gone`.
 */
export const WEB_MEDIA_TOKEN = "MEDIA:web:";
export interface OutgoingFiled { id: string; type: string; name?: string; size?: number }
const tokenFor = (entry: OutgoingFiled) => entry.type === OUTGOING_FILE_TYPE
  ? `${WEB_MEDIA_TOKEN}file:${entry.id}:${entry.size ?? 0}:${entry.name ?? "file"}` : `${WEB_MEDIA_TOKEN}${entry.id}`;

export function outgoingImagesDir(workspaceDir: string): string { return join(workspaceDir, "memory", "outgoing-images"); }

interface Entry { id: string; type: string; sessionKey: string; keys: string[]; at: number; name?: string; size?: number }
const keyOf = (sessionKey: string, turn: string, path: string) => createHash("sha256").update(`${sessionKey}\0${turn}\0${path}`).digest("hex");
const expand = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

export class OutgoingMediaError extends Error {
  constructor(readonly code: "private" | "missing" | "too_large") { super(code); }
}

export class OutgoingMediaStore {
  private cache?: { stamp: string; entries: Entry[] };
  constructor(private readonly dir: string | undefined, private readonly options: { isPrivate?: (path: string) => boolean } = {}) {}

  /**
   * Daemon side: copy `path` into the store for this turn. `turns`: the ids
   * the recorded message may carry (its requestId, the shared turnId).
   */
  file(sessionKey: string, turns: readonly string[], path: string): OutgoingFiled {
    if (!this.dir) throw new OutgoingMediaError("missing");
    const wanted = expand(path.trim());
    if (!wanted.startsWith("/")) throw new OutgoingMediaError("missing");
    // Asked twice: as written and with symlinks resolved, like the delivery guard.
    if (this.options.isPrivate?.(wanted)) throw new OutgoingMediaError("private");
    let real: string;
    try { real = realpathSync(wanted); } catch { throw new OutgoingMediaError("missing"); }
    if (this.options.isPrivate?.(real)) throw new OutgoingMediaError("private");
    let fd: number;
    try { fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new OutgoingMediaError("missing"); }
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new OutgoingMediaError("missing");
      if (stat.size > Math.max(MAX_OUTGOING_BYTES, MAX_OUTGOING_FILE_BYTES)) throw new OutgoingMediaError("too_large");
      bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, read); if (!n) break; read += n; }
      bytes = bytes.subarray(0, read);
    } finally { closeSync(fd); }
    // A picture too big to show inline is still offered, as a download.
    const sniffed = sniffImageType(bytes.subarray(0, 16));
    const image = sniffed && bytes.length <= MAX_OUTGOING_BYTES ? sniffed : undefined;
    if (!image && bytes.length > MAX_OUTGOING_FILE_BYTES) throw new OutgoingMediaError("too_large");
    const type = image ?? OUTGOING_FILE_TYPE;
    // The name the card shows: the path's last part, sanitised as an inbound file's is.
    const named = image ? {} : { name: sanitizeAttachmentFilename(real.split("/").pop(), undefined), size: bytes.length };
    const id = randomBytes(16).toString("hex");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, `${id}.${EXT[type]}`), bytes, { flag: "wx", mode: 0o600 });
    const entry: Entry = { id, type, sessionKey, keys: [...new Set(turns.filter(Boolean))].map((turn) => keyOf(sessionKey, turn, path.trim())), at: Date.now(), ...named };
    appendFileSync(join(this.dir, "index.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
    return { id, type, ...named };
  }

  /** The index, re-read when it changes (the web process reads what the daemon writes). */
  private entries(): Entry[] {
    if (!this.dir) return [];
    const path = join(this.dir, "index.jsonl");
    let stamp: string;
    try { const stat = statSync(path); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { return []; }
    if (this.cache?.stamp === stamp) return this.cache.entries;
    const entries: Entry[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as Entry;
        if (typeof e?.id === "string" && ID.test(e.id) && EXT[e.type] && typeof e.sessionKey === "string" && Array.isArray(e.keys)
          && (e.type !== OUTGOING_FILE_TYPE || (typeof e.name === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(e.name) && Number.isSafeInteger(e.size) && e.size! >= 0))) entries.push(e);
      } catch { /* a torn last line */ }
    }
    this.cache = { stamp, entries };
    return entries;
  }

  /** What a turn's tag was filed as, if anything. */
  lookup(sessionKey: string, turns: readonly (string | undefined)[], path: string): OutgoingFiled | undefined {
    const keys = new Set(turns.filter((t): t is string => !!t).map((turn) => keyOf(sessionKey, turn, path.trim())));
    if (!keys.size) return undefined;
    const entries = this.entries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.sessionKey === sessionKey && e.keys.some((k) => keys.has(k))) return { id: e.id, type: e.type, ...(e.name !== undefined ? { name: e.name, size: e.size } : {}) };
    }
    return undefined;
  }

  /**
   * An assistant message's text with every MEDIA:/STICKER: tag replaced by
   * its token (filed for this turn: see WEB_MEDIA_TOKEN) or `MEDIA:web:gone`.
   * A Telegram sticker file_id has nothing to show: it becomes "gone" too.
   */
  rewrite(sessionKey: string, turns: readonly (string | undefined)[], content: string): { content: string; ids: string[] } {
    if (!/MEDIA:|STICKER:/i.test(content)) return { content, ids: [] };
    const ids: string[] = [];
    const swap = (_whole: string, quoted?: string, bare?: string) => {
      const filed = this.lookup(sessionKey, turns, String(quoted ?? bare ?? ""));
      if (filed) ids.push(filed.id);
      return filed ? tokenFor(filed) : `${WEB_MEDIA_TOKEN}gone`;
    };
    return { content: content.replace(MEDIA_RE, swap).replace(STICKER_RE, swap), ids };
  }

  /**
   * Web side: a filed picture or file of `sessionKey`, by id. Anything else
   * is not found. A file comes back with its name, to be served as a download.
   */
  read(sessionKey: string, id: string): { type: string; bytes: Buffer; name?: string } | undefined {
    if (!this.dir || !ID.test(id)) return undefined;
    const entry = this.entries().find((e) => e.id === id && e.sessionKey === sessionKey);
    if (!entry) return undefined;
    const name = `${id}.${EXT[entry.type]}`;
    const path = join(this.dir, name);
    let fd: number | undefined;
    try {
      // The file itself, in the store: never a link out of it.
      if (realpathSync(path) !== join(realpathSync(this.dir), name)) return undefined;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      const file = entry.type === OUTGOING_FILE_TYPE;
      if (!stat.isFile() || stat.nlink > 1 || stat.size > (file ? MAX_OUTGOING_FILE_BYTES : MAX_OUTGOING_BYTES)) return undefined;
      const bytes = readFileSync(fd);
      if (file) return bytes.length === entry.size ? { type: entry.type, bytes, name: entry.name } : undefined;
      return sniffImageType(bytes.subarray(0, 16)) === entry.type ? { type: entry.type, bytes } : undefined;
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
