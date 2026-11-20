import { describe, expect, it } from "vitest";
import { resources as daemonResources } from "../src/i18n/resources.js";
import { catalogProblems, readSources, type CatalogSet } from "./helpers/i18n-catalogs.js";
import { LOCALES } from "../src/i18n/locales.js";

/** Every shipped catalog set. tsc already rejects a missing or extra key; this adds placeholders and unused keys. */
const SETS: CatalogSet[] = [
  { name: "daemon", resources: daemonResources, sources: readSources(["src"]) },
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
  const source = `const t = ownerT("ns"); t("greet"); t("msgs", { count }); t("step_one"); t("page.title");`;
  const files = (text: string, ext = "ts") => [{ path: `/fixture/a.${ext}`, file: `a.${ext}`, text }];
  const check = (zh: object, english: object = en, src = source) =>
    catalogProblems({ name: "fixture", resources: { en: { ns: english }, "zh-Hans": { ns: zh } }, sources: files(src) });

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
    expect(check({ count: "数量" }, { count: "Count: {{count}}" }, `ownerT("ns")("count")`))
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
  it("allows `_zero` in every language (i18next tries it first for count 0), next to an `_other`", () => {
    expect(check({ ...zhOk, msgs_zero: "{{name}} 没有发来消息" }, { ...en, msgs_zero: "No messages from {{name}}" })).toEqual([]);
  });
  it("lets a translation add a `_zero` English does not have, beside English's `_other`", () => {
    expect(check({ ...zhOk, msgs_zero: "{{name}} 没有发来消息" })).toEqual([]);
    expect(check({ ...zhOk, msgs_zero: "没有消息" })).toEqual(['fixture zh-Hans ns: "msgs_zero" placeholders {} ≠ English {count,name}', 'fixture zh-Hans ns: "msgs_zero" placeholders {} ≠ its _other {count,name}']);
    expect(check({ ...zhOk, greet_zero: "零" })).toEqual(['fixture zh-Hans ns: "greet_zero" is not in English']);
  });
  it("catches an English key no source uses", () => {
    expect(check(zhOk, en, `const t = ownerT("ns"); t("greet"); t("step_one");`))
      .toEqual(['fixture en ns: "msgs" is never used', 'fixture en ns: "page.title" is never used']);
  });

  describe("reading which keys are used", () => {
    const two = { a: { title: "A", only_a: "Only A" }, b: { title: "B" } };
    const unused = (text: string, defaultNS?: string) => catalogProblems({ name: "fx", resources: { en: two }, sources: files(text, "tsx"), defaultNS });

    it("does not count the same key in another namespace as used", () => {
      expect(unused(`const t = ownerT("a"); t("title"); t("only_a");`)).toEqual(['fx en b: "title" is never used']);
    });
    it("follows renamed translators, useTranslation, getFixedT, typed parameters and `ns:key`", () => {
      expect(unused(`
        const tr = ownerT("a"); tr("title");
        function C() { const { t } = useTranslation("b"); return t("title"); }
        const g = i18n.getFixedT(null, "a"); g("only_a");
      `)).toEqual([]);
      expect(unused(`function f(t: OwnerT<"a">) { t("title"); t("a:only_a"); t("b:title"); }`)).toEqual([]);
    });
    it("binds the nearest scope's translator: an inner `t` shadows the outer one", () => {
      expect(unused(`const t = ownerT("a"); function g() { const t = ownerT("b"); t("title"); } t("only_a");`)).toEqual(['fx en a: "title" is never used']);
    });
    it("uses defaultNS for an unbound `t`, and reads <Trans i18nKey>", () => {
      expect(unused(`t("title"); const x = <><Trans i18nKey="only_a" /><Trans ns="b" i18nKey="title" /></>;`, "a")).toEqual([]);
    });
    it("needs an `i18n-dynamic` declaration for keys built at runtime", () => {
      expect(unused(`const t = ownerT("a"); t(\`only_\${x}\`); ownerT("b")("title");`)).toEqual([
        'fx: a.tsx:1 builds a key at runtime with no "// i18n-dynamic: ns:prefix*" declaration in its file',
        'fx en a: "title" is never used', 'fx en a: "only_a" is never used',
      ]);
      // Every key used statically does not excuse an undeclared runtime key.
      expect(unused(`const t = ownerT("a"); t("title"); t("only_a"); ownerT("b")("title"); t(key);`)).toEqual([
        'fx: a.tsx:1 builds a key at runtime with no "// i18n-dynamic: ns:prefix*" declaration in its file',
      ]);
      expect(unused(`// i18n-dynamic: a:only_*\n// i18n-dynamic: a:title\nconst t = ownerT("a"); t(\`only_\${x}\`); ownerT("b")("title");`)).toEqual([]);
    });
  });
});
