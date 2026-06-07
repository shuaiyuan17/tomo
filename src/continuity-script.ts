import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_CONTINUITY_SCRIPT_TIMEOUT_MS = 30_000;
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

    const resolveOnce = (result: ScriptRunResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
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

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
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
      resolveOnce({
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

    child.on("close", (exitCode, signal) => {
      resolveOnce({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        exitCode,
        signal,
        timedOut,
      });
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
