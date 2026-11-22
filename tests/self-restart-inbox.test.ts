import { describe, expect, it, vi, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

// `restart-request.ts` derives its request directory from HOME at import
// time; pin it before the module graph loads (see restart-in-flight.test.ts).
const TEST_HOME = mkdtempSync(join(tmpdir(), "tomo-self-restart-"));
const REQUEST_DIR = join(TEST_HOME, ".tomo", "data", "restart-requests");
vi.stubEnv("HOME", TEST_HOME);
vi.stubEnv("TOMO_WORKSPACE", join(TEST_HOME, ".tomo", "workspace"));
vi.resetModules();

const hoisted = vi.hoisted(() => ({ spawnCalls: [] as string[][] }));

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    // The restart helper must never become a real process in a test.
    spawn: vi.fn((_command: string, args: string[]) => {
      hoisted.spawnCalls.push(args);
      return Object.assign(new EventEmitter(), { stderr: new EventEmitter(), unref: vi.fn() });
    }),
  };
});

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

const { Agent, MockChannel, installAgentTestHooks, makeMsg, mockConfig, mockSdk, peekPendingNotes, resetConfig, waitFor } =
  await import("./helpers/agent-harness.js");
const { DurableInbox } = await import("../src/agent/durable-inbox.js");
const { createRestartRequest, formatRestartRequestResult } = await import("../src/restart-request.js");

installAgentTestHooks();

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  hoisted.spawnCalls.length = 0;
  rmSync(REQUEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A turn that runs `tomo restart` itself is cut short by the restart it asked
// for. That is not an interruption: after the restart the durable inbox must
// not hand the session an `interrupted` note for it. A turn some OTHER
// session was running at the same moment really was interrupted, and still is
// reported. A restart that names no turn (a terminal `tomo restart`) keeps the
// old behaviour.
// ---------------------------------------------------------------------------

type AgentInstance = InstanceType<typeof Agent>;

async function boot(): Promise<{ agent: AgentInstance; channel: InstanceType<typeof MockChannel> }> {
  resetConfig({ inbox: true, imessageInboundSettleMs: 0, tomoHome: mockConfig.tomoHome });
  const agent = new Agent();
  const channel = new MockChannel("imessage");
  agent.addChannel(channel);
  await agent.start();
  return { agent, channel };
}

function openInbox(): InstanceType<typeof DurableInbox> {
  return new DurableInbox({ path: join(mockConfig.tomoHome, "data", "inbox.jsonl"), readOnly: true });
}

/** The mock SDK query of `sessionKey` (controllers are created in session order). */
function controllerFor(sessionKey: string) {
  const i = mockSdk.optionsBySession.findIndex((o) => o.sessionKey === sessionKey);
  return mockSdk.queryControllers[i];
}

/** What the SDK streams when the model runs `tomo restart` in a session's shell and the CLI defers it. */
function runTomoRestartIn(sessionKey: string, toolUseId: string): void {
  const request = createRestartRequest({ sessionKey, daemonPid: process.pid, reason: "deploy" }, REQUEST_DIR);
  const query = controllerFor(sessionKey);
  query.pushEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "tomo restart --reason deploy" } }] } });
  query.pushEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: formatRestartRequestResult(request) }] } });
}

const interruptedNote = (agent: AgentInstance, key: string) =>
  peekPendingNotes(agent, key).filter((n) => n.includes('name="interrupted"')).join("\n");

describe("durable inbox: a restart the turn asked for itself", () => {
  it("does not report the initiating turn as interrupted, but still reports another session's turn", async () => {
    const first = await boot();
    mockSdk.responseFn = () => new Promise(() => {}); // Both turns stay mid-flight.
    await first.channel.simulateMessage(makeMsg({ id: "self1", chatId: "701", text: "please restart tomo" }));
    await waitFor(() => expect(mockSdk.promptsBySession.some((p) => p.sessionKey === "imessage:701")).toBe(true));
    await first.channel.simulateMessage(makeMsg({ id: "other1", chatId: "702", text: "long running job" }));
    await waitFor(() => expect(mockSdk.promptsBySession.some((p) => p.sessionKey === "imessage:702")).toBe(true));

    runTomoRestartIn("imessage:701", "tu-restart");
    await waitFor(() => expect(hoisted.spawnCalls).toHaveLength(1));

    // The helper's SIGTERM: graceful shutdown cuts both turns short.
    await first.agent.stop();
    expect(openInbox().pending().map((r) => [r.message.id, r.status])).toEqual([["other1", "started"]]);

    const second = await boot();
    expect(interruptedNote(second.agent, "imessage:701")).toBe("");
    expect(interruptedNote(second.agent, "imessage:702")).toContain("long running job");
    await second.agent.stop();
  });

  it("keeps the old behaviour for a restart that names no turn", async () => {
    const first = await boot();
    mockSdk.responseFn = () => new Promise(() => {});
    await first.channel.simulateMessage(makeMsg({ id: "plain1", chatId: "703", text: "halfway there" }));
    await waitFor(() => expect(mockSdk.promptsBySession.some((p) => p.sessionKey === "imessage:703")).toBe(true));

    // A terminal `tomo restart`: no request, no marker, just the SIGTERM.
    await first.agent.stop();
    expect(openInbox().pending().map((r) => [r.message.id, r.status])).toEqual([["plain1", "started"]]);

    const second = await boot();
    expect(interruptedNote(second.agent, "imessage:703")).toContain("halfway there");
    await second.agent.stop();
  });
});
