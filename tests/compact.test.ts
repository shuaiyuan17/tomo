import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compactSession, readSinceOffset, readWholeFile } from "../src/lcm/compact.js";
import { getSdkSessionPath } from "../src/sessions/index.js";
import {
  writeFileSync, mkdirSync, unlinkSync, existsSync, appendFileSync, readFileSync, statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

function mkUserEvent(parentUuid: string | null, ts: string, text: string) {
  return {
    type: "user",
    uuid: randomUUID(),
    parentUuid,
    timestamp: ts,
    isSidechain: false,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function mkAssistantEvent(parentUuid: string | null, ts: string, text: string) {
  return {
    type: "assistant",
    uuid: randomUUID(),
    parentUuid,
    timestamp: ts,
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

describe("readWholeFile", () => {
  let path: string;

  beforeEach(() => {
    path = join(tmpdir(), `compact-whole-${randomUUID()}.jsonl`);
  });

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it("returns text + exact byte count of what was read", () => {
    const e1 = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "hello");
    writeFileSync(path, JSON.stringify(e1) + "\n");
    const expected = statSync(path).size;
    const { text, size } = readWholeFile(path);
    expect(size).toBe(expected);
    expect(text).toContain(e1.uuid);
  });

  it("returns size that exactly bounds what readSinceOffset will skip", () => {
    // The whole point of readWholeFile is to give a cursor that prevents
    // duplication. Writing more bytes after, then calling readSinceOffset
    // with the captured size, must return ONLY the new bytes.
    const e1 = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "first");
    writeFileSync(path, JSON.stringify(e1) + "\n");
    const { size } = readWholeFile(path);

    const e2 = mkAssistantEvent(e1.uuid, "2026-04-30T00:01:00.000Z", "second");
    appendFileSync(path, JSON.stringify(e2) + "\n");

    const late = readSinceOffset(path, size);
    expect(late.events).toHaveLength(1);
    expect(late.events[0].uuid).toBe(e2.uuid);
  });
});

describe("readSinceOffset", () => {
  let path: string;

  beforeEach(() => {
    path = join(tmpdir(), `compact-since-${randomUUID()}.jsonl`);
  });

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it("returns no events and unchanged readUpTo when nothing was appended", () => {
    const e = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "hello");
    writeFileSync(path, JSON.stringify(e) + "\n");
    const offset = statSync(path).size;
    const r = readSinceOffset(path, offset);
    expect(r.events).toEqual([]);
    expect(r.readUpTo).toBe(offset);
  });

  it("returns events and an exact read-up-to offset for complete bytes", () => {
    const e1 = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "first");
    writeFileSync(path, JSON.stringify(e1) + "\n");
    const offset = statSync(path).size;

    const e2 = mkAssistantEvent(e1.uuid, "2026-04-30T00:01:00.000Z", "reply");
    const e3 = mkUserEvent(e2.uuid, "2026-04-30T00:02:00.000Z", "second");
    appendFileSync(path, JSON.stringify(e2) + "\n" + JSON.stringify(e3) + "\n");

    const r = readSinceOffset(path, offset);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].uuid).toBe(e2.uuid);
    expect(r.events[1].uuid).toBe(e3.uuid);
    expect(r.readUpTo).toBe(statSync(path).size);
  });

  it("does NOT advance readUpTo past a trailing partial line", () => {
    // Critical: if a mid-write partial sits at the tail, the cursor must
    // stay before it so a subsequent pass can re-read once the SDK flushes
    // the rest. Advancing to current EOF would lose the in-flight event.
    const e1 = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "first");
    writeFileSync(path, JSON.stringify(e1) + "\n");
    const offset = statSync(path).size;

    const e2 = mkAssistantEvent(e1.uuid, "2026-04-30T00:01:00.000Z", "ok");
    const completeAppend = JSON.stringify(e2) + "\n";
    appendFileSync(path, completeAppend);
    const offsetAfterE2 = offset + Buffer.byteLength(completeAppend, "utf-8");
    const partial = '{"type":"user","uuid":"abc","par';
    appendFileSync(path, partial);

    const r = readSinceOffset(path, offset);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].uuid).toBe(e2.uuid);
    expect(r.readUpTo).toBe(offsetAfterE2);
    // Specifically: readUpTo must NOT equal the current file size (which
    // includes the partial bytes). Otherwise the partial gets clobbered.
    expect(r.readUpTo).toBeLessThan(statSync(path).size);
  });

  it("returns readUpTo === offset when the entire tail is one partial line", () => {
    // No complete line at all in the tail → caller must not advance cursor.
    const e1 = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "first");
    writeFileSync(path, JSON.stringify(e1) + "\n");
    const offset = statSync(path).size;

    appendFileSync(path, '{"type":"user","uuid":"abc","par');

    const r = readSinceOffset(path, offset);
    expect(r.events).toEqual([]);
    expect(r.readUpTo).toBe(offset);
  });
});

describe("compactSession", () => {
  let sessionId: string;
  let path: string;
  let archivePath: string;

  beforeEach(() => {
    sessionId = `test-compact-${randomUUID()}`;
    path = getSdkSessionPath(sessionId);
    archivePath = join(tmpdir(), `archive-${sessionId}.jsonl`);
  });

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
    if (existsSync(archivePath)) unlinkSync(archivePath);
    const trigger = path.replace(".jsonl", ".compact-trigger");
    if (existsSync(trigger)) unlinkSync(trigger);
    const tmp = path + ".compacting.tmp";
    if (existsSync(tmp)) unlinkSync(tmp);
  });

  it("writes atomically via rename — no .compacting.tmp leftover on success", () => {
    const events: any[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 5; i++) {
      const ts = `2026-04-30T0${i}:00:00.000Z`;
      const e = i % 2 === 0
        ? mkUserEvent(parent, ts, `msg ${i}`)
        : mkAssistantEvent(parent, ts, `reply ${i}`);
      events.push(e);
      parent = e.uuid;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = compactSession({
      sdkSessionId: sessionId,
      fromIdx: 1,
      toIdx: 3,
      summary: "compacted middle",
      transcriptPath: archivePath,
    });

    expect(result.success).toBe(true);
    expect(result.eventsAfter).toBe(3);
    expect(existsSync(path + ".compacting.tmp")).toBe(false);

    const out = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(out).toHaveLength(3);
    expect(out[1].isCompactSummary).toBe(true);
    // Chain still walks: event 4's parent should now be the summary
    expect(out[2].parentUuid).toBe(out[1].uuid);
  });

  it("re-stitches parentUuid on post-range events whose parent was removed", () => {
    // Build a chain where events 1..3 form a tool-use sub-chain and event 4
    // points back into the middle (a tool_result whose parent is in the range).
    const e0 = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "user 0");
    const e1 = mkAssistantEvent(e0.uuid, "2026-04-30T00:01:00.000Z", "thinking");
    const e2 = mkAssistantEvent(e1.uuid, "2026-04-30T00:02:00.000Z", "tool_use");
    const e3 = mkUserEvent(e2.uuid, "2026-04-30T00:03:00.000Z", "tool_result");
    // e4's parent is e2 (which will be removed) — must get rewritten to summary
    const e4 = mkAssistantEvent(e2.uuid, "2026-04-30T00:04:00.000Z", "post-range");
    const events = [e0, e1, e2, e3, e4];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = compactSession({
      sdkSessionId: sessionId,
      fromIdx: 1,
      toIdx: 3,
      summary: "removed tool chain",
      transcriptPath: archivePath,
    });

    expect(result.success).toBe(true);
    const out = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(out).toHaveLength(3);
    const summary = out[1];
    const post = out[2];
    expect(summary.isCompactSummary).toBe(true);
    // e4's parent was e2 (removed) → should now point at the summary
    expect(post.parentUuid).toBe(summary.uuid);
  });
});
