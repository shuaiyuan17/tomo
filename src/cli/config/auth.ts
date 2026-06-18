import * as p from "@clack/prompts";
import { anthropicAuthLabel, parseAnthropicAuthConfig } from "../../auth.js";
import { loadConfig, saveConfig } from "./shared.js";

interface RawAuthConfig {
  method?: string;
  apiKey?: string;
}

export async function configAnthropicAuth(): Promise<void> {
  const cfg = loadConfig();
  const current = (cfg.auth ?? null) as RawAuthConfig | null;
  const resolved = parseAnthropicAuthConfig(current);
  const configuredApiKey = String(current?.apiKey ?? "").trim();

  p.log.info([
    `Method: ${anthropicAuthLabel(resolved.method)}`,
    `Source: ${resolved.apiKeySource === "environment" ? "ANTHROPIC_API_KEY" : resolved.apiKeySource === "config" ? "config.json" : "Claude Code login"}`,
    `Stored API key: ${configuredApiKey ? "(set)" : "(none)"}`,
  ].join("\n"));

  const action = await p.select({
    message: "Anthropic authentication",
    options: [
      {
        value: "subscription",
        label: "Claude subscription",
        hint: resolved.method === "subscription" ? "current" : "use Claude Code login",
      },
      {
        value: "api-key",
        label: "Anthropic API key",
        hint: resolved.method === "api-key" ? "current" : "pay-as-you-go API billing",
      },
      { value: "back", label: "Back" },
    ],
  });

  if (p.isCancel(action) || action === "back") return;

  if (action === "subscription") {
    cfg.auth = { method: "subscription" };
    saveConfig(cfg);
    p.log.success("Claude subscription authentication saved");
    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      p.log.warn("ANTHROPIC_API_KEY is set and overrides config.json until it is unset.");
    }
    return;
  }

  const apiKey = await p.password({
    message: configuredApiKey
      ? "Anthropic API key (leave blank to keep existing)"
      : "Anthropic API key",
    validate: (value) => {
      if (!String(value ?? "").trim() && !configuredApiKey) return "API key is required.";
      return undefined;
    },
  });
  if (p.isCancel(apiKey)) return;

  cfg.auth = {
    method: "api-key",
    apiKey: String(apiKey).trim() || configuredApiKey,
  };
  saveConfig(cfg);
  p.log.success("Anthropic API key authentication saved. Restart Tomo to use it.");
}
