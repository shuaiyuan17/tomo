/**
 * One definition of "this field holds a credential", shared by every surface
 * that can render a value an operator put in `config.json`.
 *
 * There are two such surfaces and they fail in different directions:
 *
 * - `configIssues` (`config.ts`) is rendered by `tomo status`, the `tomo
 *   config` banner, and `assertConfigValid()`'s throw — which `start.ts`
 *   `console.error`s, so under launchd it is appended to
 *   `~/.tomo/logs/launchd.err.log`. A single mistyped `allowlist` used to
 *   stringify the whole `channels.telegram` entry, bot token included, into
 *   all three.
 * - pino's structured records, which had no `redact` config at all, so any
 *   future `log.info({ channel }, …)` would ship a token to the log file with
 *   nothing in the way.
 *
 * The value-shaped half (`redactSecretValue`, `redactSecrets`) is the one
 * `configIssues` needs: the operator has to be able to tell *which* token is
 * wrong, so the last four characters survive. pino's `redact` cannot take a
 * predicate — it wants literal paths — so `LOG_REDACT_PATHS` expands the same
 * name list into the paths pino understands, and `[Redacted]` (pino's default
 * censor) is what lands in the log.
 */

/**
 * Substrings that make a field name a credential regardless of what surrounds
 * them. Matched against the field name lowercased with separators removed, so
 * `api_key`, `apiKey` and `API-KEY` are all `apikey`.
 */
const SECRET_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "authorization",
  "cookie",
  "credential",
];

/**
 * Qualifiers that turn a `…Key` name into a credential.
 *
 * A bare "the name contains 'key'" rule is what you would write first and it
 * is wrong here: in this codebase `key`, `sessionKey`, `storeKey`,
 * `channelKey` and `chatKey` are all routing identifiers, and `key` in
 * particular is the session key in the four `log.warn({ key, … })` calls in
 * `agent.ts`. Redacting those would blank the diagnostics an operator reads
 * the log for while protecting nothing — no config field is named `key`, and
 * every credential-shaped one (`apiKey`, `clientSecret`, `token`) is covered
 * either by `SECRET_WORDS` or by a qualifier below.
 */
const SECRET_KEY_QUALIFIERS = [
  "api",
  "secret",
  "private",
  "access",
  "signing",
  "encryption",
  "auth",
  "client",
  "shared",
  "master",
];

/** True when a field with this name holds a credential. */
export function isSecretFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SECRET_WORDS.some((word) => normalized.includes(word))) return true;
  if (normalized.endsWith("key")) {
    return SECRET_KEY_QUALIFIERS.includes(normalized.slice(0, -3));
  }
  return false;
}

/**
 * Render a secret so it can still be identified but not used: `***` plus the
 * last four characters. Short values lose even that — four characters of an
 * eight-character password is half of it.
 *
 * Non-scalars collapse to a bare `***`: a secret is never an object, and if
 * one is, its shape is not worth guessing at.
 */
export function redactSecretValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "***";
  const text = String(value);
  return text.length > 4 ? `***${text.slice(-4)}` : "***";
}

/**
 * Deep-copy `value`, replacing every secret-named field with
 * `redactSecretValue`. Non-secret fields are preserved verbatim — the point of
 * a config issue is to show the operator what they actually typed.
 *
 * `fieldName` names the value itself, for the case where the secret is the
 * whole value rather than a property of it (`groupSecret: 42`).
 */
export function redactSecrets(value: unknown, fieldName?: string): unknown {
  return redact(value, fieldName, new WeakSet());
}

function redact(value: unknown, fieldName: string | undefined, seen: WeakSet<object>): unknown {
  if (fieldName !== undefined && isSecretFieldName(fieldName)) return redactSecretValue(value);
  if (value === null || typeof value !== "object") return value;
  // Config comes from JSON.parse so cycles are impossible today, but this
  // helper is also reachable from log call sites with arbitrary objects.
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, undefined, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = redact(item, key, seen);
  }
  return result;
}

/**
 * Concrete field names for pino's `redact.paths`. fast-redact matches literal
 * keys, not patterns, so `isSecretFieldName`'s rule is enumerated here for the
 * names that actually occur — config keys, OAuth token records, and HTTP
 * header casings (paths are case-sensitive).
 *
 * This list is deliberately narrower than the predicate. The predicate guards
 * `configIssues`, where a false positive costs one unreadable value in an
 * error message; over-redacting here would quietly cost a field in every log
 * line that carries it (`tokenStoreKey`, for instance, matches the predicate
 * but names an OAuth store slot rather than holding a credential).
 */
const LOG_SECRET_FIELDS = [
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "botToken",
  "telegramToken",
  "secret",
  "groupSecret",
  "clientSecret",
  "password",
  "passwd",
  "apiKey",
  "api_key",
  "apikey",
  "privateKey",
  "secretKey",
  "accessKey",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  "credential",
  "credentials",
];

/**
 * `field`, `*.field` and `*.*.field` for each name above. Two levels of
 * wildcard covers everything the daemon logs today — `{ channel: { token } }`
 * is one, `{ config: { channels: { telegram: { token } } } }` would need three
 * and is not a shape anything constructs — without paying fast-redact's
 * per-path cost for depth nothing reaches.
 */
export const LOG_REDACT_PATHS: string[] = LOG_SECRET_FIELDS.flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
]);
