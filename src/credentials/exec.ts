import { spawn } from "node:child_process";
import { config } from "../config.js";
import { scrubKnownSecrets } from "./redactor.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;
/** Dropped from the end of a truncated stream AFTER scrubbing: the kill can land
 *  inside a value, whose front half no longer matches. Longer than any value. */
const TRUNCATION_MARGIN_CHARS = 16 * 1024;
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  /** stdout, then stderr, scrubbed. Safe to show the model. */
  output: string;
}

/**
 * Run a command with credentials in its ENVIRONMENT, never its argv. The harness
 * spawns it because a hook can rewrite a Bash command but not set its environment,
 * and a rewritten command would put the value in the transcript and `ps`.
 *
 * The streams are collected and scrubbed separately: merged in arrival order, a
 * stderr line landing between two stdout reads would split a value out of reach of
 * the literal match.
 */
export function runWithSecrets(args: {
  command: string;
  secrets: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
}): Promise<ExecResult> {
  // The daemon's own Anthropic key is not this command's business.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  Object.assign(env, args.secrets);

  return new Promise((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-lc", "--", args.command], {
      env,
      cwd: args.cwd ?? config.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const streams: Buffer[][] = [[], []];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch { /* already gone */ }
    };
    const onData = (stream: Buffer[]) => (chunk: Buffer) => {
      if (truncated) return;
      stream.push(chunk);
      size += chunk.length;
      if (size > MAX_CAPTURE_BYTES) {
        truncated = true;
        killGroup();
      }
    };
    child.stdout?.on("data", onData(streams[0]));
    child.stderr?.on("data", onData(streams[1]));
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      const cut = truncated || timedOut;
      const [stdout, stderr] = streams.map((stream) => {
        const scrubbed = scrubKnownSecrets(Buffer.concat(stream).toString("utf8"));
        return cut ? scrubbed.slice(0, Math.max(0, scrubbed.length - TRUNCATION_MARGIN_CHARS)) : scrubbed;
      });
      resolve({ exitCode, timedOut, truncated, output: stderr ? `${stdout}${stdout ? "\n" : ""}[stderr]\n${stderr}` : stdout });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      // A daemonized grandchild can hold the pipes open past the kill.
      setTimeout(() => finish(null), 1000).unref?.();
    }, args.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => finish(code));
  });
}
