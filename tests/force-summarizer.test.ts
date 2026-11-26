import { describe, expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => {
    calls.push(args);
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "the summary", total_cost_usd: 0.42, duration_ms: 1200, num_turns: 1,
        usage: { input_tokens: 150_000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    })();
  },
}));
vi.mock("../src/agent/sdk-options.js", () => ({ buildSdkEnv: () => ({ PATH: "/bin" }) }));
vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const { sdkForceSummarizer, summaryModels } = await import("../src/lcm/force-summarizer.js");
const { resolveModelName } = await import("../src/models.js");
const { forceSummaryLedgerRow } = await import("../src/usage/ledger.js");

describe("force summarizer", () => {
  it("is a clean one-turn call, and reports what it cost for the usage ledger", async () => {
    const onUsage = vi.fn();
    const text = await sdkForceSummarizer({ model: "sonnet", onUsage })({ from: "a", to: "b", events: 3, label: "whole day x", text: "conversation" });
    expect(text).toBe("the summary");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      costUsd: 0.42, subtype: "success", tokens: { input: 150_000, output: 900, cacheRead: 0, cacheCreated: 0 },
      // No modelUsage on this result: the whole call under the model asked for, so "By model" can split it.
      models: { [resolveModelName("sonnet")!]: { input: 150_000, output: 900, cacheRead: 0, cacheCreated: 0, webSearch: 0, costUsd: 0.42 } },
    }));
    const opts = (calls[0] as { options: Record<string, unknown> }).options;
    expect(opts).toMatchObject({ tools: [], mcpServers: {}, settingSources: [], maxTurns: 1, persistSession: false });
    expect(opts.env).toMatchObject({ CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1", CLAUDE_CODE_MAX_RETRIES: "2" });
  });
});

describe("the summary call's ledger row", () => {
  const usage = {
    costUsd: 0.42, tokens: { input: 10, output: 2, cacheRead: 0, cacheCreated: 0 }, subtype: "success", model: "claude-sonnet-5-5", durationMs: 1200, numTurns: 1,
    models: { "claude-sonnet-5-5": { input: 10, output: 2, cacheRead: 0, cacheCreated: 0, webSearch: 0, costUsd: 0.42 } },
  };
  it("carries the per-model split, under the compacted session", () => {
    expect(forceSummaryLedgerRow("dm:owner", usage, 5)).toEqual({
      v: 1, ts: 5, sessionKey: "dm:owner", source: "background", trigger: "force-compact",
      costUsd: 0.42, tokens: usage.tokens, durationMs: 1200, numTurns: 1, models: usage.models,
    });
  });
  it("is the task's own cost when the compacted session is a sub-session", () => {
    expect(forceSummaryLedgerRow("task:s7", { ...usage, subtype: "error_during_execution" }, 5))
      .toMatchObject({ sessionKey: "task:s7", source: "task", taskId: "s7", subtype: "error_during_execution", models: usage.models });
  });
});

describe("summaryModels (the summary row's per-model split always adds up to the row)", () => {
  const tokens = { input: 10, output: 2, cacheRead: 0, cacheCreated: 0 };
  const usage = (costs: Record<string, number | undefined>) => ({ subtype: "success", modelUsage: Object.fromEntries(Object.entries(costs).map(([m, c]) => [m, { inputTokens: 5, outputTokens: 1, ...(c !== undefined ? { costUSD: c } : {}) }])) });
  it("takes modelUsage when its costs add up to the total", () => {
    const out = summaryModels(usage({ "claude-sonnet-5-5": 0.3, "claude-haiku-5-5": 0.12 }), "sonnet", tokens, 0.42)!;
    expect(Object.values(out).reduce((s, m) => s + m.costUsd, 0)).toBeCloseTo(0.42);
  });
  it("a single model with no cost gets the total", () => {
    expect(summaryModels(usage({ "claude-sonnet-5-5": undefined }), "sonnet", tokens, 0.42)).toMatchObject({ "claude-sonnet-5-5": { costUsd: 0.42 } });
  });
  it("several models that do not add up: no split (the row shows as unsplit, not as $0 by model)", () => {
    expect(summaryModels(usage({ "claude-sonnet-5-5": undefined, "claude-haiku-5-5": 0.1 }), "sonnet", tokens, 0.42)).toBeUndefined();
  });
});
