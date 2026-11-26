import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { checkRewrittenChain, compactSessionChecked } from "../src/lcm/chain-check.js";
import { compactSession, getCompactTriggerPath, type CompactRequest } from "../src/lcm/compact.js";
import { loaderVisibleIds, removedLoaderIds } from "../src/lcm/loader-ids.js";
import { getSdkSessionPath } from "../src/sessions/index.js";
import { isRawJsonlLine } from "../src/jsonl.js";
import { sdkSessionsDirForWorkspace } from "../src/runtime-paths.js";

/**
 * Contract test for the LCM rewrite against the INSTALLED SDK's loader — no
 * mock. `getSessionMessages` rebuilds the parentUuid chain the agent resumes
 * on; if an SDK upgrade changes how it reads a rewritten transcript (follows
 * a different link, drops `isCompactSummary` events, needs a new field), the
 * first test here fails at upgrade time instead of a live session silently
 * losing its summary blocks.
 */

let root: string;
let home: string;
let sdkSessionsDir: string;
let sessionsDir: string;

/** A workspace under the temp root, with its SDK project dir created. */
function workspaceAt(name: string): { workspace: string; sdkDir: string } {
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true });
  const sdkDir = sdkSessionsDirForWorkspace(workspace, home);
  mkdirSync(sdkDir, { recursive: true });
  return { workspace, sdkDir };
}

let workspace: string;

beforeEach(() => {
  // realpath: on macOS tmpdir() is a /var symlink and the SDK resolves `dir` through it.
  root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-lcm-chain-")));
  home = join(root, "home");
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  ({ workspace, sdkDir: sdkSessionsDir } = workspaceAt("workspace"));
  sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  sessionId: string;
  text: string;
  /** Conversation-relative range of day 1 (what the rollup replaces). */
  fromIdx: number;
  toIdx: number;
  firstUuid: string;
  lastUuid: string;
  oldBlockUuid: string;
  day1Uuids: string[];
  tailUuids: string[];
  /** File uuid of the day-1 queued_command attachment (with `queuedCommandInDay1`). */
  queuedFileUuid?: string;
}

/**
 * A transcript shaped like a live LCM session: an older summary block at the
 * head, one day of conversation with thinking, tool use and results, the
 * SDK's bookkeeping records (attachment, queue-operation, last-prompt)
 * between the messages, then the next day's fresh tail.
 */
function buildFixture(sessionId = randomUUID(), cwd = "/workspace", opts: { queuedCommandInDay1?: boolean; metaCopyInTail?: boolean } = {}): Fixture {
  const lines: string[] = [];
  let parent: string | null = null;
  let n = 0;
  const convUuids: string[] = [];
  const envelope = { isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd, sessionId, version: "2.1.329", gitBranch: "main" };
  const at = (day: number, i: number) => new Date(2026, 10, day, 9, 0, i).toISOString();
  const push = (record: Record<string, unknown>) => { lines.push(JSON.stringify(record)); };
  const msg = (type: "user" | "assistant", day: number, content: unknown, extra: Record<string, unknown> = {}) => {
    const uuid = randomUUID();
    n++;
    push({
      parentUuid: parent, ...envelope, type, uuid, timestamp: at(day, n), ...extra,
      message: type === "assistant"
        ? { model: "claude-opus-5-5", id: `msg_${n}`, type: "message", role: "assistant", content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
        : { role: "user", content },
    });
    parent = uuid;
    convUuids.push(uuid);
    return uuid;
  };
  const attachment = (day: number) => {
    const uuid = randomUUID();
    push({ parentUuid: parent, ...envelope, type: "attachment", attachment: { type: "date", date: at(day, 0).slice(0, 10) }, uuid, timestamp: at(day, ++n) });
    parent = uuid;
  };
  // A message typed while a turn was running: the SDK records it as a
  // queued_command attachment, and its loader turns that into a user message
  // whose uuid is the attachment's source_uuid, not the event's own uuid.
  let queuedFileUuid: string | undefined;
  let queuedSourceUuid: string | undefined;
  const queuedCommand = (day: number, prompt: string) => {
    const uuid = randomUUID();
    const sourceUuid = randomUUID();
    queuedSourceUuid = sourceUuid;
    push({
      parentUuid: parent, ...envelope, type: "attachment", uuid, timestamp: at(day, ++n),
      attachment: { type: "queued_command", prompt, source_uuid: sourceUuid, commandMode: "prompt" },
    });
    parent = uuid;
    queuedFileUuid = uuid;
    return sourceUuid;
  };

  const oldBlockUuid = msg("user", 18, "[daily 2026-11-18 — 12 events summarized]\n\nEarlier day.", { isCompactSummary: true, blockTag: "daily 2026-11-18" });

  const day1: string[] = [];
  attachment(19);
  day1.push(msg("user", 19, "Check the release notes."));
  day1.push(msg("assistant", 19, [{ type: "thinking", thinking: "Read them first.", signature: "sig" }, { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/repo/CHANGELOG.md" } }]));
  day1.push(msg("user", 19, [{ type: "tool_result", tool_use_id: "toolu_01", content: "## 0.14.0" }], { toolUseResult: { type: "text" } }));
  push({ type: "queue-operation", operation: "enqueue", timestamp: at(19, ++n), sessionId });
  // Delivered mid-turn, answered by the reply that follows: the loader shows it.
  if (opts.queuedCommandInDay1) day1.push(queuedCommand(19, "Also check the migration guide."));
  day1.push(msg("assistant", 19, [{ type: "text", text: "0.14.0 is the latest." }]));
  day1.push(msg("user", 19, "Thanks."));
  day1.push(msg("assistant", 19, [{ type: "text", text: "Any time." }]));
  push({ type: "last-prompt", lastPrompt: "Thanks.", sessionId });

  const tail: string[] = [];
  attachment(20);
  tail.push(msg("user", 20, "Morning."));
  if (opts.metaCopyInTail && queuedSourceUuid) {
    // An isMeta queued_command (kept, in the tail) with the same source_uuid:
    // the loader never converts it, so it must not stand in for the removed one.
    const uuid = randomUUID();
    push({
      parentUuid: parent, ...envelope, type: "attachment", uuid, timestamp: at(20, ++n),
      attachment: { type: "queued_command", prompt: "meta", source_uuid: queuedSourceUuid, isMeta: true, commandMode: "prompt" },
    });
    parent = uuid;
  }
  tail.push(msg("assistant", 20, [{ type: "tool_use", id: "toolu_02", name: "Bash", input: { command: "date" } }]));
  tail.push(msg("user", 20, [{ type: "tool_result", tool_use_id: "toolu_02", content: "Fri Nov 20" }], { toolUseResult: { type: "text" } }));
  tail.push(msg("assistant", 20, [{ type: "text", text: "Good morning — it is Friday." }]));

  const fromIdx = convUuids.indexOf(day1[0]);
  const toIdx = convUuids.indexOf(day1[day1.length - 1]);
  return {
    sessionId, text: lines.join("\n") + "\n", fromIdx, toIdx,
    firstUuid: day1[0], lastUuid: day1[day1.length - 1], oldBlockUuid, day1Uuids: day1, tailUuids: tail, queuedFileUuid,
  };
}

function writeFixture(f: Fixture, dir = sdkSessionsDir): string {
  const path = getSdkSessionPath(f.sessionId, dir);
  writeFileSync(path, f.text);
  return path;
}

function request(f: Fixture, extra: Partial<CompactRequest> = {}, dir = sdkSessionsDir): CompactRequest {
  return {
    sdkSessionId: f.sessionId,
    sdkSessionsDir: dir,
    fromIdx: f.fromIdx,
    toIdx: f.toIdx,
    expectedFirstUuid: f.firstUuid,
    expectedLastUuid: f.lastUuid,
    summary: "Release notes checked: 0.14.0 is the latest.",
    transcriptPath: join(sessionsDir, `_archive_${f.sessionId}.jsonl`),
    blockTag: "daily 2026-11-19",
    ...extra,
  };
}

const chain = async (sessionId: string, dir = workspace) => (await getSessionMessages(sessionId, { dir })).map((m) => m.uuid);

/** The summary event the rewrite wrote (the one with the new block tag). */
function summaryUuidIn(path: string): string {
  const event = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.blockTag === "daily 2026-11-19");
  return event.uuid;
}

/**
 * Undo the rewrite's parentUuid re-pointing: every event that hangs off the
 * new summary goes back to pointing at the last removed event, which no
 * longer exists — exactly the bug the check exists for.
 */
function breakRepointing(f: Fixture): CompactRequest["corruptRewriteForTest"] {
  return (events) => {
    const summary = events.find((e) => !isRawJsonlLine(e) && e.blockTag === "daily 2026-11-19");
    if (!summary || isRawJsonlLine(summary)) throw new Error("fixture: no summary");
    for (const e of events) if (!isRawJsonlLine(e) && e.parentUuid === summary.uuid) e.parentUuid = f.lastUuid;
  };
}

/** Nothing left behind: no staging files beside the session, no verify dirs beside the project. */
function expectNoLeftovers() {
  expect(readdirSync(sdkSessionsDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(readdirSync(dirname(sdkSessionsDir)).filter((name) => name.includes("-lcm-verify-"))).toEqual([]);
}

/** A refused rewrite: original bytes, no trigger, nothing archived, nothing left behind. */
function expectUntouched(f: Fixture, path: string) {
  expect(readFileSync(path, "utf8")).toBe(f.text);
  expect(existsSync(getCompactTriggerPath(f.sessionId, sdkSessionsDir))).toBe(false);
  expect(existsSync(join(sessionsDir, `_archive_${f.sessionId}.jsonl`))).toBe(false);
  expectNoLeftovers();
}

describe("LCM rewrite, checked by the SDK's own loader before it is published", () => {
  it("contract: the loader sees [older block, new summary, fresh tail] after one rollup", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    expect(await chain(f.sessionId)).toEqual([f.oldBlockUuid, ...f.day1Uuids, ...f.tailUuids]);

    const result = await compactSessionChecked(request(f), { workspaceDir: workspace });

    expect(result).toMatchObject({ success: true });
    const summaryUuid = summaryUuidIn(path);
    const messages = await getSessionMessages(f.sessionId, { dir: workspace });
    expect(messages.map((m) => m.uuid)).toEqual([f.oldBlockUuid, summaryUuid, ...f.tailUuids]);
    const summary = messages[1].message as { content: string };
    expect(summary.content).toContain("[daily 2026-11-19 — ");
    expect(summary.content).toContain("Release notes checked");
    expect(existsSync(getCompactTriggerPath(f.sessionId, sdkSessionsDir))).toBe(true);
    expectNoLeftovers();
  });

  it("refuses at the publication gate once its signal is aborted (shutdown): the file is untouched", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    const ac = new AbortController();
    const result = await compactSessionChecked(request(f), {
      workspaceDir: workspace, signal: ac.signal,
      loadChain: async (id, dir) => { const m = await getSessionMessages(id, { dir }); if (dir !== workspace) ac.abort(); return m; },
    });
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/Aborted/);
    expect(readFileSync(path, "utf8")).toBe(f.text);
    expect(existsSync(getCompactTriggerPath(f.sessionId, sdkSessionsDir))).toBe(false);
  });

  it("the loader really loses the summary when re-pointing is skipped (what the check guards against)", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    // The unchecked rewrite, with the same break: it reports success.
    const result = compactSession(request(f, { corruptRewriteForTest: breakRepointing(f) }));
    expect(result.success).toBe(true);
    const after = await chain(f.sessionId);
    expect(after).not.toContain(summaryUuidIn(path));
    expect(after).not.toContain(f.oldBlockUuid);
    expect(after).toEqual(f.tailUuids);
  });

  it("red/green: broken re-pointing is refused before publish and the file stays byte-identical", async () => {
    const f = buildFixture();
    const path = writeFixture(f);

    const result = await compactSessionChecked(
      request(f, { corruptRewriteForTest: breakRepointing(f) }),
      { workspaceDir: workspace },
    );

    expect(result.success).toBe(false);
    expect(result.eventsRemoved).toBe(0);
    expect(result.error).toMatch(/Chain check failed, rewrite not published/);
    expect(result.error).toMatch(/summary block is not on the loaded chain/);
    expect(result.error).toMatch(/before the summary dropped/);
    expectUntouched(f, path);
  });

  it("splices lines the SDK appends while the check runs, like any other late append", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    const lateUuid = randomUUID();
    const late = JSON.stringify({
      parentUuid: f.tailUuids[f.tailUuids.length - 1], type: "user", uuid: lateUuid, isSidechain: false,
      sessionId: f.sessionId, timestamp: new Date(2026, 10, 20, 10).toISOString(), message: { role: "user", content: "One more thing." },
    }) + "\n";
    let calls = 0;
    const result = await compactSessionChecked(request(f), {
      workspaceDir: workspace,
      loadChain: async (sid, dir) => {
        if (++calls === 2) appendFileSync(path, late); // the live turn writes during the staged check
        return getSessionMessages(sid, { dir });
      },
    });

    expect(result.success).toBe(true);
    expect(readFileSync(path, "utf8").endsWith(late)).toBe(true);
    expect(await chain(f.sessionId)).toEqual([f.oldBlockUuid, summaryUuidIn(path), ...f.tailUuids, lateUuid]);
  });

  it("re-checks after splicing late lines, and refuses when they move the leaf off the summary", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    // A late line that starts a new root: the loader's leaf is now on another branch.
    const late = JSON.stringify({
      parentUuid: null, type: "user", uuid: randomUUID(), isSidechain: false,
      sessionId: f.sessionId, timestamp: new Date(2026, 10, 20, 10).toISOString(), message: { role: "user", content: "Detached." },
    }) + "\n";
    let calls = 0;
    const result = await compactSessionChecked(request(f), {
      workspaceDir: workspace,
      loadChain: async (sid, dir) => {
        if (++calls === 2) appendFileSync(path, late);
        return getSessionMessages(sid, { dir });
      },
    });

    expect(calls).toBe(3); // live read, staged check, re-check of the spliced output
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/summary block is not on the loaded chain/);
    // Only the SDK's own append happened; the rewrite published nothing.
    expect(readFileSync(path, "utf8")).toBe(f.text + late);
    expect(existsSync(getCompactTriggerPath(f.sessionId, sdkSessionsDir))).toBe(false);
    expectNoLeftovers();
  });

  it("refuses to publish when the session file was replaced during validation", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    const replacement = buildFixture(f.sessionId).text;
    let calls = 0;
    const result = await compactSessionChecked(request(f), {
      workspaceDir: workspace,
      loadChain: async (sid, dir) => {
        if (++calls === 2) { // another rewriter swaps the file in while the staged copy is checked
          writeFileSync(`${path}.other`, replacement);
          renameSync(`${path}.other`, path);
        }
        return getSessionMessages(sid, { dir });
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/replaced during validation/);
    expect(readFileSync(path, "utf8")).toBe(replacement);
    expect(existsSync(getCompactTriggerPath(f.sessionId, sdkSessionsDir))).toBe(false);
    expect(existsSync(join(sessionsDir, `_archive_${f.sessionId}.jsonl`))).toBe(false);
  });

  it("sweeps only its own stale verify dirs, never a real project dir with a similar name", async () => {
    const projects = dirname(sdkSessionsDir);
    const base = sdkSessionsDir.slice(projects.length + 1);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const make = (name: string, marker: boolean) => {
      const dir = join(projects, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${randomUUID()}.jsonl`), "{}\n");
      if (marker) writeFileSync(join(dir, ".tomo-lcm-verify"), "");
      utimesSync(dir, old, old);
      return dir;
    };
    const hex = "0123456789abcdef0123456789abcdef";
    const realLookalike = make(`${base}-lcm-verify-client`, false);
    const realWithMarker = make(`${base}-lcm-verify-client`.replace("client", "client2"), true);
    const unmarked = make(`${base}-lcm-verify-${hex}`, false);
    const ours = make(`${base}-lcm-verify-${hex.replace("0", "f")}`, true);

    const f = buildFixture();
    writeFixture(f);
    expect((await compactSessionChecked(request(f), { workspaceDir: workspace })).success).toBe(true);

    expect(existsSync(realLookalike)).toBe(true);
    expect(existsSync(realWithMarker)).toBe(true);
    expect(existsSync(unmarked)).toBe(true);
    expect(existsSync(ours)).toBe(false);
  });

  it("happy path writes exactly what the unchecked rewrite writes", async () => {
    const sessionId = randomUUID();
    const a = workspaceAt("plain");
    const b = workspaceAt("checked");
    const f = buildFixture(sessionId);
    writeFixture(f, a.sdkDir);
    writeFixture(f, b.sdkDir);

    expect(compactSession(request(f, {}, a.sdkDir)).success).toBe(true);
    expect((await compactSessionChecked(request(f, {}, b.sdkDir), { workspaceDir: b.workspace })).success).toBe(true);

    // The summary uuid is random per run; everything else must match byte for byte.
    const plainPath = getSdkSessionPath(sessionId, a.sdkDir);
    const checkedPath = getSdkSessionPath(sessionId, b.sdkDir);
    const plain = readFileSync(plainPath, "utf8").replaceAll(summaryUuidIn(plainPath), "SUMMARY");
    const checked = readFileSync(checkedPath, "utf8").replaceAll(summaryUuidIn(checkedPath), "SUMMARY");
    expect(checked).toBe(plain);
  });

  it("fails closed when the loader cannot see the session", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    // A workspace the SDK resolves to a different project dir: it finds nothing.
    const result = await compactSessionChecked(request(f), { workspaceDir: join(root, "elsewhere") });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Chain check unavailable, rewrite not published: the SDK loader sees no messages/);
    expectUntouched(f, path);
  });

  // The first load reads the live session, the second the staged rewrite.
  it.each([
    ["before staging (the live session's read)", 1],
    ["after staging (the staged rewrite's read)", 2],
  ])("fails closed when the loader throws %s", async (_label, failingCall) => {
    const f = buildFixture();
    const path = writeFixture(f);
    let calls = 0;
    const result = await compactSessionChecked(request(f), {
      workspaceDir: workspace,
      loadChain: async (sid, dir) => {
        if (++calls === failingCall) throw new Error("loader exploded");
        return getSessionMessages(sid, { dir });
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/loader exploded/);
    expectUntouched(f, path);
  });

  it("fails closed when the staged rewrite loads as nothing", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    let calls = 0;
    const result = await compactSessionChecked(request(f), {
      workspaceDir: workspace,
      loadChain: async (sid, dir) => (++calls === 2 ? [] : getSessionMessages(sid, { dir })),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sees no messages in the staged rewrite/);
    expectUntouched(f, path);
  });

  it("a queued_command inside the range: the loader's id for it is its source_uuid, and the rollup passes", async () => {
    const f = buildFixture(undefined, undefined, { queuedCommandInDay1: true });
    const path = writeFixture(f);
    // The loader shows the attachment as a user message under its source_uuid.
    const sourceUuid = f.day1Uuids[3];
    expect(sourceUuid).not.toBe(f.queuedFileUuid);
    expect(await chain(f.sessionId)).toEqual([f.oldBlockUuid, ...f.day1Uuids, ...f.tailUuids]);

    const result = await compactSessionChecked(request(f), { workspaceDir: workspace });

    expect(result).toMatchObject({ success: true });
    expect(await chain(f.sessionId)).toEqual([f.oldBlockUuid, summaryUuidIn(path), ...f.tailUuids]);
    expect(readFileSync(path, "utf8")).not.toContain(sourceUuid);
  });

  it.each([
    ["", { queuedCommandInDay1: true }],
    [" (an isMeta queued_command with the same source_uuid in the tail does not mask it)", { queuedCommandInDay1: true, metaCopyInTail: true }],
  ] as const)("a removed queued_command that stays on the chain is refused%s", async (_label, opts) => {
    const f = buildFixture(undefined, undefined, opts);
    const path = writeFixture(f);
    if ("metaCopyInTail" in opts) {
      // The meta copy is not shown: the live chain is unchanged by it.
      expect(await chain(f.sessionId)).toEqual([f.oldBlockUuid, ...f.day1Uuids, ...f.tailUuids]);
    }
    const original = f.text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.uuid === f.queuedFileUuid);
    // Broken removal: the attachment survives, moved into the fresh tail where
    // a reply follows it, so the loader still shows it (under its source_uuid).
    const result = await compactSessionChecked(request(f, {
      corruptRewriteForTest: (events) => {
        const at = events.findIndex((e) => !isRawJsonlLine(e) && e.uuid === f.tailUuids[0]);
        const next = events.find((e) => !isRawJsonlLine(e) && e.parentUuid === f.tailUuids[0]);
        if (at < 0 || !next || isRawJsonlLine(next)) throw new Error("fixture: no tail");
        next.parentUuid = original.uuid;
        events.splice(at + 1, 0, { ...original, parentUuid: f.tailUuids[0] });
      },
    }), { workspaceDir: workspace });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/1 removed event\(s\) still on the chain/);
    expectUntouched(f, path);
  });

  it("refuses a range that is not on the current chain", async () => {
    // Day 1 becomes a dead branch: the next day's first message hangs off the older block.
    const f = buildFixture();
    const lines = f.text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const tailHead = lines.find((e) => e.uuid === f.tailUuids[0]);
    const tailAttachment = lines.find((e) => e.uuid === tailHead.parentUuid);
    tailAttachment.parentUuid = f.oldBlockUuid;
    f.text = lines.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const path = writeFixture(f);
    expect(await chain(f.sessionId)).toEqual([f.oldBlockUuid, ...f.tailUuids]);

    const result = await compactSessionChecked(request(f), { workspaceDir: workspace });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/the selected range is not on the current chain/);
    expectUntouched(f, path);
  });
});

describe("checkRewrittenChain", () => {
  const removed = new Set(["r1", "r2"]);
  const check = (after: string[], before = ["h1", "r1", "r2", "t1", "t2"]) =>
    checkRewrittenChain({ before, after, summaryUuid: "S", removedIds: removed });

  it("accepts the collapsed chain, with appends at the end", () => {
    expect(check(["h1", "S", "t1", "t2"]).ok).toBe(true);
    expect(check(["h1", "S", "t1", "t2", "late"]).ok).toBe(true);
  });

  it("flags a missing summary, an orphaned tail, a removed event left behind, and reordering", () => {
    expect(check(["t1", "t2"]).problems).toEqual(expect.arrayContaining([
      "summary block is not on the loaded chain", "1 event(s) before the summary dropped off the chain",
    ]));
    expect(check(["h1", "S", "t2"])).toMatchObject({ ok: false, tailExpected: 2, tailFound: 1 });
    expect(check(["h1", "r2", "S", "t1", "t2"]).problems).toContain("1 removed event(s) still on the chain");
    expect(check(["h1", "S", "t2", "t1"]).problems).toContain("surviving events are out of their original order");
  });

  it("requires the summary even when the range was not on the chain, and flags that range", () => {
    const verdict = check(["h1", "t1"], ["h1", "t1"]);
    expect(verdict.problems).toEqual(expect.arrayContaining([
      "the selected range is not on the current chain", "summary block is not on the loaded chain",
    ]));
  });
});

describe("loaderVisibleIds / removedLoaderIds", () => {
  const queued = (uuid: string, source_uuid?: string, extra: Record<string, unknown> = {}) =>
    ({ type: "attachment", uuid, attachment: { type: "queued_command", prompt: "p", ...(source_uuid === undefined ? {} : { source_uuid }), ...extra } });

  it("maps a convertible queued_command to its source_uuid and everything else to its uuid", () => {
    const events = [{ type: "user", uuid: "u1" }, queued("a1", "src1"), queued("a2", ""), { type: "attachment", uuid: "a3", attachment: { type: "date" } }];
    expect(loaderVisibleIds(events)).toEqual(["u1", "src1", "a2", "a3"]);
  });

  it("keeps the own uuid for a queued_command the loader does not convert", () => {
    expect(loaderVisibleIds([
      queued("m1", "s1", { isMeta: true }),
      queued("f1", "s2", { forwardedIntent: { lineage: "x" } }),
      queued("p1", "s3", { prompt: 42 }),
      { type: "user", uuid: "u1" }, queued("c1", "u1"), // source_uuid collides with another event
      queued("d1", "s4"), queued("d2", "s4"), // the first copy takes the id
    ])).toEqual(["m1", "f1", "p1", "u1", "c1", "s4", "d2"]);
  });

  it("converts an isMeta queued_command whose origin the loader keeps", () => {
    expect(loaderVisibleIds([queued("m1", "s1", { isMeta: true, origin: { kind: "channel" } })])).toEqual(["s1"]);
  });

  it("an isMeta copy does not mask the removed one, and a collision does not mask a removed user message", () => {
    expect(removedLoaderIds([queued("a1", "s1"), queued("m1", "s1", { isMeta: true })], (i) => i === 0).has("s1")).toBe(true);
    expect(removedLoaderIds([{ type: "user", uuid: "u1" }, queued("c1", "u1")], (i) => i === 0).has("u1")).toBe(true);
    expect(removedLoaderIds([{ type: "user", uuid: "u1" }, queued("c1", "u1")], (i) => i === 1)).toEqual(new Set(["c1"]));
  });
});
