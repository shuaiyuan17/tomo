import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { clearSecretValuesForTests, markRedactionReady, registerSecretValue, scrubDeep, scrubKnownSecrets } from "../src/credentials/redactor.js";
import { CredentialStoreError, isStorableValue, KeychainBackend } from "../src/credentials/store.js";
import { keychainReadCommand } from "../src/credentials/names.js";
import { buildHooksOption, credentialRedactionHooks } from "../src/agent/sdk-options.js";

const FAKE = "fake-redactor-credential-7c21";
const REDACTED = "[REDACTED secret://x]";

/** A fake `security`: logs argv and stdin, then runs `body`. No test touches the
 *  real one. */
function fakeSecurity(dir: string, body: string): { path: string; argvLog: string; stdinLog: string } {
  const path = join(dir, "fake-bin");
  const argvLog = join(dir, "argv.log");
  const stdinLog = join(dir, "stdin.log");
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${argvLog}"\ncat >> "${stdinLog}" 2>/dev/null\n${body}\n`);
  chmodSync(path, 0o755);
  writeFileSync(argvLog, "");
  writeFileSync(stdinLog, "");
  return { path, argvLog, stdinLog };
}

type PostHook = (input: { tool_name?: string; tool_response?: unknown }) => Promise<Record<string, unknown>>;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-broker-redactor-"));
  registerSecretValue(FAKE, "x");
  // As after the broker's first successful load: while not ready, every output is withheld.
  markRedactionReady();
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

  // The global redactor, as the session installs it: no matcher, so it covers
  // Bash, where the agent reads a value with $(security … -w) and a careless
  // `echo` would put it in the transcript.
  it("masks a value in Bash output through the session's hooks, and covers every tool (no matcher)", async () => {
    const hooks = buildHooksOption({ maxTurns: 10, sessionKey: "dm:owner", credentialBroker: true }) as { hooks: Record<string, Array<{ matcher?: string; hooks: PostHook[] }>> };
    const post = hooks.hooks.PostToolUse;
    expect(post).toHaveLength(1);
    expect(post[0].matcher).toBeUndefined();
    const bash = { stdout: `token is ${FAKE}\n`, stderr: "", interrupted: false, isImage: false };
    const result = await post[0].hooks[0]({ tool_name: "Bash", tool_response: bash });
    expect(result).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { ...bash, stdout: `token is ${REDACTED}\n` } } });
    expect(JSON.stringify(result)).not.toContain(FAKE);
    const read = await post[0].hooks[0]({ tool_name: "Read", tool_response: { file: { content: FAKE } } });
    expect(JSON.stringify(read)).not.toContain(FAKE);
  });

  it("is not installed while the broker is off", () => {
    const hooks = buildHooksOption({ maxTurns: 10, sessionKey: "dm:owner" }) as { hooks?: Record<string, unknown> };
    expect(hooks.hooks?.PostToolUse).toBeUndefined();
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
    // The raw value, so the agent's `security … -w` reads it back unchanged.
    const hex = /-X ([0-9a-f]+)/.exec(stdin)![1];
    expect(Buffer.from(hex, "hex").toString("utf8")).toBe(FAKE);
  });

  it("reads with the same command the agent is told to use, value on stdout only", async () => {
    const reader = fakeSecurity(dir, `printf '%s\\n' '${FAKE}'; exit 0`);
    expect(await new KeychainBackend(reader.path).get("x")).toBe(FAKE);
    expect(readFileSync(reader.argvLog, "utf8").trim()).toBe(keychainReadCommand("x").replace(/^security /, ""));
  });

  it("maps not-found, and hides everything else behind one error", async () => {
    expect(await new KeychainBackend(fakeSecurity(dir, "exit 44").path).get("x")).toBeNull();
    await expect(new KeychainBackend(fakeSecurity(dir, `echo ${FAKE}; exit 1`).path).get("x")).rejects.toBeInstanceOf(CredentialStoreError);
    await expect(new KeychainBackend(fakeSecurity(dir, "exit 1").path).put("x", FAKE)).rejects.toBeInstanceOf(CredentialStoreError);
    await expect(new KeychainBackend(join(dir, "missing")).get("x")).rejects.toBeInstanceOf(CredentialStoreError);
    await expect(new KeychainBackend(fakeSecurity(dir, "exit 0").path).put("x", "fake-é-value")).rejects.toBeInstanceOf(CredentialStoreError);
  });

  it("stores only printable ASCII, which `security -w` prints unchanged", () => {
    expect(isStorableValue("ghp_abc DEF-123!")).toBe(true);
    expect(isStorableValue("tab\there")).toBe(false);
    expect(isStorableValue("café-key")).toBe(false);
  });
});
