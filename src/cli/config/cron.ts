import * as p from "@clack/prompts";
import { CronStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import { formatSchedule, formatRelative } from "../../cron/format.js";

function statusHint(job: CronJob): string {
  if (!job.enabled) {
    if (job.lastStatus === "interrupted") return "disabled — last run interrupted by a restart";
    return job.lastStatus === "error" ? "disabled — last run failed" : "disabled";
  }
  const next = job.nextRunAt ? formatRelative(job.nextRunAt) : "never";
  const last = job.lastStatus ? ` · last: ${job.lastStatus}` : "";
  return `next: ${next}${last}`;
}

function describeJob(job: CronJob): string {
  const lines = [
    `Job: ${job.name} [${job.id}]`,
    `  Status:   ${job.enabled ? "enabled" : "disabled"} · ${job.deleteAfterRun ? "one-shot" : "recurring"}`,
    `  Schedule: ${formatSchedule(job.schedule)}`,
    `  Message:  ${job.message}`,
    `  Session:  ${job.sessionKey}`,
    `  Next run: ${job.nextRunAt ? `${new Date(job.nextRunAt).toLocaleString()} (${formatRelative(job.nextRunAt)})` : "never"}`,
    `  Last run: ${job.lastRunAt ? `${new Date(job.lastRunAt).toLocaleString()} (${job.lastStatus})` : "never"}`,
  ];
  if (job.retryCount) lines.push(`  Retries:  ${job.retryCount}`);
  return lines.join("\n");
}

export async function configCron(): Promise<void> {
  for (;;) {
    // Fresh store per pass: the daemon and `tomo cron` mutate the same
    // jobs.json, so re-read instead of browsing a startup-time snapshot.
    const store = new CronStore();
    const jobs = store.list();

    if (jobs.length === 0) {
      p.log.info("No scheduled tasks. Ask Tomo in chat, or use `tomo cron add`.");
      return;
    }

    const enabled = jobs.filter((j) => j.enabled).length;
    const failing = jobs.filter((j) => j.lastStatus === "error").length;
    p.log.info(
      `${jobs.length} scheduled task${jobs.length === 1 ? "" : "s"} — ${enabled} enabled` +
      (failing ? `, ${failing} failing` : ""),
    );

    const options: Array<{ value: string; label: string; hint?: string }> = jobs.map((j) => ({
      value: j.id,
      label: j.name,
      hint: statusHint(j),
    }));
    options.push({ value: "back", label: "Back" });

    const choice = await p.select({ message: "Scheduled tasks", options });
    if (p.isCancel(choice) || choice === "back") return;

    const job = store.get(choice as string);
    if (!job) continue;

    p.log.info(describeJob(job));

    const action = await p.select({
      message: `Manage "${job.name}"`,
      options: [
        job.enabled
          ? { value: "disable", label: "Disable", hint: "keep the job but stop it from running" }
          : { value: "enable", label: "Enable", hint: "recompute next run and resume" },
        { value: "remove", label: "Remove", hint: "delete the job permanently" },
        { value: "back", label: "Back" },
      ],
    });
    if (p.isCancel(action) || action === "back") continue;

    if (action === "enable" || action === "disable") {
      const updated = store.setEnabled(job.id, action === "enable");
      if (updated) {
        const next = updated.nextRunAt ? formatRelative(updated.nextRunAt) : "never";
        p.log.success(
          action === "enable"
            ? `"${updated.name}" enabled — next run ${next}`
            : `"${updated.name}" disabled`,
        );
      }
    }

    if (action === "remove") {
      const confirm = await p.confirm({ message: `Remove "${job.name}"? This cannot be undone.` });
      if (p.isCancel(confirm) || !confirm) continue;
      store.remove(job.id);
      p.log.success(`Removed "${job.name}"`);
    }
  }
}
