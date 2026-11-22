import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { checkRewrittenChain, compactSessionChecked } from "../src/lcm/chain-check.js";
import { compactSession, getCompactTriggerPath, type CompactRequest } from "../src/lcm/compact.js";
import { getSdkSessionPath } from "../src/sessions/index.js";
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
}

/**
 * A transcript shaped like a live LCM session: an older summary block at the
 * head, one day of conversation with thinking, tool use and results, the
 * SDK's bookkeeping records (attachment, queue-operation, last-prompt)
 * between the messages, then the next day's fresh tail.
 */
function buildFixture(sessionId = randomUUID(), cwd = "/workspace"): Fixture {
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

  const oldBlockUuid = msg("user", 18, "[daily 2026-11-18 — 12 events summarized]\n\nEarlier day.", { isCompactSummary: true, blockTag: "daily 2026-11-18" });

  const day1: string[] = [];
  attachment(19);
  day1.push(msg("user", 19, "Check the release notes."));
  day1.push(msg("assistant", 19, [{ type: "thinking", thinking: "Read them first.", signature: "sig" }, { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/repo/CHANGELOG.md" } }]));
  day1.push(msg("user", 19, [{ type: "tool_result", tool_use_id: "toolu_01", content: "## 0.14.0" }], { toolUseResult: { type: "text" } }));
  push({ type: "queue-operation", operation: "enqueue", timestamp: at(19, ++n), sessionId });
  day1.push(msg("assistant", 19, [{ type: "text", text: "0.14.0 is the latest." }]));
  day1.push(msg("user", 19, "Thanks."));
  day1.push(msg("assistant", 19, [{ type: "text", text: "Any time." }]));
  push({ type: "last-prompt", lastPrompt: "Thanks.", sessionId });

  const tail: string[] = [];
  attachment(20);
  tail.push(msg("user", 20, "Morning."));
  tail.push(msg("assistant", 20, [{ type: "tool_use", id: "toolu_02", name: "Bash", input: { command: "date" } }]));
  tail.push(msg("user", 20, [{ type: "tool_result", tool_use_id: "toolu_02", content: "Fri Nov 20" }], { toolUseResult: { type: "text" } }));
  tail.push(msg("assistant", 20, [{ type: "text", text: "Good morning — it is Friday." }]));

  const fromIdx = convUuids.indexOf(day1[0]);
  const toIdx = convUuids.indexOf(day1[day1.length - 1]);
  return {
    sessionId, text: lines.join("\n") + "\n", fromIdx, toIdx,
    firstUuid: day1[0], lastUuid: day1[day1.length - 1], oldBlockUuid, day1Uuids: day1, tailUuids: tail,
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
 * Undo the rewrite's parentUuid re-pointing in the published file: every
 * event that now hangs off the summary goes back to pointing at the last
 * removed event, which no longer exists — exactly the bug the check exists for.
 */
function breakRepointing(path: string, f: Fixture): () => void {
  return () => {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const summary = lines.find((e) => e.blockTag === "daily 2026-11-19");
    for (const e of lines) if (e.parentUuid === summary.uuid) e.parentUuid = f.lastUuid;
    writeFileSync(path, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };
}

const leftovers = (dir = sdkSessionsDir) => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

describe("LCM rewrite, read back by the SDK's own loader", () => {
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
    // Nothing left behind but the reload trigger.
    expect(leftovers()).toEqual([]);
    expect(existsSync(getCompactTriggerPath(f.sessionId, sdkSessionsDir))).toBe(true);
  });

  it("the loader really loses the summary when re-pointing is skipped (what the check guards against)", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    // The unchecked rewrite, with the same break: it reports success.
    const result = compactSession(request(f, { afterRenameForTest: breakRepointing(path, f) }));
    expect(result.success).toBe(true);
    const after = await chain(f.sessionId);
    expect(after).not.toContain(summaryUuidIn(path));
    expect(after).not.toContain(f.oldBlockUuid);
    expect(after).toEqual(f.tailUuids);
  });

  it("red/green: broken re-pointing is caught, rolled back to the exact pre-rewrite bytes, and reported", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    const before = await chain(f.sessionId);

    const result = await compactSessionChecked(
      request(f, { afterRenameForTest: breakRepointing(path, f) }),
      { workspaceDir: workspace },
    );

    expect(result.success).toBe(false);
    expect(result.eventsRemoved).toBe(0);
    expect(result.error).toMatch(/Chain check failed/);
    expect(result.error).toMatch(/summary block is not on the loaded chain/);
    expect(result.error).toMatch(/fresh tail broken|before the summary dropped/);
    expect(result.error).toMatch(/restored to its pre-rewrite state/);
    expect(readFileSync(path, "utf8")).toBe(f.text);
    expect(await chain(f.sessionId)).toEqual(before);
    // No half-done state: no reload trigger, no backup or staging file.
    expect(existsSync(getCompactTriggerPath(f.sessionId, sdkSessionsDir))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("a retry after a rollback succeeds and archives no event twice", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    await compactSessionChecked(request(f, { afterRenameForTest: breakRepointing(path, f) }), { workspaceDir: workspace });
    const archive = join(sessionsDir, `_archive_${f.sessionId}.jsonl`);
    const archivedUuids = () => readFileSync(archive, "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l).uuid).filter((uuid): uuid is string => typeof uuid === "string");
    const once = archivedUuids();
    expect(once).toEqual(expect.arrayContaining(f.day1Uuids));

    const retry = await compactSessionChecked(request(f), { workspaceDir: workspace });

    expect(retry.success).toBe(true);
    // Records without a uuid (queue-operation) are re-archived by design; nothing with one is.
    expect(archivedUuids()).toEqual(once);
    expect(await chain(f.sessionId)).toEqual([f.oldBlockUuid, summaryUuidIn(path), ...f.tailUuids]);
  });

  it("rollback keeps lines the SDK appended to the published file while the check ran", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    const late = JSON.stringify({
      parentUuid: f.tailUuids[f.tailUuids.length - 1], type: "user", uuid: randomUUID(), isSidechain: false,
      sessionId: f.sessionId, timestamp: new Date(2026, 10, 20, 10).toISOString(), message: { role: "user", content: "One more thing." },
    }) + "\n";
    let calls = 0;
    const result = await compactSessionChecked(
      request(f, { afterRenameForTest: breakRepointing(path, f) }),
      {
        workspaceDir: workspace,
        loadChain: async (sid, dir) => {
          if (++calls === 2) appendFileSync(path, late); // the live turn writes during the check
          return getSessionMessages(sid, { dir });
        },
      },
    );

    expect(result.success).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(f.text + late);
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

  it("runs unchecked, as before, when the loader cannot see the session", async () => {
    const f = buildFixture();
    const path = writeFixture(f);
    // A workspace the SDK resolves to a different project dir: it finds nothing.
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const result = await compactSessionChecked(request(f), { workspaceDir: elsewhere });
    expect(result.success).toBe(true);
    expect(await chain(f.sessionId)).toEqual([f.oldBlockUuid, summaryUuidIn(path), ...f.tailUuids]);
  });
});

describe("checkRewrittenChain", () => {
  const removed = new Set(["r1", "r2"]);
  const check = (after: string[], before = ["h1", "r1", "r2", "t1", "t2"]) =>
    checkRewrittenChain({ before, after, summaryUuid: "S", removedUuids: removed });

  it("accepts the collapsed chain, with late appends at the end", () => {
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
});
