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
const OPTIONAL_PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many"] as const;

/** `K` without an optional plural suffix (`msgs_one` → `msgs`); never when it has none. */
type StripOptionalPlural<K> =
  K extends `${infer B}_zero` ? B : K extends `${infer B}_one` ? B : K extends `${infer B}_two` ? B
    : K extends `${infer B}_few` ? B : K extends `${infer B}_many` ? B : never;
/**
 * True for a plural form a language may leave out: an optional suffix AND an
 * `_other` in the same family. `step_one` with no `step_other` is an
 * ordinary key, required like any other.
 */
type IsOptionalPlural<T, K> = [StripOptionalPlural<K>] extends [never] ? false
  : `${StripOptionalPlural<K> & string}_other` extends keyof T ? true : false;

/** A catalog with the same keys as `T`, every leaf a string. */
export type Translation<T> = {
  -readonly [K in keyof T as IsOptionalPlural<T, K> extends true ? never : K]: T[K] extends string ? string : Translation<T[K]>;
} & {
  -readonly [K in keyof T as IsOptionalPlural<T, K> extends true ? K : never]?: string;
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

/**
 * The key call sites write for `key` (`t("msgs", { count })` for `msgs_one`):
 * the plural suffix is dropped only when `key` is `_other` or its family
 * has an `_other` among `keys` (the flattened catalog it comes from), the
 * same rule {@link Translation} uses.
 */
export function baseKey(key: string, keys: ReadonlySet<string> | ReadonlyMap<string, unknown>): string {
  if (key.endsWith("_other")) return key.slice(0, -"_other".length);
  for (const suffix of OPTIONAL_PLURAL_SUFFIXES) {
    if (key.endsWith(suffix) && keys.has(`${key.slice(0, -suffix.length)}_other`)) return key.slice(0, -suffix.length);
  }
  return key;
}

/** True when `key` is a plural form a translation may omit (see {@link Translation}). */
export function isOptionalPluralForm(key: string, keys: ReadonlySet<string> | ReadonlyMap<string, unknown>): boolean {
  return !key.endsWith("_other") && baseKey(key, keys) !== key;
}

/** The `{{name}}` / `{{name, format}}` placeholders a text interpolates. */
export function placeholdersOf(text: string): Set<string> {
  return new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]!));
}
