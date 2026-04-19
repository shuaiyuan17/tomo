import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TOMO_HOME = join(homedir(), ".tomo");
const PID_FILE = join(TOMO_HOME, "tomo.pid");

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
    unlinkSync(PID_FILE);
    return null;
  }
  return pid;
}

export const startCommand = new Command("start")
  .description("Start Tomo")
  .option("-f, --foreground", "Run in foreground (default: background)")
  .action(async (opts) => {
    if (opts.foreground) {
      return startForeground();
    }
    return startDaemon();
  });

async function startForeground(): Promise<void> {
  // Refuse to start if another tomo (manual daemon or launchd-managed) already
  // owns the pidfile. Prevents two tomos fighting over Telegram polling, the
  // BlueBubbles webhook port, and the session registry.
  const existing = getRunningPid();
  if (existing) {
    console.error(`Tomo is already running (PID ${existing}). Refusing to start a second instance.`);
    process.exit(1);
  }

  const { Agent } = await import("../agent.js");
  const { TelegramChannel } = await import("../channels/index.js");
  const { config } = await import("../config.js");
  const { CronScheduler } = await import("../cron/scheduler.js");

  // Ensure directories exist (handles upgrades where new dirs were added)
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(TOMO_HOME, "workspace", "tmp"), { recursive: true });
  mkdirSync(join(TOMO_HOME, "workspace", "memory"), { recursive: true });
  mkdirSync(join(TOMO_HOME, "workspace", "memory", "journal"), { recursive: true });
  mkdirSync(join(TOMO_HOME, "data", "cron"), { recursive: true });
  mkdirSync(join(TOMO_HOME, "logs"), { recursive: true });

  // Sync defaults on startup (handles upgrades)
  const { copyFileSync, existsSync: fileExists, readdirSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { dirname: dirnameFn } = await import("node:path");
  const { fileURLToPath: fileUrlFn } = await import("node:url");
  const __dirname = dirnameFn(fileUrlFn(import.meta.url));
  const defaultsDir = resolve(__dirname, "../../defaults");

  // Copy missing workspace files (CONTINUITY.md, etc.)
  for (const file of ["CONTINUITY.md"]) {
    const dest = join(TOMO_HOME, "workspace", file);
    const src = join(defaultsDir, file);
    if (!fileExists(dest) && fileExists(src)) {
      copyFileSync(src, dest);
    }
  }

  // Sync tomo- skills (always overwrite to pick up updates)
  const defaultSkillsDir = join(defaultsDir, "skills");
  const targetSkillsDir = join(TOMO_HOME, "workspace", ".claude", "skills");
  if (fileExists(defaultSkillsDir)) {
    mkdirSync(targetSkillsDir, { recursive: true });
    for (const skill of readdirSync(defaultSkillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const destDir = join(targetSkillsDir, `tomo-${skill.name}`);
      mkdirSync(destDir, { recursive: true });
      for (const file of readdirSync(join(defaultSkillsDir, skill.name))) {
        copyFileSync(join(defaultSkillsDir, skill.name, file), join(destDir, file));
      }
    }
  }

  const agent = new Agent();

  const imageStoreBaseDir = config.saveInboundImages ? config.workspaceDir : undefined;

  if (config.telegramToken) {
    agent.addChannel(new TelegramChannel(config.telegramToken, { imageStoreBaseDir }));
  }

  if (config.imessageUrl) {
    const { BlueBubblesChannel } = await import("../channels/index.js");
    agent.addChannel(new BlueBubblesChannel({
      url: config.imessageUrl,
      password: config.imessagePassword,
      webhookPort: config.imessageWebhookPort,
      imageStoreBaseDir,
    }));
  }

  const scheduler = new CronScheduler(agent);

  // Start continuity runner if enabled
  const { ContinuityRunner } = await import("../continuity.js");
  const continuity = new ContinuityRunner(agent, config.city);
  if (config.continuity) {
    continuity.start();
  }

  // Start version checker (weekly check, daytime-only notification)
  const { VersionChecker } = await import("../version.js");
  const versionChecker = new VersionChecker(agent);
  versionChecker.start();

  // Start LCM rollup runner (hourly check for due daily/weekly/monthly/yearly promotions)
  const { RollupRunner } = await import("../lcm/runner.js");
  const rollupRunner = new RollupRunner(agent);
  rollupRunner.start();

  // Write PID so `tomo stop` can find us
  writeFileSync(PID_FILE, String(process.pid));

  const shutdown = async () => {
    versionChecker.stop();
    rollupRunner.stop();
    continuity.stop();
    scheduler.stop();
    await agent.stop();
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await agent.start();
  scheduler.start();
}

async function startDaemon(): Promise<void> {
  const existing = getRunningPid();
  if (existing) {
    console.log(`Tomo is already running (PID ${existing})`);
    process.exit(1);
  }

  const logFile = join(TOMO_HOME, "logs", "tomo.log");
  const errFile = join(TOMO_HOME, "logs", "tomo.err");

  const { openSync } = await import("node:fs");
  const { mkdirSync: mkdirSyncFs } = await import("node:fs");
  mkdirSyncFs(join(TOMO_HOME, "logs"), { recursive: true });
  const errFd = openSync(errFile, "a");

  // Re-run ourselves in foreground mode as a detached child
  const child = spawn(process.execPath, [process.argv[1], "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", "ignore", errFd],
    env: {
      ...process.env,
      TOMO_LOG_FILE: logFile,
    },
  });

  child.unref();
  console.log(`Tomo started in background (PID ${child.pid})`);
  console.log(`Logs: ${logFile}`);
  process.exit(0);
}
