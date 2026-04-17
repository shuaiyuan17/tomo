import { Command } from "commander";
import { computeContextStats, resolveTimeRange } from "../lcm/stats.js";
import { compactSession } from "../lcm/compact.js";
import { pruneTools } from "../lcm/prune-tools.js";
import { resolveBlockRange, type BlockLevel } from "../lcm/blocks.js";
import { SessionStore } from "../sessions/store.js";
import { join } from "node:path";
import { homedir } from "node:os";

async function getSessionsDir(): Promise<string> {
  try {
    const { config } = await import("../config.js");
    return config.sessionsDir ?? join(homedir(), ".tomo", "data", "sessions");
  } catch {
    return join(homedir(), ".tomo", "data", "sessions");
  }
}

export const lcmCommand = new Command("lcm")
  .description("Context management tools");

lcmCommand
  .command("session-id")
  .description("Get the active SDK session ID for a channel")
  .requiredOption("--channel-key <key>", "Channel key (e.g. telegram_123456789)")
  .action(async (opts) => {
    const sessionsDir = await getSessionsDir();
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

    console.log(`Total: ${result.totalMessages} messages, ~${Math.round(result.totalTokens / 1000)}K tokens`);
    console.log(`Times shown in local timezone (${tzAbbrev()}).\n`);
    console.log("Sections:");
    for (const s of result.sections) {
      const tools = s.toolsUsed.length > 0 ? ` [${s.toolsUsed.join(", ")}]` : "";
      console.log(
        `  #${s.id} | ${s.type.padEnd(12)} | msgs ${s.fromIdx}-${s.toIdx} (${s.messageCount}) | ~${Math.round(s.tokens / 1000)}K tokens | ${formatLocal(s.earliestAt)} → ${formatLocal(s.latestAt)}${tools}`
      );
    }
  });

function formatLocal(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function tzAbbrev(): string {
  const parts = new Date().toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ");
  return parts[parts.length - 1] || "local";
}

function registerBlockLevel(level: BlockLevel, periodOpt: { flag: string; desc: string }) {
  lcmCommand
    .command(level)
    .description(`Roll up into a ${level} block (auto-resolves range + tag)`)
    .requiredOption("--session-id <id>", "SDK session ID")
    .requiredOption("--summary <text>", "Summary text")
    .option(periodOpt.flag, periodOpt.desc)
    .action(async (opts) => {
      const sessionsDir = await getSessionsDir();
      // Option name is the part after `--`, converted to camelCase by commander.
      // (The earlier version used /<(\w+)>/ on the placeholder, which failed
      // on "YYYY-MM-DD" because \w+ doesn't cross hyphens — falling back to
      // `opts.period`, which doesn't exist, so --date was silently ignored.)
      const flagMatch = periodOpt.flag.match(/^--(\S+)/);
      const rawKey = flagMatch?.[1] ?? "";
      const periodKey = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const period: string | undefined = opts[periodKey];

      const resolved = resolveBlockRange(opts.sessionId, level, period);
      if (!resolved) {
        console.error(JSON.stringify({
          status: "error",
          error: `No events found for ${level} ${period ?? "(auto)"}`,
        }));
        process.exit(1);
      }

      const transcriptPath = join(sessionsDir, `_archive_${opts.sessionId}.jsonl`);
      const result = compactSession({
        sdkSessionId: opts.sessionId,
        fromIdx: resolved.fromIdx,
        toIdx: resolved.toIdx,
        summary: opts.summary,
        transcriptPath,
        blockTag: resolved.blockTag,
      });

      if (result.success) {
        console.log(JSON.stringify({
          status: "ok",
          blockTag: resolved.blockTag,
          description: resolved.description,
          eventsRemoved: result.eventsRemoved,
          eventsAfter: result.eventsAfter,
        }));
      } else {
        console.error(JSON.stringify({ status: "error", error: result.error }));
        process.exit(1);
      }
    });
}

registerBlockLevel("daily", {
  flag: "--date <YYYY-MM-DD>",
  desc: "Date to compact (defaults to today, local tz)",
});
registerBlockLevel("weekly", {
  flag: "--week <YYYY-Www>",
  desc: "ISO week to roll up (defaults to last completed week)",
});
registerBlockLevel("monthly", {
  flag: "--month <YYYY-MM>",
  desc: "Month to roll up (defaults to last completed month)",
});
registerBlockLevel("yearly", {
  flag: "--year <YYYY>",
  desc: "Year to roll up (defaults to last completed year)",
});

lcmCommand
  .command("compact")
  .description("Compact a range of events by time range, replacing with a summary")
  .requiredOption("--session-id <id>", "SDK session ID")
  .requiredOption("--from-time <iso>", "Start timestamp (ISO 8601, e.g. 2026-03-28T16:29)")
  .requiredOption("--to-time <iso>", "End timestamp (ISO 8601, e.g. 2026-03-28T19:09)")
  .requiredOption("--summary <text>", "Summary text to replace the range")
  .action(async (opts) => {
    const sessionsDir = await getSessionsDir();
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

    // Archive file is keyed by SDK session id — matches store.searchArchive()
    // and the pattern used by prune-tools. Previously an optional --channel-key
    // branch wrote to `<channelKey>.jsonl`, colliding with the live transcript
    // namespace (e.g. `dm:shuai.jsonl` next to `dm_shuai.jsonl`).
    const transcriptPath = join(sessionsDir, `_archive_${opts.sessionId}.jsonl`);

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
  .action(async (opts) => {
    const sessionsDir = await getSessionsDir();
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

lcmCommand
  .command("prune-tools")
  .description("Prune bulky tool results and base64 images from a session")
  .requiredOption("--session-id <id>", "SDK session ID")
  .option("--min-size <chars>", "Only prune entries larger than N chars (default 500)", parseInt)
  .option("--tools <names>", "Comma-separated tool names to prune (e.g. Read,Bash,WebSearch)")
  .option("--no-images", "Skip pruning base64 images")
  .option("--dry-run", "Preview what would be pruned without modifying")
  .option("--channel-key <key>", "Channel key for archiving originals")
  .action(async (opts) => {
    const sessionsDir = await getSessionsDir();

    const result = pruneTools({
      sdkSessionId: opts.sessionId,
      minSize: opts.minSize,
      tools: opts.tools ? opts.tools.split(",") : undefined,
      includeImages: opts.images !== false,
      dryRun: opts.dryRun,
      archivePath: opts.channelKey
        ? join(sessionsDir, `_archive_${opts.sessionId}.jsonl`)
        : undefined,
    });

    if (!result.success) {
      console.error(result.error);
      process.exit(1);
    }

    if (result.pruned.length === 0) {
      console.log("Nothing to prune.");
      return;
    }

    // Group by label (tool name or "images")
    const byLabel = new Map<string, { count: number; chars: number }>();
    for (const p of result.pruned) {
      const label = p.category === "image" ? "images" : (p.tool ?? "unknown");
      const entry = byLabel.get(label) ?? { count: 0, chars: 0 };
      entry.count++;
      entry.chars += p.originalSize;
      byLabel.set(label, entry);
    }

    const label = opts.dryRun ? "Would prune" : "Pruned";
    const afterChars = result.pruned.length * 40; // rough stub size
    console.log(`${label} ${result.pruned.length} entries (${result.totalCharsRemoved.toLocaleString()} chars → ~${afterChars.toLocaleString()} chars)\n`);
    for (const [name, { count, chars }] of byLabel) {
      console.log(`  ${name.padEnd(12)} x${count}  — ${chars.toLocaleString()} chars removed`);
    }
  });
