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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const paths = vi.hoisted(() => ({ root: "", sdkSessionsDir: "", workspaceDir: "", sessionsDir: "", watchSocketPath: "", pidFile: "" }));

vi.mock("../src/config.js", () => ({
  config: {
    lcm: { dailyFreshTail: 1, globalFreshTail: false },
    get sdkSessionsDir() { return paths.sdkSessionsDir; },
    get workspaceDir() { return paths.workspaceDir; },
    get sessionsDir() { return paths.sessionsDir; },
  },
}));
vi.mock("../src/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime-paths.js")>()),
  defaultRuntimePaths: {
    get watchSocketPath() { return paths.watchSocketPath; },
    get pidFile() { return paths.pidFile; },
  },
}));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/agent/sdk-options.js", () => ({ usesLcmCompact: () => true }));

const { WatchServer } = await import("../src/watch/server.js");
const { reserveCompact } = await import("../src/watch/background-query.js");
const { compactRefusal } = await import("../src/lcm/background-gate.js");
const { CompactReservations } = await import("../src/agent/compact-reservations.js");
import { createServer, createConnection, type Server } from "node:net";
import type { CompactReservation } from "../src/lcm/background-gate.js";
const { lcmCommand, LCM_DEFERRED_EXIT_CODE } = await import("../src/cli/lcm.js");
const { getSdkSessionPath } = await import("../src/sessions/index.js");
const { getCompactTriggerPath } = await import("../src/lcm/compact.js");
const { RollupRunner } = await import("../src/lcm/runner.js");
const { NudgeCooldownStore } = await import("../src/lcm/nudge-cooldown-store.js");
import type { WatchSnapshot } from "../src/watch/protocol.js";
import { sdkSessionsDirForWorkspace } from "../src/runtime-paths.js";

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

describe("compactRefusal", () => {
  it("reads as a retryable reason for each refusal", () => {
    const state = { activeBackgroundTasks: 1, awaitingTaskReport: false };
    expect(compactRefusal({ ok: false, key: "k", reason: "background-tasks", state }, "daily rollup")).toMatchObject({
      status: "deferred",
      activeBackgroundTasks: 1,
      error: expect.stringContaining("1 background task is still running"),
    });
    expect(compactRefusal({ ok: false, key: "k", reason: "awaiting-task-report", state: { ...state, activeBackgroundTasks: 0 } }).error)
      .toContain("has not been reported");
    expect(compactRefusal({ ok: false, key: "k", reason: "background-tasks", state: { ...state, activeBackgroundTasks: 3 } }).error)
      .toContain("retry after they finish");
  });
});

/** A daemon stand-in: the real WatchServer, gated by real CompactReservations. */
function startDaemon(state: { tasks: number; awaitingReport: boolean }) {
  const reservations = new CompactReservations(
    (_key, sid) => existsSync(getCompactTriggerPath(sid, paths.sdkSessionsDir)),
  );
  const KEY = "dm:owner";
  const server = new WatchServer(paths.watchSocketPath, {
    getSnapshot: () => fakeSnapshot(),
    sendChat: async () => {},
    compactGate: {
      reserve: (sdkSessionId): CompactReservation => {
        const r = reservations.reserve(KEY, sdkSessionId, { activeBackgroundTasks: state.tasks, awaitingTaskReport: state.awaitingReport, backgroundingInFlight: 0 });
        return r.ok ? { ok: true, key: KEY, reservationId: r.reservationId } : { ...r, key: KEY };
      },
      finish: (r) => { if (r.ok && r.key && r.reservationId) reservations.finish(r.key, r.reservationId); },
    },
  });
  server.start();
  return { server, reservations, KEY };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe("tomo lcm compact gate (over the watch socket)", () => {
  let daemon: ReturnType<typeof startDaemon> | null = null;
  let extra: Server | null = null;
  let state: { tasks: number; awaitingReport: boolean };
  let sessionId: string;

  beforeEach(async () => {
    // The rewrite is checked with the SDK's loader before it is published, so
    // the session lives where the SDK resolves the workspace to (realpath: on
    // macOS tmpdir() is a /var symlink) and has a session id it accepts.
    paths.root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-bg-gate-")));
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(paths.root, "home", ".claude"));
    paths.workspaceDir = join(paths.root, "workspace");
    paths.sdkSessionsDir = sdkSessionsDirForWorkspace(paths.workspaceDir, join(paths.root, "home"));
    paths.sessionsDir = join(paths.root, "sessions");
    paths.watchSocketPath = join(paths.root, "watch.sock");
    paths.pidFile = join(paths.root, "tomo.pid");
    mkdirSync(paths.sdkSessionsDir, { recursive: true });
    mkdirSync(paths.sessionsDir, { recursive: true });
    sessionId = randomUUID();
    state = { tasks: 0, awaitingReport: false };
    // A live daemon process: this one.
    writeFileSync(paths.pidFile, `${process.pid}\n`);
    daemon = startDaemon(state);
    await waitForSocket(paths.watchSocketPath);
  });

  afterEach(async () => {
    daemon?.server.stop();
    daemon?.reservations.dispose();
    daemon = null;
    if (extra) {
      extra.close();
      extra.unref();
    }
    extra = null;
    vi.unstubAllEnvs();
    rmSync(paths.root, { recursive: true, force: true });
  });

  const daily = (summary = "9/8: two exchanges.", ...extraArgs: string[]) =>
    runLcm(["daily", "--session-id", sessionId, "--date", "2026-09-08", "--summary", summary, ...extraArgs]);

  it("`tomo lcm daily` refuses while background tasks run and leaves the session untouched", async () => {
    const path = writeSession(sessionId);
    const before = readFileSync(path, "utf8");
    state.tasks = 1;

    const res = await daily();

    expect(res.code).toBe(LCM_DEFERRED_EXIT_CODE);
    const body = JSON.parse(res.stderr);
    expect(body).toMatchObject({ status: "deferred", reason: "background-tasks", activeBackgroundTasks: 1 });
    expect(body.error).toContain("1 background task is still running");
    expect(readFileSync(path, "utf8")).toBe(before);
    // No trigger: nothing will reload — and so nothing will be killed.
    expect(existsSync(getCompactTriggerPath(sessionId, paths.sdkSessionsDir))).toBe(false);
    expect(daemon!.reservations.isPending(daemon!.KEY)).toBe(false);
  });

  it("refuses in the report window: tasks drained, their report turn not yet run", async () => {
    writeSession(sessionId);
    state.awaitingReport = true;
    const res = await daily();
    expect(res.code).toBe(LCM_DEFERRED_EXIT_CODE);
    expect(JSON.parse(res.stderr).reason).toBe("awaiting-task-report");
  });

  it("proceeds as before with no background work, and leaves the session marked pending until its reload", async () => {
    const path = writeSession(sessionId);
    const res = await daily();
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ status: "ok", blockTag: "daily 2026-09-08", eventsRemoved: 4 });
    expect(readFileSync(path, "utf8")).toContain("9/8: two exchanges.");
    expect(existsSync(getCompactTriggerPath(sessionId, paths.sdkSessionsDir))).toBe(true);
    // TOCTOU: from the approval until the reload, a new background launch is
    // denied — so the reload has nothing to kill.
    await until(() => daemon!.reservations.launchDenial(daemon!.KEY) !== null);
    expect(daemon!.reservations.launchDenial(daemon!.KEY)).toContain("pending");
    daemon!.reservations.clear(daemon!.KEY); // the reload
    expect(daemon!.reservations.launchDenial(daemon!.KEY)).toBeNull();
  });

  it("a rewrite that changes nothing releases the mark right away", async () => {
    writeSession(sessionId);
    const res = await runLcm(["prune-tools", "--session-id", sessionId]);
    expect(res.code, res.stderr).toBe(0);
    expect(existsSync(getCompactTriggerPath(sessionId, paths.sdkSessionsDir))).toBe(false);
    await until(() => !daemon!.reservations.isPending(daemon!.KEY));
    expect(daemon!.reservations.isPending(daemon!.KEY)).toBe(false);
  });

  it("a dropped connection does NOT release an approval (the CLI may still be writing); an explicit finish does", async () => {
    const socket = createConnection(paths.watchSocketPath);
    await new Promise((r) => socket.once("connect", r));
    let reply = "";
    socket.setEncoding("utf-8");
    socket.on("data", (c: string) => { reply += c; });
    socket.write(JSON.stringify({ kind: "compact-reserve", sdkSessionId: sessionId }) + "\n");
    await until(() => reply.includes('"kind":"compact-reserve"'));
    const frame = reply.split("\n").map((l) => (l ? JSON.parse(l) : null)).find((f) => f?.kind === "compact-reserve");
    expect(frame.reservation.ok).toBe(true);
    socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(daemon!.reservations.isPending(daemon!.KEY)).toBe(true);
    expect(daemon!.reservations.launchDenial(daemon!.KEY)).not.toBeNull();

    // The rewrite later ends without a trigger (it failed): an explicit
    // finish on a fresh connection releases it.
    const fin = createConnection(paths.watchSocketPath);
    await new Promise((r) => fin.once("connect", r));
    fin.write(JSON.stringify({ kind: "compact-finish", sdkSessionId: sessionId, reservation: frame.reservation }) + "\n");
    await until(() => !daemon!.reservations.isPending(daemon!.KEY));
    fin.destroy();
    expect(daemon!.reservations.isPending(daemon!.KEY)).toBe(false);
  });

  it("an unreadable or malformed pid file is not proof of absence: fail closed", async () => {
    daemon!.server.stop();
    daemon = null;
    const path = writeSession(sessionId);
    const before = readFileSync(path, "utf8");
    writeFileSync(paths.pidFile, "not-a-pid\n");
    expect((await daily()).code).toBe(LCM_DEFERRED_EXIT_CODE);
    rmSync(paths.pidFile);
    mkdirSync(paths.pidFile); // EISDIR on read
    expect((await daily()).code).toBe(LCM_DEFERRED_EXIT_CODE);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("`compact` and `prune-tools` are gated too; a prune dry run is not", async () => {
    const path = writeSession(sessionId);
    const before = readFileSync(path, "utf8");
    state.tasks = 2;

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

  it("fails closed against a daemon too old to answer", async () => {
    daemon!.server.stop();
    daemon = null;
    const old = new WatchServer(paths.watchSocketPath, { getSnapshot: () => fakeSnapshot(), sendChat: async () => {} });
    old.start();
    await waitForSocket(paths.watchSocketPath);
    try {
      const path = writeSession(sessionId);
      const before = readFileSync(path, "utf8");
      const res = await daily();
      expect(res.code).toBe(LCM_DEFERRED_EXIT_CODE);
      const body = JSON.parse(res.stderr);
      expect(body.reason).toBe("daemon-unreachable");
      expect(body.error).toContain("--no-daemon-check");
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      old.stop();
    }
  });

  it("fails closed when the daemon does not answer in time", async () => {
    daemon!.server.stop();
    daemon = null;
    extra = createServer((sock) => { sock.on("error", () => {}); /* accept, never answer */ });
    await new Promise<void>((r) => extra!.listen(paths.watchSocketPath, r));
    const res = await reserveCompact(paths.watchSocketPath, sessionId, { timeoutMs: 100, daemonAlive: () => true });
    expect(res).toMatchObject({ status: "unconfirmed", detail: expect.stringContaining("no answer") });
  });

  it("fails closed when the socket is gone but a daemon process is alive", async () => {
    daemon!.server.stop();
    daemon = null;
    const path = writeSession(sessionId);
    const before = readFileSync(path, "utf8");
    const res = await daily();
    expect(res.code).toBe(LCM_DEFERRED_EXIT_CODE);
    expect(JSON.parse(res.stderr).reason).toBe("daemon-unreachable");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("proceeds when no daemon is running at all (no socket, no live pid)", async () => {
    daemon!.server.stop();
    daemon = null;
    rmSync(paths.pidFile); // no pid file at all: the only "absent" answer
    writeSession(sessionId);
    const res = await daily();
    expect(res.code, res.stderr).toBe(0);
    expect(existsSync(getCompactTriggerPath(sessionId, paths.sdkSessionsDir))).toBe(true);
  });

  it("--no-daemon-check skips the gate", async () => {
    daemon!.server.stop();
    daemon = null;
    writeSession(sessionId);
    const res = await daily("9/8.", "--no-daemon-check");
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
      hasBackgroundWork: (_key: string) => count() > 0,
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
