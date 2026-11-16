/**
 * Calendar date and clock hour of an instant in an IANA time zone, fast
 * enough to run on every ledger row of a year (~36k) per request.
 *
 * `Intl` is the only source of truth (DST comes from the tz database), but
 * formatting every row costs too much, so the zone's UTC offset is cached
 * (see offsetAt).
 */

const HOUR_MS = 3_600_000;
const MAX_CACHED_HOURS = 200_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, Map<number, number | null>>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The zone's offset from UTC at `ts`, in ms (local = ts + offset). */
export function zoneOffsetMs(ts: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ts))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return local - Math.floor(ts / 1000) * 1000;
}

const DAY_MS = 24 * HOUR_MS;

/**
 * Cached per UTC day when the offset holds all day (a day's start and end
 * agree; a zone changes offset at most once a day), else per UTC hour, else
 * (the transition's own hour) per instant.
 */
function offsetAt(ts: number, timeZone: string): number {
  let zone = offsets.get(timeZone);
  if (!zone) offsets.set(timeZone, zone = new Map());
  if (zone.size >= MAX_CACHED_HOURS) zone.clear();
  // Day keys are negative so they never collide with hour keys.
  const day = Math.floor(ts / DAY_MS);
  let daily = zone.get(-1 - day);
  if (daily === undefined) {
    const start = zoneOffsetMs(day * DAY_MS, timeZone);
    const end = zoneOffsetMs(day * DAY_MS + DAY_MS - 1000, timeZone);
    daily = start === end ? start : null;
    zone.set(-1 - day, daily);
  }
  if (daily !== null) return daily;
  const hour = Math.floor(ts / HOUR_MS);
  let cached = zone.get(hour);
  if (cached === undefined) {
    const start = zoneOffsetMs(hour * HOUR_MS, timeZone);
    const end = zoneOffsetMs(hour * HOUR_MS + HOUR_MS - 1000, timeZone);
    cached = start === end ? start : null;
    zone.set(hour, cached);
  }
  return cached ?? zoneOffsetMs(ts, timeZone);
}

export interface LocalParts {
  /** `YYYY-MM-DD`. */
  date: string;
  /** 0–23. */
  hour: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function localParts(ts: number, timeZone: string): LocalParts {
  const d = new Date(ts + offsetAt(ts, timeZone));
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, hour: d.getUTCHours() };
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Is `date` a real `YYYY-MM-DD` calendar date? */
export function isCalendarDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** `date` moved by `days` calendar days (no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Calendar days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  const ms = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** The machine's own zone: the fallback when the owner has none on record. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
