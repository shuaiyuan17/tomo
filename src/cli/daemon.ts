import { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESTART_REASON_FILE } from "../config.js";
import { TOMO_SESSION_KEY_ENV, resolveRestartInitiator, writeRestartReasonFile } from "../restart-reason.js";
import { spawn } from "node:child_process";
import { isAutostartEnabled, restartAutostart, stopLaunchdJob } from "./service.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { isRunning, getRunningPid, waitForExit, STOP_TIMEOUT_MS } from "./status-info.js";

const TOMO_HOME = defaultRuntimePaths.tomoHome;
const LOG_FILE = join(defaultRuntimePaths.logsDir, "tomo.log");

export interface StopDeps {
  autostartEnabled: () => boolean;
  stopLaunchd: () => Promise<void>;
  runningPid: () => number | null;
  alive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  wait: (pid: number, timeoutMs: number) => Promise<boolean>;
  timeoutMs?: number;
}

export interface StopOutcome {
  /** Process exit code the CLI should use. Non-zero means nothing was stopped. */
  code: number;
  message: string;
}

const defaultStopDeps: StopDeps = {
  autostartEnabled: isAutostartEnabled,
  stopLaunchd: stopLaunchdJob,
  runningPid: () => getRunningPid(),
  alive: isRunning,
  kill: (pid, signal) => { process.kill(pid, signal); },
  wait: (pid, timeoutMs) => waitForExit(pid, timeoutMs),
};

/**
 * `tomo stop`, as a function so it can be tested without a process exit.
 *
 * Two things this must not do, both of which it used to:
 *
 * 1. Report success on the strength of the launchd bootout alone.
 *    `isAutostartEnabled()` only checks that the plist FILE exists, and
 *    `stopLaunchdJob()` passes `ignoreFailure: true` so "no such job" is
 *    swallowed. With the plist on disk but the running daemon started by hand,
 *    the old code booted out a job that was not loaded, printed "Stopped
 *    Tomo", and left the manual daemon polling Telegram and holding the `imsg
 *    rpc` child — after which `tomo start` said "already running" with no
 *    explanation. So: always fall through to the pid file, exactly as
 *    `restartAutostart()` already does.
 *
 * 2. Report success on the strength of having SENT SIGTERM. The signal is
 *    asynchronous and the daemon's handler runs `agent.stop()` first, so the
 *    old `kill(); console.log("Stopped Tomo")` was true only by coincidence —
 *    and false outright when the handler was wedged. Wait for the pid to go
 *    away, and say so honestly when it does not.
 */
export async function performStop(overrides: Partial<StopDeps> = {}): Promise<StopOutcome> {
  const deps = { ...defaultStopDeps, ...overrides };
  const timeoutMs = deps.timeoutMs ?? STOP_TIMEOUT_MS;

  const autostart = deps.autostartEnabled();
  // Read the pid BEFORE the bootout: launchd may reap the process, and a pid
  // read afterwards would be null and indistinguishable from "not running".
  const pid = deps.runningPid();

  if (autostart) {
    try {
      await deps.stopLaunchd();
    } catch (err) {
      return { code: 1, message: `Failed to stop LaunchAgent: ${(err as Error).message}` };
    }
  }

  const autostartNote = autostart
    ? " (will restart at next login — use `tomo config` to disable autostart)"
    : "";

  if (pid === null) {
    return { code: 0, message: `Tomo is not running.${autostart ? " (LaunchAgent unloaded; it will restart at next login.)" : ""}` };
  }

  // The bootout above may already have taken it down; only signal if it is
  // still there, and either way wait for the pid to actually disappear.
  if (deps.alive(pid)) {
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
      /* raced away between the liveness check and the signal — the wait below settles it */
    }
  }

  if (await deps.wait(pid, timeoutMs)) {
    return { code: 0, message: `Stopped Tomo (PID ${pid})${autostartNote}.` };
  }

  return {
    code: 1,
    message:
      `Tomo (PID ${pid}) is still running ${Math.round(timeoutMs / 1000)}s after SIGTERM. `
      + `It may be finishing an in-flight turn — check \`tomo logs -f\`. `
      + `To force it: kill -9 ${pid}`,
  };
}

export const stopCommand = new Command("stop")
  .description("Stop Tomo daemon")
  .action(async () => {
    const { code, message } = await performStop();
    if (code === 0) console.log(message);
    else console.error(message);
    if (code !== 0) process.exit(code);
  });

/**
 * Persist a CLI-invoked restart's reason, attributing the initiating session
 * so the reason is delivered back to that session (and only there) after the
 * restart. The env var is stamped into every session's Bash environment by
 * the daemon; the --session flag exists as an explicit override. Terminal-run
 * restarts have neither → unattributed → legacy blessed-session delivery.
 * Exported for tests; `reasonFile`/`env` are injectable for the same reason.
 */
export function recordRestartReason(
  reason: string,
  explicitSession: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  reasonFile: string = RESTART_REASON_FILE,
): void {
  const sessionKey = resolveRestartInitiator(explicitSession, env);
  writeRestartReasonFile(reasonFile, { reason, ...(sessionKey ? { sessionKey } : {}) });
}

export const restartCommand = new Command("restart")
  .description("Restart Tomo daemon")
  .option("--reason <reason>", "Reason for restart (sent to agent after restart)")
  .option("--session <key>", `Session key the reason belongs to (defaults to $${TOMO_SESSION_KEY_ENV}, injected into every session's shell)`)
  .action(async (opts: { reason?: string; session?: string }) => {
    if (opts.reason) {
      recordRestartReason(opts.reason, opts.session);
    }
    if (isAutostartEnabled()) {
      try {
        await restartAutostart();
        console.log("Restarted Tomo (via LaunchAgent).");
      } catch (err) {
        console.error(`Failed to restart LaunchAgent: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }

    const pid = getRunningPid();
    if (pid) {
      process.kill(pid, "SIGTERM");
      console.log(`Stopped Tomo (PID ${pid})`);
      // Wait for process to exit
      while (isRunning(pid)) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    // Import and run start as daemon
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [process.argv[1], "start"], {
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

export const continuityCommand = new Command("continuity")
  .description("Manually trigger a continuity heartbeat")
  .action(() => {
    const pid = getRunningPid();
    if (!pid) {
      console.log("Tomo is not running. Start it with 'tomo start'.");
      return;
    }
    const triggerFile = join(TOMO_HOME, "continuity.trigger");
    writeFileSync(triggerFile, String(Date.now()));
    console.log("Continuity heartbeat triggered. Check logs: tomo logs -f");
  });

export const logsCommand = new Command("logs")
  .description("Tail Tomo logs")
  .option("-n, --lines <number>", "Number of lines", "50")
  .option("-f, --follow", "Follow log output", false)
  .action((opts) => {
    if (!existsSync(LOG_FILE)) {
      console.log("No log file found. Start Tomo with 'tomo start -d' first.");
      return;
    }

    const tailArgs = ["-n", opts.lines];
    if (opts.follow) tailArgs.push("-f");
    tailArgs.push(LOG_FILE);

    const tail = spawn("tail", tailArgs, { stdio: ["ignore", "pipe", "inherit"] });
    const pretty = spawn("npx", [
      "pino-pretty",
      "--ignore", "pid,hostname,channel,chatTitle,session,sender,tool,agent,is_error,group,mentioned,images,documents",
      "--translateTime", "SYS:HH:MM:ss",
      "--messageFormat", "{if channel}[{channel}] {end}{if chatTitle}({chatTitle}) {end}{if session}→{session} {end}{if sender}{sender}: {end}{if agent}{agent} ▸ {end}{msg}",
    ], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    tail.stdout.pipe(pretty.stdin);
    pretty.on("exit", (code) => process.exit(code ?? 0));
    tail.on("exit", () => pretty.stdin.end());
  });
