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
  return walk(value, fieldName, { censor: redactSecretValue, scrubStrings: false }, new Set(), 0);
}

/** What a censored field is replaced with. */
type Censor = (value: unknown) => unknown;

interface WalkOptions {
  censor: Censor;
  /**
   * Also run the value-shaped rules over string leaves. On for log records and
   * error trees; off for config values, where the operator is being shown what
   * they typed and `configIssues` has its own name-based rule.
   */
  scrubStrings: boolean;
}

/**
 * How deep the walk goes before it stops and substitutes a marker.
 *
 * Without a cap, recursion depth is attacker-controlled: a 60k-deep object
 * (a parsed JSON payload, a linked structure in a tool result) overflowed the
 * stack with a RangeError. That throw escaped into pino's `formatters.log`
 * hook, which is OUTSIDE its guarded serialization — so it killed the log
 * call, and with no `uncaughtException` handler in the daemon (issue #312,
 * finding 14) that is a process-level risk. Nothing the daemon legitimately
 * logs is anywhere near 32 deep.
 */
const MAX_WALK_DEPTH = 32;

/**
 * Longest string leaf scanned by the value-shaped rules. Beyond this the tail
 * is passed through unscanned rather than paying an unbounded regex cost on
 * every log line; a 500-character tool summary, which is the case that
 * matters, is far below it.
 */
const MAX_SCRUBBED_STRING = 8192;

const TOO_DEEP = "[Depth limit]";
const UNREADABLE = "[Unreadable]";

/**
 * Values whose structure lives somewhere other than own enumerable properties.
 * Rebuilding one from its entries would flatten it to `{}` and silently
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

/**
 * Own enumerable entries, tolerating an object that fights back.
 *
 * `Object.entries` reads every property, which INVOKES GETTERS — so one
 * throwing getter anywhere in a log record used to take the whole log call
 * with it. Keys are listed first (cheap, no getter invocation) and each
 * property is then read on its own, so a hostile property costs that property
 * and nothing else. Returns null when the object cannot even be enumerated
 * (a revoked Proxy), in which case the caller passes it through and lets
 * pino's own guarded serialization deal with it, exactly as before this
 * redaction existed.
 */
function safeEntries(value: object): Array<[string, unknown]> | null {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return null;
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    try {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      entries.push([key, UNREADABLE]);
    }
  }
  return entries;
}

/**
 * Shortest string any rule here can match. The issuer prefixes are all longer
 * than this and `CREDENTIAL_SHAPE` requires 8, so anything shorter cannot
 * contain a credential and is skipped without running a single regex — which
 * covers most of what a log record actually holds ("1200ms", "$0.0123").
 */
const MIN_SCRUBBABLE_LENGTH = 8;

function scrubLeaf(value: string): string {
  if (value.length < MIN_SCRUBBABLE_LENGTH) return value;
  if (value.length <= MAX_SCRUBBED_STRING) return scrubSecretValues(value);
  const head = value.slice(0, MAX_SCRUBBED_STRING);
  const scrubbed = scrubSecretValues(head);
  return scrubbed === head ? value : scrubbed + value.slice(MAX_SCRUBBED_STRING);
}

/**
 * The one walker behind every redaction surface.
 *
 * Returns the ORIGINAL value, by identity, when nothing changed — so a log
 * record with nothing to redact is not cloned, and a class instance is not
 * silently flattened into a plain object for no reason.
 */
function walk(
  value: unknown,
  fieldName: string | undefined,
  opts: WalkOptions,
  ancestors: Set<object>,
  depth: number,
): unknown {
  if (fieldName !== undefined && isSecretFieldName(fieldName)) return opts.censor(value);
  if (typeof value === "string") return opts.scrubStrings ? scrubLeaf(value) : value;
  if (value === null || typeof value !== "object") return value;
  // Classifying the value is itself fallible: `instanceof` and `Array.isArray`
  // both perform getPrototypeOf, which THROWS on a revoked Proxy. Anything we
  // cannot classify is treated as opaque and passed through for pino's own
  // guarded serialization to deal with.
  let kind: "error" | "opaque" | "array" | "object";
  try {
    // A raw Error is left alone: pino's `err` serializer turns it into a plain
    // object (and that serializer is wrapped in logger.ts, which routes it
    // back through here), and copying one now would strip the prototype the
    // serializer keys off, losing the stack.
    kind = value instanceof Error
      ? "error"
      : Array.isArray(value)
        ? "array"
        : isOpaque(value) ? "opaque" : "object";
  } catch {
    kind = "opaque";
  }
  if (kind === "error" || kind === "opaque") return value;
  // ANCESTORS, not "everything visited". A `seen` set that is never unwound
  // reports the second sighting of a shared-but-acyclic node as a cycle — and
  // config and log objects are full of shared references (the same identity
  // object under two channels, one options object passed twice). Only a node
  // that is its own ancestor is actually a cycle.
  if (ancestors.has(value)) return "[Circular]";
  if (depth >= MAX_WALK_DEPTH) return TOO_DEEP;
  ancestors.add(value);
  try {
    if (kind === "array") {
      let changed = false;
      const items = (value as unknown[]).map((item) => {
        const next = walk(item, undefined, opts, ancestors, depth + 1);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? items : value;
    }
    const entries = safeEntries(value);
    if (entries === null) return value;
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      const next = walk(item, key, opts, ancestors, depth + 1);
      if (next !== item) changed = true;
      result[key] = next;
    }
    return changed ? result : value;
  } finally {
    ancestors.delete(value);
  }
}

/** pino's default censor, reused so shallow (`redact.paths`) and deep (the
 *  `formatters.log` hook) redaction are indistinguishable in the output. */
export const LOG_CENSOR = "[Redacted]";

const LOG_WALK: WalkOptions = { censor: () => LOG_CENSOR, scrubStrings: true };

let warnedRedactionFailure = false;

/**
 * Deep-redact a log record: censor secret-named fields at any depth, and run
 * the value-shaped rules over string leaves.
 *
 * String leaves matter as much as field names here. `imessage-imsg.ts` logs
 * child-process RPC params, and a value like
 * `{ dbUrl: "postgres://admin:S3cret@host" }` or
 * `{ header: "Authorization: Bearer sk-ant-…" }` carries the credential under
 * a field name no rule could match.
 *
 * `redact.paths` is a fixed ladder of literal paths, so it can only ever cover
 * the depths someone thought to enumerate. Real leaks are deeper than the
 * ladder: `{ config: { channels: { telegram: { token } } } }` is four levels,
 * an axios-shaped error carries `err.config.headers.Authorization`, and an MCP
 * server entry nests `mcpServers.<name>.headers.Authorization`. This closes
 * the general case.
 */
export function redactLogRecord<T>(record: T): T {
  try {
    return walk(record, undefined, LOG_WALK, new Set(), 0) as T;
  } catch (err) {
    // The walk is defensive about getters, un-enumerable objects, cycles and
    // depth, so reaching here means something genuinely unforeseen. Losing
    // every subsequent log line to a redaction bug would be worse than the
    // record going out with only pino's own `redact.paths` in front of it,
    // which is what protected it before this hook existed.
    //
    // console, not `log` — importing the logger here would be a cycle, and
    // this fires at most once per process.
    if (!warnedRedactionFailure) {
      warnedRedactionFailure = true;
      console.warn("[tomo] log redaction failed; records pass through with path-based redaction only:", err);
    }
    return record;
  }
}

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
 */
export function redactSerializedError(value: unknown): unknown {
  try {
    return walk(value, undefined, LOG_WALK, new Set(), 0);
  } catch {
    return value;
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
  // bounded at 20 digits: an unbounded \d{6,} made this quadratic (32k digits
  // took 910ms of backtracking looking for the colon). Real bot ids are ~10.
  // No leading \\b — the form that actually leaks is grammY echoing the URL,
  // `https://api.telegram.org/bot8123456:AAH…/getUpdates`, where the token is
  // glued to `bot` and there is no word boundary in front of the digits.
  [/\d{6,20}:[A-Za-z0-9_-]{25,}\b/g, "***"],
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
  // A credential in a URL's userinfo: `postgres://admin:S3cret@host`. Keeps
  // the scheme and the username — which are what make the line diagnostic —
  // and drops the password. Connection strings reach the log through
  // ordinary-looking field names (`dbUrl`), which no name rule can catch.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s:/@]+@/gi, "$1:***@"],
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
  // `client_secret=hunter2hunter2`, `token=abc123def456`. Unquoted, so the
  // value has to look like a credential — otherwise "secret: the meeting is
  // at 3" and "authentication token: expired" lose their first word.
  [
    new RegExp(`\\b(${SECRET_KEY_NAMES})(["']?\\s*[:=]\\s*)${NOT_A_SECRET}${CREDENTIAL_SHAPE}`, "gi"),
    "$1$2***",
  ],
];
