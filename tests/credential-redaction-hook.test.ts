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
  clearSecretValuesForTests, markRedactionNotReady, markRedactionReady, registerSecretValue, scrubDeep, WITHHELD_OUTPUT,
} from "../src/credentials/redactor.js";
import { KEYCHAIN_SERVICE } from "../src/credentials/names.js";
import { credentialRedactionHooks, REDACTION_READY_TIMEOUT_MS } from "../src/agent/sdk-options.js";

const FAKE = "fake-redaction-hook-credential-91b4";
const REDACTED = "[REDACTED secret://x]";
const keychainInput = { command: `security find-generic-password -s ${KEYCHAIN_SERVICE} -a x -w` };
type Hook = (input: { tool_input?: unknown; tool_response?: unknown }) => Promise<Record<string, unknown>>;
const hook = () => credentialRedactionHooks().PostToolUse[0].hooks[0] as Hook;
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

  it("withholds when the tool input cannot be serialised", async () => {
    // Not ready, no retry registered yet: the keychain check has to serialise the input.
    const circular: Record<string, unknown> = { command: "x" };
    circular.self = circular;
    expect(await hook()({ tool_input: circular, tool_response: { stdout: FAKE } })).toEqual(withheld(WITHHELD_OUTPUT));
  });

  it("leaves the normal path unchanged: clean output untouched, dirty output scrubbed", async () => {
    vi.useFakeTimers();
    markRedactionReady();
    expect(await hook()({ tool_response: { stdout: "clean" } })).toEqual({});
    expect(await hook()({ tool_input: keychainInput, tool_response: { stdout: FAKE } })).toEqual(withheld(REDACTED));
    expect(vi.getTimerCount()).toBe(0);
  });
});
