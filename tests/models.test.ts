import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, MODEL_ALIASES, PICKER_MODELS, modelLabel, normalizeModelId, resolveModelName, sameModel } from "../src/models.js";
import {
  CHATGPT_SUBSCRIPTION_DEFAULT_MODEL,
  inferLiteLlmMode,
  isChatGptSubscriptionModel,
  liteLlmModeLabel,
  parseLiteLlmMode,
} from "../src/litellm.js";

// Model names: the aliases and pickers (src/models.ts) and the LiteLLM
// gateway modes they can route through (src/litellm.ts).

describe("model resolution", () => {
  it("maps short names to full model IDs, with no [1m] tag", () => {
    // All natively 1M (SDK 0.3.332 registry: native_1m), so the tag is gone.
    expect(MODEL_ALIASES["opus"]).toBe("claude-opus-5-5");
    expect(MODEL_ALIASES["opus-1m"]).toBe("claude-opus-5-5");
    expect(MODEL_ALIASES["sonnet"]).toBe("claude-sonnet-5-5");
    expect(MODEL_ALIASES["sonnet-1m"]).toBe("claude-sonnet-5-5");
    expect(MODEL_ALIASES["haiku"]).toBe("claude-haiku-5-5");
    expect(MODEL_ALIASES["fable"]).toBe("claude-fable-5-2");
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(Object.values(MODEL_ALIASES).some((id) => id.includes("["))).toBe(false);
  });

  it("resolves fable to Fable 5.2", () => {
    expect(resolveModelName("fable")).toBe("claude-fable-5-2");
    expect(resolveModelName("FABLE")).toBe("claude-fable-5-2");
  });

  it("does not have unknown model keys", () => {
    expect(Object.keys(MODEL_ALIASES)).toEqual(["opus", "opus-1m", "sonnet", "sonnet-1m", "haiku", "fable"]);
  });

  it("pickers offer only the 5.5 family plus Fable 5.2, untagged, default first", () => {
    expect(PICKER_MODELS.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]);
    expect(PICKER_MODELS.some((m) => /-4-|claude-(opus|sonnet)-5(\[|$)|\[/.test(m.id))).toBe(false);
  });

  it("accepts a tagged id of a natively 1M model and returns it untagged", () => {
    expect(resolveModelName("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(resolveModelName("claude-sonnet-5-5[1m]")).toBe("claude-sonnet-5-5");
    expect(resolveModelName("claude-fable-5-1[1m]")).toBe("claude-fable-5-1");
    expect(resolveModelName("claude-fable-5-2[1M]")).toBe("claude-fable-5-2");
    expect(normalizeModelId("claude-haiku-5-5[1m]")).toBe("claude-haiku-5-5");
    expect(sameModel("claude-opus-5-5[1m]", "claude-opus-5-5")).toBe(true);
    expect(sameModel("claude-opus-5-5", "claude-sonnet-5-5")).toBe(false);
  });

  it("labels tagged and untagged ids alike, Fable 5.1 as older", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5 (default)");
    expect(modelLabel("claude-opus-5-5[1m]")).toBe("Opus 5.5 (default)");
    expect(modelLabel("claude-fable-5-2")).toMatch(/^Fable 5\.2/);
    expect(modelLabel("claude-fable-5-1[1m]")).toBe("Fable 5.1 (older)");
    expect(modelLabel("claude-sonnet-5[1m]")).toBe("Sonnet 5 1M");
    expect(modelLabel("future-model")).toBe("future-model");
  });

  it("still accepts older explicit ids as is, so existing configs keep working", () => {
    // A tag on a model that was not natively 1M is meaningful and kept.
    for (const id of ["claude-sonnet-5[1m]", "claude-opus-5[1m]", "claude-opus-4-8[1m]", "claude-haiku-4-5", "claude-fable-5-1"]) {
      expect(resolveModelName(id)).toBe(id);
    }
  });

  it("accepts LiteLLM provider/model names", () => {
    expect(resolveModelName(CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe(CHATGPT_SUBSCRIPTION_DEFAULT_MODEL);
    expect(resolveModelName("openrouter/openai/gpt-4o-mini")).toBe("openrouter/openai/gpt-4o-mini");
  });

  it("accepts arbitrary direct model IDs", () => {
    expect(resolveModelName("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resolveModelName("claude-sonnet-5[1m]")).toBe("claude-sonnet-5[1m]");
    expect(resolveModelName("claude-sonnet-5-1")).toBe("claude-sonnet-5-1");
    expect(resolveModelName("future-model-20270101")).toBe("future-model-20270101");
  });

  it("rejects unsafe model names", () => {
    expect(resolveModelName("claude sonnet 5")).toBeNull();
    expect(resolveModelName("../claude-sonnet-5")).toBeNull();
  });
});

describe("LiteLLM helpers", () => {
  it("defaults to a generic Anthropic-compatible proxy mode", () => {
    expect(parseLiteLlmMode(undefined)).toBe("anthropic-compatible");
    expect(parseLiteLlmMode("custom")).toBe("anthropic-compatible");
    expect(liteLlmModeLabel("anthropic-compatible")).toBe("Anthropic-compatible proxy");
  });

  it("accepts aliases for ChatGPT subscription mode", () => {
    expect(parseLiteLlmMode("chatgpt")).toBe("chatgpt-subscription");
    expect(parseLiteLlmMode("openai-subscription")).toBe("chatgpt-subscription");
    expect(liteLlmModeLabel("chatgpt-subscription")).toBe("ChatGPT subscription");
  });

  it("infers ChatGPT subscription mode for old chatgpt/* gateway configs", () => {
    expect(inferLiteLlmMode(undefined, CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe("chatgpt-subscription");
    expect(inferLiteLlmMode(undefined, "claude-sonnet-5[1m]")).toBe("anthropic-compatible");
    expect(inferLiteLlmMode("anthropic-compatible", CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe("anthropic-compatible");
  });

  it("detects ChatGPT subscription model names", () => {
    expect(isChatGptSubscriptionModel(CHATGPT_SUBSCRIPTION_DEFAULT_MODEL)).toBe(true);
    expect(isChatGptSubscriptionModel("openrouter/openai/gpt-4o-mini")).toBe(false);
  });
});
