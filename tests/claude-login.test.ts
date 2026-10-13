import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { resolveClaudeExecutable, ClaudeLoginManager } from "../src/agent/claude-login.js";

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

describe("resolveClaudeExecutable", () => {
  const plat = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`;
  const bin = process.platform === "win32" ? "claude.exe" : "claude";

  it("prefers TOMO_CLAUDE_PATH", () => {
    expect(resolveClaudeExecutable({ TOMO_CLAUDE_PATH: "/opt/c/claude" }, () => "/x/package.json", () => true))
      .toBe("/opt/c/claude");
  });

  it("uses the SDK's bundled binary, not a bare PATH lookup", () => {
    const seen: string[] = [];
    const path = resolveClaudeExecutable({}, (id) => { seen.push(id); return "/nm/pkg/package.json"; }, () => true);
    expect(seen).toEqual([plat]);
    expect(path).toBe(`/nm/pkg/${bin}`);
  });

  it("falls back to claude on PATH when the bundled binary is missing", () => {
    expect(resolveClaudeExecutable({}, () => "/nm/pkg/package.json", () => false)).toBe("claude");
    expect(resolveClaudeExecutable({}, () => { throw new Error("MODULE_NOT_FOUND"); }, () => true)).toBe("claude");
  });

  it("finds a real binary in this checkout", () => {
    const path = resolveClaudeExecutable({});
    expect(path).not.toBe("claude");
  });
});
