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
// The launch is what these tests are about, and `spawn` is mocked below; the
// test setup turns the real helper off for everyone else.
vi.stubEnv("TOMO_RESTART_HELPER", undefined);
vi.resetModules();

const hoisted = vi.hoisted(() => ({ spawnCalls: [] as string[][], helperFails: false }));

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    // The restart helper must never become a real process in a test. The fake
    // reports that it started (or, with helperFails, that it could not).
    spawn: vi.fn((_command: string, args: string[]) => {
      hoisted.spawnCalls.push(args);
      const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), unref: vi.fn() });
      setImmediate(() => {
        if (hoisted.helperFails) child.emit("error", new Error("spawn ENOENT"));
        else child.emit("spawn");
      });
      return child;
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
  hoisted.helperFails = false;
  rmSync(REQUEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A turn that runs `tomo restart` itself is cut short by the restart it asked
// for. It is still an interrupted turn (work after the restart call may be
// unfinished, so the note and the inbox record stay), but the note says the
// turn restarted Tomo itself instead of reading like an accident, and nothing
// reaches the owner. Attribution needs the turn's own main-thread Bash call
// and a helper that actually started; anything else keeps the old wording.
// ---------------------------------------------------------------------------

type AgentInstance = InstanceType<typeof Agent>;

async function boot(): Promise<{ agent: AgentInstance; channel: InstanceType<typeof MockChannel>; ownerNotices: string[] }> {
  resetConfig({ inbox: true, imessageInboundSettleMs: 0, tomoHome: mockConfig.tomoHome });
  const agent = new Agent();
  const ownerNotices: string[] = [];
  vi.spyOn(agent, "notifyOwner").mockImplementation(async (text) => { ownerNotices.push(JSON.stringify(text)); return true; });
  const channel = new MockChannel("imessage");
  agent.addChannel(channel);
  await agent.start();
  return { agent, channel, ownerNotices };
}

function openInbox(): InstanceType<typeof DurableInbox> {
  return new DurableInbox({ path: join(mockConfig.tomoHome, "data", "inbox.jsonl"), readOnly: true });
}

/** The mock SDK query of `sessionKey` (controllers are created in session order). */
function controllerFor(sessionKey: string) {
  const i = mockSdk.optionsBySession.findIndex((o) => o.sessionKey === sessionKey);
  return mockSdk.queryControllers[i];
}

/**
 * What the SDK streams when the model runs `tomo restart` in a session's shell
 * and the CLI defers it. `tool` is the tool whose result carries the marker:
 * `Bash` for the turn's own call, `BashOutput` for a backgrounded one.
 */
function runTomoRestartIn(sessionKey: string, toolUseId: string, tool: "Bash" | "BashOutput" = "Bash"): void {
  const request = createRestartRequest({ sessionKey, daemonPid: process.pid, reason: "deploy" }, REQUEST_DIR);
  const query = controllerFor(sessionKey);
  query.pushEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: tool, input: { command: "tomo restart --reason deploy" } }] } });
  query.pushEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: formatRestartRequestResult(request) }] } });
}

const interruptedNote = (agent: AgentInstance, key: string) =>
  peekPendingNotes(agent, key).filter((n) => n.includes('name="interrupted"')).join("\n");

const SELF = "This turn restarted Tomo itself (reason: deploy)";
const ACCIDENT = "Your reply may be missing or incomplete";

async function startTurn(channel: InstanceType<typeof MockChannel>, id: string, chatId: string, text: string): Promise<void> {
  await channel.simulateMessage(makeMsg({ id, chatId, text }));
  await waitFor(() => expect(mockSdk.promptsBySession.some((p) => p.sessionKey === `imessage:${chatId}`)).toBe(true));
}

/** The restart helper's SIGTERM, then the next start. */
async function restart(first: { agent: AgentInstance }): Promise<{ agent: AgentInstance; ownerNotices: string[]; leftOver: string[][] }> {
  await new Promise((r) => setImmediate(r)); // let the helper report it started
  await first.agent.stop();
  const leftOver = openInbox().pending().map((r) => [r.message.id, r.status]);
  return { ...(await boot()), leftOver };
}

describe("durable inbox: a restart the turn asked for itself", () => {
  it("says so in the note, keeps the work, tells the owner nothing; another session's turn is unchanged", async () => {
    const first = await boot();
    mockSdk.responseFn = () => new Promise(() => {}); // Both turns stay mid-flight.
    await startTurn(first.channel, "self1", "701", "please restart tomo");
    await startTurn(first.channel, "other1", "702", "long running job");

    runTomoRestartIn("imessage:701", "tu-restart");
    await waitFor(() => expect(hoisted.spawnCalls).toHaveLength(1));

    const second = await restart(first);
    // Neither turn is written off as done: both are still owed a check.
    expect(second.leftOver).toEqual([["self1", "started"], ["other1", "started"]]);
    const own = interruptedNote(second.agent, "imessage:701");
    expect(own).toContain(SELF);
    expect(own).toContain("if the sender has not yet received the answer");
    expect(own).toContain("reply NO_REPLY only when nothing is owed");
    expect(own).toContain("please restart tomo"); // the message still travels with it
    expect(own).not.toContain(ACCIDENT);
    const other = interruptedNote(second.agent, "imessage:702");
    expect(other).toContain(ACCIDENT);
    expect(other).toContain("long running job");
    expect(other).not.toContain("restarted Tomo itself");
    expect([...first.ownerNotices, ...second.ownerNotices]).toEqual([]);
    await second.agent.stop();
  });

  it("keeps the old note for a restart that names no turn", async () => {
    const first = await boot();
    mockSdk.responseFn = () => new Promise(() => {});
    await startTurn(first.channel, "plain1", "703", "halfway there");

    // A terminal `tomo restart`: no request, no marker, just the SIGTERM.
    const second = await restart(first);
    const note = interruptedNote(second.agent, "imessage:703");
    expect(note).toContain(ACCIDENT);
    expect(note).toContain("halfway there");
    await second.agent.stop();
  });

  it("does not count a marker that came back through background output", async () => {
    const first = await boot();
    mockSdk.responseFn = () => new Promise(() => {});
    await startTurn(first.channel, "bg1", "704", "restart in the background");

    runTomoRestartIn("imessage:704", "tu-bg", "BashOutput");
    await waitFor(() => expect(hoisted.spawnCalls).toHaveLength(1));

    const second = await restart(first);
    const note = interruptedNote(second.agent, "imessage:704");
    expect(note).toContain(ACCIDENT);
    expect(note).not.toContain("restarted Tomo itself");
    await second.agent.stop();
  });

  it("does not count a restart whose helper failed to start", async () => {
    hoisted.helperFails = true;
    const first = await boot();
    mockSdk.responseFn = () => new Promise(() => {});
    await startTurn(first.channel, "fail1", "705", "restart that fails");

    runTomoRestartIn("imessage:705", "tu-fail");
    await waitFor(() => expect(hoisted.spawnCalls).toHaveLength(1));

    // The restart never happened; the turn is cut by an unrelated shutdown.
    const second = await restart(first);
    const note = interruptedNote(second.agent, "imessage:705");
    expect(note).toContain(ACCIDENT);
    expect(note).not.toContain("restarted Tomo itself");
    await second.agent.stop();
  });
});
