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

    const child = spawn("tomo", ["restart", "--reason", `Updated from v${current} to v${latest}`], {
      stdio: "inherit",
      shell: true,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });
