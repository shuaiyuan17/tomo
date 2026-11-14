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
