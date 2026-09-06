import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_CONTINUITY_SCRIPT_TIMEOUT_MS = 30_000;
/**
 * How long to keep reading after the script's own process has exited.
 *
 * The run used to resolve on `'close'`, which fires only once EVERY holder of
 * the child's stdio has let go — and a background grandchild inherits those
 * pipes. `status.sh` ending in `tail -f log &`, or any daemon it starts
 * without redirecting, therefore kept `'close'` pending for as long as the
 * grandchild lived, and the heartbeat that was awaiting it never came back:
 * not a slow heartbeat, no heartbeat at all, for the life of the daemon. The
 * timeout could not save it either, since that only killed the direct child.
 *
 * So the result is taken from `'exit'` — the script itself has finished and
 * its status is known — with a short grace period afterwards for output still
 * in flight, which is all `'close'` was ever wanted for.
 */
const DRAIN_AFTER_EXIT_MS = 1_000;
export const DEFAULT_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS = 8_000;

export interface ContinuityScriptConfig {
  path: string;
  timeoutMs: number;
  maxOutputChars: number;
}

interface ScriptRunResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError?: Error & { code?: string };
}

export async function runContinuityScript(script: ContinuityScriptConfig): Promise<string> {
  const scriptPath = script.path.trim();
  if (!scriptPath) {
    return formatPreflightFailure(scriptPath, "empty script path");
  }

  try {
    const stat = statSync(scriptPath);
    if (!stat.isFile()) {
      return formatPreflightFailure(scriptPath, "path is not a file");
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return formatPreflightFailure(scriptPath, detail);
  }

  const timeoutMs = normalizePositiveInt(script.timeoutMs, DEFAULT_CONTINUITY_SCRIPT_TIMEOUT_MS);
  const maxOutputChars = normalizePositiveInt(
    script.maxOutputChars,
    DEFAULT_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS,
  );
  const startedAt = Date.now();

  let result = await runProcess(scriptPath, [], scriptPath, timeoutMs, maxOutputChars);
  if (result.spawnError && (result.spawnError.code === "EACCES" || result.spawnError.code === "ENOEXEC")) {
    result = await runProcess("/bin/sh", [scriptPath], scriptPath, timeoutMs, maxOutputChars);
  }

  return formatRunResult(scriptPath, result, Date.now() - startedAt, timeoutMs, maxOutputChars);
}

function normalizePositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function runProcess(
  command: string,
  args: string[],
  scriptPath: string,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<ScriptRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    const resolveOnce = (result: ScriptRunResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: dirname(scriptPath),
        env: {
          ...process.env,
          TOMO_CONTINUITY: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process GROUP, so the timeout below has something to kill.
        // Without this the child shares the daemon's group: `child.kill()`
        // reaches the script and nothing it started, so a script that
        // backgrounds a process left it running — and holding the pipes —
        // after the run was supposed to be over. Never unref'd until we are
        // done with it, so a detached child cannot outlive the wait silently.
        detached: true,
      });
    } catch (err) {
      resolveOnce({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    /** Release the pipes and the child before resolving: a grandchild may
     *  still hold the write ends, and keeping the read ends open would pin
     *  the event loop to a process this run no longer cares about. */
    const settle = (result: ScriptRunResult) => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolveOnce(result);
    };

    /** Signal the whole process GROUP — the script and everything it started.
     *  Falls back to the direct child if the group is already gone. */
    const killGroup = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      try {
        if (pid !== undefined) process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already reaped; nothing left to signal.
        }
      }
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) killGroup("SIGKILL");
      }, 1_000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stdout, chunk, maxOutputChars);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stderr, chunk, maxOutputChars);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });

    child.on("error", (err: Error & { code?: string }) => {
      settle({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        exitCode: null,
        signal: null,
        timedOut,
        spawnError: err,
      });
    });

    const collected = (exitCode: number | null, signal: NodeJS.Signals | null): ScriptRunResult => ({
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      exitCode,
      signal,
      timedOut,
    });

    // The script's own process is done and its status is known. Give the
    // pipes a bounded moment for output still in flight, then answer whether
    // or not anything else is still holding them — see DRAIN_AFTER_EXIT_MS.
    child.on("exit", (exitCode, signal) => {
      if (drainTimer) return;
      // Deliberately NOT unref'd: this timer is the only thing left that can
      // settle the promise, and an unref'd one lets the loop drain with the
      // caller still awaiting.
      drainTimer = setTimeout(() => settle(collected(exitCode, signal)), DRAIN_AFTER_EXIT_MS);
    });

    // The normal case: every pipe closed with the script, so there is nothing
    // to wait for and the drain is skipped entirely.
    child.on("close", (exitCode, signal) => {
      settle(collected(exitCode, signal));
    });
  });
}

function appendBounded(current: string, chunk: Buffer, maxChars: number): { text: string; truncated: boolean } {
  if (current.length >= maxChars) return { text: current, truncated: true };

  const incoming = chunk.toString("utf8");
  const remaining = maxChars - current.length;
  if (incoming.length > remaining) {
    return { text: current + incoming.slice(0, remaining), truncated: true };
  }

  return { text: current + incoming, truncated: false };
}

function formatPreflightFailure(scriptPath: string, detail: string): string {
  return [
    "Continuity script result:",
    `path: ${scriptPath || "(empty)"}`,
    `status: failed (${detail})`,
  ].join("\n");
}

function formatRunResult(
  scriptPath: string,
  result: ScriptRunResult,
  durationMs: number,
  timeoutMs: number,
  maxOutputChars: number,
): string {
  const lines = [
    "Continuity script result:",
    `path: ${scriptPath}`,
    `status: ${formatStatus(result, timeoutMs)}`,
    `durationMs: ${durationMs}`,
  ];

  if (result.stdout.trimEnd()) {
    lines.push("stdout:", indent(formatOutput(result.stdout, result.stdoutTruncated, maxOutputChars)));
  }
  if (result.stderr.trimEnd()) {
    lines.push("stderr:", indent(formatOutput(result.stderr, result.stderrTruncated, maxOutputChars)));
  }
  if (!result.stdout.trimEnd() && !result.stderr.trimEnd()) {
    lines.push("output: (none)");
  }

  return lines.join("\n");
}

function formatStatus(result: ScriptRunResult, timeoutMs: number): string {
  if (result.spawnError) {
    const code = result.spawnError.code ? `${result.spawnError.code}: ` : "";
    return `failed to start (${code}${result.spawnError.message})`;
  }
  if (result.timedOut) return `timed out after ${timeoutMs}ms`;
  if (result.exitCode === 0) return "completed successfully";
  if (result.exitCode !== null) return `exited with code ${result.exitCode}`;
  if (result.signal) return `terminated by signal ${result.signal}`;
  return "completed";
}

function formatOutput(text: string, truncated: boolean, maxOutputChars: number): string {
  const trimmed = text.trimEnd();
  if (!truncated) return trimmed;
  return `${trimmed}\n[truncated after ${maxOutputChars} chars]`;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}
