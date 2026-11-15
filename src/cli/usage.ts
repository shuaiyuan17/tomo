import { Command } from "commander";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { usageDataDir } from "../usage/dir.js";
import { BackfillError, backfillUsage, OVERCOUNTED_BEFORE, type BackfillReport } from "../usage/backfill.js";
import { systemTimeZone } from "../usage/local-time.js";
import { validTimeZone } from "../timezone.js";

export const usageCommand = new Command("usage")
  .description("Usage ledger tools (the Study Cost page's data)");

usageCommand
  .command("backfill")
  .description("Rebuild the usage history from before the ledger started, from the activity log (one-off; running it again rebuilds the same file)")
  .option("--dry-run", "Report what would be written; write nothing")
  .option("--logs-dir <dir>", "Where activity.ndjson* is", defaultRuntimePaths.logsDir)
  .option("--usage-dir <dir>", "The usage data directory", usageDataDir(defaultRuntimePaths.tomoHome))
  .option("--timezone <zone>", "IANA zone whose dates decide what is over-counted", systemTimeZone())
  .option("--force", "Write even when the activity log yields nothing, or under half of what is already backfilled")
  .option("--json", "Print the report as JSON")
  .action((opts: { dryRun?: boolean; logsDir: string; usageDir: string; timezone: string; json?: boolean; force?: boolean }) => {
    const timeZone = validTimeZone(opts.timezone);
    if (!timeZone) {
      console.error(`Not an IANA region zone: ${opts.timezone}`);
      process.exit(1);
    }
    let report: BackfillReport;
    try {
      report = backfillUsage({ logsDir: opts.logsDir, usageDir: opts.usageDir, timeZone, dryRun: !!opts.dryRun, force: !!opts.force });
    } catch (err) {
      if (!(err instanceof BackfillError)) throw err;
      console.error(err.message);
      process.exit(1);
    }
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatBackfillReport(report));
  });

export function formatBackfillReport(r: BackfillReport): string {
  return [
    r.dryRun ? "Dry run: nothing written." : "Backfill done: merged into backfill.ndjson.",
    `Activity files: ${r.activityFiles.length === 0 ? "none" : r.activityFiles.join(", ")}`,
    `Ledger started: ${new Date(r.ledgerStartedAt).toISOString()} (only turns before it are backfilled)`,
    `Turns found: ${r.found} (at or after the ledger's start, left to it: ${r.afterStart})`,
    `${r.dryRun ? "Would add" : "Added"}: ${r.added} rows to the ${r.existing} already there`,
    `backfill.ndjson: ${r.total} rows, ${r.days} days${r.firstDay ? ` (${r.firstDay} to ${r.lastDay})` : ""}, $${r.costUsd.toFixed(2)} est.`,
    `Over-counted days (before ${OVERCOUNTED_BEFORE}, flagged): ${r.overcountedDays}`,
  ].join("\n");
}
