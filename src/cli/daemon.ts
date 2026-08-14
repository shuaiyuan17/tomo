import { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESTART_REASON_FILE } from "../config.js";
import { TOMO_SESSION_KEY_ENV, resolveRestartInitiator, writeRestartReasonFile } from "../restart-reason.js";
import { createRestartRequest, formatRestartRequestResult } from "../restart-request.js";
import { spawn } from "node:child_process";
import { isAutostartEnabled, restartAutostart, stopLaunchdJob } from "./service.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import {
  isPidAlive,
  isRecordedProcessLive,
  getRunningPidRecord,
  waitForExit,
  DAEMON_STOP_TIMEOUT_MS,
} from "./status-info.js";
import type { PidFileRecord } from "./pidfile.js";

const TOMO_HOME = defaultRuntimePaths.tomoHome;
const LOG_FILE = join(defaultRuntimePaths.logsDir, "tomo.log");
export function shouldScheduleRestart(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env[TOMO_SESSION_KEY_ENV]?.trim());
}

export interface StopDeps {
  autostartEnabled: () => boolean;
  stopLaunchd: () => Promise<void>;
  /** The live pid-file record, or null. Reaps a stale file as a side effect. */
  runningRecord: () => PidFileRecord | null;
  alive: (pid: number) => boolean;
  /** Full identity check — is the RECORDED process still the one on that pid? */
  recordLive: (record: PidFileRecord) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  wait: (pid: number, timeoutMs: number) => Promise<boolean>;
  timeoutMs: number;
}

export interface StopOutcome {
  /** Process exit code the CLI should use. Non-zero means nothing was stopped. */
  code: number;
  message: string;
}

/**
 * `tomo stop`, as a pure-ish function so it can be tested without a process
 * exit. Every dependency is REQUIRED: an earlier draft took
 * `Partial<StopDeps>` and spread it over real defaults, so one forgotten key
 * in a future test would have quietly booted out the developer's actual
 * LaunchAgent. Tests must state the whole world they are running in.
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
export async function performStopWith(deps: StopDeps): Promise<StopOutcome> {
  const autostart = deps.autostartEnabled();
  // Read the pid BEFORE the bootout: launchd may reap the process, and a pid
  // read afterwards would be null and indistinguishable from "not running".
  const record = deps.runningRecord();

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

  if (record === null) {
    return { code: 0, message: `Tomo is not running.${autostart ? " (LaunchAgent unloaded; it will restart at next login.)" : ""}` };
  }
  const pid = record.pid;

  // The bootout above may already have taken it down — and, since that was
  // an await, the pid may by now belong to someone else. Confirm the recorded
  // identity immediately before signalling, not just before the bootout:
  // SIGTERMing a stranger who inherited a recycled pid is worse than doing
  // nothing. Either way, wait for the pid to actually disappear.
  const stopped = { code: 0, message: `Stopped Tomo (PID ${pid})${autostartNote}.` };
  if (deps.alive(pid)) {
    // Identity changed under us: the daemon is gone and the pid is someone
    // else's. Nothing to signal, and nothing to wait 60s for either.
    if (!deps.recordLive(record)) return stopped;
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
      /* raced away between the liveness check and the signal — the wait below settles it */
    }
  }

  if (await deps.wait(pid, deps.timeoutMs)) return stopped;

  // The pid is alive, but is it still OUR daemon? The poll is deliberately
  // cheap (`kill(pid, 0)`), so a daemon that exited and had its pid recycled
  // by an unrelated process looks identical to one that is wedged. Confirm
  // once, here, rather than 600 times during the poll.
  if (!deps.recordLive(record)) return stopped;

  return {
    code: 1,
    message:
      `Tomo (PID ${pid}) is still running ${Math.round(deps.timeoutMs / 1000)}s after SIGTERM. `
      + `It may be finishing an in-flight turn — check \`tomo logs -f\`. `
      + `To force it: kill -9 ${pid}`,
  };
}

/** Real-world wiring for {@link performStopWith}. */
export function performStop(): Promise<StopOutcome> {
  return performStopWith({
    autostartEnabled: isAutostartEnabled,
    stopLaunchd: stopLaunchdJob,
    runningRecord: () => getRunningPidRecord(),
    alive: isPidAlive,
    recordLive: isRecordedProcessLive,
    kill: (pid, signal) => { process.kill(pid, signal); },
    wait: (pid, timeoutMs) => waitForExit(pid, timeoutMs),
    timeoutMs: DAEMON_STOP_TIMEOUT_MS,
  });
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
    if (shouldScheduleRestart()) {
      const sessionKey = resolveRestartInitiator(opts.session);
      if (!sessionKey) throw new Error("Cannot schedule restart: session key is unavailable.");
      const request = createRestartRequest(sessionKey, opts.reason);
      console.log(formatRestartRequestResult(request));
      return;
    }

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

    const record = getRunningPidRecord();
    if (record) {
      const pid = record.pid;
      process.kill(pid, "SIGTERM");
      console.log(`Stopping Tomo (PID ${pid})…`);
      // Bounded, on the same budget as `tomo stop` and the LaunchAgent
      // restart. This was `while (isRunning(pid)) await sleep(300)` with no
      // deadline and no output: SIGTERM landing mid-turn against a hung SDK
      // query left `tomo restart` sitting at a blank prompt indefinitely.
      if (!await waitForExit(pid, DAEMON_STOP_TIMEOUT_MS) && isRecordedProcessLive(record)) {
        console.error(
          `Tomo (PID ${pid}) is still running ${Math.round(DAEMON_STOP_TIMEOUT_MS / 1000)}s after SIGTERM; `
          + `not starting a second daemon. Check \`tomo logs -f\`, or force it with: kill -9 ${pid}`,
        );
        process.exit(1);
      }
      console.log(`Stopped Tomo (PID ${pid})`);
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
    const pid = getRunningPidRecord()?.pid ?? null;
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
