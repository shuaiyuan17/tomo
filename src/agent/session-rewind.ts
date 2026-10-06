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
  const assertSnapshotUnchanged = async () => {
    if (await readFile(path, "utf8") !== snapshot) throw new Error("Session history changed during rewind. Try again.");
    assertUnchanged();
  };
  const remove = async (forkId: string): Promise<boolean> => {
    try {
      await deleteSession(forkId, { dir: workspaceDir });
      return true;
    } catch (err) {
      // Preserve the original rewind failure while making cleanup failures
      // visible. The source session must never be deleted here.
      log.warn({ err, sessionId: forkId }, "Could not remove unpublished rewind fork");
      return false;
    }
  };
  const toolIds = (records: Entry[]) => {
    const uses = new Set<string>();
    const results = new Set<string>();
    for (const entry of records) {
      if (!Array.isArray(entry.message?.content)) continue;
      for (const block of entry.message.content) {
        if (entry.type === "assistant" && block?.type === "tool_use" && typeof block.id === "string") uses.add(block.id);
        if (entry.type === "user" && block?.type === "tool_result" && typeof block.tool_use_id === "string") results.add(block.tool_use_id);
      }
    }
    return { uses, results };
  };
  const sourceResults = toolIds(entries).results;
  // The guard: a tool call the fork contains whose result exists in the source
  // but was not copied. Checks the written fork, not a model of what the SDK
  // copies (it also keeps compaction-preserved and off-chain records).
  const forkSplitIds = async (forkId: string): Promise<Set<string>> => {
    const text = await readFile(getSdkSessionPath(forkId, sdkSessionsDir), "utf8");
    const { uses, results } = toolIds(text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Entry));
    return new Set([...uses].filter((id) => sourceResults.has(id) && !results.has(id)));
  };
  // Source file line of each tool call. forkSession copies records by file
  // order up to the cut, so cutting before a human message that precedes a
  // tool call's line keeps that call out of the fork.
  const toolUseLine = new Map<string, number>();
  entries.forEach((entry, line) => {
    for (const id of toolIds([entry]).uses) if (!toolUseLine.has(id)) toolUseLine.set(id, line);
  });
  const fileLine = new Map(entries.map((entry, line) => [entry.uuid, line]));
  const noCompletedTurn = () => new Error("Every recorded message in the current context arrived during a tool call, so there is no completed turn to return to. /new starts fresh.");
  // A steered user message can sit between a tool call and its result, which
  // then arrives later. Cutting there would resume a half-finished turn, so
  // step back to the previous human message until the cut splits no turn.
  // Tool calls whose result never appears (interrupted or blocked turns) are
  // history the SDK already resumes past and do not count.
  const position = new Map(chain.map((message, index) => [message.uuid, index]));
  let index = human.length - count;
  let target: Entry;
  let fork: { sessionId: string } | undefined;
  for (;;) {
    target = byId.get(human[index].uuid)!;
    const parent = resolveParent(target);
    // Cheap pre-check on the main chain, before creating any fork.
    const kept = keptToolUses(parent);
    const splitsTurn = chain.slice(position.get(target.uuid!)!).some((message) => {
      const entry = byId.get(message.uuid);
      return entry?.type === "user" && Array.isArray(entry.message?.content)
        && entry.message.content.some((block) => block?.type === "tool_result" && kept.has(block.tool_use_id));
    });
    if (!splitsTurn && parent) {
      await assertSnapshotUnchanged();
      const created = await forkSession(sessionId, { dir: workspaceDir, upToMessageId: parent, title: "Rewound conversation" });
      let split: Set<string>;
      try {
        split = await forkSplitIds(created.sessionId);
      } catch (err) {
        await remove(created.sessionId);
        throw err;
      }
      if (!split.size) {
        fork = created;
        break;
      }
      // Never step on with an unpublished fork left behind.
      if (!await remove(created.sessionId)) throw new Error("Could not remove a rejected rewind branch. Try /rewind again.");
      // Jump straight to the latest human message that precedes every split
      // tool call in the file, rather than forking once per step back.
      const earliest = Math.min(...[...split].map((id) => toolUseLine.get(id) ?? -1));
      let next = index - 1;
      while (next >= 0 && (fileLine.get(human[next].uuid) ?? Infinity) >= earliest) next--;
      if (next < 0) throw noCompletedTurn();
      index = next;
      continue;
    }
    if (!splitsTurn) break;
    if (index === 0) throw noCompletedTurn();
    index--;
  }
  let discarded = false;
  const discard = async () => {
    if (!fork || discarded) return;
    discarded = await remove(fork.sessionId);
  };
  try {
    await assertSnapshotUnchanged();
  } catch (err) {
    await discard();
    throw err;
  }
  return { sessionId: fork?.sessionId, count: human.length - index, preview: previewOf(target), assertUnchanged, discard };
}
