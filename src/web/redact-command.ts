import { scrubSecretValues } from "../redact.js";

/** What a redacted value is replaced with. */
export const MASK = "•••";

/**
 * Redact a shell command line before it reaches the browser (the task panel
 * shows background commands). BEST EFFORT, defence in depth — not a
 * security boundary: the web UI is the owner's alone (token + tailnet), and
 * the task view shows tool inputs as they are. Applied on the server (the
 * task tracker before clipping, the board before any send, the
 * full-command endpoint):
 * - environment assignments (`FOO=bar`, `export TOKEN=…`): the value;
 * - secret-ish flags (`--token x`, `--password=x`, `--api-key x`, …): the value;
 * - `Authorization: …` headers and `Bearer …` values;
 * - credential shapes (sk-…, ghp_…, github_pat_…, tomo_web_…, xox…-, AKIA…),
 *   plus everything the log scrubber knows;
 * - any path into memory/private → `<private>`.
 */
export function redactCommand(command: string): string {
  let out = redactText(command);
  out = out.replace(/(--?[A-Za-z0-9-]*(?:token|password|passwd|secret|api-?key|key|auth)[A-Za-z0-9-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s'"]+)/gi,
    (_m, flag: string, sep: string) => `${flag}${sep}${MASK}`);
  // VAR=value at a command position (line start, after ; && || | ( or `export`).
  out = out.replace(/(^|[;&|(]\s*|\bexport\s+|\s)([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g,
    (_m, lead: string, name: string) => `${lead}${name}=${MASK}`);
  return out;
}

/**
 * The parts of redactCommand that hold for any text, not only a command
 * line: the log scrubber, memory/private paths, Authorization / Bearer
 * values, secret URL parameters and credential shapes. Shell-only rules
 * (VAR=value, --token x) are left out so ordinary output keeps its shape.
 */
export function redactText(text: string): string {
  // The log scrubber masks with "***"; use one mask everywhere in the UI.
  let out = scrubSecretValues(text).replace(/\*\*\*/g, MASK);
  out = out.replace(/(?:[^\s'"=]*\/)?memory\/private(?:\/[^\s'"]*)?/g, "<private>");
  out = out.replace(/(Authorization:\s*)(?:Bearer\s+|Basic\s+)?[^\s'"]+/gi, `$1${MASK}`);
  // Secret-ish URL query parameters: ?token=… &key=… access_token=… sig=…
  out = out.replace(/([?&](?:[A-Za-z0-9_]*?(?:token|key|secret|password|passwd|auth|sig|signature|code)))=([^&\s'"#]+)/gi, `$1=${MASK}`);
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/g, `$1${MASK}`);
  return out.replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|tomo_web_[a-f0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})/g, MASK);
}

/** Field names whose value is masked whole, whatever it looks like (case-insensitive, any depth). */
export const SECRET_KEY = /password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth|authorization|credential|cookie|session|private[_-]?key/i;

/**
 * A tool call's input for the browser: a field whose NAME is secret-ish
 * (SECRET_KEY) is replaced by the mask whole — string, number or object;
 * a `command` string (Bash, Monitor…) goes through redactCommand; every
 * other string through redactText (the shape-based rules), at any depth.
 * Keys are kept; the shape is unchanged. Past MAX_DEPTH a nested value is
 * masked rather than shown unread.
 */
export function redactToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const MAX_DEPTH = 8;
  const walk = (value: unknown, key: string, depth: number): unknown => {
    if (key && SECRET_KEY.test(key) && value !== null && value !== undefined && value !== "") return MASK;
    if (typeof value === "string") return key === "command" ? redactCommand(value) : redactText(value);
    if (!value || typeof value !== "object") return value;
    if (depth > MAX_DEPTH) return MASK;
    if (Array.isArray(value)) return value.map((item) => walk(item, key, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, depth + 1)]));
  };
  return walk(input, "", 0) as Record<string, unknown>;
}

/** A redacted preview for a tooltip: at most `limit` characters. */
export function commandPreview(command: string, limit = 200): string {
  const red = redactCommand(command);
  return red.length > limit ? `${red.slice(0, limit)}…` : red;
}
