import { readFileSync, openSync, closeSync, readSync, fstatSync } from "node:fs";

export function parseJsonl<T = unknown>(text: string): T[] {
  const records: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      // Tolerant by design: SDK JSONL files can contain partial or malformed
      // lines if inspected while another process is writing.
    }
  }
  return records;
}

export function readJsonlFileSync<T = unknown>(path: string): T[] {
  return parseJsonl<T>(readFileSync(path, "utf-8"));
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
