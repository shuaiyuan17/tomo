import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { log } from "../src/logger.js";

// pruneTools takes its pinned snapshot with compact.ts's readWholeFileFromFd.
// Wrapping that one import gives the tests a moment that is AFTER the snapshot
// and BEFORE the late-splice read, which is exactly where an SDK append lands
// in production (the CLI prune runs while the daemon's turn is still writing).
// prune-tools.ts has no hook of its own for it, and one is not worth adding to
// src for a test. compact.ts's own internal calls are untouched.
const afterSnapshot = vi.hoisted(() => ({ fn: null as null | (() => void) }));
vi.mock("../src/lcm/compact.js", async (original) => {
  const real = await original<typeof import("../src/lcm/compact.js")>();
  return {
    ...real,
    readWholeFileFromFd: (...args: Parameters<typeof real.readWholeFileFromFd>) => {
      const snapshot = real.readWholeFileFromFd(...args);
      afterSnapshot.fn?.();
      return snapshot;
    },
  };
});

import { pruneTools as pruneToolsImpl, type PruneToolsRequest } from "../src/lcm/prune-tools.js";
import { getCompactTriggerPath as getCompactTriggerPathImpl } from "../src/lcm/compact.js";
import { getSdkSessionPath } from "../src/sessions/index.js";
import {
  writeFileSync, appendFileSync, unlinkSync, existsSync, mkdirSync, readFileSync, rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

function mkToolUseEvent(parentUuid: string | null, toolUseId: string, name: string) {
  return {
    type: "assistant",
    uuid: randomUUID(),
    parentUuid,
    timestamp: "2026-06-09T00:00:00.000Z",
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name, input: {} }],
    },
  };
}

function mkToolResultEvent(parentUuid: string | null, toolUseId: string, content: string) {
  return {
    type: "user",
    uuid: randomUUID(),
    parentUuid,
    timestamp: "2026-06-09T00:00:01.000Z",
    isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

function mkUserEvent(parentUuid: string | null, text: string) {
  return {
    type: "user",
    uuid: randomUUID(),
    parentUuid,
    timestamp: "2026-06-09T00:00:02.000Z",
    isSidechain: false,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function writeEvents(path: string, events: object[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("pruneTools", () => {
  let sessionId: string;
  let path: string;
  let archivePath: string;
  let sdkSessionsDir: string;

  function pruneTools(req: Omit<PruneToolsRequest, "sdkSessionsDir">) {
    return pruneToolsImpl({ ...req, sdkSessionsDir });
  }

  function getCompactTriggerPath(id: string) {
    return getCompactTriggerPathImpl(id, sdkSessionsDir);
  }

  beforeEach(() => {
    sessionId = `test-prune-${randomUUID()}`;
    sdkSessionsDir = join(tmpdir(), `tomo-test-prune-sdk-${randomUUID()}`);
    path = getSdkSessionPath(sessionId, sdkSessionsDir);
    archivePath = join(tmpdir(), `archive-${sessionId}.jsonl`);
  });

  afterEach(() => {
    afterSnapshot.fn = null;
    vi.restoreAllMocks();
    rmSync(sdkSessionsDir, { recursive: true, force: true });
    for (const p of [archivePath]) {
      if (existsSync(p)) unlinkSync(p);
    }
  });

  function seedSession(): { bigContent: string } {
    const bigContent = "x".repeat(1000);
    const use = mkToolUseEvent(null, "tool-1", "Read");
    const result = mkToolResultEvent(use.uuid, "tool-1", bigContent);
    const tail = mkUserEvent(result.uuid, "thanks");
    writeEvents(path, [use, result, tail]);
    return { bigContent };
  }

  it("prunes large tool results and writes the trigger file", () => {
    const { bigContent } = seedSession();

    const res = pruneTools({ sdkSessionId: sessionId, minSize: 500 });

    expect(res.success).toBe(true);
    expect(res.pruned).toHaveLength(1);
    expect(res.pruned[0]).toMatchObject({ category: "tool", tool: "Read", originalSize: 1000 });

    const after = readFileSync(path, "utf-8");
    expect(after).not.toContain(bigContent);
    expect(after).toContain("[pruned");
    expect(after.trimEnd().split("\n")).toHaveLength(3);
    expect(existsSync(getCompactTriggerPath(sessionId))).toBe(true);
  });

  it("dry run reports findings without modifying the file", () => {
    seedSession();
    const before = readFileSync(path, "utf-8");

    const res = pruneTools({ sdkSessionId: sessionId, minSize: 500, dryRun: true });

    expect(res.success).toBe(true);
    expect(res.pruned).toHaveLength(1);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(existsSync(getCompactTriggerPath(sessionId))).toBe(false);
  });

  it("splices in a complete event the SDK appended after the snapshot, as-is and once", () => {
    const { bigContent } = seedSession();
    // This used to append BEFORE calling pruneTools, so the line was simply
    // part of the snapshot and the late-splice read was never reached. The
    // hook appends between the snapshot and that read instead.
    const late = mkToolResultEvent(null, "tool-late", "y".repeat(1000));
    afterSnapshot.fn = () => { appendFileSync(path, JSON.stringify(late) + "\n"); };
    const info = vi.spyOn(log, "info");

    const res = pruneTools({ sdkSessionId: sessionId, minSize: 500 });

    expect(res.success).toBe(true);
    const lines = readFileSync(path, "utf-8").trimEnd().split("\n").map((l) => JSON.parse(l) as { uuid: string });
    expect(lines).toHaveLength(4);
    expect(lines[3].uuid).toBe(late.uuid);
    // As-is: a late event is this turn's fresh activity and is never pruned,
    // even when it is big. Only the snapshot's result was.
    expect(JSON.stringify(lines[3])).toContain("y".repeat(1000));
    expect(JSON.stringify(lines.slice(0, 3))).not.toContain(bigContent);
    expect(res.pruned).toHaveLength(1);
    // And it came in through the splice, not through the post-rename drain
    // of the old inode (which would also have kept it).
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ lateAppended: 1, postRenameDrained: 0 }), "Tool results pruned");
  });

  it("aborts without side effects when an SDK write is mid-flight (partial tail)", () => {
    seedSession();
    // Trailing bytes with no newline = another process mid-write.
    appendFileSync(path, '{"type":"user","uuid":"partial');
    const before = readFileSync(path, "utf-8");

    const res = pruneTools({ sdkSessionId: sessionId, minSize: 500, archivePath });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Partial SDK write/);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(existsSync(archivePath)).toBe(false);
    expect(existsSync(getCompactTriggerPath(sessionId))).toBe(false);
  });

  it("archives the pre-prune snapshot when requested", () => {
    const { bigContent } = seedSession();

    const res = pruneTools({ sdkSessionId: sessionId, minSize: 500, archivePath });

    expect(res.success).toBe(true);
    const archive = readFileSync(archivePath, "utf-8");
    expect(archive).toContain("# pre-prune snapshot");
    expect(archive).toContain(bigContent);
  });

  describe("what is pruned", () => {
    const b64 = "A".repeat(2048);

    it("replaces a base64 image block with a text stub, keeping the event and its place", () => {
      const img = {
        type: "user", uuid: randomUUID(), parentUuid: null, timestamp: "2026-06-09T00:00:00.000Z", isSidechain: false,
        message: { role: "user", content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
        ] },
      };
      writeEvents(path, [img]);

      const res = pruneTools({ sdkSessionId: sessionId, minSize: 500 });

      expect(res.pruned).toEqual([{ category: "image", mediaType: "image/png", originalSize: 2048 }]);
      const [after] = readFileSync(path, "utf-8").trimEnd().split("\n").map((l) => JSON.parse(l));
      expect(after.uuid).toBe(img.uuid);
      expect(after.message.content).toEqual([
        { type: "text", text: "look" },
        { type: "text", text: "[pruned — image/png, 2KB base64]" },
      ]);
    });

    it("replaces an event-level toolUseResult image preview (the SDK's visual copy)", () => {
      const evt = {
        ...mkUserEvent(null, "screenshot taken"),
        toolUseResult: { type: "image", file: { base64: b64, type: "image/jpeg" } },
      };
      writeEvents(path, [evt]);

      const res = pruneTools({ sdkSessionId: sessionId, minSize: 500 });

      expect(res.pruned).toEqual([{ category: "image", mediaType: "image/jpeg", originalSize: 2048 }]);
      const [after] = readFileSync(path, "utf-8").trimEnd().split("\n").map((l) => JSON.parse(l));
      expect(after.toolUseResult).toEqual({ type: "text", text: "[pruned — image/jpeg, 2KB base64]" });
      expect(after.message.content).toEqual(evt.message.content);
    });

    it("leaves images alone with includeImages: false", () => {
      const evt = { ...mkUserEvent(null, "x"), toolUseResult: { type: "image", file: { base64: b64, type: "image/jpeg" } } };
      writeEvents(path, [evt]);
      const before = readFileSync(path, "utf-8");

      const res = pruneTools({ sdkSessionId: sessionId, minSize: 500, includeImages: false });

      expect(res).toEqual({ success: true, pruned: [], totalCharsRemoved: 0 });
      expect(readFileSync(path, "utf-8")).toBe(before);
    });

    it("prunes only the named tools (case-insensitive), and sizes array content by its JSON", () => {
      const read = mkToolUseEvent(null, "t-read", "Read");
      const readResult = mkToolResultEvent(read.uuid, "t-read", "r".repeat(1000));
      const bash = mkToolUseEvent(readResult.uuid, "t-bash", "Bash");
      const blocks = [{ type: "text", text: "b".repeat(600) }];
      const bashResult = {
        ...mkToolResultEvent(bash.uuid, "t-bash", ""),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-bash", content: blocks }] },
      };
      writeEvents(path, [read, readResult, bash, bashResult]);

      const res = pruneTools({ sdkSessionId: sessionId, minSize: 500, tools: ["bash"] });

      expect(res.pruned).toEqual([{ category: "tool", tool: "Bash", originalSize: JSON.stringify(blocks[0]).length }]);
      const after = readFileSync(path, "utf-8");
      expect(after).toContain("r".repeat(1000));
      expect(after).not.toContain("b".repeat(600));
    });
  });

  it("reports a session file that does not exist, and creates nothing", () => {
    const res = pruneTools({ sdkSessionId: sessionId, minSize: 500 });
    expect(res).toEqual({ success: false, pruned: [], totalCharsRemoved: 0, error: "Session file not found" });
    expect(existsSync(getCompactTriggerPath(sessionId))).toBe(false);
  });

  it("aborts with the session untouched when the archive cannot be written", () => {
    const { bigContent } = seedSession();
    const before = readFileSync(path, "utf-8");
    // A directory where the archive file should go: EISDIR for every uid.
    mkdirSync(archivePath, { recursive: true });

    try {
      const res = pruneTools({ sdkSessionId: sessionId, minSize: 500, archivePath });

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Could not archive the pre-prune snapshot .*session left unchanged/);
      expect(readFileSync(path, "utf-8")).toBe(before);
      expect(before).toContain(bigContent);
      expect(existsSync(getCompactTriggerPath(sessionId))).toBe(false);
    } finally {
      rmSync(archivePath, { recursive: true, force: true });
    }
  });
});
