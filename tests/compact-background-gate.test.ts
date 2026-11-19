/**
 * A compact/rollup must not run while the session has live background tasks.
 *
 * Every rewrite of a session file leaves a compact trigger, and the daemon
 * answers it by closing the live session at the end of the turn — which kills
 * any background subagent or shell the session is running. The reload cannot
 * simply wait for them: until it happens the in-memory session still holds the
 * pre-compact chain, and a turn run on it appends events parented on uuids the
 * compact removed (an orphaned chain the SDK loader drops). So the gate is at
 * the source: `tomo lcm <level|compact|prune-tools>` asks the daemon over the
 * watch socket and refuses, `lcm_rollup` refuses in-process (see
 * lcm-mcp-tools.test.ts), and the rollup runner does not even nudge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const paths = vi.hoisted(() => ({ root: "", sdkSessionsDir: "", sessionsDir: "", watchSocketPath: "" }));

vi.mock("../src/config.js", () => ({
  config: {
    lcm: { dailyFreshTail: 1, globalFreshTail: false },
    get sdkSessionsDir() { return paths.sdkSessionsDir; },
    get sessionsDir() { return paths.sessionsDir; },
  },
}));
vi.mock("../src/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime-paths.js")>()),
  defaultRuntimePaths: { get watchSocketPath() { return paths.watchSocketPath; } },
}));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/agent/sdk-options.js", () => ({ usesLcmCompact: () => true }));

const { WatchServer } = await import("../src/watch/server.js");
const { queryBackgroundTasks } = await import("../src/watch/background-query.js");
const { backgroundGateRefusal } = await import("../src/lcm/background-gate.js");
const { lcmCommand, LCM_DEFERRED_EXIT_CODE } = await import("../src/cli/lcm.js");
const { getSdkSessionPath } = await import("../src/sessions/index.js");
const { getCompactTriggerPath } = await import("../src/lcm/compact.js");
const { RollupRunner } = await import("../src/lcm/runner.js");
const { NudgeCooldownStore } = await import("../src/lcm/nudge-cooldown-store.js");
import type { WatchSnapshot } from "../src/watch/protocol.js";

function fakeSnapshot(): WatchSnapshot {
  return {
    protocolVersion: 1, pid: process.pid, startedAt: Date.now(), version: "0.0.0-test", model: "claude-test",
    channels: [], sessions: [], cron: [], nextHeartbeatAt: null, costTodayUsd: 0, costWeekUsd: 0,
    turnsToday: 0, recent: [], lastIssue: null,
  };
}

function mkEvent(type: "user" | "assistant", parentUuid: string | null, ts: string, text: string) {
  return {
    type, uuid: randomUUID(), parentUuid, timestamp: ts, isSidechain: false,
    message: { role: type, content: [{ type: "text", text }] },
  };
}

/** Two exchanges on 9/8 (the completed period) and one on 9/9 (the live tail). */
function writeSession(sessionId: string): string {
  const events: unknown[] = [];
  let parent: string | null = null;
  for (const [ts, text] of [
    [new Date(2026, 8, 8, 9, 0).toISOString(), "morning"],
    [new Date(2026, 8, 8, 9, 1).toISOString(), "reply one"],
    [new Date(2026, 8, 8, 17, 0).toISOString(), "evening"],
    [new Date(2026, 8, 8, 17, 1).toISOString(), "reply two"],
    [new Date(2026, 8, 9, 9, 0).toISOString(), "next day"],
    [new Date(2026, 8, 9, 9, 1).toISOString(), "reply three"],
  ] as const) {
    const ev = mkEvent(text.startsWith("reply") ? "assistant" : "user", parent, ts, text);
    events.push(ev);
    parent = ev.uuid;
  }
  const path = getSdkSessionPath(sessionId, paths.sdkSessionsDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

async function waitForSocket(path: string): Promise<void> {
  for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 10));
}

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) { super(`process.exit(${code})`); }
}

/** Run one `tomo lcm …` invocation; returns its exit code (0 when it returned normally) and stderr. */
async function runLcm(argv: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { stderr.push(a.join(" ")); });
  const out = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { stdout.push(a.join(" ")); });
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new ExitCalled(code); }) as never);
  try {
    await lcmCommand.parseAsync(argv, { from: "user" });
    return { code: 0, stderr: stderr.join("\n"), stdout: stdout.join("\n") };
  } catch (e) {
    if (e instanceof ExitCalled) return { code: e.code ?? 0, stderr: stderr.join("\n"), stdout: stdout.join("\n") };
    throw e;
  } finally {
    err.mockRestore();
    out.mockRestore();
    exit.mockRestore();
  }
}

describe("backgroundGateRefusal", () => {
  it("lets the rewrite through with no background tasks", () => {
    expect(backgroundGateRefusal(0)).toBeNull();
  });

  it("refuses with a readable, retryable reason while tasks run", () => {
    expect(backgroundGateRefusal(1, "daily rollup")).toMatchObject({
      status: "deferred",
      activeBackgroundTasks: 1,
      error: expect.stringContaining("1 background task is still running"),
    });
    expect(backgroundGateRefusal(3)!.error).toContain("retry after they finish");
  });
});

describe("tomo lcm background-task gate (over the watch socket)", () => {
  let server: InstanceType<typeof WatchServer> | null = null;
  let running: Record<string, number>;
  let sessionId: string;

  beforeEach(async () => {
    paths.root = mkdtempSync(join(tmpdir(), "tomo-bg-gate-"));
    paths.sdkSessionsDir = join(paths.root, "sdk");
    paths.sessionsDir = join(paths.root, "sessions");
    paths.watchSocketPath = join(paths.root, "watch.sock");
    mkdirSync(paths.sdkSessionsDir, { recursive: true });
    mkdirSync(paths.sessionsDir, { recursive: true });
    sessionId = `test-${randomUUID()}`;
    running = {};
    server = new WatchServer(paths.watchSocketPath, {
      getSnapshot: () => fakeSnapshot(),
      sendChat: async () => {},
      backgroundTaskCount: (sid) => running[sid] ?? 0,
    });
    server.start();
    await waitForSocket(paths.watchSocketPath);
  });

  afterEach(() => {
    server?.stop();
    server = null;
    rmSync(paths.root, { recursive: true, force: true });
  });

  it("the daemon answers the query with the session's live count", async () => {
    running[sessionId] = 2;
    expect(await queryBackgroundTasks(paths.watchSocketPath, sessionId)).toEqual({ status: "ok", count: 2 });
    expect(await queryBackgroundTasks(paths.watchSocketPath, "other")).toEqual({ status: "ok", count: 0 });
  });

  it("an older daemon (no backgroundTaskCount) reads as unsupported, not as a count", async () => {
    server!.stop();
    server = new WatchServer(paths.watchSocketPath, { getSnapshot: () => fakeSnapshot(), sendChat: async () => {} });
    server.start();
    await waitForSocket(paths.watchSocketPath);
    expect(await queryBackgroundTasks(paths.watchSocketPath, sessionId)).toEqual({ status: "unsupported" });
  });

  it("no daemon reads as unreachable", async () => {
    expect(await queryBackgroundTasks(join(paths.root, "missing.sock"), sessionId)).toEqual({ status: "unreachable" });
  });

  it("`tomo lcm daily` refuses while background tasks run and leaves the session untouched", async () => {
    const path = writeSession(sessionId);
    const before = readFileSync(path, "utf8");
    running[sessionId] = 1;

    const res = await runLcm(["daily", "--session-id", sessionId, "--date", "2026-09-08", "--summary", "9/8."]);

    expect(res.code).toBe(LCM_DEFERRED_EXIT_CODE);
    const body = JSON.parse(res.stderr);
    expect(body).toMatchObject({ status: "deferred", activeBackgroundTasks: 1 });
    expect(body.error).toContain("1 background task is still running");
    expect(readFileSync(path, "utf8")).toBe(before);
    // No trigger: nothing will reload — and so nothing will be killed.
    expect(existsSync(getCompactTriggerPath(sessionId, paths.sdkSessionsDir))).toBe(false);
  });

  it("`tomo lcm daily` proceeds as before with no background tasks", async () => {
    const path = writeSession(sessionId);
    const res = await runLcm(["daily", "--session-id", sessionId, "--date", "2026-09-08", "--summary", "9/8: two exchanges."]);
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ status: "ok", blockTag: "daily 2026-09-08", eventsRemoved: 4 });
    expect(readFileSync(path, "utf8")).toContain("9/8: two exchanges.");
    expect(existsSync(getCompactTriggerPath(sessionId, paths.sdkSessionsDir))).toBe(true);
  });

  it("`tomo lcm compact` and `prune-tools` are gated too; a prune dry run is not", async () => {
    const path = writeSession(sessionId);
    const before = readFileSync(path, "utf8");
    running[sessionId] = 2;

    const compact = await runLcm([
      "compact", "--session-id", sessionId,
      "--from-time", new Date(2026, 8, 8, 0, 0).toISOString(),
      "--to-time", new Date(2026, 8, 8, 23, 59).toISOString(),
      "--summary", "x",
    ]);
    expect(compact.code).toBe(LCM_DEFERRED_EXIT_CODE);
    expect(JSON.parse(compact.stderr).status).toBe("deferred");

    const prune = await runLcm(["prune-tools", "--session-id", sessionId]);
    expect(prune.code).toBe(LCM_DEFERRED_EXIT_CODE);

    const dry = await runLcm(["prune-tools", "--session-id", sessionId, "--dry-run"]);
    expect(dry.code).toBe(0);

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(getCompactTriggerPath(sessionId, paths.sdkSessionsDir))).toBe(false);
  });

  it("with no daemon running the rollup proceeds (no live session to reload)", async () => {
    server!.stop();
    server = null;
    writeSession(sessionId);
    const res = await runLcm(["daily", "--session-id", sessionId, "--date", "2026-09-08", "--summary", "9/8."]);
    expect(res.code, res.stderr).toBe(0);
    expect(existsSync(getCompactTriggerPath(sessionId, paths.sdkSessionsDir))).toBe(true);
  });
});

describe("rollup runner skips sessions with background tasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00"));
    paths.root = mkdtempSync(join(tmpdir(), "tomo-bg-gate-runner-"));
    paths.sdkSessionsDir = join(paths.root, "sdk");
    mkdirSync(paths.sdkSessionsDir, { recursive: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(paths.root, { recursive: true, force: true });
  });

  function runnerWith(count: () => number) {
    const nudges: string[] = [];
    const sessionId = `test-${randomUUID()}`;
    // A completed 8/27 with events: findDuePromotions reports it due.
    const path = getSdkSessionPath(sessionId, paths.sdkSessionsDir);
    mkdirSync(dirname(path), { recursive: true });
    let parent: string | null = null;
    const events: unknown[] = [];
    for (const [ts, text] of [
      [new Date(2026, 7, 27, 9, 0).toISOString(), "a"],
      [new Date(2026, 7, 27, 9, 1).toISOString(), "reply a"],
      [new Date(2026, 7, 28, 9, 0).toISOString(), "b"],
      [new Date(2026, 7, 28, 9, 1).toISOString(), "reply b"],
    ] as const) {
      const ev = mkEvent(text.startsWith("reply") ? "assistant" : "user", parent, ts, text);
      events.push(ev);
      parent = ev.uuid;
    }
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const agent = {
      listActiveSessions: () => [["dm:owner", sessionId]] as Array<[string, string]>,
      activeBackgroundTaskCount: (_key: string) => count(),
      handleCronMessage: async (text: string) => { nudges.push(text); return true; },
    };
    const runner = new RollupRunner(agent as never, new NudgeCooldownStore(null));
    const checkAll = () => (runner as unknown as { checkAll(): Promise<void> }).checkAll();
    return { nudges, checkAll };
  }

  it("does not nudge while tasks run, and nudges on the next tick once they finish", async () => {
    let count = 1;
    const { nudges, checkAll } = runnerWith(() => count);
    await checkAll();
    expect(nudges).toHaveLength(0);
    // No cooldown was armed by the skipped tick.
    count = 0;
    await checkAll();
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("daily 2026-08-27");
  });
});
