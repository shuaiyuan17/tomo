import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { baseKey, flattenCatalog, placeholdersOf } from "../../src/i18n/catalog.js";

/** One app's catalogs and the source that uses them. */
export interface CatalogSet {
  name: string;
  /** locale → namespace → catalog; `en` is the source. */
  resources: Record<string, Record<string, object>>;
  /** The concatenated source the keys must appear in (catalog files excluded). */
  source: string;
}

/** Every .ts/.tsx file under `roots`, minus any path containing `/catalogs/`, concatenated. */
export function readSource(roots: readonly string[]): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "node_modules" || path.includes("/catalogs")) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(readFileSync(path, "utf8"));
    }
  };
  for (const root of roots) walk(root);
  return out.join("\n");
}

/** Base key → the union of placeholders across its plural forms. */
function keysWithPlaceholders(catalog: object): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [key, text] of flattenCatalog(catalog)) {
    const base = baseKey(key);
    const set = out.get(base) ?? new Set<string>();
    for (const p of placeholdersOf(text)) set.add(p);
    out.set(base, set);
  }
  return out;
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * What tsc cannot check about a set of catalogs: every locale has every
 * English key (also tsc's job, repeated for plain-JS edits), the same
 * placeholders per key (`count` may be dropped where a language has no
 * `_one`), no empty text, and every English key used somewhere in the
 * source as a literal (keys are written out in full, never built at runtime).
 */
export function catalogProblems(set: CatalogSet): string[] {
  const problems: string[] = [];
  const en = set.resources.en ?? {};
  for (const [locale, namespaces] of Object.entries(set.resources)) {
    if (locale === "en") continue;
    for (const ns of new Set([...Object.keys(en), ...Object.keys(namespaces)])) {
      const source = keysWithPlaceholders(en[ns] ?? {});
      const target = keysWithPlaceholders(namespaces[ns] ?? {});
      for (const key of source.keys()) if (!target.has(key)) problems.push(`${set.name} ${locale} ${ns}: missing "${key}"`);
      for (const key of target.keys()) if (!source.has(key)) problems.push(`${set.name} ${locale} ${ns}: "${key}" is not in English`);
      for (const [key, want] of source) {
        const got = target.get(key);
        if (!got) continue;
        const wantNoCount = new Set([...want].filter((p) => p !== "count"));
        const gotNoCount = new Set([...got].filter((p) => p !== "count"));
        if (!same(wantNoCount, gotNoCount) || (got.has("count") && !want.has("count"))) {
          problems.push(`${set.name} ${locale} ${ns}: "${key}" placeholders {${[...got].sort().join(",")}} ≠ English {${[...want].sort().join(",")}}`);
        }
      }
      for (const [key, text] of flattenCatalog(namespaces[ns] ?? {})) if (!text.trim()) problems.push(`${set.name} ${locale} ${ns}: "${key}" is empty`);
    }
  }
  for (const [ns, catalog] of Object.entries(en)) {
    for (const key of new Set([...flattenCatalog(catalog).keys()].map(baseKey))) {
      const used = [`"${key}"`, `'${key}'`, `\`${key}\``, `"${ns}:${key}"`].some((needle) => set.source.includes(needle));
      if (!used) problems.push(`${set.name} en ${ns}: "${key}" is never used`);
    }
  }
  return problems;
}
