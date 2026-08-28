import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimePaths } from "../runtime-paths.js";

const TOMO_HOME = defaultRuntimePaths.tomoHome;
const PID_FILE = defaultRuntimePaths.pidFile;

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
  // `imsg rpc` child, and the session registry.
  const existing = getRunningPid();
  if (existing) {
    console.error(`Tomo is already running (PID ${existing}). Refusing to start a second instance.`);
    process.exit(1);
  }

  // Validate config before loading the heavy daemon modules so a fresh
  // install fails with a clear message instead of a module-load crash.
  const { config, assertConfigValid, assertAuthConfigured, assertChannelsConfigured } = await import("../config.js");
  try {
    assertConfigValid();
    assertAuthConfigured();
    assertChannelsConfigured();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const { Agent } = await import("../agent.js");
  const { TelegramChannel } = await import("../channels/index.js");
  const { CronScheduler } = await import("../cron/scheduler.js");
  const { PetScheduler } = await import("../mcp/pet-scheduler.js");

  // Ensure directories exist (handles upgrades where new dirs were added)
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(config.workspaceDir, "tmp"), { recursive: true });
  mkdirSync(join(config.workspaceDir, "memory"), { recursive: true });
  mkdirSync(join(config.workspaceDir, "memory", "journal"), { recursive: true });
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
    const dest = join(config.workspaceDir, file);
    const src = join(defaultsDir, file);
    if (!fileExists(dest) && fileExists(src)) {
      copyFileSync(src, dest);
    }
  }

  // Sync tomo- skills (always overwrite to pick up updates)
  const { rmSync } = await import("node:fs");
  const defaultSkillsDir = join(defaultsDir, "skills");
  const targetSkillsDir = join(config.workspaceDir, ".claude", "skills");
  if (fileExists(defaultSkillsDir)) {
    mkdirSync(targetSkillsDir, { recursive: true });
    const expected = new Set<string>();
    for (const skill of readdirSync(defaultSkillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      expected.add(`tomo-${skill.name}`);
      const destDir = join(targetSkillsDir, `tomo-${skill.name}`);
      mkdirSync(destDir, { recursive: true });
      for (const file of readdirSync(join(defaultSkillsDir, skill.name))) {
        copyFileSync(join(defaultSkillsDir, skill.name, file), join(destDir, file));
      }
    }
    // Prune retired tomo- skills (built-ins removed in an upgrade). Only touch
    // `tomo-` directories — the prefix is reserved for built-ins; users are
    // told to avoid it for custom skills, which therefore stay untouched here.
    for (const entry of readdirSync(targetSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("tomo-")) continue;
      if (expected.has(entry.name)) continue;
      rmSync(join(targetSkillsDir, entry.name), { recursive: true, force: true });
    }
  }

  const agent = new Agent();

  const imageStoreBaseDir = config.saveInboundImages ? config.workspaceDir : undefined;

  if (config.telegramToken) {
    agent.addChannel(new TelegramChannel(config.telegramToken, { imageStoreBaseDir }));
  }

  if (config.imessageProvider === "imsg") {
    const { ImsgChannel } = await import("../channels/index.js");
    agent.addChannel(new ImsgChannel({
      cliPath: config.imsgCliPath,
      dbPath: config.imsgDbPath ?? undefined,
      imageStoreBaseDir,
      // Path kept verbatim from the pre-2026-08-27 BlueBubbles channel: chat.db
      // message GUIDs were identical across both backends, so the store carried
      // over the cutover and messages already dispatched were not re-dispatched.
      // Do not rename it — old installs still have GUIDs in this file.
      dedupeStorePath: join(config.tomoHome, "data", "imessage", "seen-message-guids.json"),
      cursorStorePath: join(config.tomoHome, "data", "imessage", "imsg-watch-cursor.json"),
    }));
  }

  const { CronStore } = await import("../cron/store.js");
  const cronStore = new CronStore();
  const scheduler = new CronScheduler(agent, cronStore);
  const petScheduler = new PetScheduler(agent);

  // Start continuity runner if enabled
  const { ContinuityRunner } = await import("../continuity.js");
  const continuity = new ContinuityRunner(agent, config.city, config.continuityScript, {
    intervalMs: config.continuityIntervalMs,
  });
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

  // Watch server: event socket for the `tomo watch` TUI. The daemon never
  // depends on clients — see src/watch/server.ts.
  const { WatchServer } = await import("../watch/server.js");
  const { buildWatchSnapshot } = await import("../watch/snapshot.js");
  const { getCurrentVersion } = await import("../version.js");
  const daemonStartedAt = Date.now();
  const watchServer = new WatchServer(defaultRuntimePaths.watchSocketPath, {
    getSnapshot: () => buildWatchSnapshot({
      startedAt: daemonStartedAt,
      version: getCurrentVersion(),
      model: config.model,
      overview: () => agent.watchOverview(),
      cronJobs: () => cronStore.list(),
      nextHeartbeatAt: () => continuity.nextFireAt(),
    }),
    sendChat: (text) => agent.handleWatchChat(text),
  });

  // Metrics exporter + activity log: two more watch-bus subscribers, for
  // Prometheus scrapes and Loki tailing. Off unless config.metrics.enabled.
  const { MetricsExporter } = await import("../metrics/exporter.js");
  const { ActivityLog } = await import("../metrics/activity-log.js");
  let metricsExporter: InstanceType<typeof MetricsExporter> | null = null;
  let activityLog: InstanceType<typeof ActivityLog> | null = null;
  if (config.metrics.enabled) {
    metricsExporter = new MetricsExporter({
      version: getCurrentVersion(),
      model: config.model,
      collectors: {
        cronJobs: () => cronStore.list(),
        nextHeartbeatAt: () => continuity.nextFireAt(),
      },
    });
    await metricsExporter.start(config.metrics.port);
    if (config.metrics.activityLog) {
      activityLog = new ActivityLog({
        path: join(config.logsDir, "activity.ndjson"),
        includeMessageText: config.metrics.includeMessageText,
      });
      activityLog.start();
    }
  }

  // Write PID so `tomo stop` can find us
  writeFileSync(PID_FILE, String(process.pid));

  const shutdown = async () => {
    activityLog?.stop();
    metricsExporter?.stop();
    watchServer.stop();
    versionChecker.stop();
    rollupRunner.stop();
    continuity.stop();
    petScheduler.stop();
    scheduler.stop();
    await agent.stop();
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await agent.start();
  scheduler.start();
  petScheduler.start();
  watchServer.start();
}

async function startDaemon(): Promise<void> {
  const existing = getRunningPid();
  if (existing) {
    console.log(`Tomo is already running (PID ${existing})`);
    process.exit(1);
  }

  // Validate config before spawning: the detached child would die instantly
  // with this error buried in tomo.err while we print "started in background".
  const { assertConfigValid, assertAuthConfigured, assertChannelsConfigured } = await import("../config.js");
  try {
    assertConfigValid();
    assertAuthConfigured();
    assertChannelsConfigured();
  } catch (err) {
    console.error((err as Error).message);
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
