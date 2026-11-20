import type { Locale } from "../../../src/i18n/locales.js";
import type { Translation } from "../../../src/i18n/catalog.js";
import * as enCatalogs from "./catalogs/en/index.js";
import * as zhCatalogs from "./catalogs/zh-Hans/index.js";

/**
 * The web UI's catalogs, by locale and namespace (one per feature). English
 * is the source and the type of every key; each translation must satisfy
 * `Translation<typeof en>`, so a missing or extra key fails `tsc`.
 * tests/i18n-catalogs.test.ts checks placeholders and unused keys.
 */
const en = { ...enCatalogs };
export const resources = {
  en,
  "zh-Hans": { ...zhCatalogs },
} satisfies { en: typeof en } & Record<Exclude<Locale, "en">, Translation<typeof en>>;

export type WebResources = typeof en;
export const NAMESPACES = Object.keys(en) as (keyof WebResources)[];
