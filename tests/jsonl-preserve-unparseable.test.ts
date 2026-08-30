import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseJsonl, isRawJsonlLine, serializeJsonlRecord, reportRawJsonlLines, RAW_JSONL_REWARN_MS } from "../src/jsonl.js";
import { computeContextStats, resolveTimeRange } from "../src/lcm/stats.js";
import { vi } from "vitest";
import { compactSession } from "../src/lcm/compact.js";
import { pruneTools } from "../src/lcm/prune-tools.js";
import { getSdkSessionPath } from "../src/sessions/index.js";
import { SessionStore } from "../src/sessions/store.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

/** A mid-file torn line: a power loss cut it, a later append landed behind it,
 *  so hasPartialTail no longer sees it and every rewrite used to delete it. */
const TORN = '{"type":"assistant","uuid":"torn-1","message":{"role":"assis';

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

describe("parseJsonl", () => {
  const text = '{"a":1}\n' + TORN + '\n{"b":2}\n';

  it("drops unparseable lines by default (read-only consumers)", () => {
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("carries unparseable lines through in position when asked", () => {
    const records = parseJsonl(text, { preserveUnparseable: true });
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({ a: 1 });
    expect(isRawJsonlLine(records[1])).toBe(true);
    expect(records[2]).toEqual({ b: 2 });
  });

  it("round-trips every content-bearing line exactly", () => {
    const out = parseJsonl(text, { preserveUnparseable: true })
      .map(serializeJsonlRecord)
      .join("\n") + "\n";
    expect(out).toBe(text);
  });

  it("drops blank lines in both modes (per-line fidelity, not whole-file)", () => {
    // JSONL has no semantics for blank lines and the SDK never writes them.
    // Documented rather than preserved.
    const withBlanks = '{"a":1}\n\n' + TORN + "\n\n";
    const out = parseJsonl(withBlanks, { preserveUnparseable: true })
      .map(serializeJsonlRecord)
      .join("\n") + "\n";
    expect(out).toBe('{"a":1}\n' + TORN + "\n");
  });

  it("carries a line that is valid JSON but not an object", () => {
    // `null` is the dangerous one: it parses, so it used to be handed out as a
    // record, and every `evt.type` read on it throws. A bare number or string
    // is equally un-rewritable. All are carried instead.
    const scalars = 'null\n42\n"hello"\n{"real":true}\n';
    const records = parseJsonl(scalars, { preserveUnparseable: true });
    expect(records.map(isRawJsonlLine)).toEqual([true, true, true, false]);
    expect(records.map(serializeJsonlRecord).join("\n") + "\n").toBe(scalars);
    // Read-only mode is unchanged: it still hands `null` out, as before.
    expect(parseJsonl(scalars)).toEqual([null, 42, "hello", { real: true }]);
  });

  it("carries an array line — valid JSON, but not a record either", () => {
    const text = '{"a":1}\n[1,2,3]\n{"b":2}\n';
    const records = parseJsonl(text, { preserveUnparseable: true });
    expect(isRawJsonlLine(records[1])).toBe(true);
    expect(serializeJsonlRecord(records[1])).toBe("[1,2,3]");
    expect(parseJsonl(text)).toEqual([{ a: 1 }, [1, 2, 3], { b: 2 }]);   // read-only: still a value
  });

  it("preserves when the flag is a non-literal boolean that happens to be true", () => {
    const flag: boolean = process.env.TOMO_NEVER_SET === undefined;
    const records = parseJsonl(text, { preserveUnparseable: flag });
    expect(records.some(isRawJsonlLine)).toBe(true);
  });

  it("warns once per (file, line) and again only after 24h; dry runs go to debug and do not count", () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    let clock = 1_000_000;
    const now = () => clock;
    const records = parseJsonl(text, { preserveUnparseable: true });

    expect(reportRawJsonlLines(records, { sessionId: "s-dedupe" }, { logger, now })).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    reportRawJsonlLines(records, { sessionId: "s-dedupe" }, { logger, now });
    expect(logger.warn).toHaveBeenCalledTimes(1);           // same line, same file: not again
    expect(logger.debug).toHaveBeenCalledTimes(1);

    reportRawJsonlLines(records, { sessionId: "s-other" }, { logger, now });
    expect(logger.warn).toHaveBeenCalledTimes(2);           // a different file: its own warning

    clock += RAW_JSONL_REWARN_MS + 1;
    reportRawJsonlLines(records, { sessionId: "s-dedupe" }, { logger, now });
    expect(logger.warn).toHaveBeenCalledTimes(3);           // re-warned after the window

    // A dry run (the per-turn nudge check) never warns and never marks.
    logger.warn.mockClear(); logger.debug.mockClear();
    reportRawJsonlLines(records, { sessionId: "s-dry" }, { logger, now, dryRun: true });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    reportRawJsonlLines(records, { sessionId: "s-dry" }, { logger, now });
    expect(logger.warn).toHaveBeenCalledTimes(1);           // the real run still warns
  });

  it("reports each carried line and returns the count", () => {
    expect(reportRawJsonlLines(parseJsonl(text, { preserveUnparseable: true }), { op: "test" })).toBe(1);
    expect(reportRawJsonlLines(parseJsonl('{"a":1}\n'), { op: "test" })).toBe(0);
  });

  it("never lets a carried line stringify as an empty object", () => {
    const [raw] = parseJsonl(TORN, { preserveUnparseable: true });
    // A symbol key is invisible to JSON.stringify, so a raw line that leaked
    // into a plain stringify would silently become "{}" — worse than dropping.
    expect(JSON.stringify(raw)).toBe("{}");
    expect(serializeJsonlRecord(raw)).toBe(TORN);
  });
});

describe("compactSession preserves unparseable lines", () => {
  let sessionId: string;
  let sdkSessionsDir: string;
  let path: string;
  let archivePath: string;

  beforeEach(() => {
    sessionId = `test-compact-raw-${randomUUID()}`;
    sdkSessionsDir = join(tmpdir(), `tomo-test-compact-raw-${randomUUID()}`);
    mkdirSync(sdkSessionsDir, { recursive: true });
    path = getSdkSessionPath(sessionId, sdkSessionsDir);
    archivePath = join(sdkSessionsDir, "transcript.jsonl");
  });

  afterEach(() => {
    rmSync(sdkSessionsDir, { recursive: true, force: true });
  });

  function seed(tornAt: number) {
    const events = [
      mkUserEvent(null, "2026-04-01T00:00:00.000Z", "one"),
      mkAssistantEvent(null, "2026-04-01T00:00:01.000Z", "two"),
      mkUserEvent(null, "2026-04-01T00:00:02.000Z", "three"),
      mkAssistantEvent(null, "2026-04-01T00:00:03.000Z", "four"),
      mkUserEvent(null, "2026-04-01T00:00:04.000Z", "five"),
    ];
    for (let i = 1; i < events.length; i++) events[i].parentUuid = events[i - 1].uuid;
    const lines = events.map((e) => JSON.stringify(e));
    lines.splice(tornAt, 0, TORN);
    writeFileSync(path, lines.join("\n") + "\n");
    return events;
  }

  it("keeps a torn line that sits inside the compacted range", () => {
    const events = seed(2); // between conversation events 1 and 2
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

    const after = readFileSync(path, "utf-8").trimEnd().split("\n");
    expect(after).toContain(TORN);
    // The surviving conversation events are all still there...
    expect(after.some((l) => l.includes(events[0].uuid))).toBe(true);
    expect(after.some((l) => l.includes(events[4].uuid))).toBe(true);
    // ...and the torn line was NOT archived as if it had been summarized.
    expect(readFileSync(archivePath, "utf-8")).not.toContain("torn-1");
    // Everything still parses, plus the one line that never did.
    expect(parseJsonl(readFileSync(path, "utf-8"))).toHaveLength(after.length - 1);
  });

  it("survives and preserves a bare `null` line mid-file", () => {
    const events = [
      mkUserEvent(null, "2026-04-01T00:00:00.000Z", "one"),
      mkAssistantEvent(null, "2026-04-01T00:00:01.000Z", "two"),
      mkUserEvent(null, "2026-04-01T00:00:02.000Z", "three"),
    ];
    for (let i = 1; i < events.length; i++) events[i].parentUuid = events[i - 1].uuid;
    const lines = events.map((e) => JSON.stringify(e));
    lines.splice(1, 0, "null");
    writeFileSync(path, lines.join("\n") + "\n");

    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 2,
      expectedFirstUuid: events[1].uuid,
      expectedLastUuid: events[2].uuid,
      summary: "compacted",
      transcriptPath: archivePath,
    });

    expect(result.success).toBe(true);
    expect(readFileSync(path, "utf-8").trimEnd().split("\n")).toContain("null");
  });

  it("drops the torn line only when --drop-unparseable is asked for", () => {
    const events = seed(2);
    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 3,
      expectedFirstUuid: events[1].uuid,
      expectedLastUuid: events[3].uuid,
      summary: "compacted middle",
      transcriptPath: archivePath,
      dropUnparseable: true,
    });
    expect(result.success).toBe(true);
    expect(readFileSync(path, "utf-8")).not.toContain("torn-1");
  });

  it("keeps a torn line that sits outside the compacted range", () => {
    const events = seed(5); // after the last conversation event
    const result = compactSession({
      sdkSessionId: sessionId,
      sdkSessionsDir,
      fromIdx: 1,
      toIdx: 2,
      expectedFirstUuid: events[1].uuid,
      expectedLastUuid: events[2].uuid,
      summary: "compacted middle",
      transcriptPath: archivePath,
    });
    expect(result.success).toBe(true);

    const after = readFileSync(path, "utf-8").trimEnd().split("\n");
    expect(after).toContain(TORN);
    expect(after.some((l) => l.includes(events[0].uuid))).toBe(true);
    expect(after.some((l) => l.includes(events[3].uuid))).toBe(true);
    expect(after.some((l) => l.includes(events[4].uuid))).toBe(true);
  });
});

describe("pruneTools preserves unparseable lines", () => {
  let sessionId: string;
  let sdkSessionsDir: string;
  let path: string;

  beforeEach(() => {
    sessionId = `test-prune-raw-${randomUUID()}`;
    sdkSessionsDir = join(tmpdir(), `tomo-test-prune-raw-${randomUUID()}`);
    mkdirSync(sdkSessionsDir, { recursive: true });
    path = getSdkSessionPath(sessionId, sdkSessionsDir);
  });

  afterEach(() => {
    rmSync(sdkSessionsDir, { recursive: true, force: true });
  });

  it("keeps the torn line and prunes everything else as before", () => {
    const bigContent = "x".repeat(1000);
    const use = {
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: null,
      timestamp: "2026-06-09T00:00:00.000Z",
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] },
    };
    const result = {
      type: "user",
      uuid: randomUUID(),
      parentUuid: use.uuid,
      timestamp: "2026-06-09T00:00:01.000Z",
      isSidechain: false,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: bigContent }] },
    };
    const tail = mkUserEvent(result.uuid, "2026-06-09T00:00:02.000Z", "thanks");
    writeFileSync(path, [JSON.stringify(use), TORN, JSON.stringify(result), JSON.stringify(tail)].join("\n") + "\n");

    const res = pruneTools({ sdkSessionId: sessionId, sdkSessionsDir, minSize: 500 });
    expect(res.success).toBe(true);
    expect(res.pruned).toHaveLength(1);

    const after = readFileSync(path, "utf-8").trimEnd().split("\n");
    expect(after).toContain(TORN);
    expect(after).toHaveLength(4);
    expect(after.join("\n")).not.toContain(bigContent);
    expect(after.join("\n")).toContain("[pruned");
    // Position preserved: still the second line, between the tool_use and the
    // tool_result it was torn between.
    expect(after[1]).toBe(TORN);
  });
});

describe("transcript rotation preserves unparseable lines", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `tomo-test-rotate-raw-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the torn line in the active file instead of dropping it", () => {
    const key = "telegram:1";
    const file = join(dir, "telegram_1.jsonl");
    const old = Date.parse("2020-01-15T00:00:00.000Z");
    const now = Date.now();
    const msg = (timestamp: number, content: string) => JSON.stringify({
      role: "user", content, channel: "telegram", timestamp,
    });

    writeFileSync(file, [
      msg(old, "ancient one"),
      TORN,
      msg(old, "ancient two"),
      msg(now, "recent"),
    ].join("\n") + "\n");

    // rotateBytes below the file size forces rotation on first get().
    const store = new SessionStore(dir, 20, join(dir, "sdk-sessions"), { rotateBytes: 1 });
    store.get(key);

    const after = readFileSync(file, "utf-8").trimEnd().split("\n");
    expect(after).toContain(TORN);
    // The two prior-month messages rolled into the archive...
    const archive = readFileSync(join(dir, "_archive_telegram_1_2020-01.jsonl"), "utf-8");
    expect(archive).toContain("ancient one");
    expect(archive).toContain("ancient two");
    // ...and the current-month message plus the torn line stayed behind.
    expect(after.join("\n")).toContain("recent");
    expect(after).toHaveLength(2);
  });
});

describe("read-only consumers survive non-object lines", () => {
  const dir = join(tmpdir(), `tomo-jsonl-stats-${randomUUID()}`);
  beforeEach(() => mkdirSync(dir, { recursive: true }));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("computeContextStats and resolveTimeRange skip null and array lines instead of throwing", () => {
    const sid = randomUUID();
    const u = mkUserEvent(null, "2026-03-28T16:30:00.000Z", "hello");
    const a = mkAssistantEvent(u.uuid, "2026-03-28T16:31:00.000Z", "hi");
    writeFileSync(getSdkSessionPath(sid, dir), [
      "null", JSON.stringify(u), "[1,2]", JSON.stringify(a), "42", "",
    ].join("\n"));
    const stats = computeContextStats(sid, dir);
    expect(stats?.totalMessages).toBe(2);
    const range = resolveTimeRange(sid, "2026-03-28T00:00", "2026-03-28T23:59", dir);
    expect(range).toEqual({ fromIdx: 0, toIdx: 1, firstUuid: u.uuid, lastUuid: a.uuid });
  });

  it("the rollup subcommands expose --drop-unparseable like compact and prune-tools", async () => {
    const { lcmCommand } = await import("../src/cli/lcm.js");
    for (const name of ["daily", "weekly", "monthly", "yearly", "compact", "prune-tools"]) {
      const cmd = lcmCommand.commands.find((c) => c.name() === name);
      expect(cmd, name).toBeDefined();
      expect(cmd!.options.some((o) => o.long === "--drop-unparseable"), name).toBe(true);
    }
  });
});
