import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { runWithSecrets } from "../src/credentials/exec.js";
import { clearSecretValuesForTests, registerSecretValue, scrubDeep, scrubKnownSecrets } from "../src/credentials/redactor.js";
import { CredentialStoreError, KeychainBackend } from "../src/credentials/store.js";
import { credentialRedactionHooks } from "../src/agent/sdk-options.js";
import { agentProfileDenial } from "../src/agent/permissions.js";

const FAKE = "fake-exec-credential-7c21";
const REDACTED = "[REDACTED secret://x]";

/** A fake `security`: logs argv and stdin, then runs `body`. No test touches the
 *  real one. */
function fakeSecurity(dir: string, body: string): { path: string; argvLog: string; stdinLog: string } {
  const path = join(dir, "fake-bin");
  const argvLog = join(dir, "argv.log");
  const stdinLog = join(dir, "stdin.log");
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${argvLog}"\ncat >> "${stdinLog}"\n${body}\n`);
  chmodSync(path, 0o755);
  writeFileSync(argvLog, "");
  writeFileSync(stdinLog, "");
  return { path, argvLog, stdinLog };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-broker-exec-"));
  registerSecretValue(FAKE, "x");
});
afterEach(() => {
  clearSecretValuesForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("redactor", () => {
  it("removes the literal value, and pins that it does not catch a transformed one", () => {
    expect(scrubKnownSecrets(`a ${FAKE} b`)).toBe(`a ${REDACTED} b`);
    const encoded = Buffer.from(FAKE).toString("base64");
    expect(scrubKnownSecrets(encoded)).toBe(encoded);
  });

  it("scrubDeep keeps the shape, and identity when clean, because the CLI drops a misshapen rewrite", () => {
    const clean = { stdout: "ok", interrupted: false };
    expect(scrubDeep(clean)).toBe(clean);
    expect(scrubDeep({ stdout: FAKE, n: 3, nested: [{ text: FAKE }], interrupted: false })).toEqual({
      stdout: REDACTED, n: 3, nested: [{ text: REDACTED }], interrupted: false,
    });
  });

  it("the PostToolUse hook returns nothing for clean output and a rewrite for dirty output", async () => {
    const hook = credentialRedactionHooks().PostToolUse[0].hooks[0];
    expect(await hook({ tool_response: { stdout: "clean" } })).toEqual({});
    expect(await hook({ tool_response: { stdout: FAKE } })).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout: REDACTED } },
    });
  });

  it("the log scrubber picks up registered values", async () => {
    const { scrubSecretValues } = await import("../src/redact.js");
    expect(scrubSecretValues(`failed with ${FAKE}`)).toBe(`failed with ${REDACTED}`);
  });
});

describe("KeychainBackend, against a fake security binary", () => {
  it("sends the value over stdin as hex, never in argv, and always replaces", async () => {
    const fake = fakeSecurity(dir, "exit 0");
    await new KeychainBackend(fake.path).put("x", FAKE);
    const argv = readFileSync(fake.argvLog, "utf8");
    const stdin = readFileSync(fake.stdinLog, "utf8");
    expect(argv.trim()).toBe("-i -p");
    expect(argv + stdin).not.toContain(FAKE);
    expect(stdin).toContain('add-generic-password -a "x" -s "tomo-credential-broker" -U -X ');
  });

  it("round-trips the stored form, surviving a prompt in the output", async () => {
    const capture = fakeSecurity(dir, "exit 0");
    await new KeychainBackend(capture.path).put("x", FAKE);
    const hex = /-X ([0-9a-f]+)/.exec(readFileSync(capture.stdinLog, "utf8"))![1];
    const stored = Buffer.from(hex, "hex").toString("utf8");
    const reader = fakeSecurity(dir, `printf 'security> ${stored}\\n'; exit 0`);
    expect(await new KeychainBackend(reader.path).get("x")).toBe(FAKE);
  });

  it("maps not-found, and hides everything else behind one error", async () => {
    expect(await new KeychainBackend(fakeSecurity(dir, "exit 44").path).get("x")).toBeNull();
    await expect(new KeychainBackend(fakeSecurity(dir, `echo ${FAKE}; exit 1`).path).get("x")).rejects.toBeInstanceOf(CredentialStoreError);
    await expect(new KeychainBackend(fakeSecurity(dir, "exit 1").path).put("x", FAKE)).rejects.toBeInstanceOf(CredentialStoreError);
    await expect(new KeychainBackend(join(dir, "missing")).get("x")).rejects.toBeInstanceOf(CredentialStoreError);
  });
});

describe.runIf(process.platform === "darwin")("runWithSecrets (fake value)", () => {
  const run = (command: string, secrets: Record<string, string> = {}) =>
    runWithSecrets({ command, secrets, cwd: dir, timeoutMs: 20_000 });

  it("puts the value in the environment and scrubs it from output", async () => {
    const result = await run('printf "%s" "$MY_TOKEN"', { MY_TOKEN: FAKE });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(REDACTED);
  });

  it("does not expose the value in the command's argv", async () => {
    const result = await run("ps -o args= -p $$", { MY_TOKEN: FAKE });
    expect(result.output).not.toContain("[REDACTED");
    expect(result.output).not.toContain(FAKE);
  });

  it("reports failure scrubbed, and bounds a runaway command", async () => {
    const failed = await run('echo "$T" >&2; exit 7', { T: FAKE });
    expect(failed.exitCode).toBe(7);
    expect(failed.output).not.toContain(FAKE);
    const hung = await runWithSecrets({ command: "sleep 30", secrets: {}, cwd: dir, timeoutMs: 1000 });
    expect(hung.timedOut).toBe(true);
  });

  // Codex finding 6.
  it.each([
    ["stdout", `printf 'fake-exec-'; sleep 0.2; printf '[other]' >&2; sleep 0.2; printf 'credential-7c21'`],
    ["stderr", `printf 'fake-exec-' >&2; sleep 0.2; printf '[other]'; sleep 0.2; printf 'credential-7c21' >&2`],
  ])("scrubs a value split across two %s reads with the other stream between them", async (_label, command) => {
    const result = await run(command);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(REDACTED);
    expect(result.output).toContain("[other]");
    expect(result.output).not.toContain("fake-exec-");
    expect(result.output).not.toContain("credential-7c21");
  });

  it("does not leave the head of a value on either stream when truncated", async () => {
    const result = await run(`(yes "$T" | head -c 3000000) & (yes "$T" | head -c 3000000 >&2); wait`, { T: FAKE });
    expect(result.truncated).toBe(true);
    expect(result.output).not.toContain(FAKE.slice(0, 12));
  });
});

describe("agent profiles", () => {
  it("a profiled subagent cannot use run_with_secrets, whose shell its Bash rules never see", () => {
    const profile = { writeRoots: [], denyReadPaths: [], bash: "none" } as unknown as Parameters<typeof agentProfileDenial>[0];
    expect(agentProfileDenial(profile, "mcp__tomo-internal__run_with_secrets", { command: "x" }, "/tmp")).toMatch(/cannot use run_with_secrets/);
  });
});
