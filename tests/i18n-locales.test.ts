import { describe, expect, it } from "vitest";
import { isLocale, localeName, matchLocale, resolveLocale } from "../src/i18n/locales.js";
import { joinText, raw } from "../src/i18n/index.js";

describe("locale matching", () => {
  it.each([
    ["en", "en"], ["en-US", "en"], ["en-GB", "en"],
    ["zh", "zh-Hans"], ["zh-CN", "zh-Hans"], ["zh-SG", "zh-Hans"], ["zh-Hans", "zh-Hans"], ["zh-Hans-HK", "zh-Hans"],
  ])("%s → %s", (tag, want) => expect(matchLocale(tag)).toBe(want));

  it.each(["zh-TW", "zh-HK", "zh-Hant", "fr-FR", "ja", "", "not a tag!"])("%s → no match (Traditional Chinese is not shown Simplified)", (tag) => {
    expect(matchLocale(tag)).toBeNull();
  });

  it("takes the first candidate that matches, else English", () => {
    expect(resolveLocale(undefined, "fr", "zh-CN", "en")).toBe("zh-Hans");
    expect(resolveLocale(null, "en-US", "zh-CN")).toBe("en");
    expect(resolveLocale("ja", "zh-TW")).toBe("en");
    expect(resolveLocale()).toBe("en");
  });

  it("knows only the shipped locales", () => {
    expect(isLocale("zh-Hans")).toBe(true);
    expect(isLocale("zh")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it("names each locale in itself", () => {
    expect(localeName("en")).toBe("English");
    expect(localeName("zh-Hans")).toBe("简体中文");
  });
});

describe("owner text", () => {
  it("passes raw text through unchanged and joins parts", () => {
    expect(joinText([raw("a"), raw("b")])).toBe("a\nb");
    expect(joinText([raw("a"), raw("b")], " · ")).toBe("a · b");
  });
});
