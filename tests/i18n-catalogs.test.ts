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
  const en = { greet: "Hi {{name}}", msgs_one: "One message from {{name}}", msgs_other: "{{count}} messages from {{name}}", step_one: "Step one", page: { title: "Cost" } };
  const zhOk = { greet: "你好，{{name}}", msgs_other: "{{name}} 发来 {{count}} 条消息", step_one: "第一步", page: { title: "费用" } };
  const source = `t("greet"); t("msgs", { count }); t("step_one"); t("page.title")`;
  const check = (zh: object, english: object = en, src = source) =>
    catalogProblems({ name: "fixture", resources: { en: { ns: english }, "zh-Hans": { ns: zh } }, source: src });

  it("passes a complete translation that drops `_one`", () => {
    expect(check(zhOk)).toEqual([]);
  });
  it("catches a missing key, an extra key and an empty text", () => {
    expect(check({ ...zhOk, greet: "", page: {}, extra: "多余" })).toEqual([
      'fixture zh-Hans ns: missing "page.title"',
      'fixture zh-Hans ns: "greet" placeholders {} ≠ English {name}',
      'fixture zh-Hans ns: "extra" is not in English',
      'fixture zh-Hans ns: "greet" is empty',
    ]);
  });
  it("treats `step_one` with no `step_other` as an ordinary, required key", () => {
    const zh: Partial<typeof zhOk> = { ...zhOk };
    delete zh.step_one;
    expect(check(zh)).toEqual(['fixture zh-Hans ns: missing "step_one"']);
  });
  it("catches a renamed placeholder", () => {
    expect(check({ ...zhOk, greet: "你好，{{who}}" })).toEqual(['fixture zh-Hans ns: "greet" placeholders {who} ≠ English {name}']);
  });
  it("catches a dropped {{count}} outside a plural family", () => {
    expect(check({ count: "数量" }, { count: "Count: {{count}}" }, `t("count")`))
      .toEqual(['fixture zh-Hans ns: "count" placeholders {} ≠ English {count}']);
  });
  it("compares each plural form on its own: one form dropping a variable is caught", () => {
    expect(check({ ...zhOk, msgs_other: "{{count}} 条消息" })).toEqual(['fixture zh-Hans ns: "msgs_other" placeholders {count} ≠ English {count,name}']);
  });
  it("catches an English `_one` that drops a variable other than count", () => {
    expect(check(zhOk, { ...en, msgs_one: "One message" })).toEqual(['fixture en ns: "msgs_one" placeholders {} ≠ its _other {count,name}']);
  });
  it("catches a plural form the language does not have (Chinese has no `one`)", () => {
    expect(check({ ...zhOk, msgs_one: "{{name}} 发来一条消息" })).toEqual(['fixture zh-Hans ns: "msgs_one" is a "one" form, which zh-Hans does not have']);
  });
  it("catches an empty English text", () => {
    expect(check(zhOk, { ...en, page: { title: " " } })).toEqual(['fixture en ns: "page.title" is empty']);
  });
  it("catches an English key no source uses", () => {
    expect(check(zhOk, en, `t("greet"); t("step_one")`))
      .toEqual(['fixture en ns: "msgs" is never used', 'fixture en ns: "page.title" is never used']);
  });
});
