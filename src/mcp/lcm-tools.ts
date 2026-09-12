import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { join } from "node:path";
import { compactSession } from "../lcm/compact.js";
import { resolveBlockRange, summaryBudgetCheck, type BlockLevel } from "../lcm/blocks.js";
import { log } from "../logger.js";

export interface LcmToolDeps {
  /** The caller's SDK session id, resolved at call time (it changes on reset). */
  sdkSessionIdFor: () => string | undefined;
  sdkSessionsDir: string;
  sessionsDir: string;
  sessionKey: string;
}

const PERIOD_HINT: Record<BlockLevel, string> = {
  daily: "YYYY-MM-DD (defaults to today, local time)",
  weekly: "YYYY-Www, ISO week (defaults to the last completed week)",
  monthly: "YYYY-MM (defaults to the last completed month)",
  yearly: "YYYY (defaults to the last completed year)",
};

/**
 * `lcm_rollup` — the `tomo lcm <level>` command as a tool, for sessions that
 * have no shell.
 *
 * Why it exists: a turn barred from `memory/private/` used to have no Bash at
 * all, and group sessions are barred for their whole life. The rollup nudge kept
 * arriving in those sessions anyway, asking for a CLI command they could not
 * run, and the periods piled up. A barred turn now DOES get a shell — wrapped in
 * a `sandbox-exec` profile that makes the private dir unreadable in the kernel
 * (`agent/bash-sandbox.ts`) — so `tomo lcm <level>` is reachable again, but this
 * tool stays: it is the path that still works when the sandbox cannot be set up
 * (the fallback is withholding Bash, not an unsandboxed shell), and it needs no
 * shell to begin with. This is the same compaction, in-process:
 * it resolves the block range, writes the summary block and archives the
 * source events exactly as the CLI does, and leaves the same trigger file
 * the CLI leaves, so the live session reloads on the same path afterwards.
 */
export function buildLcmTools(deps: LcmToolDeps) {
  return [
    tool(
      "lcm_rollup",
      [
        "Roll a completed period of this session's history up into one summary block (the `tomo lcm <level>` command, without a shell).",
        "",
        "Use it when an lcm-rollup nudge arrives and you would rather not shell out, or Bash is unavailable. Same effect as the CLI:",
        "the period's events are replaced by your summary, the originals are archived, and the live session reloads after this turn.",
        "",
        "Pass the level and period named in the nudge, and the summary text you would have passed to `--summary`.",
        "One rollup per turn — running two back-to-back can orphan the chain.",
      ].join("\n"),
      {
        level: z.enum(["daily", "weekly", "monthly", "yearly"]).describe("Which block level to roll up."),
        period: z.string().optional().describe(
          "The period to roll up: daily YYYY-MM-DD, weekly YYYY-Www, monthly YYYY-MM, yearly YYYY. Omit for the default period of that level.",
        ),
        summary: z.string().min(1).describe("The summary block text — note-to-self, dated facts, decisions and quotes over abstraction."),
      },
      async (args) => {
        const level = args.level as BlockLevel;
        const sdkSessionId = deps.sdkSessionIdFor();
        const fail = (error: string) => ({
          content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error }) }],
          isError: true,
        });
        if (!sdkSessionId) return fail("This session has no SDK session id yet; nothing to roll up.");

        const resolved = resolveBlockRange(sdkSessionId, level, args.period, deps.sdkSessionsDir);
        if (!resolved) {
          return fail(`No events found for ${level} ${args.period ?? "(default period)"}. Period format: ${PERIOD_HINT[level]}.`);
        }
        const result = compactSession({
          sdkSessionId,
          sdkSessionsDir: deps.sdkSessionsDir,
          fromIdx: resolved.fromIdx,
          toIdx: resolved.toIdx,
          expectedFirstUuid: resolved.firstUuid,
          expectedLastUuid: resolved.lastUuid,
          summary: args.summary,
          transcriptPath: join(deps.sessionsDir, `_archive_${sdkSessionId}.jsonl`),
          blockTag: resolved.blockTag,
          dropUnparseable: false,
        });
        if (!result.success) return fail(result.error ?? "compaction failed");

        const budget = summaryBudgetCheck(level, args.summary);
        log.info(
          { key: deps.sessionKey, blockTag: resolved.blockTag, eventsRemoved: result.eventsRemoved },
          "lcm_rollup: block written from the tool path",
        );
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "ok",
              blockTag: resolved.blockTag,
              description: resolved.description,
              eventsRemoved: result.eventsRemoved,
              eventsAfter: result.eventsAfter,
              summaryTokens: budget.tokens,
              summaryBudget: budget.budget,
              ...(budget.overBudget ? {
                warning: `summary is ~${budget.tokens} tokens (budget ${budget.budget} for ${level}); ` +
                  "if the period genuinely has irreducible texture this is fine, otherwise compress harder next time",
              } : {}),
              note: "The live session reloads after this turn. Reply NO_REPLY to finish the housekeeping turn.",
            }),
          }],
        };
      },
      { searchHint: "lcm rollup compact summarize period daily weekly monthly yearly block no shell" },
    ),
  ];
}
