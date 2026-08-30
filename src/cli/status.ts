import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isAutostartEnabled } from "./service.js";
import { getDaemonStatus } from "./status-info.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { SessionStore } from "../sessions/store.js";
import { CronStore } from "../cron/store.js";
import { withCronStore } from "./cron-errors.js";
import type { CronJob } from "../cron/types.js";
import { formatDuration, formatRelative } from "../cron/format.js";

export interface StatusReport {
  version: string;
  daemon: { pid: number | null; uptimeMs: number | null; autostart: boolean };
  configIssues: readonly string[];
  channels: Array<{ name: string; configured: boolean }>;
  sessions: Array<{ key: string; contextPct: number; queries: number; costUsd: number }>;
  cron: {
    total: number;
    enabled: number;
    failing: number;
    upcoming: Array<{ name: string; nextRunAt: number }>;
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

  // An unreadable jobs file exits non-zero rather than reporting zero tasks:
  // "no scheduled tasks" and "could not look" must not print the same.
  const jobs = withCronStore(() => new CronStore().list());
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
    sessions,
    cron: {
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
  if (r.cron.total === 0) {
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

export const statusCommand = new Command("status")
  .description("Show Tomo status: daemon, config, channels, sessions, scheduled tasks")
  .action(async () => {
    console.log(renderStatusReport(await gatherStatus()));
  });
