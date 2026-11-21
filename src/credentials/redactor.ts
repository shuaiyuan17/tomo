/**
 * The values the harness knows are secrets, and removing them from text. A
 * literal match, for the accidental leak: `env`, a verbose curl, an error message.
 * It does not stop a command that encodes or transforms the value.
 *
 * Module-level and dependency-free because the logger reaches it through
 * `scrubSecretValues`. Values are never forgotten within a process: replacing a
 * credential does not take the old value out of a running child or a file.
 */
const secrets = new Map<string, string>();

/** Shorter values are refused at capture: scrubbing "abc" out of every tool
 *  result would mangle output and tell the model what the value is. */
export const MIN_SECRET_LENGTH = 4;

export function registerSecretValue(value: string, name: string): void {
  if (value.length >= MIN_SECRET_LENGTH) secrets.set(value, name);
}

/** Back to a fresh process: no values, and not ready until a first load succeeds. */
export function clearSecretValuesForTests(): void {
  secrets.clear();
  readiness = initialReadiness();
}

export function scrubKnownSecrets(text: string): string {
  if (secrets.size === 0 || !text) return text;
  let out = text;
  for (const [value, name] of secrets) {
    if (out.includes(value)) out = out.split(value).join(`[REDACTED secret://${name}]`);
  }
  return out;
}

/**
 * `value` with every string leaf scrubbed and its shape untouched, or the same
 * reference when nothing changed. The CLI checks a PostToolUse rewrite against
 * the tool's output schema and uses the ORIGINAL output on a mismatch, so a
 * reshaped rewrite would fail open.
 */
export function scrubDeep<T>(value: T, depth = 0): T {
  if (secrets.size === 0) return value;
  if (typeof value === "string") return scrubKnownSecrets(value) as unknown as T;
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const next = value.map((item) => scrubDeep(item, depth + 1));
    return next.some((item, i) => item !== value[i]) ? (next as unknown as T) : value;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const next = entries.map(([key, item]) => [key, scrubDeep(item, depth + 1)] as const);
  return next.some(([, item], i) => item !== entries[i][1]) ? (Object.fromEntries(next) as T) : value;
}

/**
 * Whether the redactor knows every value the broker holds. After a restart it
 * learns them from the keychain (`CredentialBroker.primeRedaction`); until that
 * has succeeded it does not, and a value printed meanwhile would pass the
 * literal match. While not ready, `ensureRedactionReady` retries the load (with
 * backoff) and the PostToolUse hook withholds every tool output (`withholdDeep`).
 */
interface Readiness { retry: (() => Promise<boolean>) | null; nextAt: number; backoffMs: number; inFlight?: Promise<boolean> }
const MIN_BACKOFF_MS = 5_000;
/** NOT ready until the first load has succeeded: a restart's load runs in the
 *  background, and output arriving before it returns must not pass unmasked.
 *  `retry: null` = the first load is still running; nothing to retry yet. */
const initialReadiness = (): Readiness => ({ retry: null, nextAt: 0, backoffMs: MIN_BACKOFF_MS });
let readiness: Readiness | null = initialReadiness();
const MAX_BACKOFF_MS = 5 * 60_000;

export function redactionReady(): boolean {
  return readiness === null;
}

/** Marks the redactor not ready; `retry` loads the values again and says whether it worked. */
export function markRedactionNotReady(retry: () => Promise<boolean>, now = Date.now()): void {
  if (readiness?.retry) return;
  readiness = { retry, nextAt: now + MIN_BACKOFF_MS, backoffMs: MIN_BACKOFF_MS };
}

export function markRedactionReady(): void {
  readiness = null;
}

/** Retries the load if it is due. Resolves to whether the redactor is ready. Never throws. */
export async function ensureRedactionReady(now = Date.now()): Promise<boolean> {
  const r = readiness;
  if (!r) return true;
  if (r.inFlight) return r.inFlight;
  if (!r.retry || now < r.nextAt) return false;
  r.inFlight = r.retry().catch(() => false).then((ok) => {
    if (ok) { if (readiness === r) readiness = null; return true; }
    r.backoffMs = Math.min(r.backoffMs * 2, MAX_BACKOFF_MS);
    r.nextAt = Date.now() + r.backoffMs;
    r.inFlight = undefined;
    return false;
  });
  return r.inFlight;
}

export const WITHHELD_OUTPUT = "[output withheld: Tomo's credential redaction is not ready, so tool output is hidden until it is]";

/**
 * `value` with every string leaf replaced, its shape kept (see scrubDeep).
 * Never throws: a field that cannot be read becomes the notice, and a node that
 * cannot be walked at all becomes the notice in its place. This is the
 * fail-closed path, so it must not fail itself.
 */
export function withholdDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return (value ? WITHHELD_OUTPUT : value) as unknown as T;
  if (depth > 32 || value === null || typeof value !== "object") return value;
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) out.push(withholdField(value as unknown as Record<number, unknown>, i, depth));
      return out as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = withholdField(value as Record<string, unknown>, key, depth);
    return out as T;
  } catch {
    return WITHHELD_OUTPUT as unknown as T;
  }
}

function withholdField(parent: Record<string | number, unknown>, key: string | number, depth: number): unknown {
  let item: unknown;
  try { item = parent[key]; } catch { return WITHHELD_OUTPUT; }
  return withholdDeep(item, depth + 1);
}

/**
 * The last resort when the output cannot be walked at all: a fixed replacement
 * that does not touch the original. The CLI checks a rewrite against the tool's
 * output schema and keeps the ORIGINAL on a mismatch; this shape is the one
 * Bash's schema accepts (stdout, stderr and interrupted are required), and an
 * in-process MCP tool accepts any shape. A built-in tool with another schema
 * would still fall back to its original output (pinned in the e2e tests).
 */
export function withheldFallbackOutput(): { stdout: string; stderr: string; interrupted: boolean } {
  return { stdout: WITHHELD_OUTPUT, stderr: "", interrupted: false };
}

