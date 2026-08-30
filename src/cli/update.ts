import { Command } from "commander";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { getCurrentVersion, fetchLatestVersion } from "../version.js";

const execFileAsync = promisify(execFile);

export const updateCommand = new Command("update")
  .description("Update Tomo to the latest version and restart")
  .action(async () => {
    const current = getCurrentVersion();
    console.log(`Current version: v${current}`);
    console.log("Checking for updates...");

    const latest = await fetchLatestVersion();
    if (!latest) {
      console.error("Failed to check npm registry. Please try again later.");
      process.exit(1);
    }

    if (latest === current) {
      console.log(`Already on the latest version (v${current}).`);
      return;
    }

    console.log(`New version available: v${latest}`);
    console.log("Updating...");

    try {
      const { stdout, stderr } = await execFileAsync("npm", ["install", "-g", "tomo-ai@latest"], {
        timeout: 120_000,
      });
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.error(stderr.trim());
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      console.error(`Update failed: ${e.stderr || e.message}`);
      process.exit(1);
    }

    console.log(`Updated to v${latest}. Restarting...`);

    const child = spawnPostUpdateRestart(current, latest);
    child.on("exit", (code) => process.exit(code ?? 0));
  });

/**
 * Re-exec the CLI to restart the daemon, passing the update reason as ONE argv
 * entry.
 *
 * This used to run `spawn("tomo", [...], { shell: true })`. With `shell: true`
 * Node joins the file and every argument with spaces and hands the result to
 * `sh -c` UNQUOTED, so the reason was word-split by the shell: commander saw
 * `--reason Updated` plus four stray positionals (which it accepts silently),
 * and every post-update restart told the agent the reason was `Updated`. It
 * also made the registry-supplied `latest` a shell metacharacter sink.
 *
 * `process.execPath` + `process.argv[1]` is how `daemon.ts` already re-execs
 * the CLI; the PATH lookup is only a fallback for the case where argv[1] is
 * missing.
 */
export function spawnPostUpdateRestart(
  current: string,
  latest: string,
  spawnFn: typeof spawn = spawn,
): ReturnType<typeof spawn> {
  const reason = `Updated from v${current} to v${latest}`;
  const cli = process.argv[1];
  return cli
    ? spawnFn(process.execPath, [cli, "restart", "--reason", reason], { stdio: "inherit" })
    : spawnFn("tomo", ["restart", "--reason", reason], { stdio: "inherit" });
}
