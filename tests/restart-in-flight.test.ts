import { describe, expect, it, vi, afterAll } from "vitest";
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
const { createRestartRequest, formatRestartRequestResult } = await import("../src/restart-request.js");

installAgentTestHooks();

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

/** The two restart entry points are private; this is the seam under test. */
interface RestartHandlers {
  handleTurnComplete(key: string): void;
  handleToolResult(key: string, toolName: string, content: unknown, isError: boolean): void;
}

function makeAgent(): RestartHandlers {
  hoisted.spawnCalls.length = 0;
  rmSync(REQUEST_DIR, { recursive: true, force: true });
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

    createRestartRequest("dm:shuai", "first", REQUEST_DIR);
    agent.handleTurnComplete("dm:shuai");
    expect(hoisted.spawnCalls).toHaveLength(1);

    // A second request while the first restart is in flight. Returning early
    // left this file on disk: the daemon restarts, and within the TTL the next
    // turn's fallback claims it and restarts AGAIN, announcing "second".
    createRestartRequest("dm:shuai", "second", REQUEST_DIR);
    agent.handleTurnComplete("dm:shuai");

    expect(hoisted.spawnCalls).toHaveLength(1);
    expect(pending()).toEqual([]);
  });

  it("drains a straggler the marker path did not name", () => {
    const agent = makeAgent();

    createRestartRequest("dm:shuai", "first", REQUEST_DIR);
    agent.handleTurnComplete("dm:shuai");
    expect(hoisted.spawnCalls).toHaveLength(1);

    // Two more in the same turn: the marker names `second`, and `third` is the
    // straggler nothing would otherwise collect.
    const second = createRestartRequest("dm:shuai", "second", REQUEST_DIR);
    createRestartRequest("dm:shuai", "third", REQUEST_DIR);
    agent.handleToolResult("dm:shuai", "Bash", formatRestartRequestResult(second), false);

    expect(hoisted.spawnCalls).toHaveLength(1);
    expect(pending()).toEqual([]);
  });

  it("leaves another session's request alone while draining its own", () => {
    const agent = makeAgent();

    createRestartRequest("dm:shuai", "first", REQUEST_DIR);
    agent.handleTurnComplete("dm:shuai");

    createRestartRequest("dm:shuai", "mine", REQUEST_DIR);
    const theirs = createRestartRequest("telegram:123", "theirs", REQUEST_DIR);
    agent.handleTurnComplete("dm:shuai");

    // Draining is scoped to the session that has the restart in flight.
    expect(pending()).toEqual([`${theirs.id}.json`]);
  });

  it("restarts with the request's reason on the first, non-superseded turn end", () => {
    const agent = makeAgent();

    createRestartRequest("dm:shuai", "config changed", REQUEST_DIR);
    agent.handleTurnComplete("dm:shuai");

    expect(hoisted.spawnCalls).toHaveLength(1);
    expect(hoisted.spawnCalls[0]).toContain("--reason");
    expect(hoisted.spawnCalls[0]).toContain("config changed");
    expect(hoisted.spawnCalls[0]).toContain("dm:shuai");
  });
});
