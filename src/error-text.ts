/**
 * One-line, human-readable text for any thrown or reported value.
 *
 * `${err}` / `String(err)` on a non-Error object yields "[object Object]",
 * and `err.message` alone drops what usually explains a failure: a system
 * error's `code`, a child process's `stderr`, `signal` and exit code, a
 * JSON-RPC error's structured `data`. This keeps the message and appends the
 * fields that are present, e.g.
 *
 *   `spawn imsg ENOENT (code=ENOENT, syscall=spawn imsg)`
 *   `Mutation lane blocked: {"lane":"send","reason":"busy"}`
 */

/** Diagnostic fields worth showing next to an Error's message, in order. */
const ERROR_FIELDS = ["code", "errno", "syscall", "signal", "exitCode", "status", "stderr", "data"] as const;
const FIELD_MAX = 500;
const TOTAL_MAX = 2000;

export function describeError(value: unknown): string {
  return clip(describe(value), TOTAL_MAX);
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    const head = value.message || value.name || "Error";
    const record = value as unknown as Record<string, unknown>;
    const extras: string[] = [];
    for (const field of ERROR_FIELDS) {
      const shown = fieldText(record[field]);
      // A field the message already spells out (e.g. a code in "spawn imsg
      // ENOENT") is still listed: it is short, and it is what people grep for.
      if (shown !== null) extras.push(`${field}=${clip(shown, FIELD_MAX)}`);
    }
    return extras.length ? `${head} (${extras.join(", ")})` : head;
  }
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return safeJson(value);
  return String(value);
}

function fieldText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "object") return safeJson(value);
  return String(value);
}

/** JSON that survives cycles and BigInt, never throws, never "[object Object]". */
export function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Error) return describe(v);
      if (v !== null && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
    return text ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
