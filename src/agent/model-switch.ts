import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { config, CONFIG_BACKUP_PATH, CONFIG_PATH } from "../config.js";
import { withConfigLockSync } from "../config-file.js";
import { backupFileIfExistsSync, writeJsonAtomicSync } from "../fs-utils.js";
import { CHATGPT_SUBSCRIPTION_DEFAULT_MODEL, CHATGPT_SUBSCRIPTION_MODE, isChatGptSubscriptionModel } from "../litellm.js";
import { log } from "../logger.js";
import { MODEL_ALIASES, isLiteLlmProviderModel, modelLabel, resolveModelName } from "../models.js";
import type { WebModelView } from "../web/protocol.js";
import { effectiveEffort } from "./effort.js";

/**
 * One way to switch a session's model, shared by the `/model` chat command and
 * the web Study, so validation, persistence and the session restart cannot
 * drift between them:
 *
 *   resolve the name → check LiteLLM routing → persist
 *   `sessionModelOverrides[key]` to config.json under the config lock → update
 *   the in-memory override map → close the live session, so the next turn
 *   starts a fresh SDK child on the new model (the SDK session id is kept).
 *
 * Nothing is persisted or changed in memory when any step before the write
 * refuses, or when the write itself fails.
 */

export type ModelSwitchRefusal =
  /** Not an alias, a known id, a direct model id or a LiteLLM provider/model name. */
  | "unknown_model"
  /** A LiteLLM provider/model name, but no gateway is configured. */
  | "gateway_required"
  /** The configured ChatGPT-subscription gateway only routes chatgpt/* models. */
  | "gateway_unroutable"
  /** `expectedCurrent` was given and the session's model is no longer it. */
  | "model_changed"
  /** `hasTurnInFlight` was given and says a turn is running on the session. */
  | "turn_in_flight"
  /** config.json could not be read or written; the model is unchanged. */
  | "persist_failed";

export type ModelSwitchOutcome =
  | { ok: true; model: string; previous: string; changed: boolean }
  /** `model`: the resolved id, when the name resolved before the refusal. */
  | { ok: false; reason: ModelSwitchRefusal; model?: string };

export interface ModelSwitchDeps {
  /** Shared with the Agent — per-session model overrides read at session create time. */
  modelOverrides: Map<string, string>;
  closeLiveSession(key: string): void;
  /**
   * When given, a switch is refused (`turn_in_flight`) while this answers
   * true, instead of closing the session under a running turn. The chat
   * command does not pass it: `/model` keeps its long-standing behaviour.
   */
  hasTurnInFlight?(key: string): boolean;
}

export interface ModelSwitchOptions {
  /** The model the caller reviewed; a different current model refuses (`model_changed`). */
  expectedCurrent?: string;
  /** Switching to the model already in use is a no-op (`changed: false`): nothing is written or restarted. */
  unchangedIsNoop?: boolean;
}

/** The model a session key runs on: its override, else config.model. */
export function currentSessionModel(overrides: ReadonlyMap<string, string>, key: string): string {
  return overrides.get(key) ?? config.model;
}

/** Resolve and validate a model name against the configured gateway, without changing anything. */
export function validateModelChoice(input: string): { ok: true; model: string } | { ok: false; reason: "unknown_model" | "gateway_required" | "gateway_unroutable"; model?: string } {
  const resolved = resolveModelName(input);
  if (!resolved) return { ok: false, reason: "unknown_model" };
  if (isLiteLlmProviderModel(resolved)) {
    if (!config.litellm?.baseUrl) return { ok: false, reason: "gateway_required", model: resolved };
    if (config.litellm.mode === CHATGPT_SUBSCRIPTION_MODE && !isChatGptSubscriptionModel(resolved)) {
      return { ok: false, reason: "gateway_unroutable", model: resolved };
    }
  }
  return { ok: true, model: resolved };
}

export function switchSessionModel(deps: ModelSwitchDeps, key: string, input: string, options: ModelSwitchOptions = {}): ModelSwitchOutcome {
  const target = validateModelChoice(input);
  if (!target.ok) return target;
  const previous = currentSessionModel(deps.modelOverrides, key);
  if (options.expectedCurrent !== undefined && previous !== options.expectedCurrent) {
    return { ok: false, reason: "model_changed", model: target.model };
  }
  if (options.unchangedIsNoop && previous === target.model) {
    return { ok: true, model: target.model, previous, changed: false };
  }
  // Checked last, right before the synchronous write and close: no turn can
  // start in between on this (single) event loop.
  if (deps.hasTurnInFlight?.(key)) return { ok: false, reason: "turn_in_flight", model: target.model };
  if (!persistModelOverride(key, target.model)) return { ok: false, reason: "persist_failed", model: target.model };
  deps.modelOverrides.set(key, target.model);
  // Model changes require a fresh SDK child process, but keep the SDK
  // session ID so continuity survives switching between Claude and LiteLLM.
  // getOrCreateLiveSession repairs provider-specific JSONL quirks before
  // resuming.
  deps.closeLiveSession(key);
  return { ok: true, model: target.model, previous, changed: true };
}

/** The models a picker offers: each alias target once, in MODEL_ALIASES order, with every alias naming it. */
export function modelChoices(): Array<{ id: string; label: string; aliases: string[] }> {
  const choices = new Map<string, { id: string; label: string; aliases: string[] }>();
  for (const [alias, id] of Object.entries(MODEL_ALIASES)) {
    const choice = choices.get(id) ?? { id, label: modelLabel(id), aliases: [] };
    choice.aliases.push(alias);
    choices.set(id, choice);
  }
  return [...choices.values()];
}

/** What the web Study's Model page shows for a session key (no browser session id or write access: the caller adds those). */
export function describeSessionModel(overrides: ReadonlyMap<string, string>, key: string, busy: boolean): Omit<WebModelView, "sessionId" | "writable"> {
  const current = currentSessionModel(overrides, key);
  return {
    model: { id: current, label: modelLabel(current) },
    defaultModel: { id: config.model, label: modelLabel(config.model) },
    overridden: overrides.has(key),
    effort: effectiveEffort(config, key, current),
    busy,
    options: modelChoices(),
    gateway: {
      configured: !!config.litellm?.baseUrl,
      chatgptOnly: !!config.litellm?.baseUrl && config.litellm.mode === CHATGPT_SUBSCRIPTION_MODE,
      example: CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
    },
  };
}

/** Persist a model override into config.json. Returns false (after logging,
 *  leaving in-memory state untouched) if the file can't be read or written. */
export function persistModelOverride(key: string, model: string): boolean {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    // Shared config lock, re-read inside it (see saveConfig).
    withConfigLockSync(CONFIG_PATH, () => {
      const cfg = existsSync(CONFIG_PATH)
        ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>
        : {};
      const overrides = (cfg.sessionModelOverrides ?? {}) as Record<string, string>;
      overrides[key] = model;
      cfg.sessionModelOverrides = overrides;
      backupConfigFile();
      writeJsonAtomicSync(CONFIG_PATH, cfg, { mode: 0o600 });
    });
    config.sessionModelOverrides[key] = model;
    return true;
  } catch (err) {
    log.error({ err, key }, "Failed to persist model override");
    return false;
  }
}

/** Back up ~/.tomo/config.json before a programmatic rewrite. */
export function backupConfigFile(): void {
  mkdirSync(dirname(CONFIG_BACKUP_PATH), { recursive: true });
  backupFileIfExistsSync(CONFIG_PATH, CONFIG_BACKUP_PATH, { mode: 0o600 });
}
