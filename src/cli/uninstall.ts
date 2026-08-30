import { Command } from "commander";
import { existsSync, unlinkSync } from "node:fs";
import * as p from "@clack/prompts";
import { printBanner } from "./banner.js";
import { disableAutostart, isAutostartEnabled, isMacOS } from "./service.js";
import { defaultRuntimePaths } from "../runtime-paths.js";
import { isRecordedProcessLive, readPidFileRecord } from "./pidfile.js";

const PID_FILE = defaultRuntimePaths.pidFile;

export const uninstallCommand = new Command("uninstall")
  .description("Stop Tomo and remove the login-item (keeps your data)")
  .action(async () => {
    printBanner();
    p.intro("Uninstall Tomo");

    p.note(
      [
        "This will:",
        "  • Stop Tomo if it's running",
        "  • Remove the login-item (if autostart is enabled)",
        "",
        "Your data in ~/.tomo/ will be kept. To also delete it,",
        "remove ~/.tomo/ manually after.",
      ].join("\n"),
      "What will happen",
    );

    const confirm = await p.confirm({
      message: "Continue?",
      initialValue: false,
    });
    if (p.isCancel(confirm) || !confirm) {
      p.cancel("Uninstall cancelled.");
      return;
    }

    if (isMacOS() && isAutostartEnabled()) {
      const s = p.spinner();
      s.start("Removing login-item");
      try {
        await disableAutostart();
        s.stop("Login-item removed");
      } catch (err) {
        s.stop("Could not remove login-item");
        p.log.warn((err as Error).message);
      }
    }

    stopPidfileTomo();

    p.note(
      [
        "Your data is preserved at ~/.tomo/",
        "",
        "To also remove the Tomo binary:",
        "  npm uninstall -g tomo-ai",
      ].join("\n"),
      "Done",
    );
    p.outro("Tomo uninstalled.");
  });

function stopPidfileTomo(): void {
  if (!existsSync(PID_FILE)) return;
  const s = p.spinner();
  s.start("Stopping Tomo");
  try {
    // See service.ts: parse the record, and only signal a pid that is still
    // the daemon we recorded.
    const record = readPidFileRecord(PID_FILE);
    if (record && isRecordedProcessLive(record)) {
      try { process.kill(record.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    s.stop("Tomo stopped");
  } catch {
    s.stop("Nothing to stop");
  }
}
