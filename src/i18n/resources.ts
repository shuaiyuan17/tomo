import type { Locale } from "./locales.js";
import type { Translation } from "./catalog.js";

/**
 * Every daemon-side catalog, by locale and namespace (one namespace per
 * feature). English is the source and the type of every key; each other
 * locale must satisfy `Translation<typeof en>`, so a missing or extra key is
 * a compile error. tests/i18n-catalogs.test.ts adds what tsc cannot see:
 * matching placeholders, and no key left unused.
 *
 * Adding a namespace: `catalogs/en/<ns>.ts` (`export const <ns> = { ... }
 * as const`), `catalogs/zh-Hans/<ns>.ts` (the same name, `satisfies
 * Translation<typeof en>`), and one entry per locale below.
 */
const en = {} as const;

export const resources = {
  en,
  "zh-Hans": {},
} satisfies { en: typeof en } & Record<Exclude<Locale, "en">, Translation<typeof en>>;

export type ServerResources = typeof en;
export type ServerNamespace = keyof ServerResources;
export const NAMESPACES = Object.keys(en) as ServerNamespace[];
