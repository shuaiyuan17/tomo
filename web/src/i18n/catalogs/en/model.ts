/** The Study's Model page. */
export const model = {
  error: {
    turn_in_flight: "{{agent}} is in the middle of a reply. Try again once it has finished; nothing was changed.",
    model_changed: "The model changed since this page loaded. The page has been refreshed; review it and try again.",
    unknown_model: "That is not a model name {{agent}} recognises. Use an alias from the list or a full model id.",
    gateway_required: "That model needs a LiteLLM gateway. Set one up with tomo config first.",
    gateway_unroutable: "The configured ChatGPT subscription gateway only routes chatgpt/* models.",
    owner_dm_only: "Only your own conversation can be switched from the browser.",
    owner_setup_required: "No owner is configured yet.",
    epoch_changed: "{{agent}} restarted since this page loaded. The page has been refreshed; review it and try again.",
    persist_failed: "config.json could not be written, so the model is unchanged.",
    session_not_found: "That conversation is no longer available.",
    invalid_model_change: "That model name is too long or empty.",
    other: "The switch could not be confirmed. Refresh and check the model before trying again.",
  },
  confirm: {
    title: "Switch to {{to}}?",
    body: "This conversation moves from {{from}} to {{to}}. It continues on the new model from the next message; the history is kept.",
  },
  effort: {
    session: "{{level}}, chosen for this conversation (sessionEffortOverrides).", global: "{{level}}, the default from config.json.",
    sdkDefault: "not set; the model's own default applies.", notSupported: "not sent; this model does not take an effort setting.",
  },
  current: "Model · {{title}}", overridden: "Chosen for this conversation. Without that choice it would use the default, {{model}}.",
  default: "The default from config.json.",
  effortTitle: "What tomo asks for. The model may run lower if it does not support this level.", effortLine: "Requested effort: {{effort}}",
  busy: "{{agent}} is replying right now. A switch can be made once the reply has finished.",
  readOnly: "Groups are read-only here. To change a group's model, send /model in that group.",
  offline: "Switching is available while connected.",
  switched: "Switched from {{from}} to {{to}}. The next message runs on it.", unchanged: "Already on {{model}}; nothing changed.",
  from: "From", to: "To", switching: "Switching…", switch: "Switch model", options: "Models", active: "Active",
  other: "Another model", otherPlaceholder: "Model id, e.g. claude-opus-4-8", switchOther: "Switch…",
  gateway: {
    chatgptOnly: "The LiteLLM gateway routes chatgpt/* models only, e.g. {{example}}.",
    litellm: "LiteLLM provider/model names are accepted too, e.g. {{example}}.",
    none: "Any direct Claude model id is accepted; it is checked before anything is saved.",
  },
} as const;
