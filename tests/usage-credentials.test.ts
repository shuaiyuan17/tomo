import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecFileException } from "node:child_process";

// The default credential loader (no `loadCredentials` injected): the macOS
// Keychain via `security`, then the on-disk credentials file. Both are stubbed
// here, so nothing reads the real Keychain or the real home directory.
type ExecCallback = (err: ExecFileException | null, stdout: string, stderr: string) => void;
const state = vi.hoisted(() => ({
  security: null as null | ((args: readonly string[]) => { err?: Partial<ExecFileException>; stdout?: string; stderr?: string }),
  securityCalls: 0,
  file: null as null | (() => string),
  fileReads: 0,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: (file: string, args: readonly string[], _opts: unknown, cb: ExecCallback) => {
      if (file !== "security" || !state.security) throw new Error(`unexpected execFile: ${file}`);
      state.securityCalls++;
      const { err, stdout, stderr } = state.security(args);
      queueMicrotask(() => cb(err ? err as ExecFileException : null, stdout ?? "", stderr ?? ""));
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: (async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path.endsWith(".credentials.json")) {
        state.fileReads++;
        if (!state.file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return state.file();
      }
      return (original.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof original.readFile,
  };
});

const { buildUsageReport, fetchUsage } = await import("../src/agent/usage.js");

const NOW = Date.parse("2026-07-27T22:00:00Z");
const STORED = JSON.stringify({ claudeAiOauth: { accessToken: "stored-token", expiresAt: NOW + 3_600_000 } });
const realPlatform = process.platform;
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { value, configurable: true });

/** Runs a read with the default loader; returns the bearer token the request carried. */
async function read(): Promise<{ result: Awaited<ReturnType<typeof fetchUsage>>; bearer: string | null }> {
  let bearer: string | null = null;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bearer = new Headers(init?.headers).get("Authorization");
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const result = await fetchUsage({ now: () => NOW, fetchImpl });
  return { result, bearer };
}

afterEach(() => {
  setPlatform(realPlatform);
  state.security = null;
  state.securityCalls = 0;
  state.file = null;
  state.fileReads = 0;
});

describe("default credential loader on macOS", () => {
  it("reads the token from the Keychain item and never touches the file", async () => {
    setPlatform("darwin");
    let seenArgs: readonly string[] = [];
    state.security = (args) => { seenArgs = args; return { stdout: `${STORED}\n` }; };
    const { result, bearer } = await read();
    expect(result.ok).toBe(true);
    expect(bearer).toBe("Bearer stored-token");
    expect(seenArgs).toEqual(["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    expect(state.fileReads).toBe(0);
  });

  it("falls back to the credentials file only when `security` itself is missing", async () => {
    setPlatform("darwin");
    state.security = () => ({ err: { code: "ENOENT" } });
    state.file = () => STORED;
    const { result, bearer } = await read();
    expect(result.ok).toBe(true);
    expect(bearer).toBe("Bearer stored-token");
    expect(state.fileReads).toBe(1);
  });

  it.each<[string, { err?: Partial<ExecFileException>; stdout?: string; stderr?: string }, string, string]>([
    ["a missing Keychain item", { err: { code: 44 as unknown as string } }, "no_token",
      "Claude usage unavailable: no Claude Code credentials in the macOS Keychain. Log in with Claude Code first."],
    ["a locked Keychain", { err: { code: "1" }, stderr: "User interaction is not allowed." }, "credentials_unreadable",
      "Claude usage unavailable: the macOS Keychain is locked or denied access — unlock it and try /usage again."],
    ["a lookup timeout", { err: { killed: true, signal: "SIGTERM" } }, "credentials_unreadable",
      "Claude usage unavailable: the macOS Keychain lookup timed out — unlock the Keychain and try /usage again."],
    ["any other Keychain failure", { err: { code: "1" }, stderr: "unexpected" }, "credentials_unreadable",
      "Claude usage unavailable: could not read Claude Code credentials from the macOS Keychain."],
    ["a Keychain item that is not JSON", { stdout: "not json" }, "credentials_unreadable",
      "Claude usage unavailable: Keychain credentials were not valid JSON."],
    ["a Keychain item that is not an object", { stdout: "null" }, "credentials_unreadable",
      "Claude usage unavailable: Claude Code credentials were malformed. Re-login to Claude Code (`claude` → /login)."],
  ])("reports %s without falling back to the file", async (_label, outcome, reason, message) => {
    setPlatform("darwin");
    state.security = () => outcome;
    state.file = () => STORED;
    const { result, bearer } = await read();
    expect(result).toMatchObject({ ok: false, reason, message });
    expect(bearer).toBeNull();
    expect(state.fileReads).toBe(0);
  });
});

describe("default credential loader off macOS", () => {
  it("reads the credentials file and never runs `security`", async () => {
    setPlatform("linux");
    state.file = () => STORED;
    const { result, bearer } = await read();
    expect(result.ok).toBe(true);
    expect(bearer).toBe("Bearer stored-token");
    expect(state.securityCalls).toBe(0);
  });

  it.each<[string, null | (() => string), string, string]>([
    ["a missing file", null, "no_token",
      "Claude usage unavailable: no Claude Code credentials found. Log in with Claude Code first."],
    ["a file that is not JSON", () => "{", "credentials_unreadable",
      "Claude usage unavailable: Claude Code credentials file was not valid JSON."],
    ["a file that is not an object", () => "null", "credentials_unreadable",
      "Claude usage unavailable: Claude Code credentials were malformed. Re-login to Claude Code (`claude` → /login)."],
  ])("reports %s", async (_label, file, reason, message) => {
    setPlatform("linux");
    state.file = file;
    const { result } = await read();
    expect(result).toMatchObject({ ok: false, reason, message });
    // `/usage` prints the same text.
    expect(await buildUsageReport({ now: () => NOW })).toBe(message);
  });
});
