import { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESTART_REASON_FILE } from "../config.js";
import { TOMO_SESSION_KEY_ENV, resolveRestartInitiator, writeRestartReasonFile } from "../restart-reason.js";
import { spawn } from "node:child_process";
import { isAutostartEnabled, restartAutostart, stopLaunchdJob } from "./service.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { isRunning, getRunningPid } from "./status-info.js";

const TOMO_HOME = defaultRuntimePaths.tomoHome;
const LOG_FILE = join(defaultRuntimePaths.logsDir, "tomo.log");

export const stopCommand = new Command("stop")
  .description("Stop Tomo daemon")
  .action(async () => {
    if (isAutostartEnabled()) {
      try {
        await stopLaunchdJob();
        console.log("Stopped Tomo (will restart at next login — use `tomo config` to disable autostart).");
      } catch (err) {
        console.error(`Failed to stop LaunchAgent: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }

    const pid = getRunningPid();
    if (!pid) {
      console.log("Tomo is not running.");
      return;
    }
    process.kill(pid, "SIGTERM");
    console.log(`Stopped Tomo (PID ${pid})`);
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
