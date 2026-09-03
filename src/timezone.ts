import { log } from "./logger.js";

/**
 * IANA time zone helpers for person records.
 *
 * Everything here goes through the platform tz database (`Intl`), so DST is
 * handled by the data rather than by arithmetic: a stored value is always an
 * identifier (`Asia/Tokyo`), never a fixed offset, and the offset is derived
 * again for every render.
 *
 * A bad value must never take anything down with it. A hand-edited record can
 * hold any string at all, and it is read on the message path and on every
 * prompt build — so validation returns `undefined` instead of throwing, and
 * the warning is emitted once per distinct value rather than on every message.
 */

/** Distinct values already warned about, so a bad record logs once, not per message. */
const warned = new Set<string>();
/** Bound on the memo above; a pathological registry cannot grow it forever. */
const MAX_WARNED = 200;

/**
 * Fixed-offset forms (`+08:00`) that `Intl` also accepts are deliberately
 * rejected: they look like a time zone and then silently sit an hour wrong for
 * half the year. Only real identifiers, which carry DST rules, are stored.
 */
function isOffsetForm(value: string): boolean {
  return /^[+-]/.test(value);
}

/**
 * The canonical IANA name for `value` (`asia/tokyo` → `Asia/Tokyo`,
 * `Etc/UTC` → `UTC`), or undefined when it is not a usable identifier.
 * Silent — callers that want the log use `validTimeZone`.
 */
export function canonicalTimeZone(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v || isOffsetForm(v)) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** True when `value` is an identifier this codebase will store and render. */
export function isValidTimeZone(value: string | undefined): boolean {
  return canonicalTimeZone(value) !== undefined;
}

/**
 * Canonical time zone for a value that came off disk, or undefined — logging
 * an unusable one ONCE. Use this on read paths (prompt build, message
 * envelope) where a broken record must degrade to "no time zone" quietly.
 */
export function validTimeZone(value: string | undefined, context: Record<string, unknown> = {}): string | undefined {
  const canonical = canonicalTimeZone(value);
  if (canonical) return canonical;
  const raw = value?.trim();
  if (raw && !warned.has(raw)) {
    if (warned.size >= MAX_WARNED) warned.clear();
    warned.add(raw);
    log.warn({ ...context, timezone: raw }, "Ignoring an unusable time zone (expected an IANA identifier)");
  }
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
