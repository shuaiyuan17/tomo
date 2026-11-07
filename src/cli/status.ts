import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isAutostartEnabled } from "./service.js";
import { getDaemonStatus } from "./status-info.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { SessionStore } from "../sessions/store.js";
import { CronStore } from "../cron/store.js";
import { readCronJobsSafely } from "./cron-errors.js";
import type { CronJob } from "../cron/types.js";
import { formatDuration, formatRelative } from "../cron/format.js";
import { connect } from "node:net";
import { readWebStatus, type WebStatusRecord } from "../web/status-file.js";

export interface StatusReport {
  version: string;
  daemon: { pid: number | null; uptimeMs: number | null; autostart: boolean };
  configIssues: readonly string[];
  channels: Array<{ name: string; configured: boolean }>;
  /**
   * The web UI. `listening` is a live TCP probe of the port, so it is right
   * even when the supervisor's record is missing or stale; `record` is that
   * record, kept only when the running daemon wrote it. Absent when disabled.
   */
  web?: { port: number; listening: boolean | null; record: WebStatusRecord | null };
  sessions: Array<{ key: string; contextPct: number; queries: number; costUsd: number }>;
  cron: {
    total: number;
    enabled: number;
    failing: number;
    upcoming: Array<{ name: string; nextRunAt: number }>;
    /**
     * Set when jobs.json exists but could not be read. The counts are then
     * zero because nothing could be counted — which is NOT the same as a
     * store with no jobs, so it is reported separately.
     */
    unreadable?: string;
};
}

const MAX_SESSIONS_SHOWN = 5;
const MAX_UPCOMING_SHOWN = 3;

export async function gatherStatus(): Promise<StatusReport> {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf-8"),
  ) as { version: string };
  const { config, configIssues, imessageConfigured } = await import("../config.js");

  const daemon = getDaemonStatus();

  const store = new SessionStore(defaultRuntimePaths.sessionsDir, 0, defaultRuntimePaths.sdkSessionsDir);
  const sessions = store
    .listAllSessions()
    .filter((e) => e.unlinkedAt === null)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((e) => ({
      key: e.channelKey,
      contextPct: e.stats && e.stats.contextMax > 0
        ? Math.round((e.stats.contextUsed / e.stats.contextMax) * 100)
        : 0,
      queries: e.stats?.totalQueries ?? 0,
      costUsd: e.stats?.totalCostUsd ?? 0,
    }));

  // An unreadable jobs file degrades this one section instead of taking the
  // whole report down — daemon state, config issues and channels are exactly
  // what someone runs `tomo status` for when something is broken. It is still
  // never reported as "no scheduled tasks": that lie is what this PR is about.
  const { jobs, unreadablePath } = readCronJobsSafely(new CronStore());

  let web: StatusReport["web"];
  if (config.web?.enabled) {
    const stored = readWebStatus(config.tomoHome);
    const record = stored && daemon.pid !== null && stored.daemonPid === daemon.pid ? stored : null;
    const port = record?.port ?? config.web.port;
    web = { port, listening: daemon.pid === null ? null : await probePort(port), record };
  }
  const upcoming = jobs
    .filter((j): j is CronJob & { nextRunAt: number } => j.enabled && j.nextRunAt !== null)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
    .map((j) => ({ name: j.name, nextRunAt: j.nextRunAt }));

  return {
    version: pkg.version,
    daemon: { ...daemon, autostart: isAutostartEnabled() },
    configIssues,
    channels: [
      { name: "telegram", configured: Boolean(config.telegramToken) },
      { name: "imessage", configured: imessageConfigured(config) },
    ],
    ...(web ? { web } : {}),
    sessions,
    cron: {
      ...(unreadablePath ? { unreadable: unreadablePath } : {}),
      total: jobs.length,
      enabled: jobs.filter((j) => j.enabled).length,
      failing: jobs.filter((j) => j.lastStatus === "error").length,
      upcoming,
    },
  };
}

export function renderStatusReport(r: StatusReport, now = Date.now()): string {
  const lines: string[] = [];

  const autostart = r.daemon.autostart ? " [autostart]" : "";
  if (r.daemon.pid) {
    const uptime = r.daemon.uptimeMs !== null ? `, up ${formatDuration(r.daemon.uptimeMs)}` : "";
    lines.push(`Tomo v${r.version} — running (PID ${r.daemon.pid}${uptime})${autostart}`);
  } else {
    const note = r.daemon.autostart ? " — autostart is enabled, it will start at next login" : "";
    lines.push(`Tomo v${r.version} — not running${note}`);
  }

  if (r.configIssues.length > 0) {
    lines.push("");
    lines.push(`Config: ${r.configIssues.length} issue${r.configIssues.length === 1 ? "" : "s"} (daemon will refuse to start)`);
    for (const issue of r.configIssues) lines.push(`  ✗ ${issue}`);
  }

  lines.push("");
  lines.push("Channels:");
  for (const c of r.channels) {
    lines.push(`  ${c.name.padEnd(10)} ${c.configured ? "configured" : "not configured"}`);
  }

  if (r.web) lines.push(`  ${"web".padEnd(10)} ${renderWeb(r.web, now)}`);

  lines.push("");
  if (r.sessions.length === 0) {
    lines.push("Sessions: none");
  } else {
    lines.push(`Sessions (${r.sessions.length} active):`);
    const width = Math.max(...r.sessions.slice(0, MAX_SESSIONS_SHOWN).map((s) => s.key.length));
    for (const s of r.sessions.slice(0, MAX_SESSIONS_SHOWN)) {
      lines.push(`  ${s.key.padEnd(width)}   ctx ${String(s.contextPct).padStart(3)}% · ${s.queries} queries · $${s.costUsd.toFixed(4)}`);
    }
    if (r.sessions.length > MAX_SESSIONS_SHOWN) {
      lines.push(`  …and ${r.sessions.length - MAX_SESSIONS_SHOWN} more`);
    }
  }

  lines.push("");
  if (r.cron.unreadable) {
    lines.push(`Scheduled tasks: store unreadable (${r.cron.unreadable})`);
    lines.push("  fix or remove the file; the daemon recreates it empty");
  } else if (r.cron.total === 0) {
    lines.push("Scheduled tasks: none");
  } else {
    const failing = r.cron.failing ? `, ${r.cron.failing} failing` : "";
    lines.push(`Scheduled tasks (${r.cron.total} — ${r.cron.enabled} enabled${failing}):`);
    const shown = r.cron.upcoming.slice(0, MAX_UPCOMING_SHOWN);
    const width = shown.length ? Math.max(...shown.map((j) => j.name.length)) : 0;
    for (const j of shown) {
      lines.push(`  ${j.name.padEnd(width)}   ${formatRelative(j.nextRunAt, now)}`);
    }
    if (r.cron.upcoming.length === 0) {
      lines.push("  no upcoming runs");
    }
  }

  return lines.join("\n");
}

/** Can something on this machine accept a TCP connection on the port? */
export function probePort(port: number, host = "127.0.0.1", timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function renderWeb(web: NonNullable<StatusReport["web"]>, now: number): string {
  if (web.listening === null) return `daemon not running (port ${web.port})`;
  if (web.listening) return `listening on 127.0.0.1:${web.port}`;
  const rec = web.record;
  const detail: string[] = [];
  if (rec && rec.restarts > 0) detail.push(`${rec.restarts} consecutive failed start${rec.restarts === 1 ? "" : "s"}`);
  if (rec?.lastError) detail.push(`last: ${rec.lastError}`);
  const suffix = detail.length ? ` (${detail.join("; ")})` : "";
  if (rec?.state === "starting") return `starting on port ${web.port}${suffix}`;
  if (rec?.state === "backoff" && rec.nextRetryAt !== null) {
    return `DOWN — retrying ${formatRelative(rec.nextRetryAt, now)}${suffix}`;
  }
  if (rec?.state === "failed") return `DOWN — gave up${suffix}`;
  return `DOWN — nothing listening on port ${web.port}${suffix}`;
}

export const statusCommand = new Command("status")
  .description("Show Tomo status: daemon, config, channels, web UI, sessions, scheduled tasks")
  .action(async () => {
    console.log(renderStatusReport(await gatherStatus()));
  });
