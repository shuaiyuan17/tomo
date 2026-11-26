import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { buildSdkEnv } from "../agent/sdk-options.js";
import { resolveModelName } from "../models.js";
import { cumulativeModelCounters, type ModelTurnUsage, type SdkResultLike } from "../agent/sdk-result.js";
import { errorMessage } from "../error-text.js";
import { log } from "../logger.js";
import type { StretchForSummary } from "./force-compact.js";

/**
 * The summary call of a forced compaction (`lcm/force-compact.ts`, step 3).
 *
 * The session being compacted cannot write its own summary — it is the thing
 * that no longer fits — so this is a separate, clean model call: a fresh CLI
 * child through the same SDK path (and the same auth/routing env) the live
 * sessions use, with NOTHING of the session's context: no system prompt
 * beyond the instructions below, no tools, no MCP servers, no settings files,
 * no plugins, one turn, and nothing persisted to disk. Its only input is the
 * original text of the stretch being replaced.
 */

/** How long one summary call may take before it counts as failed. */
export const FORCE_SUMMARY_TIMEOUT_MS = 5 * 60 * 1000;

const SYSTEM_PROMPT = [
  "You write a compact summary block that will REPLACE a stretch of an assistant's conversation history.",
  "The assistant (Tomo) will read your block instead of the original messages, so write it as Tomo's own note-to-self:",
  "dated facts, decisions, commitments and open threads, names, numbers, links, file paths, and short quotes where the exact words matter.",
  "Prefer concrete over abstract; drop chit-chat and tool noise. Keep the language(s) the conversation used.",
  "No preamble, no closing remarks, no headings about yourself — output only the block text.",
  "Aim for at most about 1500 words.",
].join(" ");

export interface ForceSummarizerOptions {
  /** Model alias or id (config lcm.forceCompactModel). */
  model: string;
  timeoutMs?: number;
  /** Shutdown: aborts the call. */
  signal?: AbortSignal;
  /** What the call cost, from its SDK result (success or not): for the usage ledger. */
  onUsage?: (u: ForceSummaryUsage) => void;
}

export interface ForceSummaryUsage {
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreated: number };
  durationMs?: number;
  numTurns?: number;
  subtype: string;
  model: string;
  /** The call per model, as the ledger's `models` (see summaryModels); absent when the split does not add up. */
  models?: Record<string, ModelTurnUsage>;
}

/** Build the summary function `forceCompactSession` is given. Throws on any failure (the caller falls back to archiving). */
export function sdkForceSummarizer(opts: ForceSummarizerOptions): (stretch: StretchForSummary) => Promise<string> {
  return async (stretch) => {
    const model = resolveModelName(opts.model) ?? opts.model;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), opts.timeoutMs ?? FORCE_SUMMARY_TIMEOUT_MS);
    const onAbort = () => abortController.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const prompt = [
      `Conversation stretch to summarize: ${stretch.from} → ${stretch.to} (${stretch.events} events, ${stretch.label}).`,
      "",
      "<conversation>",
      stretch.text,
      "</conversation>",
      "",
      "Write the summary block now.",
    ].join("\n");
    try {
      const q = query({
        prompt,
        options: {
          model,
          systemPrompt: SYSTEM_PROMPT,
          tools: [],
          allowedTools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          plugins: [],
          maxTurns: 1,
          persistSession: false,
          cwd: tmpdir(),
          abortController,
          // The CLI titles a new session with a second model call fed the
          // same first prompt — here that would double the cost of a call
          // whose input is up to 150K tokens: DISABLE_TERMINAL_TITLE turns
          // titling off. And its own retries back off for minutes on an
          // overloaded API while the session is held; this call has a
          // fallback (archiving), so two retries are enough.
          env: {
            ...buildSdkEnv({ disableAutoCompact: true, model }),
            CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
            CLAUDE_CODE_MAX_RETRIES: "2",
          },
        },
      });
      let text = "";
      for await (const msg of q) {
        if (msg.type === "result") {
          const r = msg as unknown as SdkResultLike & { usage?: Record<string, number> };
          try {
            const tokens = {
              input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0,
              cacheRead: r.usage?.cache_read_input_tokens ?? 0, cacheCreated: r.usage?.cache_creation_input_tokens ?? 0,
            };
            const costUsd = r.total_cost_usd ?? 0;
            opts.onUsage?.({
              costUsd,
              tokens,
              models: summaryModels(r, model, tokens, costUsd),
              ...(r.duration_ms !== undefined ? { durationMs: r.duration_ms } : {}),
              ...(r.num_turns !== undefined ? { numTurns: r.num_turns } : {}),
              subtype: r.subtype,
              model,
            });
          } catch (err) {
            log.warn({ err: errorMessage(err) }, "Forced compaction: could not record the summary call's usage");
          }
          if (msg.subtype !== "success" || msg.is_error) {
            const detail = msg.subtype === "success" ? msg.result : (msg as { errors?: string[] }).errors?.join("; ");
            throw new Error(`summary call failed (${msg.subtype}): ${detail ?? "no detail"}`);
          }
          text = msg.result ?? "";
        }
      }
      return text;
    } catch (err) {
      log.warn({ err: errorMessage(err), model }, "Forced compaction: the summary call failed");
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * The call per model for the ledger. The result's `modelUsage` when its
 * costs add up to the call's total (a fresh CLI, so its counters are this
 * call's own); a single model whose cost is missing gets the total; when
 * there is no `modelUsage`, the whole call goes under the model asked for.
 * A split that does not add up and cannot be mended is left out (undefined):
 * the row's cost then shows as unsplit, never as missing from "By model".
 */
export function summaryModels(
  result: SdkResultLike,
  model: string,
  tokens: { input: number; output: number; cacheRead: number; cacheCreated: number },
  costUsd: number,
): Record<string, ModelTurnUsage> | undefined {
  const split = cumulativeModelCounters(result);
  if (!split) return { [model]: { ...tokens, webSearch: 0, costUsd } };
  const entries = Object.entries(split);
  const sum = entries.reduce((total, [, m]) => total + m.costUsd, 0);
  if (Math.abs(sum - costUsd) <= 1e-9 * Math.max(1, costUsd)) return split;
  if (entries.length === 1) return { [entries[0][0]]: { ...entries[0][1], costUsd } };
  return undefined;
}
