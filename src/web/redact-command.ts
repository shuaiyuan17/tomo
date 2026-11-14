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
  // The log scrubber masks with "***"; use one mask everywhere in the UI.
  let out = scrubSecretValues(command).replace(/\*\*\*/g, MASK);
  out = out.replace(/(?:[^\s'"=]*\/)?memory\/private(?:\/[^\s'"]*)?/g, "<private>");
  out = out.replace(/(Authorization:\s*)(?:Bearer\s+|Basic\s+)?[^\s'"]+/gi, `$1${MASK}`);
  // Secret-ish URL query parameters: ?token=… &key=… access_token=… sig=…
  out = out.replace(/([?&](?:[A-Za-z0-9_]*?(?:token|key|secret|password|passwd|auth|sig|signature|code)))=([^&\s'"#]+)/gi, `$1=${MASK}`);
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/g, `$1${MASK}`);
  out = out.replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|tomo_web_[a-f0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})/g, MASK);
  out = out.replace(/(--?[A-Za-z0-9-]*(?:token|password|passwd|secret|api-?key|key|auth)[A-Za-z0-9-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s'"]+)/gi,
    (_m, flag: string, sep: string) => `${flag}${sep}${MASK}`);
  // VAR=value at a command position (line start, after ; && || | ( or `export`).
  out = out.replace(/(^|[;&|(]\s*|\bexport\s+|\s)([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g,
    (_m, lead: string, name: string) => `${lead}${name}=${MASK}`);
  return out;
}

/** A redacted preview for a tooltip: at most `limit` characters. */
export function commandPreview(command: string, limit = 200): string {
  const red = redactCommand(command);
  return red.length > limit ? `${red.slice(0, limit)}…` : red;
}
