import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Same discipline as tests/workspace.test.ts: `restart-request.ts` derives its
// request directory from `defaultRuntimePaths`, a module-level const built from
// `homedir()`, so HOME has to be pinned before the import graph loads or this
// test would drive the real ~/.tomo.
const TEST_HOME = mkdtempSync(join(tmpdir(), "tomo-restart-inflight-"));
const REQUEST_DIR = join(TEST_HOME, ".tomo", "data", "restart-requests");
vi.stubEnv("HOME", TEST_HOME);
vi.stubEnv("TOMO_WORKSPACE", join(TEST_HOME, ".tomo", "workspace"));
vi.resetModules();

const hoisted = vi.hoisted(() => ({ spawnCalls: [] as string[][] }));

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    // The restart helper is spawned detached; in a test it must never become a
    // real process. Record the invocation instead.
    spawn: vi.fn((_command: string, args: string[]) => {
      hoisted.spawnCalls.push(args);
      return { stderr: null, on: vi.fn(), once: vi.fn(), unref: vi.fn() };
    }),
  };
});

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

// DYNAMIC, and that is the whole point: a static import is hoisted above the
// `vi.stubEnv` above, so the module graph would resolve its paths against the
// developer's real HOME before the stub ever ran.
const { Agent, installAgentTestHooks } = await import("./helpers/agent-harness.js");
const { createRestartRequest, formatRestartRequestResult, sweepStaleRestartRequests } = await import("../src/restart-request.js");

/** Requests are only actionable by the daemon that filed them. */
const DAEMON = process.pid;
const file = (sessionKey: string, reason: string) =>
  createRestartRequest({ sessionKey, daemonPid: DAEMON, reason }, REQUEST_DIR);

installAgentTestHooks();

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

/** The two restart entry points are private; this is the seam under test. */
interface RestartHandlers {
  handleTurnComplete(key: string): void;
  handleToolResult(key: string, toolName: string, content: unknown, isError: boolean): void;
  stop(): Promise<void>;
}

beforeEach(() => {
  hoisted.spawnCalls.length = 0;
  rmSync(REQUEST_DIR, { recursive: true, force: true });
});

function makeAgent(): RestartHandlers {
  return new Agent() as unknown as RestartHandlers;
}

const pending = () => {
  try {
    return readdirSync(REQUEST_DIR);
  } catch {
    return [];
  }
};

describe("a restart already in flight drains the requests it supersedes", () => {
  it("drops a request arriving at the end of a later turn instead of leaving it on disk", () => {
    const agent = makeAgent();

    file("dm:shuai", "first");
    agent.handleTurnComplete("dm:shuai");
    expect(hoisted.spawnCalls).toHaveLength(1);

    // A second request while the first restart is in flight. Returning early
    // left this file on disk: the daemon restarts, and within the TTL the next
    // turn's fallback claims it and restarts AGAIN, announcing "second".
    file("dm:shuai", "second");
    agent.handleTurnComplete("dm:shuai");

    expect(hoisted.spawnCalls).toHaveLength(1);
    expect(pending()).toEqual([]);
  });

  it("drains a straggler the marker path did not name", () => {
    const agent = makeAgent();

    file("dm:shuai", "first");
    agent.handleTurnComplete("dm:shuai");
    expect(hoisted.spawnCalls).toHaveLength(1);

    // Two more in the same turn: the marker names `second`, and `third` is the
    // straggler nothing would otherwise collect.
    const second = file("dm:shuai", "second");
    file("dm:shuai", "third");
    agent.handleToolResult("dm:shuai", "Bash", formatRestartRequestResult(second), false);

    expect(hoisted.spawnCalls).toHaveLength(1);
    expect(pending()).toEqual([]);
  });

  it("leaves a live session's request alone while draining its own", () => {
    const agent = makeAgent();

    file("dm:shuai", "first");
    agent.handleTurnComplete("dm:shuai");

    file("dm:shuai", "mine");
    const theirs = file("telegram:123", "theirs");
    agent.handleTurnComplete("dm:shuai");

    // Draining is scoped to the session with the restart in flight, and this
    // daemon filed `theirs`, so its own turn end is still entitled to it.
    // What must NOT survive is a foreign DAEMON's request — that is the
    // startup sweep's job, covered in restart-request.test.ts.
    expect(pending()).toEqual([`${theirs.id}.json`]);
  });

  it("restarts with the request's reason on the first, non-superseded turn end", () => {
    const agent = makeAgent();

    file("dm:shuai", "config changed");
    agent.handleTurnComplete("dm:shuai");

    expect(hoisted.spawnCalls).toHaveLength(1);
    expect(hoisted.spawnCalls[0]).toContain("--reason");
    expect(hoisted.spawnCalls[0]).toContain("config changed");
    expect(hoisted.spawnCalls[0]).toContain("dm:shuai");
  });
});

describe("a previous daemon's requests never reach a turn end", () => {
  it("sweeps a foreign daemon's request for a session this daemon would not even restart", () => {
    // The cross-restart leak: filed by a daemon that is gone, it would be
    // claimed at some later turn end and restart with a stale foreign reason.
    // The startup sweep is what removes it — asserted here in the shape the
    // Agent depends on, since the Agent has no other guard against it.
    createRestartRequest({ sessionKey: "telegram:123", daemonPid: DAEMON + 1, reason: "stale" }, REQUEST_DIR);

    expect(sweepStaleRestartRequests(REQUEST_DIR, Date.now(), undefined, DAEMON)).toBe(1);
    expect(pending()).toEqual([]);
  });

  it("leaves this daemon's own pending request for the turn end to claim", () => {
    file("dm:shuai", "mine");

    expect(sweepStaleRestartRequests(REQUEST_DIR, Date.now(), undefined, DAEMON)).toBe(0);

    const agent = makeAgent();
    agent.handleTurnComplete("dm:shuai");
    expect(hoisted.spawnCalls).toHaveLength(1);
  });
});

describe("a stop in progress outranks a deferred restart", () => {
  it("does not resurrect the daemon from a request claimed during shutdown", async () => {
    // `Agent.stop()` stops sessions before channels, so turns keep ENDING
    // while shutdown runs — and the completion signal fires on those exits by
    // design. Without a stopping guard, `tomo stop` on a session that had just
    // asked for a restart spawns a helper that brings the daemon right back.
    const agent = makeAgent();
    file("dm:shuai", "please restart");

    await agent.stop();
    agent.handleTurnComplete("dm:shuai");

    expect(hoisted.spawnCalls).toEqual([]);
    // Dropped rather than left to fire on the next daemon.
    expect(pending()).toEqual([]);
  });

  it("does not restart from a marker observed during shutdown either", async () => {
    const agent = makeAgent();
    const request = file("dm:shuai", "please restart");

    await agent.stop();
    agent.handleToolResult("dm:shuai", "Bash", formatRestartRequestResult(request), false);

    expect(hoisted.spawnCalls).toEqual([]);
    expect(pending()).toEqual([]);
  });
});

describe("background restarts report through BashOutput", () => {
  it("accepts the marker from the background-output tool", () => {
    const agent = makeAgent();
    const request = file("dm:shuai", "backgrounded");

    agent.handleToolResult("dm:shuai", "BashOutput", formatRestartRequestResult(request), false);

    expect(hoisted.spawnCalls).toHaveLength(1);
    expect(hoisted.spawnCalls[0]).toContain("backgrounded");
  });

  it("still ignores unrelated tools", () => {
    const agent = makeAgent();
    const request = file("dm:shuai", "not via Read");

    agent.handleToolResult("dm:shuai", "Read", formatRestartRequestResult(request), false);

    expect(hoisted.spawnCalls).toEqual([]);
    // Untouched — the end-of-turn fallback is what will collect it.
    expect(pending()).toHaveLength(1);
  });
});
