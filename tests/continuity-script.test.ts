import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContinuityRunner } from "../src/continuity.js";
import { runContinuityScript, type ContinuityScriptConfig } from "../src/continuity-script.js";

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
    expect(prompt).toContain("Read CONTINUITY.md");
    expect(prompt).toContain("Continuity script result:");
    expect(prompt).toContain("runner-output");
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
