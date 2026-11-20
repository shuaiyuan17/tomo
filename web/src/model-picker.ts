import type { WebModelView } from "../../src/web/protocol.js";
import { i18n } from "./i18n/index.js";

/** What the Study's Model page says when a switch is refused, by error code. */
const MODEL_ERRORS: Record<string, `model:error.${string}`> = {
  turn_in_flight: "model:error.turn_in_flight",
  model_changed: "model:error.model_changed",
  unknown_model: "model:error.unknown_model",
  gateway_required: "model:error.gateway_required",
  gateway_unroutable: "model:error.gateway_unroutable",
  owner_dm_only: "model:error.owner_dm_only",
  owner_setup_required: "model:error.owner_setup_required",
  epoch_changed: "model:error.epoch_changed",
  persist_failed: "model:error.persist_failed",
  session_not_found: "model:error.session_not_found",
  invalid_model_change: "model:error.invalid_model_change",
};

export function modelErrorText(code: string, agent: string): string {
  // i18n-dynamic: model:error.*
  return i18n.t((MODEL_ERRORS[code] ?? "model:error.other") as "model:error.other", { agent });
}

/** Codes after which the page re-reads the model before anything else. */
export function modelErrorRefreshes(code: string): boolean {
  return code === "model_changed" || code === "epoch_changed" || code === "session_not_found";
}

/**
 * What a typed model name stands for, as far as the page can tell: one of
 * the listed options (by alias or id), else the text itself (the server
 * resolves and validates it).
 */
export function pickTarget(view: Pick<WebModelView, "options">, input: string): { id: string; label: string } | null {
  const text = input.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const option = view.options.find((o) => o.id === text || o.aliases.includes(lower));
  return option ? { id: option.id, label: option.label } : { id: text, label: text };
}

/** The confirmation for a switch: names both models and when the new one applies. */
export function switchCopy(from: { id: string; label: string }, to: { id: string; label: string }): { title: string; body: string } {
  return {
    title: i18n.t("model:confirm.title", { to: to.label }),
    body: i18n.t("model:confirm.body", { from: from.label, to: to.label }),
  };
}

/** The Model page's effort line: the level the conversation starts with and where it comes from. */
export function effortText(effort: WebModelView["effort"]): string {
  switch (effort.source) {
    case "session": return i18n.t("model:effort.session", { level: effort.level ?? "" });
    case "global": return i18n.t("model:effort.global", { level: effort.level ?? "" });
    case "sdk-default": return i18n.t("model:effort.sdkDefault");
    case "not-supported": return i18n.t("model:effort.notSupported");
  }
}
