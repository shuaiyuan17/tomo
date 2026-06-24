import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  function pruneTools(req: PruneToolsRequest) {
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

  it("preserves complete lines appended after the snapshot boundary", () => {
    seedSession();
    // A complete event already on disk past the last event is picked up by
    // the late-splice read and must survive the rewrite. (Simulates the SDK
    // appending while the CLI prune process runs.)
    const late = mkUserEvent(null, "late append");
    appendFileSync(path, JSON.stringify(late) + "\n");

    const res = pruneTools({ sdkSessionId: sessionId, minSize: 500 });

    expect(res.success).toBe(true);
    const after = readFileSync(path, "utf-8");
    expect(after).toContain(late.uuid);
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
});
