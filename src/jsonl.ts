import { readFileSync } from "node:fs";

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
