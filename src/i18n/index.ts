import i18next, { type ParseKeys, type TOptions } from "i18next";
import { config } from "../config.js";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./locales.js";
import { NAMESPACES, resources, type ServerNamespace, type ServerResources } from "./resources.js";

export { DEFAULT_LOCALE, LOCALES, isLocale, localeName, matchLocale, resolveLocale, type Locale } from "./locales.js";

declare module "i18next" {
  interface CustomTypeOptions {
    resources: ServerResources;
    defaultNS: false;
  }
}

declare const ownerTextBrand: unique symbol;
/**
 * Text Tomo itself writes to a person (a command reply, an owner notice, the
 * permission DM), already in their language. The owner-facing outlets take
 * this type and nothing else, so a fixed English string cannot reach them
 * without going through a catalog: build one with {@link ownerT}, or say
 * explicitly that the text is not ours to translate with {@link raw}.
 */
export type OwnerText = string & { readonly [ownerTextBrand]: true };

/**
 * Text passed through unchanged: model output, a file name, an error message
 * from a library, a value the person typed. Never wrap fixed copy in it.
 */
export function raw(text: string): OwnerText {
  return text as OwnerText;
}

/** Join translated parts (lines of one reply). */
export function joinText(parts: readonly OwnerText[], separator = "\n"): OwnerText {
  return parts.join(separator) as OwnerText;
}

/**
 * The daemon's i18next instance. No current language lives on it: every
 * message picks its locale explicitly through {@link ownerT}, so one
 * conversation's language can never leak into another's. Text written for
 * the MODEL (system prompt, tomo-event blocks, heartbeat prompts, tool
 * descriptions) stays English and never goes through here; so do logs and
 * the CLI.
 */
const i18n = i18next.createInstance();
void i18n.init({
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...LOCALES],
  load: "currentOnly",
  resources,
  ns: NAMESPACES,
  defaultNS: false,
  // The catalogs are bundled: `t` works the moment this module is imported.
  initAsync: false,
  // Chat text is plain text.
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** The locale owner-facing text is written in: config `locale`, else English. */
export function ownerLocale(): Locale {
  return config.locale ?? DEFAULT_LOCALE;
}

/** A translator for one namespace in one locale. Keys are checked against the English catalog by tsc. */
export type OwnerT<NS extends ServerNamespace> = (key: ParseKeys<NS>, options?: TOptions) => OwnerText;

/**
 * Translate keys of `ns` into `locale` (default: {@link ownerLocale}, read
 * now, so a test or a future reload sees the current setting). Numbers and
 * dates go through the built-in `{{value, number}}` / `{{value, datetime}}`
 * / `{{value, relativetime}}` formatters, which are `Intl` underneath.
 */
export function ownerT<NS extends ServerNamespace>(ns: NS, locale: Locale = ownerLocale()): OwnerT<NS> {
  const fixed = i18n.getFixedT(locale, ns) as unknown as (key: string, options?: TOptions) => string;
  return (key, options) => fixed(key as string, options) as OwnerText;
}

/**
 * The locale to hand `Intl` for dates and numbers: config `locale` when it
 * is set, else undefined, the system's own default, exactly as before
 * there was a setting. (Text falls back to English instead: {@link ownerLocale}.)
 */
export function formatLocale(): Locale | undefined {
  return config.locale ?? undefined;
}

/** A date and time as `locale` writes it (`toLocaleString`); undefined is the system default. */
export function formatDateTime(value: number | Date, locale: Locale | undefined = formatLocale(), options?: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleString(locale, options);
}

/** A number as `locale` writes it (`Intl.NumberFormat`); undefined is the system default. */
export function formatNumber(value: number, locale: Locale | undefined = formatLocale(), options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}
