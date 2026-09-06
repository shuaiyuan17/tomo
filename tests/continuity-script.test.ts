import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContinuityRunner } from "../src/continuity.js";
import { runContinuityScript, type ContinuityScriptConfig } from "../src/continuity-script.js";
import { CONTINUITY_DELIVERY_NOTE } from "../src/continuity-defaults.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tomo-continuity-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function scriptConfig(path: string, overrides: Partial<ContinuityScriptConfig> = {}): ContinuityScriptConfig {
  return {
    path,
    timeoutMs: 1_000,
    maxOutputChars: 2_000,
    ...overrides,
  };
}

function writeScript(name: string, content: string, executable = true): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
  return path;
}

describe("runContinuityScript", () => {
  it("runs an executable script and captures stdout", async () => {
    const path = writeScript("status.sh", "#!/bin/sh\necho \"hello $TOMO_CONTINUITY\"\n");

    const result = await runContinuityScript(scriptConfig(path));

    expect(result).toContain("Continuity script result:");
    expect(result).toContain("status: completed successfully");
    expect(result).toContain("stdout:");
    expect(result).toContain("hello true");
  });

  it("falls back to /bin/sh when a readable script is not executable", async () => {
    const path = writeScript("not-executable.sh", "echo fallback-ok\n", false);

    const result = await runContinuityScript(scriptConfig(path));

    expect(result).toContain("status: completed successfully");
    expect(result).toContain("fallback-ok");
  });

  it("captures non-zero exits and stderr without throwing", async () => {
    const path = writeScript("fail.sh", "#!/bin/sh\necho nope >&2\nexit 7\n");

    const result = await runContinuityScript(scriptConfig(path));

    expect(result).toContain("status: exited with code 7");
    expect(result).toContain("stderr:");
    expect(result).toContain("nope");
  });

  it("returns as soon as the script exits, even with a background child on the pipes", async () => {
    // `'close'` fires only when EVERY holder of the child's stdio has let go,
    // and a backgrounded grandchild inherits them. Resolving on it meant one
    // `sleep 30 &` in the user's status script stopped the heartbeat for
    // thirty seconds — a daemon started the same way stopped it forever, and
    // the timeout could not help because it only killed the direct child.
    const path = writeScript("background.sh", "#!/bin/sh\nsleep 30 &\necho done-now\nexit 0\n");

    const startedAt = Date.now();
    const result = await runContinuityScript(scriptConfig(path, { timeoutMs: 20_000 }));
    const elapsed = Date.now() - startedAt;

    expect(result).toContain("status: completed successfully");
    expect(result).toContain("done-now");
    expect(elapsed).toBeLessThan(10_000);
  });

  it("kills the whole process group when the script times out", async () => {
    // The timeout killed only the direct child, so anything the script had
    // started survived it — and kept holding the pipes.
    const pidFile = join(tmpDir, "grandchild.pid");
    const path = writeScript(
      "leaves-child.sh",
      `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nsleep 30\n`,
    );

    const result = await runContinuityScript(scriptConfig(path, { timeoutMs: 500 }));

    expect(result).toContain("status: timed out after 500ms");
    const grandchild = Number(readFileSync(pidFile, "utf-8").trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    // SIGKILL to the group is asynchronous; give the kernel a moment.
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(grandchild, 0)).toThrow();
  }, 15_000);

  it("bounds captured output", async () => {
    const path = writeScript("long.sh", "#!/bin/sh\nprintf abcdef\n");

    const result = await runContinuityScript(scriptConfig(path, { maxOutputChars: 3 }));

    expect(result).toContain("abc");
    expect(result).toContain("[truncated after 3 chars]");
    expect(result).not.toContain("abcdef");
  });
});

describe("ContinuityRunner", () => {
  it("appends the script result to the normal heartbeat prompt", async () => {
    const path = writeScript("runner.sh", "#!/bin/sh\necho runner-output\n");
    const handleContinuity = vi.fn().mockResolvedValue(undefined);
    const runner = new ContinuityRunner(
      { handleContinuity } as unknown as ConstructorParameters<typeof ContinuityRunner>[0],
      null,
      scriptConfig(path),
    );

    await (runner as unknown as { fire(): Promise<void> }).fire();

    expect(handleContinuity).toHaveBeenCalledTimes(1);
    const prompt = handleContinuity.mock.calls[0][0] as string;
    expect(prompt).toMatch(/^<tomo-event type="heartbeat" ts="[^"]+">/);
    expect(prompt.trimEnd()).toMatch(/<\/tomo-event>$/);
    expect(prompt).toContain("Read CONTINUITY.md");
    expect(prompt).toContain("Continuity script result:");
    expect(prompt).toContain("runner-output");
  });

  /**
   * The heartbeat turn suppresses its own output (option A). The model is told
   * so in the EVENT ITSELF, not only in CONTINUITY.md: a model that believes
   * its reply will be read writes a reply instead of calling the tool that
   * would actually deliver one, and CONTINUITY.md is a file it may or may not
   * have read this turn.
   */
  it("tells the model in the heartbeat event that its reply text is not delivered", async () => {
    const handleContinuity = vi.fn().mockResolvedValue(undefined);
    const runner = new ContinuityRunner(
      { handleContinuity } as unknown as ConstructorParameters<typeof ContinuityRunner>[0],
      null,
    );

    await (runner as unknown as { fire(): Promise<void> }).fire();

    const prompt = handleContinuity.mock.calls[0][0] as string;
    expect(prompt).toContain(CONTINUITY_DELIVERY_NOTE);
    expect(prompt).toContain("Your reply text is not delivered to the user; to send a message, use send_message.");
  });

  it("uses the configured interval for scheduled heartbeats", async () => {
    vi.useFakeTimers();
    const handleContinuity = vi.fn().mockResolvedValue(undefined);
    const runner = new ContinuityRunner(
      { handleContinuity } as unknown as ConstructorParameters<typeof ContinuityRunner>[0],
      null,
      null,
      { triggerDir: tmpDir, intervalMs: 25 },
    );

    try {
      runner.start();
      await vi.advanceTimersByTimeAsync(24);
      expect(handleContinuity).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(handleContinuity).toHaveBeenCalledTimes(1);
    } finally {
      runner.stop();
      vi.useRealTimers();
    }
  });

  it("runs the script when the manual continuity trigger file is written", async () => {
    const triggerDir = join(tmpDir, "trigger");
    mkdirSync(triggerDir);
    const path = writeScript("manual.sh", "#!/bin/sh\necho manual-output\n");
    const handleContinuity = vi.fn().mockResolvedValue(undefined);
    const runner = new ContinuityRunner(
      { handleContinuity } as unknown as ConstructorParameters<typeof ContinuityRunner>[0],
      null,
      scriptConfig(path),
      { triggerDir },
    );
    let triggerInterval: ReturnType<typeof setInterval> | null = null;

    try {
      runner.start();
      const triggerFile = join(triggerDir, "continuity.trigger");
      triggerInterval = setInterval(() => {
        writeFileSync(triggerFile, String(Date.now()));
      }, 25);

      await vi.waitFor(() => {
        expect(handleContinuity.mock.calls.length).toBeGreaterThanOrEqual(1);
      });

      const prompt = handleContinuity.mock.calls[0][0] as string;
      expect(prompt).toContain("Continuity script result:");
      expect(prompt).toContain("manual-output");
    } finally {
      if (triggerInterval) clearInterval(triggerInterval);
      runner.stop();
    }
  });
});
