import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

/**
 * Every owner-facing outlet takes `OwnerText`, so a fixed English string
 * cannot reach the owner without a catalog. Checked with the compiler: each
 * line of a virtual file calls one outlet, and exactly the plain-string calls
 * must fail to type-check.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const virtual = join(root, "tests", "__virtual__", "owner-outlets.ts");
const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
const options: ts.CompilerOptions = { ...config.options, noEmit: true, rootDir: root };

const OUTLETS = [
  "agent.notifyOwner(TEXT)",
  "agent.sendNotification(TEXT)",
  "notices.notifyOwner(TEXT)",
  "notices.sendOwnerNotice(TEXT, undefined)",
  "notices.sendNotification(TEXT)",
  "health.notifyOwner(TEXT)",
  "errors.send(TEXT, report)",
  "credentials.notifyOwner?.(TEXT)",
  "capture.open(view, TEXT)",
  "capture.notify(TEXT)",
  "commandDeps.sendToOwnerDm(owner, TEXT)",
];

function diagnostics(): ts.Diagnostic[] {
  const lines = OUTLETS.flatMap((call) => [call.replace("TEXT", `"plain English"`), call.replace("TEXT", `t("newSession")`), call.replace("TEXT", `raw("model output")`)]);
  const code = [
    `import type { Agent } from "../../src/agent.js";`,
    `import type { OwnerNotices } from "../../src/agent/owner-notices.js";`,
    `import type { McpHealthMonitorDeps } from "../../src/agent/mcp-health.js";`,
    `import type { OwnerErrorNotifierDeps, SuppressedErrorReport } from "../../src/agent/owner-error-notice.js";`,
    `import type { CaptureChannel, BrokerDeps, CredentialRequestView } from "../../src/credentials/broker.js";`,
    `import type { ChatCommandDeps } from "../../src/agent/commands.js";`,
    `import type { OwnerConfig } from "../../src/owner.js";`,
    `import { ownerT, raw } from "../../src/i18n/index.js";`,
    `declare const agent: Agent, notices: OwnerNotices, health: McpHealthMonitorDeps, errors: OwnerErrorNotifierDeps, report: SuppressedErrorReport;`,
    `declare const credentials: BrokerDeps, capture: CaptureChannel, view: CredentialRequestView, commandDeps: ChatCommandDeps, owner: OwnerConfig;`,
    `const t = ownerT("commands");`,
    `export async function run(): Promise<void> {`,
    ...lines.map((line) => `  await ${line};`),
    `}`,
  ].join("\n");
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) => name === virtual ? ts.createSourceFile(name, code, version) : getSourceFile(name, version, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === virtual || fileExists(name);
  const program = ts.createProgram([virtual], options, host);
  return [...ts.getPreEmitDiagnostics(program, program.getSourceFile(virtual))];
}

describe("owner-facing outlets", () => {
  it("reject a plain string and accept translated or explicitly raw text", () => {
    const failing = diagnostics().map((d) => {
      const file = d.file!;
      const line = file.getLineAndCharacterOfPosition(d.start!).line;
      return file.text.split("\n")[line].trim();
    });
    expect(failing).toEqual(OUTLETS.map((call) => `await ${call.replace("TEXT", `"plain English"`)};`));
  }, 60_000);
});
