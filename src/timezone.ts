import { log } from "./logger.js";

/**
 * IANA time zone helpers for person records.
 *
 * Everything here goes through the platform tz database (`Intl`), so DST is
 * handled by the data rather than by arithmetic: a stored value is always a
 * REGION identifier (`Asia/Tokyo`), never a fixed offset, and the offset is
 * derived again for every render.
 *
 * A bad value must never take anything down with it. A hand-edited record can
 * hold any string at all, and it is read on the message path and on every
 * prompt build — so validation returns `undefined` instead of throwing, and
 * the warning is emitted at most once per distinct value.
 */

/** Distinct values already warned about, so a bad record logs once, not per message. */
const warned = new Set<string>();
/**
 * Bound on the memo above; a pathological registry cannot grow it forever.
 *
 * Past the cap we STOP RECORDING rather than clearing: clearing the set made
 * the memo useless exactly when it mattered — a registry holding one more bad
 * value than the cap would forget everything and warn for all of them again on
 * the very next render, turning "log once" into a log storm. Not recording
 * costs at most one uncounted repeat per value beyond the cap, and the
 * suppression notice below says the ceiling was reached.
 */
const MAX_WARNED = 200;
/** Emitted once, the first time a value has to go unrecorded. */
let suppressionAnnounced = false;

/**
 * The regions of the tz database. Used only as a fallback for a runtime
 * without `Intl.supportedValuesOf` — on Node 22 (this package's floor) the
 * real list is available and is exactly these ten prefixes.
 */
const TZ_REGIONS = new Set([
  "Africa", "America", "Antarctica", "Arctic", "Asia",
  "Atlantic", "Australia", "Europe", "Indian", "Pacific",
]);

/** Canonical zone names the runtime knows, or null where unavailable. */
const SUPPORTED_ZONES: ReadonlySet<string> | null = (() => {
  try {
    const values = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    return values && values.length > 0 ? new Set(values) : null;
  } catch {
    return null;
  }
})();

/**
 * Is this a region identifier — `Continent/City` — rather than one of the
 * pseudo-zones that behave like a stored offset?
 *
 * The rejected set is the whole point of the feature, so it is checked on the
 * RAW value as well as on the canonical one:
 *
 * - `+09:00` / `-05:00` — an offset wearing a zone's clothes.
 * - anything without a `/` — `UTC`, `GMT`, and the legacy all-caps aliases
 *   `EST`, `MST`, `HST`, `EST5EDT`, `CST6CDT`, `Zulu`, `Universal`. These are
 *   the dangerous ones: ICU quietly resolves `EST` to `America/Panama`, a zone
 *   that never observes DST, so a record meaning "New York" would read an hour
 *   wrong every summer — and would look perfectly healthy while doing it.
 * - the `Etc/` namespace — `Etc/GMT+8`, `Etc/UTC`, `Etc/Zulu`. Fixed offsets
 *   by construction, and `Etc/GMT+8` would put a bare numeric offset into the
 *   prompt-cached participants block.
 *
 * Checking the raw value matters because canonicalization is ICU-version
 * dependent: `EST` resolves to a real-looking `America/…` name on this build,
 * so a canonical-only test would let it through on some hosts and not others.
 * Region ALIASES still work — `US/Pacific`, `Asia/Kolkata`, `Europe/Kyiv` all
 * canonicalize into the allowlist and are accepted.
 */
function isRegionZone(raw: string, canonical: string): boolean {
  if (/^[+-]/.test(raw)) return false;
  for (const name of [raw, canonical]) {
    const slash = name.indexOf("/");
    if (slash <= 0) return false;
    if (name.slice(0, slash).toLowerCase() === "etc") return false;
  }
  // The runtime's own list is the authority when it has one; every canonical
  // name ICU produces for a real zone appears in it. The region-prefix rule is
  // the fallback, and a second opinion when the list is missing an alias
  // target.
  if (SUPPORTED_ZONES?.has(canonical)) return true;
  return TZ_REGIONS.has(canonical.slice(0, canonical.indexOf("/")));
}

/**
 * The canonical IANA name for `value` (`asia/tokyo` → `Asia/Tokyo`,
 * `US/Pacific` → `America/Los_Angeles`), or undefined when it is not a region
 * identifier this codebase will store and render. Silent — callers that want
 * the log use `validTimeZone`.
 */
export function canonicalTimeZone(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  return isRegionZone(v, canonical) ? canonical : undefined;
}

/** True when `value` is an identifier this codebase will store and render. */
export function isValidTimeZone(value: string | undefined): boolean {
  return canonicalTimeZone(value) !== undefined;
}

/**
 * Canonical time zone for a value that came off disk, or undefined — logging
 * an unusable one ONCE. Use this on read paths (prompt build, message
 * envelope, tool output) where a broken record must degrade to "no time zone"
 * quietly.
 */
export function validTimeZone(value: string | undefined, context: Record<string, unknown> = {}): string | undefined {
  const canonical = canonicalTimeZone(value);
  if (canonical) return canonical;
  const raw = value?.trim();
  if (!raw || warned.has(raw)) return undefined;
  if (warned.size >= MAX_WARNED) {
    if (!suppressionAnnounced) {
      suppressionAnnounced = true;
      log.warn(
        { distinctValues: warned.size },
        "Too many distinct unusable time zones; further invalid timezone warnings are suppressed",
      );
    }
    return undefined;
  }
  warned.add(raw);
  log.warn({ ...context, timezone: raw }, "Ignoring an unusable time zone (expected an IANA identifier)");
  return undefined;
}

/**
 * Wall clock in `timeZone` as `MM/DD HH:mm ZZZ` — the host's own zone when it
 * is undefined. Recomputed per call from the tz database, so a DST transition
 * needs no code change and no stored offset.
 *
 * The pieces match the inbound stamp's existing host segment exactly (same
 * locale, same options), which is what lets the caller compare the two
 * renderings to decide whether a second one is worth showing at all.
 */
export function formatZonedClock(now: Date, timeZone?: string): string {
  const zoneOpt = timeZone ? { timeZone } : {};
  const date = now.toLocaleDateString("en-US", { ...zoneOpt, month: "2-digit", day: "2-digit" });
  const time = now.toLocaleTimeString("en-US", { ...zoneOpt, hour: "2-digit", minute: "2-digit", hour12: false });
  const zone = now.toLocaleTimeString("en-US", { ...zoneOpt, timeZoneName: "short" }).split(" ").pop();
  return `${date} ${time} ${zone}`;
}
