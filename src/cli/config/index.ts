import { Command } from "commander";
import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import { printBanner } from "../banner.js";
import { isAutostartEnabled, isMacOS } from "../service.js";
import { CONFIG_PATH } from "./shared.js";
import { configModel } from "./model.js";
import { configAutostart } from "./autostart.js";
import { configChannels } from "./channels.js";
import { configIdentities } from "./identities.js";
import { configGroups } from "./groups.js";
import { configSessions } from "./sessions.js";
import { configCostAnalysis } from "./costs.js";
import { configLiteLlm } from "./litellm.js";

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

    for (;;) {
      const options: Array<{ value: string; label: string; hint?: string }> = [
        { value: "model", label: "Model", hint: "set default model" },
        { value: "litellm", label: "LiteLLM gateway", hint: "ChatGPT subscription or custom proxy" },
        { value: "channels", label: "Channels", hint: "manage channel connections" },
        { value: "identities", label: "Identities", hint: "bind DMs across channels" },
        { value: "groups", label: "Group chats", hint: "activation secret" },
        { value: "sessions", label: "Sessions", hint: "view and configure sessions" },
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
      if (choice === "litellm") await configLiteLlm();
      if (choice === "channels") await configChannels();
      if (choice === "identities") await configIdentities();
      if (choice === "groups") await configGroups();
      if (choice === "sessions") await configSessions();
      if (choice === "costs") await configCostAnalysis();
      if (choice === "autostart") await configAutostart();
    }

    p.outro("Restart tomo for changes to take effect.");
  });
