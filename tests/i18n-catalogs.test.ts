import { describe, expect, it } from "vitest";
import { resources as daemonResources } from "../src/i18n/resources.js";
import { catalogProblems, readSource, type CatalogSet } from "./helpers/i18n-catalogs.js";
import { LOCALES } from "../src/i18n/locales.js";

/** Every shipped catalog set. tsc already rejects a missing or extra key; this adds placeholders and unused keys. */
const SETS: CatalogSet[] = [
  { name: "daemon", resources: daemonResources, source: readSource(["src"]) },
];

describe("the shipped catalogs", () => {
  for (const set of SETS) {
    it(`${set.name}: every locale is present`, () => {
      expect(Object.keys(set.resources).sort()).toEqual([...LOCALES].sort());
    });
    it(`${set.name}: same keys and placeholders in every locale, and every key used`, () => {
      expect(catalogProblems(set)).toEqual([]);
    });
  }
});

describe("the catalog check itself", () => {
  const en = { greet: "Hi {{name}}", msgs_one: "One message", msgs_other: "{{count}} messages", page: { title: "Cost" } };
  const source = `t("greet"); t("msgs", { count }); t("page.title")`;
  const check = (zh: object, src = source) => catalogProblems({ name: "fixture", resources: { en: { ns: en }, "zh-Hans": { ns: zh } }, source: src });

  it("passes a complete translation that drops `_one`", () => {
    expect(check({ greet: "你好，{{name}}", msgs_other: "{{count}} 条消息", page: { title: "费用" } })).toEqual([]);
  });
  it("catches a missing key, an extra key and an empty text", () => {
    expect(check({ greet: "", msgs_other: "{{count}} 条消息", page: {}, extra: "多余" })).toEqual([
      'fixture zh-Hans ns: missing "page.title"',
      'fixture zh-Hans ns: "extra" is not in English',
      'fixture zh-Hans ns: "greet" placeholders {} ≠ English {name}',
      'fixture zh-Hans ns: "greet" is empty',
    ]);
  });
  it("catches a renamed placeholder", () => {
    expect(check({ greet: "你好，{{who}}", msgs_other: "{{count}} 条消息", page: { title: "费用" } }))
      .toEqual(['fixture zh-Hans ns: "greet" placeholders {who} ≠ English {name}']);
  });
  it("catches an English key no source uses", () => {
    expect(check({ greet: "你好，{{name}}", msgs_other: "{{count}} 条消息", page: { title: "费用" } }, `t("greet")`))
      .toEqual(['fixture en ns: "msgs" is never used', 'fixture en ns: "page.title" is never used']);
  });
});
