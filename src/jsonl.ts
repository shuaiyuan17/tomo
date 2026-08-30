import { readFileSync, openSync, closeSync, readSync, fstatSync } from "node:fs";
import { log } from "./logger.js";

/**
 * Carrier for a line that could not be parsed as JSON. A `Symbol` key, so it
 * cannot collide with a real field and `JSON.stringify` ignores it — a raw
 * line that leaked into a plain stringify would serialize as `{}` rather than
 * as itself, which is exactly the loss this exists to prevent. Use
 * {@link serializeJsonlRecord} to write records back out.
 */
const RAW_JSONL_LINE = Symbol("tomo.rawJsonlLine");

export interface RawJsonlLine {
  [RAW_JSONL_LINE]: string;
}

export function isRawJsonlLine(value: unknown): value is RawJsonlLine {
  return typeof value === "object"
    && value !== null
    && typeof (value as RawJsonlLine)[RAW_JSONL_LINE] === "string";
}

/**
 * Serialize one record from `parseJsonl(text, { preserveUnparseable: true })`.
 * Real records stringify; carried-through lines are emitted exactly as read,
 * including any leading/trailing whitespace within the line.
 *
 * Note this is per-line fidelity, not whole-file fidelity: `parseJsonl` skips
 * blank lines in every mode, so a file round-tripped through parse+serialize
 * loses its blank lines (JSONL has no semantics for them and the SDK never
 * writes them). Every line that carries content survives.
 */
export function serializeJsonlRecord(value: unknown): string {
  return isRawJsonlLine(value) ? value[RAW_JSONL_LINE] : JSON.stringify(value);
}

export interface ParseJsonlOptions {
  /**
   * Emit an opaque {@link RawJsonlLine} for every line that fails to parse,
   * in its original position, instead of dropping it.
   *
   * **Every caller that rewrites the file it read must set this.** Dropping is
   * the right tolerance for a read-only consumer, but a read-modify-rewrite
   * that emits only what parsed *deletes* the rest: a single mid-file torn
   * line (a power loss, with a later append landing behind it so `hasPartialTail`
   * no longer sees it) is silently erased by the next compact or prune, and if
   * it was an assistant `tool_use` the following `tool_result` is left with a
   * dangling `tool_use_id`.
   *
   * Carried lines have no `type`, `uuid`, `message` or `timestamp`, so the
   * normal field tests skip them; they are never archived, summarized or
   * re-stitched, only preserved.
   */
  preserveUnparseable?: boolean;
}

// The two overloads are the point: asking to preserve widens the element type,
// so a caller that opts in cannot then treat entries as plain `T` without
// narrowing. A future rewriter gets a compile error instead of a `undefined`
// field read on a carrier.
export function parseJsonl<T = unknown>(
  text: string,
  opts: ParseJsonlOptions & { preserveUnparseable: true },
): (T | RawJsonlLine)[];
export function parseJsonl<T = unknown>(text: string, opts?: ParseJsonlOptions): T[];
export function parseJsonl<T = unknown>(
  text: string,
  opts?: ParseJsonlOptions,
): (T | RawJsonlLine)[] {
  const records: (T | RawJsonlLine)[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Tolerant by design: SDK JSONL files can contain partial or malformed
      // lines if inspected while another process is writing. Read-only
      // consumers skip them; rewriters carry them through verbatim.
      if (opts?.preserveUnparseable) records.push({ [RAW_JSONL_LINE]: line });
      continue;
    }
    if (opts?.preserveUnparseable && (parsed === null || typeof parsed !== "object")) {
      // A line that is valid JSON but not an object — `null`, a bare number, a
      // quoted string — is not a record any rewriting caller can reason about,
      // and `null` in particular makes every `evt.type` read throw. Carry it
      // verbatim rather than handing it out as a `T`.
      records.push({ [RAW_JSONL_LINE]: line });
      continue;
    }
    records.push(parsed as T);
  }
  return records;
}

export function readJsonlFileSync<T = unknown>(
  path: string,
  opts: ParseJsonlOptions & { preserveUnparseable: true },
): (T | RawJsonlLine)[];
export function readJsonlFileSync<T = unknown>(path: string, opts?: ParseJsonlOptions): T[];
export function readJsonlFileSync<T = unknown>(
  path: string,
  opts?: ParseJsonlOptions,
): (T | RawJsonlLine)[] {
  return parseJsonl<T>(readFileSync(path, "utf-8"), opts as ParseJsonlOptions & { preserveUnparseable: true });
}

/**
 * Log every carrier in a parsed record list, one line each, and return how many
 * there were. Carriers are rare by construction (a torn write, bit rot), so
 * per-line logging is affordable and the byte offset is what a human needs to
 * go and look at the file.
 *
 * Rewriting callers should call this once after parsing: a line nobody can
 * read is worth surfacing even though it is being preserved rather than lost.
 */
export function reportRawJsonlLines(
  records: readonly unknown[],
  context: Record<string, unknown>,
): number {
  let count = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!isRawJsonlLine(record)) continue;
    count++;
    const raw = record[RAW_JSONL_LINE];
    log.warn(
      { ...context, index, bytes: Buffer.byteLength(raw, "utf-8"), preview: raw.slice(0, 120) },
      "Unparseable JSONL line preserved verbatim through a rewrite",
    );
  }
  return count;
}

/**
 * Yield JSONL records newest-first, reading the file backwards in fixed-size
 * chunks so consumers can early-exit without paying for the whole file.
 * Malformed lines are skipped (same tolerance as parseJsonl). A missing file
 * yields nothing.
 *
 * The carry between chunks is kept as bytes, not text: a UTF-8 code point can
 * straddle a chunk boundary, and decoding it half-read would corrupt it.
 * Splitting at newline bytes is safe — 0x0A never appears inside a multi-byte
 * UTF-8 sequence.
 */
export function* iterateJsonlBackwardsSync<T = unknown>(
  path: string,
  chunkSize = 64 * 1024,
): Generator<T> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (pos > 0) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, pos);
      let chunk = Buffer.concat([buf, carry]);
      carry = Buffer.alloc(0);
      if (pos > 0) {
        // The bytes before the first newline are the tail of a line that
        // starts in an earlier chunk — hold them for the next iteration.
        const nl = chunk.indexOf(0x0a);
        if (nl === -1) {
          carry = chunk;
          continue;
        }
        carry = chunk.subarray(0, nl);
        chunk = chunk.subarray(nl + 1);
      }
      const lines = chunk.toString("utf-8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as T;
        } catch {
          // Skip malformed lines
        }
      }
    }
  } finally {
    closeSync(fd);
  }
}

/** Read the last `maxRecords` records of a JSONL file, in file order, without
 *  loading the whole file. */
export function readJsonlTailSync<T = unknown>(path: string, maxRecords: number): T[] {
  const records: T[] = [];
  for (const record of iterateJsonlBackwardsSync<T>(path)) {
    records.push(record);
    if (records.length >= maxRecords) break;
  }
  return records.reverse();
}

/** Read the first parseable record of a JSONL file, or undefined. */
export function readFirstJsonlRecordSync<T = unknown>(path: string): T | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const chunkSize = 64 * 1024;
    let pos = 0;
    let pending = Buffer.alloc(0);
    while (pos < size) {
      const readSize = Math.min(chunkSize, size - pos);
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, pos);
      pos += readSize;
      pending = pending.length > 0 ? Buffer.concat([pending, buf]) : buf;
      // Try every complete line accumulated so far; tolerate leading junk.
      let start = 0;
      let nl: number;
      while ((nl = pending.indexOf(0x0a, start)) !== -1) {
        const line = pending.subarray(start, nl).toString("utf-8").trim();
        start = nl + 1;
        if (!line) continue;
        try {
          return JSON.parse(line) as T;
        } catch {
          // Skip malformed lines
        }
      }
      pending = pending.subarray(start);
    }
    const last = pending.toString("utf-8").trim();
    if (last) {
      try {
        return JSON.parse(last) as T;
      } catch {
        // Skip malformed trailing line
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
