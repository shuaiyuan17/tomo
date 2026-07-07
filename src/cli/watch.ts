import { Command } from "commander";
import { join } from "node:path";
import { defaultRuntimePaths } from "../runtime-paths.js";

export const watchCommand = new Command("watch")
  .description("Live mission-control TUI — watch what Tomo is doing right now")
  .action(async () => {
    if (!process.stdout.isTTY) {
      console.error("tomo watch needs an interactive terminal.");
      process.exit(1);
    }
    // Lazy-load so ink/react never weigh down other CLI commands.
    const { runWatchTui } = await import("../watch/tui/index.js");
    await runWatchTui(
      defaultRuntimePaths.watchSocketPath,
      join(defaultRuntimePaths.logsDir, "tomo.log"),
    );
  });
