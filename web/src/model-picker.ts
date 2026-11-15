import type { WebModelView } from "../../src/web/protocol.js";

/** What the Study's Model page says when a switch is refused, by error code. */
const MODEL_ERRORS: Record<string, string> = {
  turn_in_flight: "{agent} is in the middle of a reply. Try again once it has finished; nothing was changed.",
  model_changed: "The model changed since this page loaded. The page has been refreshed; review it and try again.",
  unknown_model: "That is not a model name {agent} recognises. Use an alias from the list or a full model id.",
  gateway_required: "That model needs a LiteLLM gateway. Set one up with tomo config first.",
  gateway_unroutable: "The configured ChatGPT subscription gateway only routes chatgpt/* models.",
  owner_dm_only: "Only your own conversation can be switched from the browser.",
  owner_setup_required: "No owner is configured yet.",
  epoch_changed: "{agent} restarted since this page loaded. The page has been refreshed; review it and try again.",
  persist_failed: "config.json could not be written, so the model is unchanged.",
  session_not_found: "That conversation is no longer available.",
  invalid_model_change: "That model name is too long or empty.",
};

export function modelErrorText(code: string, agent: string): string {
  return (MODEL_ERRORS[code] ?? "The switch could not be confirmed. Refresh and check the model before trying again.").replaceAll("{agent}", agent);
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
    title: `Switch to ${to.label}?`,
    body: `This conversation moves from ${from.label} to ${to.label}. It continues on the new model from the next message; the history is kept.`,
  };
}
