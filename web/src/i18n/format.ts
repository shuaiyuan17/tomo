import { formatLocale, i18n } from "./index.js";

/**
 * Numbers, durations, dates and relative times in the active locale, all
 * through `Intl` (never hand-built: "2h 14m" is "2小时14分钟" in Chinese).
 */

/** 1234 → "1,234". */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(formatLocale(), options).format(value);
}

/** 12_345 → "12.3K" / "1.2万". */
export function formatCompact(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(formatLocale(), { notation: "compact", maximumFractionDigits }).format(value);
}

/** 2, "hour" → "2h" / "2小时". */
export function formatUnit(value: number, unit: "day" | "hour" | "minute" | "second" | "millisecond", unitDisplay: "narrow" | "short" | "long" = "narrow"): string {
  return new Intl.NumberFormat(formatLocale(), { style: "unit", unit, unitDisplay }).format(value);
}

/** Two units of one span ("2h 14m" / "2小时14分钟"). */
export function formatUnitPair(first: string, second: string): string {
  return i18n.t("common:format.unitPair", { first, second });
}

/** A date or time in the active locale. */
export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(formatLocale(), options).format(value);
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000], ["second", 1_000]];
/** `ms` from now (negative: in the past) as "2 minutes ago" / "2分钟前", in the largest whole unit. */
export function formatRelative(ms: number, style: Intl.RelativeTimeFormatStyle = "long"): string {
  const format = new Intl.RelativeTimeFormat(formatLocale(), { numeric: "auto", style });
  for (const [unit, size] of RELATIVE_UNITS) if (Math.abs(ms) >= size || unit === "second") return format.format(Math.trunc(ms / size), unit);
  return format.format(0, "second");
}

/** ["a", "b", "c"] → "a, b, and c" / "a、b和c". */
export function formatList(items: readonly string[], type: Intl.ListFormatType = "conjunction"): string {
  return new Intl.ListFormat(formatLocale(), { style: "long", type }).format(items);
}
