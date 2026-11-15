import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { sniffImageType } from "./image-type.js";
import { MEDIA_RE, STICKER_RE } from "../agent/text-utils.js";

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
 * Filed only: a regular file outside memory/private (the P0-2 guard, #464),
 * at most MAX_OUTGOING_BYTES, whose leading bytes are PNG/JPEG/GIF/WebP/HEIC.
 */
export const MAX_OUTGOING_BYTES = 15 * 1024 * 1024;
const ID = /^[a-f0-9]{32}$/;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic" };
/** The history token a tag is rewritten to: `MEDIA:web:<id>` or `MEDIA:web:gone`. */
export const WEB_MEDIA_TOKEN = "MEDIA:web:";

export function outgoingImagesDir(workspaceDir: string): string { return join(workspaceDir, "memory", "outgoing-images"); }

interface Entry { id: string; type: string; sessionKey: string; keys: string[]; at: number }
const keyOf = (sessionKey: string, turn: string, path: string) => createHash("sha256").update(`${sessionKey}\0${turn}\0${path}`).digest("hex");
const expand = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

export class OutgoingMediaError extends Error {
  constructor(readonly code: "private" | "missing" | "not_image" | "too_large") { super(code); }
}

export class OutgoingMediaStore {
  private cache?: { stamp: string; entries: Entry[] };
  constructor(private readonly dir: string | undefined, private readonly options: { isPrivate?: (path: string) => boolean } = {}) {}

  /**
   * Daemon side: copy `path` into the store for this turn. `turns`: the ids
   * the recorded message may carry (its requestId, the shared turnId).
   */
  file(sessionKey: string, turns: readonly string[], path: string): { id: string; type: string } {
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
      if (stat.size > MAX_OUTGOING_BYTES) throw new OutgoingMediaError("too_large");
      bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, read); if (!n) break; read += n; }
      bytes = bytes.subarray(0, read);
    } finally { closeSync(fd); }
    const type = sniffImageType(bytes.subarray(0, 16));
    if (!type) throw new OutgoingMediaError("not_image");
    const id = randomBytes(16).toString("hex");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, `${id}.${EXT[type]}`), bytes, { flag: "wx", mode: 0o600 });
    const entry: Entry = { id, type, sessionKey, keys: [...new Set(turns.filter(Boolean))].map((turn) => keyOf(sessionKey, turn, path.trim())), at: Date.now() };
    appendFileSync(join(this.dir, "index.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
    return { id, type };
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
        if (typeof e?.id === "string" && ID.test(e.id) && EXT[e.type] && typeof e.sessionKey === "string" && Array.isArray(e.keys)) entries.push(e);
      } catch { /* a torn last line */ }
    }
    this.cache = { stamp, entries };
    return entries;
  }

  /** The id a turn's tag was filed under, if any. */
  lookup(sessionKey: string, turns: readonly (string | undefined)[], path: string): string | undefined {
    const keys = new Set(turns.filter((t): t is string => !!t).map((turn) => keyOf(sessionKey, turn, path.trim())));
    if (!keys.size) return undefined;
    const entries = this.entries();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].sessionKey === sessionKey && entries[i].keys.some((k) => keys.has(k))) return entries[i].id;
    }
    return undefined;
  }

  /**
   * An assistant message's text with every MEDIA:/STICKER: tag replaced by
   * `MEDIA:web:<id>` (filed for this turn) or `MEDIA:web:gone`. A Telegram
   * sticker file_id has nothing to show: it becomes "gone" too.
   */
  rewrite(sessionKey: string, turns: readonly (string | undefined)[], content: string): { content: string; ids: string[] } {
    if (!/MEDIA:|STICKER:/i.test(content)) return { content, ids: [] };
    const ids: string[] = [];
    const swap = (_whole: string, quoted?: string, bare?: string) => {
      const id = this.lookup(sessionKey, turns, String(quoted ?? bare ?? ""));
      if (id) ids.push(id);
      return `${WEB_MEDIA_TOKEN}${id ?? "gone"}`;
    };
    return { content: content.replace(MEDIA_RE, swap).replace(STICKER_RE, swap), ids };
  }

  /** Web side: a filed image of `sessionKey`, by id. Anything else is not found. */
  read(sessionKey: string, id: string): { type: string; bytes: Buffer } | undefined {
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
      if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_OUTGOING_BYTES) return undefined;
      const bytes = readFileSync(fd);
      return sniffImageType(bytes.subarray(0, 16)) === entry.type ? { type: entry.type, bytes } : undefined;
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
