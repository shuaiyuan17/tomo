import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `raw()` turns any string into `OwnerText`, so it is the one way past the
 * owner-facing outlets' type check. It is meant for text that is not ours to
 * translate (model output, a person's input, a library's error message), and
 * this list keeps every use visible in review: a new `raw(` call, or a new
 * file using it, fails here until the list is updated with it.
 *
 * Map: file → how many `raw(` calls it may have.
 */
const RAW_ALLOWLIST: Record<string, number> = {};

/** Files allowed to cast to `OwnerText` directly: only the module that defines it. */
const CAST_ALLOWLIST = new Set(["src/i18n/index.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

const root = join(import.meta.dirname, "..");
const files = sourceFiles(join(root, "src")).map((path) => ({ file: relative(root, path), text: readFileSync(path, "utf8") }));

describe("the OwnerText escape hatches", () => {
  it("raw() is called only where the allowlist says, as many times as it says", () => {
    const uses: Record<string, number> = {};
    for (const { file, text } of files) {
      if (file === "src/i18n/index.ts") continue; // the definition
      const count = text.match(/(?<![\w.])raw\(/g)?.length ?? 0;
      if (count) uses[file] = count;
    }
    expect(uses).toEqual(RAW_ALLOWLIST);
  });

  it("raw is never imported under another name", () => {
    expect(files.filter(({ text }) => /import\s*\{[^}]*\braw\s+as\s+\w[^}]*\}\s*from\s*["'][^"']*i18n\/index\.js["']/.test(text)).map(({ file }) => file)).toEqual([]);
  });

  it("nothing casts to OwnerText outside src/i18n/index.ts", () => {
    expect(files.filter(({ file, text }) => !CAST_ALLOWLIST.has(file) && /as\s+(unknown\s+as\s+)?OwnerText\b|<OwnerText>/.test(text)).map(({ file }) => file)).toEqual([]);
  });
});
