import { Command } from "commander";
import { CronStore, parseScheduleString, unschedulableReason } from "../cron/store.js";
import { formatSchedule, formatRelative } from "../cron/format.js";
import { withCronStore } from "./cron-errors.js";

const store = new CronStore();

export const cronCommand = new Command("cron")
  .description("Manage scheduled tasks");

cronCommand
  .command("add")
  .description("Add a scheduled task")
  .requiredOption("--name <name>", "Job name")
  .requiredOption("--schedule <schedule>", 'Schedule: "in 20m", "every 1h", "0 9 * * *"')
  .requiredOption("--message <message>", "Message to send when triggered")
  .requiredOption("--session <key>", "Session key to deliver to (see 'Session key' in the agent system prompt)")
  .option("--once", "Delete after successful run (default: true for one-time 'at' schedules, false for recurring)")
  .action((opts) => withCronStore(() => {
    const schedule = parseScheduleString(opts.schedule);
    // Same refusal the MCP tool makes: a schedule with no future occurrence
    // would be stored enabled with `nextRunAt: null` and never fire, and
    // "Next run: never" under a "Created job" line is not a no.
    const unschedulable = unschedulableReason(schedule, Date.now());
    if (unschedulable) {
      console.error(`Cannot schedule "${opts.schedule}": ${unschedulable}, so the job could never fire.`);
      process.exit(1);
    }
    // Pass opts.once through as-is (undefined when not provided). The store
    // defaults deleteAfterRun=true for "at" schedules, false otherwise — so
    // one-time schedules ("in 20m", "2026-05-01", etc.) auto-clean after firing.
    const job = store.add({
      name: opts.name,
      schedule,
      message: opts.message,
      sessionKey: opts.session,
      deleteAfterRun: opts.once,
    });
    console.log(`Created job ${job.id}: "${job.name}"`);
    console.log(`  Schedule: ${formatSchedule(job.schedule)}`);
    console.log(`  Session:  ${job.sessionKey}`);
    console.log(`  Type:     ${job.deleteAfterRun ? "one-shot (auto-deletes after run)" : "recurring"}`);
    console.log(`  Next run: ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "never"}`);
  }));

cronCommand
  .command("list")
  .description("List all scheduled tasks")
  .action(() => withCronStore(() => {
    const jobs = store.list();
    if (jobs.length === 0) {
      console.log("No scheduled tasks.");
      return;
    }
    for (const job of jobs) {
      const status = job.enabled ? "enabled" : "disabled";
      const lifecycle = job.deleteAfterRun ? "once" : "recurring";
      const next = job.nextRunAt
        ? `${new Date(job.nextRunAt).toLocaleString()} (${formatRelative(job.nextRunAt)})`
        : "—";
      const last = job.lastRunAt
        ? `${new Date(job.lastRunAt).toLocaleString()} (${job.lastStatus})`
        : "never";
      console.log(`[${job.id}] ${job.name} (${status}, ${lifecycle})`);
      console.log(`  Schedule: ${formatSchedule(job.schedule)}`);
      console.log(`  Message:  ${job.message}`);
      console.log(`  Session:  ${job.sessionKey}`);
      console.log(`  Next run: ${next}`);
      console.log(`  Last run: ${last}`);
      console.log();
    }
  }));

cronCommand
  .command("remove <id>")
  .description("Remove a scheduled task")
  .action((id) => withCronStore(() => {
    if (store.remove(id)) {
      console.log(`Removed job ${id}`);
    } else {
      console.error(`Job ${id} not found`);
      process.exit(1);
    }
  }));

cronCommand
  .command("enable <id>")
  .description("Re-enable a disabled task (recomputes next run)")
  .action((id) => withCronStore(() => {
    const job = store.setEnabled(id, true);
    if (!job) {
      console.error(`Job ${id} not found`);
      process.exit(1);
    }
    const next = job.nextRunAt ? formatRelative(job.nextRunAt) : "never";
    console.log(`Enabled job ${job.id}: "${job.name}" — next run ${next}`);
  }));

cronCommand
  .command("disable <id>")
  .description("Disable a task without deleting it")
  .action((id) => withCronStore(() => {
    const job = store.setEnabled(id, false);
    if (!job) {
      console.error(`Job ${id} not found`);
      process.exit(1);
    }
    console.log(`Disabled job ${job.id}: "${job.name}"`);
  }));

cronCommand
  .command("run <id>")
  .description("Trigger a job immediately (for testing)")
  .action((id) => withCronStore(() => {
    const job = store.get(id);
    if (!job) {
      console.error(`Job ${id} not found`);
      process.exit(1);
    }
    console.log(`Would trigger: [${job.id}] ${job.name}`);
    console.log(`  Type:    ${job.deleteAfterRun ? "one-shot (auto-deletes after run)" : "recurring"}`);
    console.log(`  Message: ${job.message}`);
    console.log("(Use 'tomo start' to run jobs — this just previews)");
  }));
