import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { deleteSession, forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { getSdkSessionPath } from "../sessions/index.js";
import { log } from "../logger.js";

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

export interface PreparedRewind {
  /** Fork to publish; undefined means a fresh context (rewound the first message). */
  sessionId?: string;
  /** Human messages actually rewound; larger than requested when the cut moved back. */
  count: number;
  /** Start of the earliest rewound human message, for the confirmation reply. */
  preview: string;
  assertUnchanged(): void;
  discard(): Promise<void>;
}

function previewOf(entry: Entry): string {
  const content = entry.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join(" ")
    : "";
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > 80 ? `${chars.slice(0, 80).join("").trimEnd()}…` : flat;
}

/** Fork only; the caller publishes the new link while holding its session queue. */
export async function prepareSessionRewind(
  sessionId: string,
  count: number,
  workspaceDir: string,
  sdkSessionsDir: string,
): Promise<PreparedRewind> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Use /rewind or /rewind <positive integer>.");
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(sessionId)) throw new Error("Invalid SDK session ID.");
  const path = getSdkSessionPath(sessionId, sdkSessionsDir);
  const fileVersion = () => {
    const { dev, ino, size, mtimeNs, ctimeNs } = statSync(path, { bigint: true });
    return [dev, ino, size, mtimeNs, ctimeNs].join(":");
  };
  const version = fileVersion();
  // The final publish guard must not yield between validation and the link
  // swap. Keep only the small metadata check synchronous, not whole-file I/O.
  const assertUnchanged = () => {
    if (fileVersion() !== version) throw new Error("Session history changed during rewind. Try again.");
  };
  const snapshot = await readFile(path, "utf8");
  assertUnchanged();
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
  // Fork point for cutting before `target`: its parent, skipping progress entries.
  const resolveParent = (target: Entry): string | null => {
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
    return parent ?? null;
  };
  // Tool calls kept by a fork at `parent` (back to the last compaction).
  const keptToolUses = (parent: string | null): Set<string> => {
    const ids = new Set<string>();
    const seen = new Set<string>();
    let cursor: string | null | undefined = parent;
    while (cursor) {
      const entry = byId.get(cursor);
      if (!entry || seen.has(cursor)) throw new Error("Cannot safely resolve the rewind boundary.");
      seen.add(cursor);
      if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block?.type === "tool_use" && typeof block.id === "string") ids.add(block.id);
        }
      }
      if (entry.type === "system" && entry.subtype === "compact_boundary") break;
      cursor = entry.parentUuid;
    }
    return ids;
  };
  // A steered user message can sit between a tool call and its result, which
  // then arrives later in the chain. Cutting there would resume a half-finished
  // turn, so step back to the previous human message until no kept tool call
  // has its result after the cut. Tool calls whose result never appears
  // (interrupted or blocked turns) are history the SDK already resumes past.
  const position = new Map(chain.map((message, index) => [message.uuid, index]));
  let index = human.length - count;
  let target: Entry;
  let parent: string | null;
  for (;;) {
    target = byId.get(human[index].uuid)!;
    parent = resolveParent(target);
    const kept = keptToolUses(parent);
    const splitsTurn = chain.slice(position.get(target.uuid!)!).some((message) => {
      const entry = byId.get(message.uuid);
      return entry?.type === "user" && Array.isArray(entry.message?.content)
        && entry.message.content.some((block) => block?.type === "tool_result" && kept.has(block.tool_use_id));
    });
    if (!splitsTurn) break;
    if (index === 0) throw new Error("Every recorded message in the current context arrived during a tool call, so there is no completed turn to return to. /new starts fresh.");
    index--;
  }
  const assertSnapshotUnchanged = async () => {
    if (await readFile(path, "utf8") !== snapshot) throw new Error("Session history changed during rewind. Try again.");
    assertUnchanged();
  };
  await assertSnapshotUnchanged();
  const fork = parent ? await forkSession(sessionId, {
    dir: workspaceDir,
    upToMessageId: parent,
    title: "Rewound conversation",
  }) : undefined;
  let discarded = false;
  const discard = async () => {
    if (!fork || discarded) return;
    try {
      await deleteSession(fork.sessionId, { dir: workspaceDir });
      discarded = true;
    } catch (err) {
      // Preserve the original rewind failure while making cleanup failures
      // visible. The source session must never be deleted here.
      log.warn({ err, sessionId: fork.sessionId }, "Could not remove unpublished rewind fork");
    }
  };
  try {
    await assertSnapshotUnchanged();
  } catch (err) {
    await discard();
    throw err;
  }
  return { sessionId: fork?.sessionId, count: human.length - index, preview: previewOf(target), assertUnchanged, discard };
}
