import { readFileSync } from "node:fs";
import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { getSdkSessionPath } from "../sessions/index.js";

interface Entry {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  origin?: { kind?: string };
  isMeta?: boolean;
  isSynthetic?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
}

/** Fork only; the caller publishes the new link while holding its session queue. */
export async function prepareSessionRewind(
  sessionId: string,
  count: number,
  workspaceDir: string,
  sdkSessionsDir: string,
): Promise<{ sessionId?: string; assertUnchanged(): void }> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Use /rewind or /rewind <positive integer>.");
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(sessionId)) throw new Error("Invalid SDK session ID.");
  const path = getSdkSessionPath(sessionId, sdkSessionsDir);
  const snapshot = readFileSync(path, "utf8");
  // Refuse incomplete/corrupt snapshots instead of silently dropping history.
  if (!snapshot.endsWith("\n")) throw new Error("Session history is still being written. Try /rewind again shortly.");
  const entries = snapshot.split("\n").filter((line) => line.trim()).map((line): Entry => {
    const entry: unknown = JSON.parse(line);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Unreadable session history.");
    return entry as Entry;
  });
  const byId = new Map(entries.filter((e) => e.uuid).map((e) => [e.uuid!, e]));
  // The SDK resolves branches and compaction boundaries. Do not count old
  // branches, tool results, summaries, cron turns, or synthetic user entries.
  const chain = await getSessionMessages(sessionId, { dir: workspaceDir, includeSystemMessages: true });
  const human = chain.filter((message) => {
    const entry = byId.get(message.uuid);
    if (entry?.type !== "user" || entry.origin?.kind !== "human"
      || entry.isMeta || entry.isSynthetic || entry.isCompactSummary) return false;
    const content = entry.message?.content;
    return !Array.isArray(content) || !content.some((block) => block?.type === "tool_result");
  });
  if (count > human.length) {
    throw new Error(`Only ${human.length} recorded human message(s) can be rewound in the current context. Older or compacted messages may be unavailable; /new starts fresh.`);
  }
  const target = byId.get(human[human.length - count].uuid)!;
  let parent: string | null | undefined = target.parentUuid;
  if (parent === undefined) throw new Error("Cannot safely resolve the rewind boundary.");
  const seen = new Set<string>();
  while (parent) {
    if (seen.has(parent) || !byId.has(parent)) throw new Error("Cannot safely resolve the rewind boundary.");
    seen.add(parent);
    const entry: Entry = byId.get(parent)!;
    if (entry.type !== "progress") break;
    parent = entry.parentUuid;
  }
  // A steered user message can sit between a tool call and its result.
  // Forking there would resume dangling tool work instead of a completed turn.
  const kept: Entry[] = [];
  seen.clear();
  let cursor: string | null | undefined = parent;
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry || seen.has(cursor)) throw new Error("Cannot safely resolve the rewind boundary.");
    seen.add(cursor);
    kept.push(entry);
    if (entry.type === "system" && entry.subtype === "compact_boundary") break;
    cursor = entry.parentUuid;
  }
  const pendingTools = new Set<string>();
  for (const entry of kept.reverse()) {
    if (!Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (entry.type === "assistant" && block?.type === "tool_use" && typeof block.id === "string") pendingTools.add(block.id);
      if (entry.type === "user" && block?.type === "tool_result" && typeof block.tool_use_id === "string") pendingTools.delete(block.tool_use_id);
    }
  }
  if (pendingTools.size) throw new Error("That message arrived during a tool call. Increase the /rewind count to include the preceding user message.");
  const assertUnchanged = () => {
    if (readFileSync(path, "utf8") !== snapshot) throw new Error("Session history changed during rewind. Try again.");
  };
  assertUnchanged();
  const fork = parent ? await forkSession(sessionId, {
    dir: workspaceDir,
    upToMessageId: parent,
    title: "Rewound conversation",
  }) : undefined;
  assertUnchanged();
  return { sessionId: fork?.sessionId, assertUnchanged };
}
