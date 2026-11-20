/**
 * The locales Tomo ships copy for, and how a requested language is matched
 * to one. Pure (no Node or DOM APIs beyond `Intl`) so the web UI imports the
 * same resolution the daemon uses.
 *
 * English is the source catalog: every key exists in `en` first, other
 * locales translate it, and anything missing falls back to English.
 */
export const LOCALES = ["en", "zh-Hans"] as const;
export type Locale = typeof LOCALES[number];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The shipped locale a BCP 47 tag asks for, or null when none fits.
 * `Intl.Locale#maximize` supplies the likely script, so `zh`, `zh-CN` and
 * `zh-SG` are Simplified Chinese while `zh-TW` / `zh-HK` (Traditional) are
 * not matched rather than shown a script their reader did not ask for.
 */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  let locale: Intl.Locale;
  try { locale = new Intl.Locale(tag).maximize(); } catch { return null; }
  if (locale.language === "en") return "en";
  if (locale.language === "zh" && locale.script === "Hans") return "zh-Hans";
  return null;
}

/** The first candidate that matches a shipped locale, else English. */
export function resolveLocale(...candidates: ReadonlyArray<string | null | undefined>): Locale {
  for (const candidate of candidates) {
    const match = matchLocale(candidate);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/** A locale's own name for itself ("English", "中文（简体）"), from `Intl.DisplayNames`. */
export function localeName(locale: Locale): string {
  try { return new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale; } catch { return locale; }
}
