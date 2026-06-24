import * as p from "@clack/prompts";
import { SessionStore } from "../../sessions/store.js";
import { loadConfig, saveConfig, modelLabel, SESSIONS_DIR, SDK_SESSIONS_DIR } from "./shared.js";
import { promptForModel } from "./model-picker.js";

export async function configSessions(): Promise<void> {
  const store = new SessionStore(SESSIONS_DIR, 0, SDK_SESSIONS_DIR);
  const entries = store.listAllSessions().filter((e) => e.unlinkedAt === null);
  const cfg = loadConfig();
  const overrides = (cfg.sessionModelOverrides ?? {}) as Record<string, string>;

  if (entries.length === 0) {
    p.log.info("No active sessions.");
    return;
  }

  for (;;) {
    const options: Array<{ value: string; label: string; hint?: string }> = entries.map((e) => {
      const model = overrides[e.channelKey];
      const hint = model ? `model: ${modelLabel(model)}` : `queries: ${e.stats?.totalQueries ?? 0}`;
      return { value: e.channelKey, label: e.channelKey, hint };
    });
    options.push({ value: "back", label: "Back" });

    const choice = await p.select({ message: "Sessions", options });
    if (p.isCancel(choice) || choice === "back") break;

    const key = choice as string;
    const entry = entries.find((e) => e.channelKey === key);
    if (!entry) continue;

    const currentModel = overrides[key];
    const s = entry.stats;
    const pct = s && s.contextMax > 0 ? Math.round((s.contextUsed / s.contextMax) * 100) : 0;

    p.log.info([
      `Session: ${key}`,
      `  SDK ID:   ${entry.sdkSessionId}`,
      `  Queries:  ${s?.totalQueries ?? 0}`,
      `  Cost:     $${(s?.totalCostUsd ?? 0).toFixed(4)}`,
      `  Context:  ${s?.contextUsed ?? 0}/${s?.contextMax ?? 0} (${pct}%)`,
      `  Model:    ${currentModel ? modelLabel(currentModel) : "(default)"}`,
    ].join("\n"));

    const action = await p.select({
      message: `Configure ${key}`,
      options: [
        { value: "model", label: "Set model override", hint: currentModel ? modelLabel(currentModel) : "using default" },
        { value: "clear-model", label: "Clear model override" },
        { value: "clear-session", label: "Clear session (start fresh)" },
        { value: "back", label: "Back" },
      ],
    });
    if (p.isCancel(action) || action === "back") continue;

    if (action === "model") {
      const model = await promptForModel("Select model for this session", currentModel);
      if (!model) continue;
      overrides[key] = model;
      cfg.sessionModelOverrides = overrides;
      saveConfig(cfg);
      p.log.success(`Model for ${key} set to ${modelLabel(model)}`);
    }

    if (action === "clear-model") {
      delete overrides[key];
      cfg.sessionModelOverrides = overrides;
      saveConfig(cfg);
      p.log.success(`Model override cleared for ${key}`);
    }

    if (action === "clear-session") {
      const confirm = await p.confirm({ message: `Clear session "${key}"? This will start a new conversation.` });
      if (p.isCancel(confirm) || !confirm) continue;
      store.clearSdkSessionId(key);
      delete overrides[key];
      cfg.sessionModelOverrides = overrides;
      saveConfig(cfg);
      p.log.success(`Session "${key}" cleared`);
    }
  }
}
