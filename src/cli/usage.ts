import { Command } from "commander";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { usageDataDir } from "../usage/dir.js";
import { backfillUsage, OVERCOUNTED_BEFORE, type BackfillReport } from "../usage/backfill.js";
import { systemTimeZone } from "../usage/local-time.js";
import { validTimeZone } from "../timezone.js";

export const usageCommand = new Command("usage")
  .description("Usage ledger tools (the Study Cost page's data)");

usageCommand
  .command("backfill")
  .description("Rebuild the usage ledger's history from the activity log (one-off; running it again writes nothing new)")
  .option("--dry-run", "Report what would be written; write nothing")
  .option("--logs-dir <dir>", "Where activity.ndjson* is", defaultRuntimePaths.logsDir)
  .option("--usage-dir <dir>", "The usage data directory", usageDataDir(defaultRuntimePaths.tomoHome))
  .option("--timezone <zone>", "IANA zone whose dates decide what is over-counted", systemTimeZone())
  .option("--json", "Print the report as JSON")
  .action(async (opts: { dryRun?: boolean; logsDir: string; usageDir: string; timezone: string; json?: boolean }) => {
    const timeZone = validTimeZone(opts.timezone);
    if (!timeZone) {
      console.error(`Not an IANA region zone: ${opts.timezone}`);
      process.exit(1);
    }
    const report = await backfillUsage({ logsDir: opts.logsDir, usageDir: opts.usageDir, timeZone, dryRun: !!opts.dryRun });
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatBackfillReport(report));
  });

export function formatBackfillReport(r: BackfillReport): string {
  const lines = [
    r.dryRun ? "Dry run: nothing written." : "Backfill done.",
    `Activity files: ${r.activityFiles.length === 0 ? "none" : r.activityFiles.join(", ")}`,
    `Turns found: ${r.found} (already in the ledger: ${r.alreadyThere}; at or after the ledger's first live row: ${r.afterLedger})`,
    `${r.dryRun ? "Would write" : "Wrote"}: ${r.written} rows, ${r.days} days${r.firstDay ? ` (${r.firstDay} to ${r.lastDay})` : ""}, $${r.costUsd.toFixed(2)} est.`,
    `Over-counted days (before ${OVERCOUNTED_BEFORE}, flagged): ${r.overcountedDays}`,
  ];
  for (const [file, count] of Object.entries(r.byFile).sort()) lines.push(`  ${file}: ${count}`);
  if (r.ledgerStartsAt !== null) lines.push(`Ledger's first live row: ${new Date(r.ledgerStartsAt).toISOString()}`);
  return lines.join("\n");
}
