import { baseKey, flattenCatalog, isOptionalPluralForm, placeholdersOf } from "../../src/i18n/catalog.js";
import { findUsedKeys, isDynamic, type Source } from "./i18n-ast.js";

export { readSources, type Source } from "./i18n-ast.js";

/** One app's catalogs and the source that uses them. */
export interface CatalogSet {
  name: string;
  /** locale → namespace → catalog; `en` is the source. */
  resources: Record<string, Record<string, object>>;
  /** The source files whose translator calls must use every key (catalog files excluded). */
  sources: readonly Source[];
  /** The namespace a bare, unbound `t("key")` call means (the web UI's `defaultNS`). */
  defaultNS?: string;
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const list = (set: Set<string>) => `{${[...set].sort().join(",")}}`;
const without = (set: Set<string>, name: string) => new Set([...set].filter((p) => p !== name));

/** The CLDR category a plural form names (`msgs_one` → `one`), or null for an ordinary key. */
function pluralCategory(key: string, keys: ReadonlyMap<string, string>): string | null {
  return baseKey(key, keys) === key ? null : key.slice(key.lastIndexOf("_") + 1);
}

/**
 * Problems inside one locale's catalog: empty texts; a plural form for a
 * category the language does not have (`Intl.PluralRules`: Chinese has only
 * `other`, so a Chinese `_one` is dead copy; `_zero` is allowed everywhere,
 * because i18next tries it first for `count: 0` whatever CLDR says); and a form whose placeholders
 * differ from its family's `_other` beyond `count`. Only the `zero` / `one` /
 * `two` forms may drop `{{count}}` ("One message"), because each stands for
 * a single number.
 */
function localProblems(prefix: string, locale: string, flat: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const categories = new Set<string>(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
  for (const [key, text] of flat) {
    if (!text.trim()) problems.push(`${prefix}: "${key}" is empty`);
    const category = pluralCategory(key, flat);
    if (!category) continue;
    if (category !== "zero" && !categories.has(category)) problems.push(`${prefix}: "${key}" is a "${category}" form, which ${locale} does not have`);
    const other = flat.get(`${baseKey(key, flat)}_other`);
    if (category === "other" || other === undefined) continue;
    const want = placeholdersOf(other);
    const got = placeholdersOf(text);
    const mayDropCount = ["zero", "one", "two"].includes(category);
    if (!same(mayDropCount ? without(want, "count") : want, mayDropCount ? without(got, "count") : got) || (got.has("count") && !want.has("count"))) {
      problems.push(`${prefix}: "${key}" placeholders ${list(got)} ≠ its _other ${list(want)}`);
    }
  }
  return problems;
}

/**
 * What tsc cannot check about a set of catalogs:
 * - every locale has every English key, plural forms aside (also tsc's
 *   job, repeated here for the runtime view) and no key English lacks;
 * - each translated text has exactly the placeholders of the same English
 *   form (a form English lacks is compared with the family's `_other`);
 * - the per-locale checks above, English included;
 * - every English key is used: a translator call bound to its namespace
 *   with the key as a literal (see findUsedKeys), or declared dynamic with
 *   an `// i18n-dynamic: ns:prefix*` comment.
 */
export function catalogProblems(set: CatalogSet): string[] {
  const problems: string[] = [];
  const en = set.resources.en ?? {};
  for (const [ns, catalog] of Object.entries(en)) problems.push(...localProblems(`${set.name} en ${ns}`, "en", flattenCatalog(catalog)));
  for (const [locale, namespaces] of Object.entries(set.resources)) {
    if (locale === "en") continue;
    for (const ns of new Set([...Object.keys(en), ...Object.keys(namespaces)])) {
      const prefix = `${set.name} ${locale} ${ns}`;
      const source = flattenCatalog(en[ns] ?? {});
      const target = flattenCatalog(namespaces[ns] ?? {});
      for (const key of source.keys()) {
        if (!target.has(key) && !isOptionalPluralForm(key, source)) problems.push(`${prefix}: missing "${key}"`);
      }
      for (const [key, text] of target) {
        const english = source.get(key) ?? (pluralCategory(key, source) ? undefined : null);
        const fallback = source.get(`${baseKey(key, source)}_other`);
        if (english === null || (english === undefined && fallback === undefined)) { problems.push(`${prefix}: "${key}" is not in English`); continue; }
        const want = placeholdersOf(english ?? fallback!);
        const got = placeholdersOf(text);
        if (!same(want, got)) problems.push(`${prefix}: "${key}" placeholders ${list(got)} ≠ English ${list(want)}`);
      }
      problems.push(...localProblems(prefix, locale, target));
    }
  }
  const uses = findUsedKeys(set.sources, new Set(Object.keys(en)), set.defaultNS);
  for (const [ns, catalog] of Object.entries(en)) {
    const flat = flattenCatalog(catalog);
    for (const key of new Set([...flat.keys()].map((k) => baseKey(k, flat)))) {
      if (!uses.used.get(ns)?.has(key) && !isDynamic(uses, ns, key)) problems.push(`${set.name} en ${ns}: "${key}" is never used`);
    }
  }
  return problems;
}
