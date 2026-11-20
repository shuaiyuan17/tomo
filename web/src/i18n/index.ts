import i18next from "i18next";
import { initReactI18next, Trans, useTranslation } from "react-i18next";
import { useSyncExternalStore } from "react";
import { DEFAULT_LOCALE, LOCALES, isLocale, matchLocale, resolveLocale, type Locale } from "../../../src/i18n/locales.js";
import { NAMESPACES, resources, type WebResources } from "./resources.js";

export { LOCALES, localeName, type Locale } from "../../../src/i18n/locales.js";

declare module "i18next" {
  interface CustomTypeOptions {
    resources: WebResources;
    defaultNS: "common";
  }
}

/** The Settings choice, per browser. Absent: follow config `locale`, then the browser's language. */
const STORAGE_KEY = "tomo-locale";

export function storedLocale(): Locale | null {
  try { const value = localStorage.getItem(STORAGE_KEY); return isLocale(value) ? value : null; } catch { return null; }
}

/** The browser's languages in preference order (none outside a browser, so tests and SSR are English). */
function browserLanguages(): string[] {
  if (typeof window === "undefined" || typeof navigator === "undefined") return [];
  return [...(navigator.languages ?? []), navigator.language].filter(Boolean);
}

/** config `locale` from bootstrap, once it has arrived. */
let configured: string | undefined;

/**
 * The UI's locale: the Settings choice, else config `locale`, else the
 * browser's language, else English.
 */
export function pickLocale(choice: Locale | null, config: string | undefined, browser: readonly string[]): Locale {
  return resolveLocale(choice, config, ...browser);
}

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: pickLocale(storedLocale(), undefined, browserLanguages()),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...LOCALES],
  load: "currentOnly",
  resources,
  ns: NAMESPACES,
  defaultNS: "common",
  // Bundled catalogs: usable at import, so components render translated text on the first paint (and in tests).
  initAsync: false,
  // React escapes.
  interpolation: { escapeValue: false },
  returnNull: false,
});

function syncDocument(): void {
  if (typeof document !== "undefined") document.documentElement.lang = i18n.language;
}
syncDocument();
i18n.on("languageChanged", syncDocument);

/** The active locale, for `Intl` (always one of LOCALES). */
export function locale(): Locale {
  return isLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
}

/**
 * The locale numbers and dates are formatted in, given the UI language and
 * the browser's own language: the browser's regional tag when it is that UI
 * language (en-GB under English keeps day-month dates and its own clock;
 * zh-CN under 简体中文), else the UI locale itself (an en-US browser that
 * picked 简体中文 formats as zh-Hans). Never a region the reader did not choose.
 */
export function formatLocaleFor(ui: Locale, browser: string | undefined): string {
  if (!browser || matchLocale(browser) !== ui) return ui;
  try { return Intl.getCanonicalLocales(browser)[0] ?? ui; } catch { return ui; }
}

/** The format locale now (see formatLocaleFor). Pass it to every `Intl` formatter. */
export function formatLocale(): string {
  return formatLocaleFor(locale(), typeof window === "undefined" || typeof navigator === "undefined" ? undefined : navigator.language);
}

/** Bootstrap arrived: config `locale` applies unless this browser picked one. */
export function applyConfiguredLocale(value: string | undefined): void {
  if (configured === value) return;
  configured = value;
  const next = pickLocale(storedLocale(), configured, browserLanguages());
  if (next !== i18n.language) void i18n.changeLanguage(next);
}

const listeners = new Set<() => void>();
/** Pick a language for this browser (null: follow the default again). */
export function setLocaleChoice(choice: Locale | null): void {
  try { if (choice) localStorage.setItem(STORAGE_KEY, choice); else localStorage.removeItem(STORAGE_KEY); } catch { /* Storage can be unavailable. */ }
  void i18n.changeLanguage(pickLocale(choice, configured, browserLanguages()));
  for (const listener of listeners) listener();
}

/** The Settings choice (null: default) and a way to change it. */
export function useLocaleChoice(): [Locale | null, (choice: Locale | null) => void] {
  const choice = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, storedLocale, () => null);
  useTranslation();
  return [choice, setLocaleChoice];
}

export { Trans, useTranslation };
