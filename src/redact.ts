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
 * Only plain objects and arrays are rebuilt. Anything else with structure —
 * Date, Map, Set, Buffer, RegExp, a class instance — is passed through
 * untouched. Rebuilding one from `Object.entries` would flatten it to `{}` and
 * silently destroy the value it was logged for.
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
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
  if (!Array.isArray(value) && !isPlainObject(value)) return false;
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
 * Ordered: the specific issuer formats run before the generic `key: value`
 * sweep, so a recognised token is replaced as a unit rather than being
 * half-caught by the looser rule.
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
  // `Authorization: <anything>` — the whole header value, scheme included, as
  // one unit. Runs BEFORE the Bearer rule: splitting it produces
  // `Authorization: *** <credential>`, which redacts the scheme and publishes
  // the secret.
  [/(\bAuthorization["']?\s*[:=]\s*)(["'])[^"']*\2/gi, "$1$2***$2"],
  [/(\bAuthorization\s*[:=]\s*)[^\r\n,}\]]+/gi, "$1***"],
  // `Bearer <token>` / `Basic <token>` standing on their own, in curl
  // commands and error messages that echo a request.
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
  //   - the value must LOOK like a credential: at least 16 characters and at
  //     least one digit, which no English word or short identifier satisfies.
  //   - the value cannot end in sentence punctuation, so "expired." keeps its
  //     full stop.
  [/\b(Bearer|Basic) ((?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{15,}[A-Za-z0-9=])/g, "$1 ***"],
  // `"access_token": "..."`, `client_secret=...`, `--token abc`. The key is
  // kept; only the value is replaced. Literal non-secrets are skipped so
  // `token: null` — which is a fact worth logging — survives intact.
  [
    /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|apikey|auth[_-]?token|bot[_-]?token|password|passwd|secret|token)(["']?\s*[:=]\s*)(["']?)(?!(?:null|true|false|undefined|none|nil|0)\b["',}\s]?)[^"'\s,;}&]+\3/gi,
    "$1$2$3***$3",
  ],
];
