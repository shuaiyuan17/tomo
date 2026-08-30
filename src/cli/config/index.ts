import { Command } from "commander";
import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import { printBanner } from "../banner.js";
import { isAutostartEnabled, isMacOS } from "../service.js";
import { getDaemonStatus } from "../status-info.js";
import { formatDuration } from "../../cron/format.js";
import { configIssues } from "../../config.js";
import { CONFIG_BACKUP_PATH, CONFIG_PATH, ConfigReadError, loadConfig } from "./shared.js";
import { configModel } from "./model.js";
import { configAutostart } from "./autostart.js";
import { configChannels } from "./channels.js";
import { configIdentities } from "./identities.js";
import { configGroups } from "./groups.js";
import { configSessions } from "./sessions.js";
import { configCron } from "./cron.js";
import { configCostAnalysis } from "./costs.js";
import { configLiteLlm } from "./litellm.js";
import { configAnthropicAuth } from "./auth.js";

export const configCommand = new Command("config")
  .description("Interactive configuration")
  .action(async () => {
    try {
      await runConfig();
    } catch (err) {
      if (!(err instanceof ConfigReadError)) throw err;
      // Backstop only. A ConfigReadError raised by a submenu is caught inside
      // the menu loop and returns the user to the menu (see runConfig); this
      // catches the ones raised outside it.
      p.log.error(`${describeReadFailure(err)}\n${fixHint()}`);
      p.outro("");
      process.exitCode = 1;
    }
  });

function describeReadFailure(err: ConfigReadError): string {
  const detail = err.cause instanceof Error ? err.cause.message : String(err.cause);
  return `Config at ${err.path} could not be read:\n  ${detail}`;
}

/**
 * A submenu hit an unreadable config. Report and return to the menu — do not
 * end the command.
 *
 * The message is worded to be true of both ways this happens, because the
 * caller cannot tell them apart and the common one is the less obvious one:
 * every `configXxx()` opens with `loadConfig()`, so the usual case is a load
 * failure at submenu open, where no save was ever attempted. The other is a
 * save refused mid-submenu. In both, this action wrote nothing, and in both,
 * earlier submenus in the same run may already have saved.
 */
function reportSubmenuReadFailure(err: ConfigReadError): void {
  p.log.error(
    `${describeReadFailure(err)}\n` +
    "This action wrote nothing. Any earlier changes in this session were " +
    "already saved.\n" +
    `${fixHint()}`,
  );
  process.exitCode = 1;
}

function fixHint(): string {
  return existsSync(CONFIG_BACKUP_PATH)
    ? `Fix it by hand, or restore the backup at ${CONFIG_BACKUP_PATH}.`
    : "Fix it by hand. (There is no backup to restore — Tomo only writes one " +
      "when it saves a config it could parse.)";
}

async function runConfig(): Promise<void> {
    printBanner();
    p.intro("Tomo Configuration");

    if (!existsSync(CONFIG_PATH)) {
      p.log.error("No config found. Run `tomo init` first.");
      p.outro("");
      return;
    }

    // Read the config once, up front. A parse failure does not end the
    // command — the submenus that never touch config.json are still useful,
    // and refusing to show cron status because of a trailing comma is its own
    // small outage. It does take every read-modify-write submenu off the menu,
    // because each of those is loadConfig() -> mutate one key -> saveConfig()
    // and would publish a config missing everything we could not read.
    let readError: ConfigReadError | null = null;
    try {
      loadConfig();
    } catch (err) {
      if (!(err instanceof ConfigReadError)) throw err;
      readError = err;
      p.log.error(
        `${describeReadFailure(err)}\n` +
        "Nothing has been written. Editing is disabled until this is fixed; " +
        "only the views that do not read config.json are available.\n" +
        `${fixHint()}`,
      );
      process.exitCode = 1;
    }

    const daemon = getDaemonStatus();
    if (daemon.pid) {
      const uptime = daemon.uptimeMs !== null ? `, up ${formatDuration(daemon.uptimeMs)}` : "";
      p.log.info(`Daemon: running (PID ${daemon.pid}${uptime})`);
    } else {
      p.log.warn("Daemon: not running — start it with `tomo start`.");
    }

    if (configIssues.length > 0) {
      p.log.warn(
        `Config has ${configIssues.length} issue${configIssues.length === 1 ? "" : "s"} — the daemon will refuse to start:\n` +
        configIssues.map((issue) => `  ✗ ${issue}`).join("\n"),
      );
    }

    for (;;) {
      // Everything that calls loadConfig()/saveConfig() is unavailable while
      // the file cannot be read. `sessions` is in this list rather than the
      // one below because it is not a view: it renders config-derived model
      // overrides and all three of its actions save. `tomo sessions` is the
      // read-only surface for that data and still works.
      const options: Array<{ value: string; label: string; hint?: string }> = readError ? [] : [
        { value: "auth", label: "Anthropic authentication", hint: "Claude subscription or API key" },
        { value: "model", label: "Model", hint: "set default model" },
        { value: "litellm", label: "LiteLLM gateway", hint: "ChatGPT subscription or custom proxy" },
        { value: "channels", label: "Channels", hint: "manage channel connections" },
        { value: "identities", label: "Identities", hint: "bind DMs across channels" },
        { value: "groups", label: "Group chats", hint: "activation secret" },
        { value: "sessions", label: "Sessions", hint: "view and configure sessions" },
      ];
      // These read no config at all, so an unparseable config.json cannot
      // affect them and they stay available.
      options.push(
        { value: "cron", label: "Scheduled tasks", hint: "cron job status" },
        { value: "costs", label: "Cost analysis", hint: "usage and spending breakdown" },
      );
      if (isMacOS()) {
        options.push({
          value: "autostart",
          label: "Autostart",
          hint: isAutostartEnabled() ? "enabled" : "disabled",
        });
      }
      options.push({ value: "exit", label: "Exit" });

      const choice = await p.select({
        message: "What would you like to configure?",
        options,
      });

      if (p.isCancel(choice) || choice === "exit") break;

      try {
        if (choice === "model") await configModel();
        if (choice === "auth") await configAnthropicAuth();
        if (choice === "litellm") await configLiteLlm();
        if (choice === "channels") await configChannels();
        if (choice === "identities") await configIdentities();
        if (choice === "groups") await configGroups();
        if (choice === "sessions") await configSessions();
        if (choice === "cron") await configCron();
        if (choice === "costs") await configCostAnalysis();
        if (choice === "autostart") await configAutostart();
      } catch (err) {
        if (!(err instanceof ConfigReadError)) throw err;
        // The config went bad underneath a running session. Report, remember
        // it so the next pass offers only the submenus that do not read the
        // file, and keep the menu alive rather than dumping the user out.
        reportSubmenuReadFailure(err);
        readError = err;
      }
    }

    p.outro(readError
      ? "Config was not modified. Fix the parse error, then run `tomo config` again."
      : "Restart tomo for changes to take effect.");
}
