import { describe, expect, it } from "vitest";
import { isRecord } from "../src/is-record.js";

class Point {
  x = 1;
}

describe("isRecord", () => {
  it.each<[string, unknown, boolean]>([
    ["an object literal", { a: 1 }, true],
    ["an empty object", {}, true],
    ["a prototype-less object", Object.create(null), true],
    ["a class instance", new Point(), true],
    ["a Date", new Date(0), true],
    ["a Map", new Map(), true],
    ["null", null, false],
    ["undefined", undefined, false],
    ["an empty array", [], false],
    ["an array of objects", [{ a: 1 }], false],
    ["a function", () => ({}), false],
    ["a class", Point, false],
    ["a string", "{}", false],
    ["an empty string", "", false],
    ["a number", 1, false],
    ["zero", 0, false],
    ["NaN", Number.NaN, false],
    ["true", true, false],
    ["false", false, false],
    ["a bigint", 1n, false],
    ["a symbol", Symbol("s"), false],
  ])("%s", (_name, value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });

  it("narrows to a string-keyed record", () => {
    const value: unknown = JSON.parse('{"a":{"b":2}}');
    expect(isRecord(value) && isRecord(value.a) ? value.a.b : undefined).toBe(2);
  });
});
