import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  compactSession, readSinceOffset, readWholeFile,
  checkAndClearCompactTrigger, getCompactTriggerPath,
} from "../src/lcm/compact.js";
import { getSdkSessionPath } from "../src/sessions/index.js";
import {
  writeFileSync, mkdirSync, unlinkSync, existsSync, appendFileSync, readFileSync, statSync,
  openSync, writeSync, closeSync, rmSync, readdirSync,
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

function mkSummaryEvent(parentUuid: string | null, ts: string, text: string, blockTag?: string) {
  return {
    ...mkUserEvent(parentUuid, ts, text),
    isCompactSummary: true,
    ...(blockTag ? { blockTag } : {}),
  };
}

describe("checkAndClearCompactTrigger", () => {
  let sdkSessionsDir: string;
  let sessionId: string;

  beforeEach(() => {
    sessionId = `test-trigger-${randomUUID()}`;
    sdkSessionsDir = join(tmpdir(), `tomo-test-trigger-${randomUUID()}`);
    mkdirSync(sdkSessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sdkSessionsDir, { recursive: true, force: true });
  });

  it("clears an existing trigger and returns true", () => {
    const triggerPath = getCompactTriggerPath(sessionId, sdkSessionsDir);
    writeFileSync(triggerPath, new Date().toISOString());

    expect(checkAndClearCompactTrigger(sessionId, sdkSessionsDir)).toBe(true);
    expect(existsSync(triggerPath)).toBe(false);
  });

  it("returns false without throwing when no trigger exists", () => {
    // Also covers the TOCTOU race: a concurrent caller clearing the trigger
    // between check and unlink must look like "no trigger", not an error.
    expect(checkAndClearCompactTrigger(sessionId, sdkSessionsDir)).toBe(false);
    expect(checkAndClearCompactTrigger(sessionId, sdkSessionsDir)).toBe(false);
  });
});

describe("readWholeFile", () => {
  let path: string;

  beforeEach(() => {
    path = join(tmpdir(), `compact-whole-${randomUUID()}.jsonl`);
  });

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it("returns text + exact byte count when the file ends with a newline", () => {
    const e1 = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "hello");
    writeFileSync(path, JSON.stringify(e1) + "\n");
    const expected = statSync(path).size;
    const { text, size, hasPartialTail } = readWholeFile(path);
    expect(size).toBe(expected);
    expect(text).toContain(e1.uuid);
    expect(hasPartialTail).toBe(false);
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

  it("stops at last-newline boundary and flags partial tail", () => {
    // If the file ends with a partial in-flight write, size must point at
    // the last-newline+1 (NOT current EOF) so the partial sits outside the
    // snapshot and the late-splice loop can re-detect it.
    const e1 = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "first");
    writeFileSync(path, JSON.stringify(e1) + "\n");
    const offsetAfterE1 = statSync(path).size;
    appendFileSync(path, '{"type":"user","uuid":"in-flight","par');

    const { text, size, hasPartialTail } = readWholeFile(path);
    expect(size).toBe(offsetAfterE1);
    expect(size).toBeLessThan(statSync(path).size);
    expect(text).toContain(e1.uuid);
    expect(text).not.toContain("in-flight");
    expect(hasPartialTail).toBe(true);
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
    expect(r.hasPartialTail).toBe(false);
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
    expect(r.hasPartialTail).toBe(false);
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
    // Caller must see the partial flag so it can wait/abort instead of
    // proceeding to a destructive rewrite.
    expect(r.hasPartialTail).toBe(true);
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
    expect(r.hasPartialTail).toBe(true);
  });
});

describe("compactSession", () => {
  let sessionId: string;
  let path: string;
  let archivePath: string;
  let sdkSessionsDir: string;

  beforeEach(() => {
    sessionId = `test-compact-${randomUUID()}`;
    sdkSessionsDir = join(tmpdir(), `tomo-test-compact-sdk-${randomUUID()}`);
    path = getSdkSessionPath(sessionId, sdkSessionsDir);
    archivePath = join(tmpdir(), `archive-${sessionId}.jsonl`);
  });

  afterEach(() => {
    rmSync(sdkSessionsDir, { recursive: true, force: true });
    if (existsSync(archivePath)) unlinkSync(archivePath);
  });

  /** Any staging file left beside the session file — the name is per-call. */
  const stagingLeftovers = () =>
    (existsSync(dirname(path)) ? readdirSync(dirname(path)) : [])
      .filter((f) => f.includes(".compacting.tmp"));

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
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 3,
      expectedFirstUuid: events[1].uuid,
      expectedLastUuid: events[3].uuid,
      summary: "compacted middle",
      transcriptPath: archivePath,
    });

    expect(result.success).toBe(true);
    expect(result.eventsAfter).toBe(3);
    expect(stagingLeftovers()).toEqual([]);

    const out = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(out).toHaveLength(3);
    expect(out[1].isCompactSummary).toBe(true);
    // Chain still walks: event 4's parent should now be the summary
    expect(out[2].parentUuid).toBe(out[1].uuid);
  });

  it("aborts cleanly when the first range anchor is stale", () => {
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
    const initialContent = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, initialContent);

    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 3,
      expectedFirstUuid: randomUUID(),
      expectedLastUuid: events[3].uuid,
      summary: "should not be applied",
      transcriptPath: archivePath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Range anchors moved (file rewritten since range resolution); re-resolve the range and retry");
    expect(readFileSync(path, "utf-8")).toBe(initialContent);
    expect(existsSync(archivePath)).toBe(false);
  });

  it("verifies the last range anchor when it is the only anchor provided", () => {
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
    const initialContent = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, initialContent);

    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 3,
      expectedLastUuid: randomUUID(),
      summary: "should not be applied",
      transcriptPath: archivePath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Range anchors moved (file rewritten since range resolution); re-resolve the range and retry");
    expect(readFileSync(path, "utf-8")).toBe(initialContent);
    expect(existsSync(archivePath)).toBe(false);
  });

  it("aborts cleanly when blockTag expansion would swallow another summary block", () => {
    const oldMonthly = mkSummaryEvent(null, "2026-04-30T00:00:00.000Z", "old April", "monthly 2026-04");
    const dailyMay = mkSummaryEvent(oldMonthly.uuid, "2026-05-01T00:00:00.000Z", "May day", "daily 2026-05-01");
    const raw1 = mkUserEvent(dailyMay.uuid, "2026-05-02T00:00:00.000Z", "raw 1");
    const raw2 = mkAssistantEvent(raw1.uuid, "2026-05-02T00:01:00.000Z", "raw 2");
    const events = [oldMonthly, dailyMay, raw1, raw2];
    mkdirSync(dirname(path), { recursive: true });
    const initialContent = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, initialContent);

    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 2,
      toIdx: 3,
      summary: "should not be applied",
      transcriptPath: archivePath,
      blockTag: "monthly 2026-04",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('unrelated summary block "daily 2026-05-01"');
    expect(readFileSync(path, "utf-8")).toBe(initialContent);
    expect(existsSync(archivePath)).toBe(false);
  });

  it("still expands across a blockTag gap that contains only raw events", () => {
    const oldMonthly = mkSummaryEvent(null, "2026-04-30T00:00:00.000Z", "old April", "monthly 2026-04");
    const gap1 = mkUserEvent(oldMonthly.uuid, "2026-05-01T00:00:00.000Z", "raw gap 1");
    const gap2 = mkAssistantEvent(gap1.uuid, "2026-05-01T00:01:00.000Z", "raw gap 2");
    const raw1 = mkUserEvent(gap2.uuid, "2026-05-02T00:00:00.000Z", "raw 1");
    const raw2 = mkAssistantEvent(raw1.uuid, "2026-05-02T00:01:00.000Z", "raw 2");
    const events = [oldMonthly, gap1, gap2, raw1, raw2];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 3,
      toIdx: 4,
      summary: "rebuilt April",
      transcriptPath: archivePath,
      blockTag: "monthly 2026-04",
    });

    expect(result.success).toBe(true);
    const out = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(out).toHaveLength(1);
    expect(out[0].isCompactSummary).toBe(true);
    expect(out[0].blockTag).toBe("monthly 2026-04");
    expect(out[0].message.content).toContain("[monthly 2026-04");
  });

  it("allows differently tagged summary blocks inside the requested range", () => {
    const daily1 = mkSummaryEvent(null, "2026-05-04T00:00:00.000Z", "Mon", "daily 2026-05-04");
    const daily2 = mkSummaryEvent(daily1.uuid, "2026-05-05T00:00:00.000Z", "Tue", "daily 2026-05-05");
    const rawAfter = mkUserEvent(daily2.uuid, "2026-05-06T00:00:00.000Z", "after");
    const events = [daily1, daily2, rawAfter];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 0,
      toIdx: 1,
      summary: "weekly rollup",
      transcriptPath: archivePath,
      blockTag: "weekly 2026-W19",
    });

    expect(result.success).toBe(true);
    const out = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(out).toHaveLength(2);
    expect(out[0].isCompactSummary).toBe(true);
    expect(out[0].blockTag).toBe("weekly 2026-W19");
    expect(out[1].uuid).toBe(rawAfter.uuid);
  });

  it("aborts (does not rename) when the file ends in a partial SDK write", () => {
    // The race we're guarding against: SDK is mid-append in a separate
    // process when compactSession runs. If we rename the temp over the
    // original while the file ends in partial bytes, those bytes are gone
    // (the SDK re-opens the path on next append, finds the new inode, and
    // never gets to flush the rest of its in-flight write to the old one).
    //
    // The simulation: we never complete the partial. After 8 retry passes
    // (~35ms wall), compactSession should abort cleanly: original file
    // intact, no .compacting.tmp leftover, success === false.
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
    const initialContent = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, initialContent);
    // Append a partial line that never completes — simulates SDK mid-write.
    const partial = '{"type":"assistant","uuid":"in-flight","par';
    appendFileSync(path, partial);
    const sizeBefore = statSync(path).size;

    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 3,
      summary: "should not be applied",
      transcriptPath: archivePath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/partial/i);
    // Original file untouched — partial bytes still there for SDK to finish.
    expect(statSync(path).size).toBe(sizeBefore);
    expect(readFileSync(path, "utf-8").endsWith(partial)).toBe(true);
    // No leftover tmp file from a failed rename attempt.
    expect(stagingLeftovers()).toEqual([]);
    // No archive side effect — caller can retry without duplicate transcript.
    expect(existsSync(archivePath)).toBe(false);
  });

  it("stages under a per-call temp name, so a parallel compact cannot clobber the rename", () => {
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

    const sharedName = path + ".compacting.tmp";
    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 3,
      summary: "compacted middle",
      transcriptPath: archivePath,
      // A second `tomo lcm` staging its own output at the same instant. With
      // one fixed staging name it writes into the very file this call is about
      // to rename into place, and the rename publishes the OTHER process's
      // bytes over the session — losing the whole conversation.
      beforeRenameForTest: () => {
        writeFileSync(sharedName, JSON.stringify({ clobbered: true }) + "\n");
      },
    });

    expect(result.success).toBe(true);
    const out = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(out).toHaveLength(3);
    expect(out.some((e) => e.clobbered)).toBe(false);
    expect(out[1].isCompactSummary).toBe(true);
    if (existsSync(sharedName)) unlinkSync(sharedName);
  });

  it("archives nothing when the rewrite fails after the archive point", () => {
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

    // The session directory disappears between staging and rename (the shape
    // of any late failure: ENOSPC, EACCES, a cleanup racing the write). The
    // compact never commits — so nothing may have been archived, or the retry
    // writes those events into the transcript a second time.
    expect(() => compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 3,
      summary: "never committed",
      transcriptPath: archivePath,
      beforeRenameForTest: () => {
        rmSync(sdkSessionsDir, { recursive: true, force: true });
      },
    })).toThrow();

    expect(existsSync(archivePath)).toBe(false);
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
      sdkSessionsDir,
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

  it("drains appends that land on the old inode after the final tail read", () => {
    const e0 = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "user 0");
    const e1 = mkAssistantEvent(e0.uuid, "2026-04-30T00:01:00.000Z", "thinking");
    const e2 = mkAssistantEvent(e1.uuid, "2026-04-30T00:02:00.000Z", "tool_use");
    const e3 = mkUserEvent(e2.uuid, "2026-04-30T00:03:00.000Z", "tool_result");
    const e4 = mkAssistantEvent(e3.uuid, "2026-04-30T00:04:00.000Z", "post-range");
    const late = mkAssistantEvent(e2.uuid, "2026-04-30T00:05:00.000Z", "late tool_use");
    const events = [e0, e1, e2, e3, e4];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 3,
      summary: "removed tool chain",
      transcriptPath: archivePath,
      beforeRenameForTest: () => {
        const sdkFd = openSync(path, "a");
        try {
          writeSync(sdkFd, JSON.stringify(late) + "\n");
        } finally {
          closeSync(sdkFd);
        }
      },
    });

    expect(result.success).toBe(true);
    expect(result.eventsAfter).toBe(4);
    const out = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(out).toHaveLength(4);
    const summary = out[1];
    const drainedLate = out[3];
    expect(drainedLate.uuid).toBe(late.uuid);
    // The late event pointed at a removed UUID, so the old-inode drain must
    // re-parent it exactly like the pre-rename late-splice loop does.
    expect(drainedLate.parentUuid).toBe(summary.uuid);
  });

  it("drains writes from an SDK fd that survives the compact rename", () => {
    const e0 = mkUserEvent(null, "2026-04-30T00:00:00.000Z", "user 0");
    const e1 = mkAssistantEvent(e0.uuid, "2026-04-30T00:01:00.000Z", "thinking");
    const e2 = mkAssistantEvent(e1.uuid, "2026-04-30T00:02:00.000Z", "tool_use");
    const e3 = mkUserEvent(e2.uuid, "2026-04-30T00:03:00.000Z", "tool_result");
    const e4 = mkAssistantEvent(e3.uuid, "2026-04-30T00:04:00.000Z", "post-range");
    const late = mkAssistantEvent(e2.uuid, "2026-04-30T00:05:00.000Z", "late through old fd");
    const events = [e0, e1, e2, e3, e4];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    let sdkFd: number | null = null;
    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 3,
      summary: "removed tool chain",
      transcriptPath: archivePath,
      beforeRenameForTest: () => {
        sdkFd = openSync(path, "a");
      },
      afterRenameForTest: () => {
        expect(sdkFd).not.toBeNull();
        writeSync(sdkFd as number, JSON.stringify(late) + "\n");
        closeSync(sdkFd as number);
        sdkFd = null;
      },
    });

    if (sdkFd !== null) closeSync(sdkFd);
    expect(result.success).toBe(true);
    expect(result.eventsAfter).toBe(4);
    const out = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(out).toHaveLength(4);
    const summary = out[1];
    const drainedLate = out[3];
    expect(drainedLate.uuid).toBe(late.uuid);
    expect(drainedLate.parentUuid).toBe(summary.uuid);
  });
});
