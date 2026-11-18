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

export function clearSecretValuesForTests(): void {
  secrets.clear();
  readiness = null;
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
 * backoff) and the PostToolUse hook withholds output that went near the
 * keychain (`withholdDeep`).
 */
interface Readiness { retry: () => Promise<boolean>; nextAt: number; backoffMs: number; inFlight?: Promise<boolean> }
let readiness: Readiness | null = null;
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export function redactionReady(): boolean {
  return readiness === null;
}

/** Marks the redactor not ready; `retry` loads the values again and says whether it worked. */
export function markRedactionNotReady(retry: () => Promise<boolean>, now = Date.now()): void {
  if (readiness) return;
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
  if (now < r.nextAt) return false;
  r.inFlight = r.retry().catch(() => false).then((ok) => {
    if (ok) { if (readiness === r) readiness = null; return true; }
    r.backoffMs = Math.min(r.backoffMs * 2, MAX_BACKOFF_MS);
    r.nextAt = Date.now() + r.backoffMs;
    r.inFlight = undefined;
    return false;
  });
  return r.inFlight;
}

export const WITHHELD_OUTPUT = "[withheld: Tomo's credential redaction is not ready, so output of a command that reads the keychain is not shown]";

/** `value` with every string leaf replaced, its shape kept (see scrubDeep). */
export function withholdDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return (value ? WITHHELD_OUTPUT : value) as unknown as T;
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => withholdDeep(item, depth + 1)) as unknown as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, withholdDeep(v, depth + 1)])) as T;
}

export function resetRedactionReadinessForTests(): void {
  readiness = null;
}
