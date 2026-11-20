/**
 * The shape rules every catalog follows, shared by the daemon's catalogs
 * (src/i18n/catalogs/) and the web UI's (web/src/i18n/catalogs/). Pure types
 * and string helpers: no i18next import, so either side can use it.
 *
 * English is the source: each namespace is a named `as const` object in
 * `catalogs/en/<ns>.ts` (`export const commands = { ... } as const`). A
 * translation exports the same name, declared
 * `satisfies Translation<typeof en>`, so a key that is missing (or not in
 * English) fails `tsc`, not a reader.
 *
 * Plurals are i18next's CLDR suffixes (`_zero` `_one` `_two` `_few` `_many`
 * `_other`, chosen by `Intl.PluralRules` from `count`). A language keeps
 * only the categories it has: `_other` is required wherever English has
 * one, the rest are optional (Chinese has no `_one`).
 */
export const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"] as const;
type OptionalPluralSuffix = "_zero" | "_one" | "_two" | "_few" | "_many";
type IsOptionalPlural<K> = K extends `${string}${OptionalPluralSuffix}` ? true : false;

/** A catalog with the same keys as `T`, every leaf a string. */
export type Translation<T> = {
  -readonly [K in keyof T as IsOptionalPlural<K> extends true ? never : K]: T[K] extends string ? string : Translation<T[K]>;
} & {
  -readonly [K in keyof T as IsOptionalPlural<K> extends true ? K : never]?: string;
};

/** A nested catalog as `key.path → text` (leaves only). */
export function flattenCatalog(catalog: object, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else if (value && typeof value === "object") for (const [k, v] of flattenCatalog(value, path)) out.set(k, v);
  }
  return out;
}

/** A key without its plural suffix: what call sites write (`t("msgs", { count })`). */
export function baseKey(key: string): string {
  for (const suffix of PLURAL_SUFFIXES) if (key.endsWith(suffix)) return key.slice(0, -suffix.length);
  return key;
}

/** The `{{name}}` / `{{name, format}}` placeholders a text interpolates. */
export function placeholdersOf(text: string): Set<string> {
  return new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]!));
}
