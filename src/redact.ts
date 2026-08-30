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
/**
 * Words that make a field a credential when they appear as a whole segment of
 * its name. SEGMENT, not substring: `tokens` is not a `token`.
 *
 * Substring matching shipped in the first revision of this and redacted
 * `tokens` out of every "Run completed" line — the daemon's most useful log
 * record, whose `tokens` field is the string `"in:1234 out:567"`. `inputTokens`,
 * `maxTokens` and `contextBreakdown[].tokens` went the same way. Plurals are
 * deliberately absent for `token` because no credential in this codebase is
 * named with one (the OAuth store uses `accessToken` / `refreshToken`), while
 * every token COUNT is plural. `credential`/`secret` keep their plurals,
 * because `credentials` and `secrets` really are used for the thing itself.
 */
const SECRET_WORDS = [
  "token",
  "secret",
  "secrets",
  "password",
  "passwd",
  "pwd",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
];

/**
 * Words that make a name a measurement of a credential rather than the
 * credential. `tokenCount` is the case that needs this: it splits to
 * `token` + `count`, so segment matching alone would still redact it.
 *
 * Kept to unambiguous metric nouns. `used`, `max` and `min` are deliberately
 * NOT here — `tokenUsed` could plausibly name the credential that was used,
 * and the plural forms (`maxTokens`) are already excluded by segment matching.
 */
const COUNT_WORDS = ["count", "counts", "length", "size", "limit", "total", "usage", "budget", "remaining"];

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

/** Split a field name into lowercase words across camelCase, snake and kebab. */
function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** True when a field with this name holds a credential. */
export function isSecretFieldName(name: string): boolean {
  const segments = nameSegments(name);
  if (segments.some((word) => COUNT_WORDS.includes(word))) return false;
  if (segments.some((word) => SECRET_WORDS.includes(word))) return true;
  // `key` only counts when something in front of it says which kind.
  const keyAt = segments.lastIndexOf("key");
  if (keyAt > 0 && SECRET_KEY_QUALIFIERS.includes(segments[keyAt - 1])) return true;
  // `apikey` written as one word survives the split as one segment, which the
  // SECRET_WORDS check above already caught; this covers `apikeys`.
  return segments.includes("apikeys");
}

/**
 * Shortest value that may keep its tail. Below this, `***` + last four is a
 * meaningful fraction of the secret rather than a fingerprint of it — four
 * characters of a five-character value is 80% of it. Real credentials (a
 * Telegram bot token, an `sk-…` API key, an OAuth bearer) are far longer than
 * this, so the tail survives exactly where it is useful and disappears exactly
 * where it would be a disclosure.
 */
const MIN_LENGTH_TO_KEEP_TAIL = 12;

/**
 * Render a secret so it can still be identified but not used: `***` plus the
 * last four characters, and only for values long enough that four characters
 * are a fingerprint rather than a substantial share of the secret.
 *
 * Non-scalars collapse to a bare `***`: a secret is never an object, and if
 * one is, its shape is not worth guessing at.
 */
export function redactSecretValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "***";
  const text = String(value);
  return text.length >= MIN_LENGTH_TO_KEEP_TAIL ? `***${text.slice(-4)}` : "***";
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
  return redact(value, fieldName, redactSecretValue, new Set());
}

/** What a censored field is replaced with. */
type Censor = (value: unknown) => unknown;

/**
 * Values whose structure lives somewhere other than own enumerable properties.
 * Rebuilding one from `Object.entries` would flatten it to `{}` and silently
 * destroy the value it was logged for, so they pass through untouched.
 *
 * Everything else IS walked, including class instances. An earlier version
 * only walked `Object.prototype` objects, which meant a config or client
 * object nested at depth 2 — `{ mcp: { client: someInstanceWithAToken } }` —
 * was handed back unredacted: `JSON.stringify` would happily emit its own
 * enumerable `token` property that this never looked at.
 */
function isOpaque(value: object): boolean {
  return value instanceof Date
    || value instanceof RegExp
    || value instanceof Map
    || value instanceof Set
    || value instanceof WeakMap
    || value instanceof WeakSet
    || value instanceof Promise
    || ArrayBuffer.isView(value)
    || value instanceof ArrayBuffer;
}

function redact(
  value: unknown,
  fieldName: string | undefined,
  censor: Censor,
  ancestors: Set<object>,
): unknown {
  if (fieldName !== undefined && isSecretFieldName(fieldName)) return censor(value);
  if (value === null || typeof value !== "object") return value;
  // An Error is left alone: pino's `err` serializer turns it into a plain
  // object (and that serializer is wrapped in logger.ts), and copying one here
  // would strip the prototype the serializer keys off, losing the stack.
  if (value instanceof Error) return value;
  if (!Array.isArray(value) && isOpaque(value)) return value;
  // ANCESTORS, not "everything visited". A `seen` set that is never unwound
  // reports the second sighting of a shared-but-acyclic node as a cycle — and
  // config and log objects are full of shared references (the same identity
  // object under two channels, one options object passed twice). Only a node
  // that is its own ancestor is actually a cycle.
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redact(item, undefined, censor, ancestors));
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redact(item, key, censor, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** pino's default censor, reused so shallow (`redact.paths`) and deep (the
 *  `formatters.log` hook) redaction are indistinguishable in the output. */
export const LOG_CENSOR = "[Redacted]";

/**
 * Deep-redact a log record by the same name rule, at any depth.
 *
 * `redact.paths` is a fixed ladder of literal paths, so it can only ever cover
 * the depths someone thought to enumerate. Real leaks are deeper than the
 * ladder: `{ config: { channels: { telegram: { token } } } }` is four levels,
 * an axios-shaped error carries `err.config.headers.Authorization`, and an MCP
 * server entry nests `mcpServers.<name>.headers.Authorization`. This closes
 * the general case.
 *
 * Returns the ORIGINAL object when there is nothing to redact, which is the
 * overwhelmingly common case — the daemon logs at `debug` by default, so
 * cloning every record would be a real cost for nothing. The scan still walks
 * the record (via `Object.entries`, which allocates), but it does not rebuild
 * it, and it stops at the first secret-named key it finds.
 */
/**
 * Redact a *serialized* error object: censor secret-named fields at any depth,
 * and scrub every string by value.
 *
 * Errors need their own pass for three reasons, all verified against a real
 * pino instance:
 *  - `formatters.log` runs BEFORE serializers, so the deep pass sees a raw
 *    `Error` and steps over it;
 *  - `pino.stdSerializers.err` returns an object with a non-`Object` prototype
 *    (as do the entries of `aggregateErrors`), so a plain-object-only walker
 *    rejects it at the door — leaving `err.response.data.config.headers
 *    .Authorization` (depth 6) exposed;
 *  - the credential is often in `message` or `stack`, under no key that any
 *    name rule could match, and `AggregateError`'s sub-errors carry their own.
 *
 * So this walks ANY object, and scrubs strings as well as censoring names.
 * Error trees are small and rare, so the extra work is bounded.
 */
export function redactSerializedError(value: unknown): unknown {
  return redactErrorNode(value, undefined, new Set());
}

function redactErrorNode(value: unknown, fieldName: string | undefined, ancestors: Set<object>): unknown {
  if (fieldName !== undefined && isSecretFieldName(fieldName)) return LOG_CENSOR;
  if (typeof value === "string") return scrubSecretValues(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactErrorNode(item, undefined, ancestors));
    }
    // Own enumerable properties only — exactly what JSON.stringify would have
    // emitted, so nothing visible in the output is lost by rebuilding as a
    // plain object.
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactErrorNode(item, key, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function redactLogRecord<T>(record: T): T {
  if (!containsSecret(record, new Set())) return record;
  return redact(record, undefined, () => LOG_CENSOR, new Set()) as T;
}

function containsSecret(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value !== "object") return false;
  if (value instanceof Error) return false;
  if (!Array.isArray(value) && isOpaque(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.some((item) => containsSecret(item, ancestors));
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretFieldName(key)) return true;
      if (containsSecret(item, ancestors)) return true;
    }
    return false;
  } finally {
    ancestors.delete(value);
  }
}


/**
 * A deliberately SHORT ladder for pino's `redact.paths`.
 *
 * It used to be every name above at five depths — 115 paths with four nested
 * wildcards — which measured 25-120x the cost of the whole rest of the
 * redaction on a single log line (142 us for a 5-deep record, against 4.6 us
 * for `redactLogRecord` alone), on a logger that runs at `debug` by default.
 * It was also redundant: `redactLogRecord` covers every plain-object record at
 * any depth, and the `err` serializer covers error trees, so the ladder was
 * paying fast-redact's per-path cost to find things already found.
 *
 * What is left is the top-level and one-deep header casings — the shapes most
 * likely to appear and the cheapest possible check — kept purely as a
 * belt-and-braces layer in front of the hooks. Everything censors to the same
 * `[Redacted]`, so which layer fired is invisible in the output.
 */
export const LOG_REDACT_PATHS: string[] = ["Authorization", "authorization", "Cookie", "cookie", "token", "apiKey"]
  .flatMap((field) => [field, `*.${field}`]);

/**
 * Redact credentials out of a free-text string.
 *
 * The field-name rule above protects *structured* data — pino's merged object,
 * a config value. It cannot protect the pino **message**, which is a plain
 * string, and that is where the daemon's largest exposure actually is:
 * `summarizeToolResult` (`agent/live-session.ts`) puts the first 500
 * characters of every tool result into the message at `info`, and
 * `summarizeToolInput` does the same for tool arguments. A single
 * `Read ~/.tomo/config.json`, or any command that prints the MCP OAuth token
 * store, writes live credentials into `~/.tomo/logs/tomo.log` — defeating the
 * 0600 the token store is careful to set, because the log is world-readable
 * and is what gets pasted into a bug report.
 *
 * There is no key to match on here, so this matches on the *shape of the
 * value*: issuer-specific formats that cannot plausibly be anything else, plus
 * the `key: value` and `Authorization:` forms that carry them. The key is
 * always preserved, so the line still reads — only the value goes.
 *
 * Deliberately conservative. This is a net under the structured redaction, not
 * a replacement for it: a bare high-entropy string with no recognisable prefix
 * and no key in front of it is not matched, because "looks random" is not a
 * test that can be applied to arbitrary tool output without mangling it.
 */
export function scrubSecretValues(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of TEXT_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * What a credential looks like when there is no key to identify it: either 8+
 * characters containing a digit, or 16+ characters of anything. Never ending
 * in punctuation, so a sentence keeps its full stop.
 *
 * This gate is what keeps the rules below off ordinary English. "required",
 * "expired", "the", "meeting" and "endpoint" all fail it; a bot token, an
 * `sk-` key and a base64 blob all pass.
 */
const CREDENTIAL_SHAPE = "(?:(?=[A-Za-z0-9._~+/=-]*\\d)[A-Za-z0-9._~+/=-]{7,}|[A-Za-z0-9._~+/=-]{15,})[A-Za-z0-9=]";

/** Values that are facts about a credential rather than one. */
const NOT_A_SECRET = "(?!(?:null|true|false|undefined|none|nil|unset|empty|0)\\b)";

/** Field names that introduce a credential in `key: value` text. */
const SECRET_KEY_NAMES = "access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|apikey|auth[_-]?token|bot[_-]?token|password|passwd|secret|token";

/**
 * Ordered: the specific issuer formats run first, then the header rules, then
 * the generic key/value sweep. A recognised token is replaced as a unit rather
 * than being half-caught by a looser rule.
 */
const TEXT_SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Telegram bot token: <numeric bot id>:<35-char secret>. NO leading \b —
  // the form that actually leaks is grammY echoing the request URL,
  // `https://api.telegram.org/bot8123456:AAH…/getUpdates`, where the token is
  // glued to `bot` and there is no word boundary in front of the digits.
  [/\d{6,}:[A-Za-z0-9_-]{25,}\b/g, "***"],
  // Anthropic / OpenAI style. sk-ant- first so the longer prefix wins.
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "***"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "***"],
  // GitHub personal-access and app tokens.
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "***"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "***"],
  // Slack.
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "***"],
  // AWS access key id.
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "***"],
  // Google API key.
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, "***"],
  // JWTs (three base64url segments).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***"],
  // `Authorization: <scheme> <credential>` / `Cookie: <value>`, quoted form.
  // Inside quotes the key is unambiguous, so the whole value goes whatever it
  // looks like.
  [/\b(Authorization|Cookie|Set-Cookie)(["']?\s*[:=]\s*)(["'])[^"']*\3/gi, "$1$2$3***$3"],
  // Unquoted header form. Consumes the scheme plus ONE token, never to end of
  // line: `curl -H 'Authorization: Bearer …' https://example.com` must keep
  // its URL, and `Authorization: required for this endpoint` must survive
  // untouched, which the credential gate ensures.
  [
    new RegExp(`\\b(Authorization\\s*[:=]\\s*)((?:Bearer|Basic|Digest|Token|Negotiate)\\s+)?${CREDENTIAL_SHAPE}`, "gi"),
    "$1$2***",
  ],
  [new RegExp(`\\b(Cookie\\s*[:=]\\s*)${NOT_A_SECRET}${CREDENTIAL_SHAPE}`, "gi"), "$1***"],
  // `Bearer <token>` / `Basic <token>` standing on their own, in curl commands
  // and error messages that echo a request.
  //
  // Tightly constrained, because this rule sits in front of ordinary English
  // and the cost of a false positive is a mangled log line. Verified against
  // real messages in tomo.log that an earlier, looser version destroyed:
  // "assuming basic features are supported", "Missing token endpoint or
  // client id", "OAuth token response did not include access_token",
  // "access token expired."
  //   - case-SENSITIVE: `Bearer`/`Basic` are HTTP scheme tokens and are
  //     capitalised; "basic"/"token" in prose are not.
  //   - no `Token` alternative at all: as a scheme it is rare, and as an
  //     English word it precedes a noun in half the OAuth log lines we have.
  //     A real `Token <credential>` is still caught by the key/value rule.
  [new RegExp(`\\b(Bearer|Basic) (${CREDENTIAL_SHAPE})`, "g"), "$1 ***"],
  // `"access_token": "..."` — quoted, so the key is unambiguous and the value
  // goes whatever its shape, bar the literals that are facts worth keeping.
  [
    new RegExp(`\\b(${SECRET_KEY_NAMES})(["']?\\s*[:=]\\s*)(["'])${NOT_A_SECRET}[^"']*\\3`, "gi"),
    "$1$2$3***$3",
  ],
  // `client_secret=hunter2hunter2`, `--token abc123def456`. Unquoted, so the
  // value has to look like a credential — otherwise "secret: the meeting is
  // at 3" and "authentication token: expired" lose their first word.
  [
    new RegExp(`\\b(${SECRET_KEY_NAMES})(["']?\\s*[:=]\\s*)${NOT_A_SECRET}${CREDENTIAL_SHAPE}`, "gi"),
    "$1$2***",
  ],
];
