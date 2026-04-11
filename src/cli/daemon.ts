import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { isAutostartEnabled, restartAutostart, stopLaunchdJob } from "./service.js";

const TOMO_HOME = join(homedir(), ".tomo");
const PID_FILE = join(TOMO_HOME, "tomo.pid");
const LOG_FILE = join(TOMO_HOME, "logs", "tomo.log");

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getRunningPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
  if (isNaN(pid) || !isRunning(pid)) {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return null;
  }
  return pid;
}

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

export const restartCommand = new Command("restart")
  .description("Restart Tomo daemon")
  .action(async () => {
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

export const statusCommand = new Command("status")
  .description("Show Tomo status")
  .action(() => {
    const autostart = isAutostartEnabled();
    const pid = getRunningPid();

    if (!pid) {
      console.log("Tomo is not running.");
      if (autostart) {
        console.log("Autostart is enabled — it will start at next login.");
      }
      return;
    }

    let uptime = "";
    if (existsSync(PID_FILE)) {
      const started = statSync(PID_FILE).mtimeMs;
      const ms = Date.now() - started;
      const hours = Math.floor(ms / 3_600_000);
      const mins = Math.floor((ms % 3_600_000) / 60_000);
      uptime = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    const mode = autostart ? " [autostart]" : "";
    console.log(`Tomo is running (PID ${pid}, uptime: ${uptime})${mode}`);
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
    const pretty = spawn("npx", ["pino-pretty", "--ignore", "pid,hostname", "--translateTime", "SYS:HH:MM:ss"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    tail.stdout.pipe(pretty.stdin);
    pretty.on("exit", (code) => process.exit(code ?? 0));
    tail.on("exit", () => pretty.stdin.end());
  });
