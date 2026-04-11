import { Command } from "commander";
import { CronStore, parseScheduleString } from "../cron/store.js";

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
  .option("--once", "Delete after successful run", false)
  .action((opts) => {
    const schedule = parseScheduleString(opts.schedule);
    const job = store.add({
      name: opts.name,
      schedule,
      message: opts.message,
      sessionKey: opts.session,
      deleteAfterRun: opts.once ?? (schedule.kind === "at"),
    });
    console.log(`Created job ${job.id}: "${job.name}"`);
    console.log(`  Schedule: ${formatSchedule(job.schedule)}`);
    console.log(`  Session:  ${job.sessionKey}`);
    console.log(`  Next run: ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "never"}`);
  });

cronCommand
  .command("list")
  .description("List all scheduled tasks")
  .action(() => {
    const jobs = store.list();
    if (jobs.length === 0) {
      console.log("No scheduled tasks.");
      return;
    }
    for (const job of jobs) {
      const status = job.enabled ? "enabled" : "disabled";
      const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—";
      const last = job.lastRunAt
        ? `${new Date(job.lastRunAt).toLocaleString()} (${job.lastStatus})`
        : "never";
      console.log(`[${job.id}] ${job.name} (${status})`);
      console.log(`  Schedule: ${formatSchedule(job.schedule)}`);
      console.log(`  Message:  ${job.message}`);
      console.log(`  Session:  ${job.sessionKey}`);
      console.log(`  Next run: ${next}`);
      console.log(`  Last run: ${last}`);
      console.log();
    }
  });

cronCommand
  .command("remove <id>")
  .description("Remove a scheduled task")
  .action((id) => {
    if (store.remove(id)) {
      console.log(`Removed job ${id}`);
    } else {
      console.error(`Job ${id} not found`);
      process.exit(1);
    }
  });

cronCommand
  .command("run <id>")
  .description("Trigger a job immediately (for testing)")
  .action((id) => {
    const job = store.get(id);
    if (!job) {
      console.error(`Job ${id} not found`);
      process.exit(1);
    }
    console.log(`Would trigger: [${job.id}] ${job.name}`);
    console.log(`Message: ${job.message}`);
    console.log("(Use 'tomo start' to run jobs — this just previews)");
  });

function formatSchedule(s: { kind: string; at?: string; everyMs?: number; expr?: string; tz?: string }): string {
  switch (s.kind) {
    case "at": return `once at ${s.at}`;
    case "every": return `every ${(s.everyMs! / 60_000).toFixed(0)}m`;
    case "cron": return `${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
    default: return JSON.stringify(s);
  }
}
