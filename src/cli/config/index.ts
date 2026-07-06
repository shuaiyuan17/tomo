import { Command } from "commander";
import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import { printBanner } from "../banner.js";
import { isAutostartEnabled, isMacOS } from "../service.js";
import { getDaemonStatus } from "../status-info.js";
import { formatDuration } from "../../cron/format.js";
import { configIssues } from "../../config.js";
import { CONFIG_PATH } from "./shared.js";
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
    printBanner();
    p.intro("Tomo Configuration");

    if (!existsSync(CONFIG_PATH)) {
      p.log.error("No config found. Run `tomo init` first.");
      p.outro("");
      return;
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
      const options: Array<{ value: string; label: string; hint?: string }> = [
        { value: "auth", label: "Anthropic authentication", hint: "Claude subscription or API key" },
        { value: "model", label: "Model", hint: "set default model" },
        { value: "litellm", label: "LiteLLM gateway", hint: "ChatGPT subscription or custom proxy" },
        { value: "channels", label: "Channels", hint: "manage channel connections" },
        { value: "identities", label: "Identities", hint: "bind DMs across channels" },
        { value: "groups", label: "Group chats", hint: "activation secret" },
        { value: "sessions", label: "Sessions", hint: "view and configure sessions" },
        { value: "cron", label: "Scheduled tasks", hint: "cron job status" },
        { value: "costs", label: "Cost analysis", hint: "usage and spending breakdown" },
      ];
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
    }

    p.outro("Restart tomo for changes to take effect.");
  });
