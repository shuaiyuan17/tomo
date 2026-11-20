import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

/**
 * `Translation<typeof en>` is what makes a missing key a compile error, so
 * its rules are checked with the compiler itself. Every case is a tiny
 * virtual file, and all of them go into ONE program, built once: a program
 * per case re-reads and re-checks the TypeScript lib each time, which is
 * seconds per case on a slow CI runner.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16, strict: true, noEmit: true, skipLibCheck: true, types: [] };
const EN = `{ msgs_one: "One", msgs_other: "{{count}}", step_one: "Step one", title: "Cost" }`;

const CASES = {
  dropsOne: { zh: `{ msgs_other: "{{count}}", step_one: "第一步", title: "费用" }` },
  addsZero: { zh: `{ msgs_zero: "没有", msgs_other: "{{count}}", step_one: "第一步", title: "费用" }` },
  addsFew: { zh: `{ msgs_few: "{{count}}", msgs_other: "{{count}}", step_one: "第一步", title: "费用" }` },
  zeroBesideOrdinary: { zh: `{ msgs_other: "{{count}}", step_one: "第一步", title: "费用", title_zero: "零" }` },
  missingOrdinary: { zh: `{ msgs_other: "{{count}}", step_one: "第一步" }` },
  missingOther: { zh: `{ step_one: "第一步", title: "费用" }` },
  missingStepOne: { zh: `{ msgs_other: "{{count}}", title: "费用" }` },
  extraKey: { zh: `{ msgs_other: "{{count}}", step_one: "第一步", title: "费用", extra: "多余" }` },
  nestedMissing: { zh: `{ page: {} }`, en: `{ page: { title: "Cost" } }` },
} satisfies Record<string, { zh: string; en?: string }>;
type Case = keyof typeof CASES;

const fileOf = (name: Case) => join(root, "tests", "__virtual__", `catalog-${name}.ts`);
let errors: Record<Case, string>;

beforeAll(() => {
  const sources = new Map(Object.entries(CASES).map(([name, c]) => [fileOf(name as Case),
    `import type { Translation } from "../../src/i18n/catalog.js";\nconst en = ${"en" in c ? c.en : EN} as const;\nexport const zh = ${c.zh} satisfies Translation<typeof en>;\n`]));
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) => {
    const code = sources.get(name);
    return code !== undefined ? ts.createSourceFile(name, code, version) : getSourceFile(name, version, ...rest);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => sources.has(name) || fileExists(name);
  const program = ts.createProgram([...sources.keys()], options, host);
  errors = Object.fromEntries(Object.keys(CASES).map((name) => [name,
    ts.getPreEmitDiagnostics(program, program.getSourceFile(fileOf(name as Case))).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n")])) as Record<Case, string>;
}, 60_000);

describe("Translation<typeof en>", { timeout: 30_000 }, () => {
  it("accepts a translation without the plural forms its language lacks", () => {
    expect(errors.dropsOne).toBe("");
  });
  it("accepts a `_zero` (or `_few`) English lacks, beside an English `_other`, but not beside an ordinary key", () => {
    expect(errors.addsZero).toBe("");
    expect(errors.addsFew).toBe("");
    expect(errors.zeroBesideOrdinary).toContain("'title_zero' does not exist");
  });
  it("rejects a missing ordinary key", () => {
    expect(errors.missingOrdinary).toContain("'title' is missing");
  });
  it("rejects a missing `_other`", () => {
    expect(errors.missingOther).toContain("'msgs_other' is missing");
  });
  it("treats `step_one` with no `step_other` as ordinary: leaving it out is an error", () => {
    expect(errors.missingStepOne).toContain("'step_one' is missing");
  });
  it("rejects a key English does not have", () => {
    expect(errors.extraKey).toContain("'extra' does not exist");
  });
  it("checks nested namespaces the same way", () => {
    expect(errors.nestedMissing).toContain("'title' is missing");
  });
});
