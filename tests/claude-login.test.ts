import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { bundledPackageNames, resolveClaudeExecutable, ClaudeLoginManager, type ClaudeLoginFailure } from "../src/agent/claude-login.js";

const LOGIN_URL = "https://claude.com/cai/oauth/authorize?code=true&state=test-state";

function fakeLoginProcess(): {
  child: ChildProcessWithoutNullStreams;
  stdin: PassThrough;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => {
    events.emit("exit", null, "SIGTERM");
    return true;
  });
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    kill,
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, stdin, stdout, kill };
}

describe("ClaudeLoginManager", () => {
  it("keeps the PKCE child alive, validates state, submits the code, and verifies", async () => {
    const fake = fakeLoginProcess();
    const verifyLogin = vi.fn(async () => {});
    const manager = new ClaudeLoginManager({
      spawnLogin: () => fake.child,
      verifyLogin,
      timeoutMs: 1_000,
    });
    let submitted = "";
    fake.stdin.on("data", (chunk) => { submitted += chunk.toString(); });
    fake.stdin.on("finish", () => {
      fake.stdout.write("Login successful.\n");
      fake.child.emit("exit", 0, null);
    });

    const startPromise = manager.start("Shuai");
    fake.stdout.write(`If the browser didn't open, visit: ${LOGIN_URL}\nPaste code here > `);
    await expect(startPromise).resolves.toEqual({ url: LOGIN_URL, reused: false });

    await expect(manager.complete("shuai", "one-time-code#wrong-state"))
      .rejects.toThrow("does not match");

    await expect(manager.complete("SHUAI", "one-time-code#test-state"))
      .resolves.toEqual({ verified: true });

    expect(submitted).toBe("one-time-code#test-state\n");
    expect(verifyLogin).toHaveBeenCalledOnce();
  });

  it("reports a probe failure separately after the CLI saves credentials", async () => {
    const fake = fakeLoginProcess();
    const manager = new ClaudeLoginManager({
      spawnLogin: () => fake.child,
      verifyLogin: async () => {
        throw new Error("verification network unavailable");
      },
      timeoutMs: 1_000,
    });
    fake.stdin.on("finish", () => {
      fake.child.emit("exit", 0, null);
    });

    const startPromise = manager.start("shuai");
    fake.stdout.write(`${LOGIN_URL}\n`);
    await startPromise;

    await expect(manager.complete("shuai", "one-time-code#test-state")).resolves.toEqual({
      verified: false,
      verificationError: "verification network unavailable",
      verificationFailure: expect.objectContaining({ message: "verification network unavailable" }),
    });
  });

  it("reuses the active owner's URL and rejects a different owner", async () => {
    const fake = fakeLoginProcess();
    const manager = new ClaudeLoginManager({
      spawnLogin: () => fake.child,
      verifyLogin: async () => {},
      timeoutMs: 1_000,
    });

    const first = manager.start("shuai");
    fake.stdout.write(`${LOGIN_URL}\n`);
    await expect(first).resolves.toEqual({ url: LOGIN_URL, reused: false });
    await expect(manager.start("SHUAI")).resolves.toEqual({ url: LOGIN_URL, reused: true });
    await expect(manager.start("other")).rejects.toThrow("Another owner");

    expect(manager.cancel("shuai")).toBe(true);
    expect(fake.kill).toHaveBeenCalledOnce();
  });

  it("expires an abandoned login flow", async () => {
    const fake = fakeLoginProcess();
    const manager = new ClaudeLoginManager({
      spawnLogin: () => fake.child,
      verifyLogin: async () => {},
      timeoutMs: 5,
    });

    await expect(manager.start("shuai")).rejects.toThrow("expired");
    expect(fake.kill).toHaveBeenCalledOnce();
  });
});

/** A manager whose child has printed the login URL, and the fake behind it. */
async function startedLogin(owner = "shuai"): Promise<{ manager: ClaudeLoginManager; fake: ReturnType<typeof fakeLoginProcess> }> {
  const fake = fakeLoginProcess();
  const manager = new ClaudeLoginManager({ spawnLogin: () => fake.child, verifyLogin: async () => {}, timeoutMs: 1_000 });
  const started = manager.start(owner);
  fake.stdout.write(`${LOGIN_URL}\n`);
  await started;
  return { manager, fake };
}

/** The failure a rejected login call carries, so a test can pin its kind. */
async function failureOf(promise: Promise<unknown>): Promise<ClaudeLoginFailure> {
  const err = await promise.then(() => undefined, (e: unknown) => e);
  expect(err, "expected the call to reject").toBeDefined();
  return (err as { failure: ClaudeLoginFailure }).failure;
}

describe("ClaudeLoginManager refusals", () => {
  it("refuses a code when no login is waiting", async () => {
    const manager = new ClaudeLoginManager({ spawnLogin: () => fakeLoginProcess().child, verifyLogin: async () => {} });
    expect(await failureOf(manager.complete("shuai", "code#test-state"))).toEqual({ kind: "none_waiting" });
  });

  it("refuses a code from an owner other than the one who started the login", async () => {
    const { manager } = await startedLogin("shuai");
    expect(await failureOf(manager.complete("other", "code#test-state"))).toEqual({ kind: "other_owner" });
    manager.stop();
  });

  it.each([
    ["no #state", "one-time-code"],
    ["an empty code before #", "#test-state"],
    ["an empty state after #", "one-time-code#"],
    ["whitespace inside", "one-time code#test-state"],
  ])("refuses a code with %s as invalid, and submits nothing", async (_label, code) => {
    const { manager, fake } = await startedLogin();
    let submitted = "";
    fake.stdin.on("data", (chunk) => { submitted += chunk.toString(); });
    expect(await failureOf(manager.complete("shuai", code))).toEqual({ kind: "invalid_code" });
    expect(submitted).toBe("");
    manager.stop();
  });

  it("refuses a second code while the first is being verified", async () => {
    const { manager, fake } = await startedLogin();
    // The CLI has the first code and has not exited yet.
    const first = manager.complete("shuai", "one-time-code#test-state");
    expect(await failureOf(manager.complete("shuai", "one-time-code#test-state"))).toEqual({ kind: "verifying" });
    fake.child.emit("exit", 0, null);
    await expect(first).resolves.toEqual({ verified: true });
  });

  it("fails the login with the exit code when the CLI exits non-zero after the code", async () => {
    const { manager, fake } = await startedLogin();
    const completion = manager.complete("shuai", "one-time-code#test-state");
    fake.child.emit("exit", 1, null);
    expect(await failureOf(completion)).toEqual({ kind: "exited", code: 1 });
  });

  it("fails start() with the signal when the CLI dies before printing a URL", async () => {
    const fake = fakeLoginProcess();
    const manager = new ClaudeLoginManager({ spawnLogin: () => fake.child, verifyLogin: async () => {}, timeoutMs: 1_000 });
    const started = manager.start("shuai");
    fake.child.emit("exit", null, "SIGKILL");
    expect(await failureOf(started)).toEqual({ kind: "exited", signal: "SIGKILL" });
    // The flow is gone: a code now finds nothing waiting.
    expect(await failureOf(manager.complete("shuai", "code#test-state"))).toEqual({ kind: "none_waiting" });
  });

  it("treats an exit 0 BEFORE any code as a failed login, not a success", async () => {
    const { manager, fake } = await startedLogin();
    fake.child.emit("exit", 0, null);
    expect(await failureOf(manager.complete("shuai", "one-time-code#test-state"))).toEqual({ kind: "none_waiting" });
  });
});

describe("resolveClaudeExecutable", () => {

  it("prefers TOMO_CLAUDE_PATH", () => {
    expect(resolveClaudeExecutable({ TOMO_CLAUDE_PATH: "/opt/c/claude" }, () => "/x/package.json", () => true))
      .toBe("/opt/c/claude");
  });

  it("uses the SDK's bundled binary, not a bare PATH lookup", () => {
    // Platform, arch and libc are passed explicitly: with the real musl probe
    // a musl Linux runner (Alpine CI) would try the -musl package first.
    const seen: string[] = [];
    const path = resolveClaudeExecutable({}, (id) => { seen.push(id); return "/nm/pkg/package.json"; }, () => true,
      "linux", "x64", () => false);
    expect(seen).toEqual(["@anthropic-ai/claude-agent-sdk-linux-x64/package.json"]);
    expect(path).toBe("/nm/pkg/claude");
  });

  it("falls back to claude on PATH when the bundled binary is missing", () => {
    expect(resolveClaudeExecutable({}, () => "/nm/pkg/package.json", () => false)).toBe("claude");
    expect(resolveClaudeExecutable({}, () => { throw new Error("MODULE_NOT_FOUND"); }, () => true)).toBe("claude");
  });

  it("finds a real binary in this checkout", () => {
    const path = resolveClaudeExecutable({});
    expect(path).not.toBe("claude");
  });

  it("tries the musl build first on musl Linux, glibc first elsewhere", () => {
    expect(bundledPackageNames("linux", "x64", () => true))
      .toEqual(["claude-agent-sdk-linux-x64-musl", "claude-agent-sdk-linux-x64"]);
    expect(bundledPackageNames("linux", "arm64", () => false))
      .toEqual(["claude-agent-sdk-linux-arm64", "claude-agent-sdk-linux-arm64-musl"]);
    expect(bundledPackageNames("darwin", "arm64", () => true)).toEqual(["claude-agent-sdk-darwin-arm64"]);
    expect(bundledPackageNames("android", "arm64", () => false)).toEqual(["claude-agent-sdk-linux-arm64-android"]);
  });

  it("on musl, skips a missing musl package and uses the next candidate", () => {
    const seen: string[] = [];
    const path = resolveClaudeExecutable({}, (id) => {
      seen.push(id);
      if (id.includes("-musl")) throw new Error("MODULE_NOT_FOUND");
      return "/nm/glibc/package.json";
    }, () => true, "linux", "x64", () => true);
    expect(seen[0]).toContain("linux-x64-musl");
    expect(path).toBe("/nm/glibc/claude");
  });
});
