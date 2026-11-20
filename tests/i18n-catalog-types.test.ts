import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

/**
 * `Translation<typeof en>` is what makes a missing key a compile error, so
 * its rules are checked with the compiler itself: each case is a tiny
 * virtual file type-checked against src/i18n/catalog.ts.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const virtual = join(root, "tests", "__virtual__", "catalog-fixture.ts");
const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16, strict: true, noEmit: true, skipLibCheck: true, types: [] };

function errorsFor(zh: string, en = `{ msgs_one: "One", msgs_other: "{{count}}", step_one: "Step one", title: "Cost" }`): string[] {
  const code = `import type { Translation } from "../../src/i18n/catalog.js";\nconst en = ${en} as const;\nexport const zh = ${zh} satisfies Translation<typeof en>;\n`;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) => name === virtual ? ts.createSourceFile(name, code, version) : getSourceFile(name, version, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === virtual || fileExists(name);
  const program = ts.createProgram([virtual], options, host);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(virtual)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("Translation<typeof en>", () => {
  it("accepts a translation without the plural forms its language lacks", () => {
    expect(errorsFor(`{ msgs_other: "{{count}}", step_one: "第一步", title: "费用" }`)).toEqual([]);
  });
  it("accepts a `_zero` (or `_few`) English lacks, beside an English `_other`, but not beside an ordinary key", () => {
    expect(errorsFor(`{ msgs_zero: "没有", msgs_other: "{{count}}", step_one: "第一步", title: "费用" }`)).toEqual([]);
    expect(errorsFor(`{ msgs_few: "{{count}}", msgs_other: "{{count}}", step_one: "第一步", title: "费用" }`)).toEqual([]);
    expect(errorsFor(`{ msgs_other: "{{count}}", step_one: "第一步", title: "费用", title_zero: "零" }`).join("\n")).toContain("'title_zero' does not exist");
  });
  it("rejects a missing ordinary key", () => {
    expect(errorsFor(`{ msgs_other: "{{count}}", step_one: "第一步" }`).join("\n")).toContain("'title' is missing");
  });
  it("rejects a missing `_other`", () => {
    expect(errorsFor(`{ step_one: "第一步", title: "费用" }`).join("\n")).toContain("'msgs_other' is missing");
  });
  it("treats `step_one` with no `step_other` as ordinary: leaving it out is an error", () => {
    expect(errorsFor(`{ msgs_other: "{{count}}", title: "费用" }`).join("\n")).toContain("'step_one' is missing");
  });
  it("rejects a key English does not have", () => {
    expect(errorsFor(`{ msgs_other: "{{count}}", step_one: "第一步", title: "费用", extra: "多余" }`).join("\n")).toContain("'extra' does not exist");
  });
  it("checks nested namespaces the same way", () => {
    expect(errorsFor(`{ page: {} }`, `{ page: { title: "Cost" } }`).join("\n")).toContain("'title' is missing");
  });
});
