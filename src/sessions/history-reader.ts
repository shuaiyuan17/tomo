import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { SessionStore } from "./store.js";
import type { SessionMessage } from "./types.js";

const cursorSchema = z.object({ time: z.number().finite(), order: z.number().int().nonnegative(), revision: z.string().max(64) }).strict();
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
export class HistoryReadError extends Error {
  constructor(readonly code: "invalid_cursor" | "history_changed" | "history_too_large") { super(code); }
}
export interface HistoryRecord extends SessionMessage { id: string }
type PositionedRecord = HistoryRecord & { order: number };
const position = (m: PositionedRecord) => ({ time: m.timestamp, order: m.order });
const compare = (a: { time: number; order: number }, b: { time: number; order: number }) =>
  a.time - b.time || a.order - b.order;

/** Bounded, read-only pagination over the store's canonical AND legacy read
 * sets. Records keep independent identities even when sidecar seqs collide. */
export async function readHistoryPage(
  dirs: { sessionsDir: string; sdkSessionsDir: string }, key: string, cursor?: string,
): Promise<{ messages: HistoryRecord[]; nextCursor: string | null; revision: string }> {
  let before: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    try {
      if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      before = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
    } catch { throw new HistoryReadError("invalid_cursor"); }
  }
  const files = SessionStore.readHistoryFiles(dirs.sessionsDir, dirs.sdkSessionsDir, key).reverse();
  if (files.length > 1024) throw new HistoryReadError("history_too_large");
  const revision = createHash("sha256").update(files.map((file) => basename(file)).join("\n")).digest("base64url");
  if (before && before.revision !== revision) throw new HistoryReadError("history_changed");
  let scanned = 0;
  let order = 0;
  const tail: PositionedRecord[] = [];
  for (const file of files) {
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (!fd) continue;
    try {
      const stat = await fd.stat();
      if (!stat.isFile()) throw new Error("Invalid history file");
      scanned += stat.size;
      if (scanned > MAX_SCAN_BYTES) throw new HistoryReadError("history_too_large");
      // Snapshot this file's byte length so an active writer cannot make an
      // otherwise bounded read run forever. Ignore its incomplete last line.
      if (!stat.size) continue;
      const stream = fd.createReadStream({ autoClose: false, start: 0, end: stat.size - 1, encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let ordinal = 0;
      try {
        for await (const line of lines) {
          ordinal++;
          order++;
          let value: unknown;
          try { value = JSON.parse(line); } catch { continue; }
          if (!value || typeof value !== "object") continue;
          const m = value as SessionMessage;
          if (!["user", "assistant", "tool_summary"].includes(m.role) || typeof m.content !== "string"
            || !Number.isFinite(m.timestamp) || typeof m.channel !== "string") continue;
          const id = createHash("sha256").update(`${basename(file)}:${ordinal}:${line}`).digest("base64url");
          const record: PositionedRecord = { id, order, role: m.role, content: m.content, timestamp: m.timestamp,
            channel: m.channel, ...(m.requestId ? { requestId: m.requestId } : {}) };
          if (before && compare(position(record), before) >= 0) continue;
          let low = 0; let high = tail.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (compare(position(tail[middle]), position(record)) > 0) low = middle + 1;
            else high = middle;
          }
          tail.splice(low, 0, record);
          if (tail.length > 101) tail.pop();
        }
      } finally { lines.close(); stream.destroy(); }
    } finally { await fd.close(); }
  }
  const hasMore = tail.length > 100;
  const selected = tail.slice(0, 100).reverse();
  const messages = selected.map(({ order, ...message }) => { void order; return message; });
  if (Buffer.byteLength(JSON.stringify(messages)) > 2 * 1024 * 1024) throw new HistoryReadError("history_too_large");
  return { messages, revision, nextCursor: hasMore
    ? Buffer.from(JSON.stringify({ ...position(selected[0]), revision })).toString("base64url") : null };
}
