import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, MODEL_ALIASES, PICKER_MODELS, resolveModelName } from "../src/models.js";
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
  it("maps short names to full model IDs", () => {
    // 5.5 family, 1M by default: [1m] ids where the SDK has a [1m] alias
    // (sonnet/opus/fable); the bundled binary handles the tag in its model
    // lookup. Haiku 5.5 is natively 1M and has no [1m] alias.
    expect(MODEL_ALIASES["opus"]).toBe("claude-opus-5-5[1m]");
    expect(MODEL_ALIASES["opus-1m"]).toBe("claude-opus-5-5[1m]");
    expect(MODEL_ALIASES["sonnet"]).toBe("claude-sonnet-5-5[1m]");
    expect(MODEL_ALIASES["sonnet-1m"]).toBe("claude-sonnet-5-5[1m]");
    expect(MODEL_ALIASES["haiku"]).toBe("claude-haiku-5-5");
    expect(MODEL_ALIASES["fable"]).toBe("claude-fable-5-1[1m]");
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5[1m]");
  });

  it("does not have unknown model keys", () => {
    expect(Object.keys(MODEL_ALIASES)).toEqual(["opus", "opus-1m", "sonnet", "sonnet-1m", "haiku", "fable"]);
  });

  it("pickers offer only the 5.5 family plus Fable 5.1, 1M by default, default first", () => {
    expect(PICKER_MODELS.map((m) => m.id)).toEqual(["claude-opus-5-5[1m]", "claude-sonnet-5-5[1m]", "claude-haiku-5-5", "claude-fable-5-1[1m]"]);
    expect(PICKER_MODELS.some((m) => /-4-|claude-(opus|sonnet)-5(\[|$)/.test(m.id))).toBe(false);
  });

  it("still accepts older explicit ids, so existing configs keep working", () => {
    for (const id of ["claude-sonnet-5[1m]", "claude-opus-5[1m]", "claude-opus-4-8[1m]", "claude-haiku-4-5", "claude-opus-5-5[1m]"]) {
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
