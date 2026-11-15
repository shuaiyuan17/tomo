import { describe, expect, it } from "vitest";
import { cleanSuggestion, sdkSignalOf } from "../src/agent/sdk-signals.js";

describe("sdkSignalOf", () => {
  it("reads nothing from content, unknown or malformed events", () => {
    for (const event of [null, "x", {}, { type: "assistant", message: { content: [] } }, { type: "system", subtype: "status" },
      { type: "system", subtype: "api_retry" }, { type: "rate_limit_event" }, { type: "rate_limit_event", rate_limit_info: { status: "weird" } },
      { type: "tool_progress", tool_use_id: "t", tool_name: "Bash" }, { type: "prompt_suggestion", suggestion: "   " }]) {
      expect(sdkSignalOf(event)).toBeUndefined();
    }
  });

  it("never reads a subagent's event as the owner's turn", () => {
    expect(sdkSignalOf({ type: "assistant", error: "overloaded", parent_tool_use_id: "agent-1" })).toBeUndefined();
    expect(sdkSignalOf({ type: "system", subtype: "model_refusal_fallback", scope: "local", original_model: "a", fallback_model: "b" })).toBeUndefined();
  });

  it("names a typed API error, and an unrecognised one as unknown", () => {
    expect(sdkSignalOf({ type: "assistant", error: "billing_error", parent_tool_use_id: null })).toEqual({ kind: "error", error: "billing_error" });
    expect(sdkSignalOf({ type: "assistant", error: "something_new" })).toEqual({ kind: "error", error: "unknown" });
    expect(sdkSignalOf({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, retry_delay_ms: -5, error_status: null, error: "odd" }))
      .toEqual({ kind: "retry", attempt: 1, maxRetries: 3, delayMs: 0, error: "unknown" });
  });

  it("reads a refusal with and without a fallback model", () => {
    expect(sdkSignalOf({ type: "system", subtype: "model_refusal_fallback", scope: "session", original_model: "claude-fable-5-1",
      fallback_model: "claude-opus-5-5", api_refusal_category: "cyber" }))
      .toEqual({ kind: "refusal", model: "claude-fable-5-1", fallbackModel: "claude-opus-5-5", category: "cyber" });
    expect(sdkSignalOf({ type: "system", subtype: "model_refusal_no_fallback", original_model: "claude-fable-5-1", api_refusal_category: null }))
      .toEqual({ kind: "refusal", model: "claude-fable-5-1" });
  });

  it("normalises rate-limit times to ms and utilisation to a percentage", () => {
    expect(sdkSignalOf({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_800_000_000, utilization: 1, isUsingOverage: true } }))
      .toEqual({ kind: "rate_limit", status: "rejected", limit: "seven_day", resetsAt: 1_800_000_000_000, utilization: 100, overage: true });
    expect(sdkSignalOf({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1_800_000_000_000, utilization: 42 } }))
      .toEqual({ kind: "rate_limit", status: "allowed", resetsAt: 1_800_000_000_000, utilization: 42 });
  });
});

describe("sdkSignalOf: compaction status", () => {
  it("reads the SDK's compacting status for the home, and its end", () => {
    expect(sdkSignalOf({ type: "system", subtype: "status", status: "compacting" })).toEqual({ kind: "compacting", active: true });
    expect(sdkSignalOf({ type: "system", subtype: "status", status: null, compact_result: "success" })).toEqual({ kind: "compacting", active: false });
    expect(sdkSignalOf({ type: "system", subtype: "status", status: "requesting" })).toBeUndefined();
    expect(sdkSignalOf({ type: "system", subtype: "status" })).toBeUndefined();
  });
});

describe("cleanSuggestion", () => {
  it("drops the inbound stamp a predicted prompt can imitate, and bounds the text", () => {
    expect(cleanSuggestion("[imessage · Wed 09/02 20:50 PDT] what about Friday?")).toBe("what about Friday?");
    expect(cleanSuggestion("  run the\n tests  ")).toBe("run the tests");
    expect(cleanSuggestion("[web · now]")).toBeUndefined();
    expect(cleanSuggestion(42)).toBeUndefined();
    expect(cleanSuggestion("x".repeat(900))).toHaveLength(300);
  });
});
