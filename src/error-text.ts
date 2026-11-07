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
 *
 * Never throws: it runs inside failure handlers, where an exception from a
 * hostile getter would replace the failure being reported (or leave a
 * promise unsettled).
 */

/**
 * DETAIL IS FOR LOGS, NOT CHATS. `describeError` appends stderr, RPC payloads
 * and the like — exactly what must never land in a chat, least of all a
 * group's. Anything a person reads (`[error] …`, an owner DM, a tool result
 * the model may quote) uses `shortErrorMessage` instead.
 */
const SHORT_MAX = 500;

/**
 * The bare, human-facing message: an Error's own `message` (or the
 * `publicMessage` a channel error offers in place of one that carries
 * protocol detail), a string as is, a structured value's `message` field.
 * Never "[object Object]", never stderr or RPC data. Never throws.
 */
export function shortErrorMessage(value: unknown): string {
  try {
    if (typeof value === "string") return clip(value, SHORT_MAX) || "unknown error";
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const pub = read(() => record.publicMessage);
      if (typeof pub === "string" && pub) return clip(pub, SHORT_MAX);
      const message = read(() => record.message);
      // An Error's own message is passed through unclipped: it is what was
      // always shown, and isSafeguardError / withRecoveryHint match on it.
      if (typeof message === "string" && message) return value instanceof Error ? message : clip(message, SHORT_MAX);
      if (value instanceof Error) return read(() => value.name) || "Error";
      return "unknown error (details are in the log)";
    }
    return value === undefined || value === null ? "unknown error" : clip(String(value), SHORT_MAX);
  } catch {
    return "unknown error";
  }
}

/** Diagnostic fields worth showing next to an Error's message, in order. */
const ERROR_FIELDS = ["code", "errno", "syscall", "signal", "exitCode", "status", "stderr", "data"] as const;
/** Per-field budget. `stderr` keeps its TAIL: the cause is usually last. */
const FIELD_MAX = 500;
/** Budget for the message itself, so the fields after it always survive. */
const HEAD_MAX = 1000;
const TOTAL_MAX = 2000;

export function describeError(value: unknown): string {
  try {
    return clip(describe(value), TOTAL_MAX);
  } catch {
    return "(unprintable error)";
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Error) {
    const head = clip(read(() => value.message) || read(() => value.name) || "Error", HEAD_MAX);
    const record = value as unknown as Record<string, unknown>;
    const extras: string[] = [];
    for (const field of ERROR_FIELDS) {
      const shown = fieldText(read(() => record[field]));
      if (shown === null) continue;
      extras.push(`${field}=${field === "stderr" ? clipStart(shown, FIELD_MAX) : clip(shown, FIELD_MAX)}`);
    }
    return extras.length ? `${head} (${extras.join(", ")})` : head;
  }
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return safeJson(value);
  return String(value);
}

/** A property read that a throwing getter cannot turn into an exception. */
function read<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
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

/** JSON that survives cycles, BigInt and throwing getters; never "[object Object]". */
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
    return text ?? "(unserializable value)";
  } catch {
    return "(unserializable object)";
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clipStart(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}
