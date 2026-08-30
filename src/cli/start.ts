import { Command } from "commander";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { acquirePidFile, readPidFileRecord, releasePidFile } from "./pidfile.js";
import { getRunningPid } from "./status-info.js";

const TOMO_HOME = defaultRuntimePaths.tomoHome;
const PID_FILE = defaultRuntimePaths.pidFile;

export const startCommand = new Command("start")
  .description("Start Tomo")
  .option("-f, --foreground", "Run in foreground (default: background)")
  .action(async (opts) => {
    // cli.ts runs commander's synchronous `parse()`, so a rejection of this
    // async action is an UNHANDLED rejection. Once the process error handlers
    // are installed that would be "log and continue" — a half-started daemon
    // (pid file held, one channel polling, no schedulers) running forever.
    // Startup failure is fatal; say so and exit through the fatal path.
    try {
      if (opts.foreground) await startForeground();
      else await startDaemon();
    } catch (err) {
      const { raiseFatal } = await import("../process-handlers.js");
      raiseFatal(err, "startup");
    }
  });

async function startForeground(): Promise<void> {
  // FIRST action, before any await: claim the pid file with O_EXCL. Refuse to
  // start if another tomo (manual daemon or launchd-managed) already owns it —
  // two tomos fight over Telegram polling, the `imsg rpc` child, the metrics
  // port and the session registry.
  //
  // This used to be a plain existsSync/kill(0) check here with the
  // `writeFileSync(PID_FILE, …)` all the way down at the end of startup. The
  // gap between them spanned config load, five mkdirs, a recursive skills
  // copy, channel construction and `await metricsExporter.start()`, so a login
  // autostart racing a manual `tomo start` put BOTH daemons past the check.
  const acquired = acquirePidFile(PID_FILE);
  if (!acquired.ok) {
    console.error(
      acquired.holder === null
        ? `Could not take the pid-file lock (${PID_FILE}.lock stayed busy). Another tomo process may be starting or stopping; refusing to start a second instance. Check \`tomo status\` and retry.`
        : `Tomo is already running (PID ${acquired.holder}). Refusing to start a second instance.`,
    );
    process.exit(1);
  }
  if (acquired.tookOverStale !== null) {
    console.error(`Removed a stale PID file left by PID ${acquired.tookOverStale} (no longer running); taking over.`);
  }
  // Release on every exit path, not just the signal handlers: the config
  // validation below can `process.exit(1)`, and leaving our own dead pid on
  // disk would make the next `tomo start` print a stale-takeover line for a
  // daemon that never started.
  process.on("exit", () => releasePidFile(PID_FILE));

  // Before the config and agent imports, but AFTER the synchronous pid-file
  // claim above (an await in front of the exclusion gate would re-open the
  // double-start window): a module-level throw or a rejected top-level import
  // in the block below happens before pino exists, and Node's default output
  // carries no marker. Upgraded to the real logger (and given the
  // inbound-salvage hook) a few lines down; installing twice is idempotent by
  // replacement.
  const { installBootstrapErrorHandlers, installProcessErrorHandlers } = await import("../process-handlers.js");
  installBootstrapErrorHandlers();

  // Validate config before loading the heavy daemon modules so a fresh
  // install fails with a clear message instead of a module-load crash.
  const {
    config, assertConfigValid, assertAuthConfigured, assertChannelsConfigured,
    ignoredEnvOverrideNames, ignoredEnvOverridesNotice,
  } = await import("../config.js");
  // An env override that is set but blank is ignored in favour of the config
  // file (config.ts envVar). Say so once, whichever way startup goes: nothing
  // else prints the effective model/token/gateway, so a mistyped
  // `CLAUDE_MODEL=$UNSET` is otherwise indistinguishable from a working
  // override — and on the failure path, "set TELEGRAM_BOT_TOKEN" makes no
  // sense to someone whose shell already has `TELEGRAM_BOT_TOKEN=` in it.
  const envNotice = ignoredEnvOverridesNotice();
  try {
    assertConfigValid();
    assertAuthConfigured();
    assertChannelsConfigured();
  } catch (err) {
    console.error((err as Error).message);
    if (envNotice) console.error(envNotice);
    process.exit(1);
  }

  const { Agent } = await import("../agent.js");
  const { log } = await import("../logger.js");
  if (envNotice) log.info({ vars: [...ignoredEnvOverrideNames] }, envNotice);

  // Upgrade the bootstrap handlers to pino, and give the exception path its
  // one salvage step. The hook is read through a mutable holder because the
  // handlers are installed before `agent` exists — a crash between here and
  // the assignment below simply has nothing to salvage yet.
  // See src/process-handlers.ts for why a rejection is survived and an
  // uncaught exception is not.
  let salvageInbound: (() => void) | null = null;
  installProcessErrorHandlers({ logger: log, beforeExit: () => salvageInbound?.() });
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

  // Drop restart requests that can no longer be honoured before any session
  // can observe one. A request outlives the daemon whenever the process went
  // away before its turn ended (which is the case a `tomo restart` request is
  // most likely to produce), and without this the directory only ever grows.
  const { sweepStaleRestartRequests } = await import("../restart-request.js");
  const sweptRestartRequests = sweepStaleRestartRequests();
  if (sweptRestartRequests > 0) {
    log.info({ count: sweptRestartRequests }, "Swept stale restart requests");
  }

  const agent = new Agent();
  // The messages this daemon accepted and would now never answer are recorded
  // in the transcript even on the crash path (#294).
  salvageInbound = () => agent.recordUnprocessedInboundOnCrash();

  const imageStoreBaseDir = config.saveInboundImages ? config.workspaceDir : undefined;
  // Separate gate from images: the any-MIME store is path-only — the bytes are
  // not attached to the message and are not sent to the API automatically, so
  // keeping it on costs disk while leaving the assistant free to open the path
  // deliberately. Defaults to the image setting in config.ts.
  // `undefined` is load-bearing: it is what turns the store OFF in the channel,
  // which no longer re-derives the value from `imageStoreBaseDir`.
  const fileStoreBaseDir = config.saveInboundFiles ? config.workspaceDir : undefined;

  if (config.telegramToken) {
    agent.addChannel(new TelegramChannel(config.telegramToken, { imageStoreBaseDir }));
  }

  if (config.imessageProvider === "imsg") {
    const { ImsgChannel } = await import("../channels/index.js");
    agent.addChannel(new ImsgChannel({
      cliPath: config.imsgCliPath,
      dbPath: config.imsgDbPath ?? undefined,
      imageStoreBaseDir,
      fileStoreBaseDir,
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

  // NB: the pid file was already written at the top of this function. Writing
  // it here (as this used to) is what allowed two daemons to start at once.

  const shutdown = async () => {
    activityLog?.stop();
    metricsExporter?.stop();
    watchServer.stop();
    versionChecker.stop();
    rollupRunner.stop();
    continuity.stop();
    petScheduler.stop();
    scheduler.stop();
    // `agent.stop()` bounds and swallows its own steps, but a throw escaping it
    // must still not strand the process: the daemon would sit there with a
    // stale PID file, holding the port and the imsg child, and `tomo restart`
    // would find a pid that never dies. Exit is the one thing that always
    // happens.
    try {
      await agent.stop();
    } catch (err) {
      log.error({ err }, "Agent shutdown failed; exiting anyway");
    }
    releasePidFile(PID_FILE);
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
  const { assertConfigValid, assertAuthConfigured, assertChannelsConfigured, ignoredEnvOverridesNotice } = await import("../config.js");
  try {
    assertConfigValid();
    assertAuthConfigured();
    assertChannelsConfigured();
  } catch (err) {
    console.error((err as Error).message);
    // Same explanation the foreground path gives: a blank override is the
    // likeliest reason "set X" reads as nonsense to someone who has `X=` set.
    const envNotice = ignoredEnvOverridesNotice();
    if (envNotice) console.error(envNotice);
    process.exit(1);
  }

  const logFile = join(TOMO_HOME, "logs", "tomo.log");
  const errFile = join(TOMO_HOME, "logs", "tomo.err");

  const { openSync } = await import("node:fs");
  const { mkdirSync: mkdirSyncFs } = await import("node:fs");
  mkdirSyncFs(join(TOMO_HOME, "logs"), { recursive: true });
  const errFd = openSync(errFile, "a");
  const { statSync } = await import("node:fs");
  let errSizeBefore = 0;
  try { errSizeBefore = statSync(errFile).size; } catch { /* fresh file */ }

  // Re-run ourselves in foreground mode as a detached child
  const child = spawn(process.execPath, [process.argv[1], "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", "ignore", errFd],
    env: {
      ...process.env,
      TOMO_LOG_FILE: logFile,
    },
  });

  // Do not report success on the strength of having spawned. The child's
  // first act is `acquirePidFile`, and it exits 1 if another daemon holds the
  // file — so two concurrent `tomo start`s used to both print "started" while
  // one child died with its message buried in tomo.err. Wait until the pid
  // file names this child, or the child is gone.
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", () => resolve(1));
  });
  const outcome = await awaitBackgroundClaim({ pidFile: PID_FILE, childPid: child.pid ?? -1, exited });
  child.unref();

  if (outcome.kind === "claimed") {
    console.log(`Tomo started in background (PID ${child.pid})`);
    console.log(`Logs: ${logFile}`);
    process.exit(0);
  }
  const { readFileSync } = await import("node:fs");
  let tail = "";
  try {
    tail = readFileSync(errFile, "utf-8").slice(errSizeBefore).trim();
  } catch { /* nothing to show */ }
  if (outcome.kind === "exited") {
    console.error(`Tomo exited during startup (code ${outcome.code ?? "?"}).${tail ? `\n${tail}` : ""}`);
    console.error(`Full output: ${errFile}`);
  } else {
    console.error(
      `Tomo (PID ${child.pid}) has not claimed the pid file after ${Math.round(outcome.waitedMs / 1000)}s; `
      + `cannot confirm it started. Check \`tomo status\` and ${errFile}.`,
    );
  }
  process.exit(1);
}

export type BackgroundClaimOutcome =
  | { kind: "claimed" }
  | { kind: "exited"; code: number | null }
  | { kind: "timeout"; waitedMs: number };

/**
 * Resolve once `pidFile` names `childPid`, the child has exited, or
 * `timeoutMs` passes — whichever is first. Exported for tests.
 */
export async function awaitBackgroundClaim(opts: {
  pidFile: string;
  childPid: number;
  exited: Promise<number | null>;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<BackgroundClaimOutcome> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 100;
  const started = Date.now();
  let exitCode: number | null | undefined;
  void opts.exited.then((code) => { exitCode = code; });
  for (;;) {
    if (readPidFileRecord(opts.pidFile)?.pid === opts.childPid) return { kind: "claimed" };
    // Let a settled `exited` land before judging; a child that exits 1 the
    // instant after our poll must be reported as exited, not as slow.
    await new Promise((r) => setTimeout(r, 0));
    if (exitCode !== undefined) {
      // One last look: the child may have claimed and been killed in the gap.
      if (readPidFileRecord(opts.pidFile)?.pid === opts.childPid) return { kind: "claimed" };
      return { kind: "exited", code: exitCode };
    }
    const waitedMs = Date.now() - started;
    if (waitedMs >= timeoutMs) return { kind: "timeout", waitedMs };
    await new Promise((r) => setTimeout(r, Math.min(pollMs, timeoutMs - waitedMs)));
  }
}
