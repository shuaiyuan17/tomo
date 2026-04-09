import { Command } from "commander";
import { computeContextStats, resolveTimeRange } from "../lcm/stats.js";
import { compactSession } from "../lcm/compact.js";
import { SessionStore } from "../sessions/store.js";
import { config } from "../config.js";
import { join } from "node:path";
import { homedir } from "node:os";

const sessionsDir = config.sessionsDir ?? join(homedir(), ".tomo", "data", "sessions");

export const lcmCommand = new Command("lcm")
  .description("Context management tools");

lcmCommand
  .command("session-id")
  .description("Get the active SDK session ID for a channel")
  .requiredOption("--channel-key <key>", "Channel key (e.g. telegram_123456789)")
  .action((opts) => {
    const store = new SessionStore(sessionsDir, 20);
    const sid = store.getSdkSessionId(opts.channelKey);
    if (sid) {
      console.log(sid);
    } else {
      console.error("No active session for:", opts.channelKey);
      process.exit(1);
    }
  });

lcmCommand
  .command("stats")
  .description("Show context breakdown by section")
  .requiredOption("--session-id <id>", "SDK session ID")
  .option("--json", "Output raw JSON")
  .action((opts) => {
    const result = computeContextStats(opts.sessionId);
    if (!result) {
      console.error("Session not found:", opts.sessionId);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Total: ${result.totalMessages} messages, ~${Math.round(result.totalTokens / 1000)}K tokens\n`);
    console.log("Sections:");
    for (const s of result.sections) {
      const tools = s.toolsUsed.length > 0 ? ` [${s.toolsUsed.join(", ")}]` : "";
      console.log(
        `  #${s.id} | ${s.type.padEnd(12)} | msgs ${s.fromIdx}-${s.toIdx} (${s.messageCount}) | ~${Math.round(s.tokens / 1000)}K tokens | ${s.earliestAt.slice(11, 16)}-${s.latestAt.slice(11, 16)}${tools}`
      );
    }
  });

lcmCommand
  .command("compact")
  .description("Compact a range of events by time range, replacing with a summary")
  .requiredOption("--session-id <id>", "SDK session ID")
  .requiredOption("--from-time <iso>", "Start timestamp (ISO 8601, e.g. 2026-03-28T16:29)")
  .requiredOption("--to-time <iso>", "End timestamp (ISO 8601, e.g. 2026-03-28T19:09)")
  .requiredOption("--summary <text>", "Summary text to replace the range")
  .option("--channel-key <key>", "Channel key for transcript archive (e.g. telegram_123456789)")
  .action((opts) => {
    // Resolve timestamps to indices using context_stats
    const stats = computeContextStats(opts.sessionId);
    if (!stats) {
      console.error(JSON.stringify({ status: "error", error: "Session not found" }));
      process.exit(1);
    }

    const fromTime = opts.fromTime;
    const toTime = opts.toTime;

    // Find the event index range that falls within the timestamps
    const resolved = resolveTimeRange(opts.sessionId, fromTime, toTime);
    if (!resolved) {
      console.error(JSON.stringify({ status: "error", error: `No events found in time range ${fromTime} to ${toTime}` }));
      process.exit(1);
    }

    const transcriptPath = opts.channelKey
      ? join(sessionsDir, `${opts.channelKey}.jsonl`)
      : join(sessionsDir, `_archive_${opts.sessionId}.jsonl`);

    const result = compactSession({
      sdkSessionId: opts.sessionId,
      fromIdx: resolved.fromIdx,
      toIdx: resolved.toIdx,
      summary: opts.summary,
      transcriptPath,
    });

    if (result.success) {
      console.log(JSON.stringify({
        status: "ok",
        eventsRemoved: result.eventsRemoved,
        eventsAfter: result.eventsAfter,
        timeRange: { from: fromTime, to: toTime },
      }));
    } else {
      console.error(JSON.stringify({ status: "error", error: result.error }));
      process.exit(1);
    }
  });

lcmCommand
  .command("search")
  .description("Search the transcript and archive for messages matching a query")
  .option("--channel-key <key>", "Channel key (e.g. telegram_123456789)")
  .option("--session-id <id>", "SDK session ID (searches archive too)")
  .option("--query <text>", "Text to search for")
  .option("--from-seq <n>", "Start seq number", parseInt)
  .option("--to-seq <n>", "End seq number", parseInt)
  .option("--limit <n>", "Max results", parseInt)
  .option("--json", "Output raw JSON")
  .action((opts) => {
    const store = new SessionStore(sessionsDir, 20);
    const limit = opts.limit ?? 50;
    const results: Array<{ role: string; content: string; timestamp: number; seq?: number; source?: string }> = [];

    // Search transcript if channel key provided
    if (opts.channelKey) {
      const transcriptResults = store.searchTranscript(opts.channelKey, {
        query: opts.query,
        fromSeq: opts.fromSeq,
        toSeq: opts.toSeq,
        limit,
      });
      results.push(...transcriptResults.map(r => ({ ...r, source: "transcript" })));
    }

    // Search archive if session ID provided
    if (opts.sessionId) {
      const remaining = limit - results.length;
      if (remaining > 0) {
        const archiveResults = store.searchArchive(opts.sessionId, {
          query: opts.query,
          limit: remaining,
        });
        results.push(...archiveResults.map(r => ({ ...r, source: "archive" })));
      }
    }

    if (!opts.channelKey && !opts.sessionId) {
      console.error("Provide --channel-key and/or --session-id");
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log("No results found.");
      return;
    }

    for (const msg of results) {
      const time = new Date(msg.timestamp).toISOString().slice(0, 16);
      const seq = msg.seq != null ? `#${msg.seq}` : "";
      const src = msg.source === "archive" ? "[archive]" : "";
      const preview = msg.content.slice(0, 120).replace(/\n/g, " ");
      console.log(`  ${seq.padEnd(6)} ${time} [${msg.role}] ${src} ${preview}`);
    }
    console.log(`\n${results.length} result(s)`);
  });
