import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());
// The real redactor, with scrubDeep wrapped so one test can make it throw.
vi.mock("../src/credentials/redactor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/credentials/redactor.js")>();
  return { ...actual, scrubDeep: vi.fn(actual.scrubDeep) };
});

import {
  clearSecretValuesForTests, markRedactionNotReady, markRedactionReady, registerSecretValue, scrubDeep, TOO_DEEP_OUTPUT, WITHHELD_OUTPUT,
} from "../src/credentials/redactor.js";
import { KEYCHAIN_SERVICE } from "../src/credentials/names.js";
import { credentialRedactionHooks, REDACTION_READY_TIMEOUT_MS } from "../src/agent/sdk-options.js";

const FAKE = "fake-redaction-hook-credential-91b4";
const REDACTED = "[REDACTED secret://x]";
const keychainInput = { command: `security find-generic-password -s ${KEYCHAIN_SERVICE} -a x -w` };
type Hook = (input: { tool_input?: unknown; tool_response?: unknown }) => Promise<Record<string, unknown>>;
const hook = () => credentialRedactionHooks().PostToolUse[0].hooks[0] as Hook;
/** `{ n: { n: … { stdout: leaf } } }`, `levels` objects deep. */
const nested = (levels: number, leaf: string): Record<string, unknown> => {
  let node: Record<string, unknown> = { stdout: leaf };
  for (let i = 0; i < levels; i++) node = { n: node };
  return node;
};
const withheld = (stdout: unknown) => ({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout } } });

beforeEach(() => {
  registerSecretValue(FAKE, "x");
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(scrubDeep).mockClear();
  clearSecretValuesForTests();
});

describe("credential redaction hook fails closed", () => {
  it("blocks on failure, like the PreToolUse guards", () => {
    expect(credentialRedactionHooks().PostToolUse[0]).toMatchObject({ onFailure: "block" });
  });

  it("caps a hung readiness retry and withholds keychain output once the cap passes", async () => {
    vi.useFakeTimers();
    // A keychain call that never returns (e.g. an authorisation prompt nobody answers).
    markRedactionNotReady(() => new Promise<boolean>(() => {}), Date.now() - 60_000);
    let result: unknown;
    void hook()({ tool_input: keychainInput, tool_response: { stdout: "value-not-yet-known" } }).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(REDACTION_READY_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual(withheld(WITHHELD_OUTPUT));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not leave the cap's timer behind when readiness resolves first", async () => {
    vi.useFakeTimers();
    let finish: (ok: boolean) => void = () => {};
    markRedactionNotReady(() => new Promise<boolean>((resolve) => { finish = resolve; }), Date.now() - 60_000);
    const pending = hook()({ tool_input: keychainInput, tool_response: { stdout: FAKE } });
    await vi.advanceTimersByTimeAsync(10);
    finish(true);
    expect(await pending).toEqual(withheld(REDACTED));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withholds instead of passing the original through when scrubbing throws", async () => {
    markRedactionReady();
    vi.mocked(scrubDeep).mockImplementationOnce(() => { throw new Error("scrub failed"); });
    expect(await hook()({ tool_response: { stdout: FAKE } })).toEqual(withheld(WITHHELD_OUTPUT));
  });

  // Codex #593 P1: the value need not come from a keychain command. Written to
  // a file by one command and read back by another while the retry still runs,
  // it is not registered yet and the reading command's input looks harmless.
  it("withholds EVERY tool output once the cap passes, not only keychain reads", async () => {
    vi.useFakeTimers();
    markRedactionNotReady(() => new Promise<boolean>(() => {}), Date.now() - 60_000);
    let result: unknown;
    void hook()({ tool_input: { command: "cat /tmp/token" }, tool_response: { stdout: "value-not-yet-known" } }).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(REDACTION_READY_TIMEOUT_MS);
    expect(result).toEqual(withheld(WITHHELD_OUTPUT));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withholds every tool output while the first load is still running, and says why", async () => {
    // Fresh process: not ready, no retry registered yet.
    const out = await hook()({ tool_input: { command: "ls" }, tool_response: { stdout: "a b", stderr: "", interrupted: false } });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout: WITHHELD_OUTPUT, stderr: "", interrupted: false } } });
    expect(WITHHELD_OUTPUT).toMatch(/withheld/i);
    expect(WITHHELD_OUTPUT).toMatch(/not ready/i);
  });

  // Codex #593 P2: the fallback walked the same object and could throw again.
  it("withholds leaf by leaf when reading a field throws, without throwing itself", async () => {
    markRedactionReady();
    const response = { stdout: FAKE, get stderr(): string { throw new Error("getter"); }, interrupted: false };
    expect(await hook()({ tool_response: response })).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout: WITHHELD_OUTPUT, stderr: WITHHELD_OUTPUT, interrupted: false } },
    });
  });

  it("falls back to a fixed Bash-shaped notice when the output cannot be walked at all", async () => {
    markRedactionReady();
    const response = new Proxy({ stdout: FAKE }, { ownKeys() { throw new Error("ownKeys"); } });
    const out = await hook()({ tool_response: response });
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout: WITHHELD_OUTPUT, stderr: "", interrupted: false } },
    });
  });

  // Codex #593 round 2: past the depth limit both walks returned the subtree
  // unchanged, so a value nested deep in (say) an MCP result passed through.
  it("withholds a value nested past the depth limit while not ready", async () => {
    const out = await hook()({ tool_response: nested(40, FAKE) });
    expect(JSON.stringify(out)).not.toContain(FAKE);
    expect(JSON.stringify(out)).toContain(WITHHELD_OUTPUT);
  });

  it("does not pass a known value nested past the depth limit when ready", async () => {
    markRedactionReady();
    const out = await hook()({ tool_response: nested(40, FAKE) });
    expect(JSON.stringify(out)).not.toContain(FAKE);
    expect(JSON.stringify(out)).toContain(TOO_DEEP_OUTPUT);
  });

  // Codex #593 round 3: no matching past the limit (JSON escapes quotes and
  // backslashes, so a serialised search misses such a value); the unwalked
  // subtree is replaced, clean or not.
  it("replaces even a clean subtree past the depth limit when ready", async () => {
    markRedactionReady();
    const out = JSON.stringify(await hook()({ tool_response: nested(40, "clean") }));
    expect(out).toContain(TOO_DEEP_OUTPUT);
    expect(out).not.toContain("clean");
  });

  it("does not pass a deeply nested value that holds quotes and backslashes", async () => {
    const quoted = 'p"a\\ss\\"w0rd-91b4';
    registerSecretValue(quoted, "q");
    markRedactionReady();
    const out = await hook()({ tool_response: nested(40, quoted) });
    expect(out).not.toEqual({});
    expect(JSON.stringify(out)).toContain(TOO_DEEP_OUTPUT);
    // Neither the raw value nor its JSON-escaped form survives.
    expect(JSON.stringify(out)).not.toContain(JSON.stringify(quoted).slice(1, -1));
  });

  it("leaves the normal path unchanged: clean output untouched, dirty output scrubbed", async () => {
    vi.useFakeTimers();
    markRedactionReady();
    expect(await hook()({ tool_response: { stdout: "clean" } })).toEqual({});
    expect(await hook()({ tool_input: keychainInput, tool_response: { stdout: FAKE } })).toEqual(withheld(REDACTED));
    expect(vi.getTimerCount()).toBe(0);
  });
});
