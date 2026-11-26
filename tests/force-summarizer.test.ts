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
const { sdkForceSummarizer } = await import("../src/lcm/force-summarizer.js");

describe("force summarizer", () => {
  it("is a clean one-turn call, and reports what it cost for the usage ledger", async () => {
    const onUsage = vi.fn();
    const text = await sdkForceSummarizer({ model: "sonnet", onUsage })({ from: "a", to: "b", events: 3, label: "whole day x", text: "conversation" });
    expect(text).toBe("the summary");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      costUsd: 0.42, subtype: "success", tokens: { input: 150_000, output: 900, cacheRead: 0, cacheCreated: 0 },
    }));
    const opts = (calls[0] as { options: Record<string, unknown> }).options;
    expect(opts).toMatchObject({ tools: [], mcpServers: {}, settingSources: [], maxTurns: 1, persistSession: false });
    expect(opts.env).toMatchObject({ CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1", CLAUDE_CODE_MAX_RETRIES: "2" });
  });
});
