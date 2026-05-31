import * as p from "@clack/prompts";
import { loadConfig, saveConfig } from "./shared.js";

interface RawLiteLlmConfig {
  baseUrl?: string;
  apiKey?: string;
}

export async function configLiteLlm(): Promise<void> {
  const cfg = loadConfig();
  const current = (cfg.litellm ?? null) as RawLiteLlmConfig | null;

  p.log.info([
    `Status:  ${current?.baseUrl ? "enabled" : "disabled"}`,
    `Base URL: ${current?.baseUrl ?? "(none)"}`,
    `API key:  ${current?.apiKey ? "(set)" : "(none)"}`,
  ].join("\n"));

  const action = await p.select({
    message: "LiteLLM gateway",
    options: [
      { value: "edit", label: current?.baseUrl ? "Edit gateway" : "Enable gateway" },
      { value: "disable", label: "Disable gateway" },
      { value: "back", label: "Back" },
    ],
  });

  if (p.isCancel(action) || action === "back") return;

  if (action === "disable") {
    delete cfg.litellm;
    saveConfig(cfg);
    p.log.success("LiteLLM gateway disabled");
    return;
  }

  const baseUrl = await p.text({
    message: "LiteLLM proxy base URL",
    placeholder: "http://localhost:4000",
    defaultValue: current?.baseUrl ?? "http://localhost:4000",
    validate: (value) => {
      const text = String(value ?? "").trim();
      if (!text) return "Base URL is required.";
      if (!/^https?:\/\//i.test(text)) return "Use an http:// or https:// URL.";
      return undefined;
    },
  });
  if (p.isCancel(baseUrl)) return;

  const apiKey = await p.password({
    message: current?.apiKey
      ? "LiteLLM proxy API key (leave blank to keep existing)"
      : "LiteLLM proxy API key (default: sk-tomo-local)",
  });
  if (p.isCancel(apiKey)) return;

  const nextKey = String(apiKey).trim() || current?.apiKey || "sk-tomo-local";
  cfg.litellm = {
    baseUrl: String(baseUrl).trim(),
    apiKey: nextKey,
  };
  saveConfig(cfg);
  p.log.success("LiteLLM gateway saved. Restart tomo for the daemon to use it.");
}
