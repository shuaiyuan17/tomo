import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findEscapeHatches, readSources, type Source } from "./helpers/i18n-ast.js";

/**
 * `raw()` turns any string into `OwnerText`, so it is the one way past the
 * owner-facing outlets' type check. It is meant for text that is not ours to
 * translate (model output, a person's input, a library's error message), and
 * this list keeps every use visible in review: a new `raw` call, or a new
 * file using it, fails here until the list is updated with it.
 *
 * Map: repo-relative file → how many calls of `raw` it may have. Calls are
 * found in the AST and resolved through the file's imports of
 * src/i18n/index.ts (named, renamed or namespace), not by text matching.
 */
const RAW_ALLOWLIST: Record<string, number> = {};

const I18N_MODULE = resolve(import.meta.dirname, "../src/i18n/index.ts");

describe("the OwnerText escape hatches in src/", () => {
  const uses = findEscapeHatches(readSources(["src"]), I18N_MODULE);

  it("raw() is called only where the allowlist says, as many times as it says", () => {
    expect(uses.raw).toEqual(RAW_ALLOWLIST);
  });

  it("nothing casts to OwnerText outside src/i18n/index.ts", () => {
    expect(uses.casts).toEqual([]);
  });
});

describe("the escape-hatch scanner itself", () => {
  const at = (text: string, path = resolve(import.meta.dirname, "../src/agent/fixture.ts")): Source => ({ path, file: "src/agent/fixture.ts", text });
  const scan = (text: string) => findEscapeHatches([at(text)], I18N_MODULE);

  it("counts named, spaced, renamed and namespace calls", () => {
    expect(scan(`import { raw } from "../i18n/index.js"; raw("a"); raw ("b"); raw(\n"c");`).raw).toEqual({ "src/agent/fixture.ts": 3 });
    expect(scan(`import { raw as r, ownerT } from "../i18n/index.js"; r("a");`).raw).toEqual({ "src/agent/fixture.ts": 1 });
    expect(scan(`import * as i18n from "../i18n/index.js"; i18n.raw("a"); i18n.raw ("b");`).raw).toEqual({ "src/agent/fixture.ts": 2 });
  });

  it("ignores a different `raw` (not imported from src/i18n/index.ts) and the word in strings", () => {
    expect(scan(`import { raw } from "../other.js"; raw("a"); const s = "raw(x)"; const o = { raw: (x: string) => x }; o.raw("b");`).raw).toEqual({});
  });

  it("finds casts to OwnerText in both syntaxes", () => {
    expect(scan(`const a = "x" as OwnerText;`).casts).toEqual(["src/agent/fixture.ts"]);
    expect(scan(`const a = "x" as unknown as OwnerText;`).casts).toEqual(["src/agent/fixture.ts"]);
    expect(scan(`const a = <OwnerText>"x";`).casts).toEqual(["src/agent/fixture.ts"]);
    expect(scan(`const a = "x" as string;`).casts).toEqual([]);
  });
});
