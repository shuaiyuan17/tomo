import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, writeFileSync as write } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, expectNoChangeFor, installAgentTestHooks, mockConfig, resetConfig, waitFor } from "./helpers/agent-harness.js";

installAgentTestHooks();

// ---------------------------------------------------------------------------
// A pending notes file that will not read is moved aside; the owner is told
// where it is, and the marker naming it stays until that notice is sent.
// ---------------------------------------------------------------------------

function writeFileSync(path: string, text: string): void {
  mkdirSync(mockConfig.sessionsDir, { recursive: true });
  write(path, text);
}

const owner = { identities: [{ name: "alex", channels: { telegram: "12345" }, replyPolicy: "last-active" }] };
const notesFile = () => join(mockConfig.sessionsDir, "_pending_notes.json");
const marker = () => join(mockConfig.sessionsDir, "_pending_notes.quarantined.json");
const asides = () => readdirSync(mockConfig.sessionsDir).filter((f) => f.startsWith("_pending_notes.json.corrupt-"));

async function boot(overrides: Record<string, unknown> = owner): Promise<Agent> {
  resetConfig({ tomoHome: mockConfig.tomoHome, ...overrides });
  const agent = new Agent();
  agent.addChannel(new MockChannel("imessage"));
  await agent.start();
  return agent;
}

type Internals = { pendingNotesQueue: { queueNote(k: string, n: string): boolean }; pendingNotesNoticeTimer?: ReturnType<typeof setTimeout>; tellPendingNotesQuarantined(): void };

describe("a pending notes file that will not read", () => {
  it("is moved aside, the owner is told where it is once, and the marker goes only after the notice was sent", async () => {
    const ownerNotice = vi.spyOn(Agent.prototype, "notifyOwner").mockResolvedValue(true);
    writeFileSync(notesFile(), "{not json");
    const agent = await boot();
    // The first read (here a note queued for some session) finds it.
    (agent as unknown as Internals).pendingNotesQueue.queueNote("imessage:700", "a note");
    await waitFor(() => expect(ownerNotice).toHaveBeenCalledTimes(1));
    expect(asides()).toHaveLength(1);
    expect(String(ownerNotice.mock.calls[0][0])).toContain(join(mockConfig.sessionsDir, asides()[0]));
    await waitFor(() => expect(existsSync(marker())).toBe(false));
    await agent.stop();

    const again = await boot();
    await expectNoChangeFor(() => expect(ownerNotice).toHaveBeenCalledTimes(1), 50);
    await again.stop();
  });

  it("a run that went away before telling the owner leaves the marker, and the next start tells them", async () => {
    const ownerNotice = vi.spyOn(Agent.prototype, "notifyOwner").mockResolvedValue(true);
    const aside = join(mockConfig.sessionsDir, "_pending_notes.json.corrupt-99");
    writeFileSync(aside, "{not json");
    writeFileSync(marker(), JSON.stringify({ asides: [aside] }));
    const agent = await boot();
    await waitFor(() => expect(ownerNotice).toHaveBeenCalledTimes(1));
    expect(String(ownerNotice.mock.calls[0][0])).toContain(aside);
    await waitFor(() => expect(existsSync(marker())).toBe(false));
    await agent.stop();
  });

  it("a notice that could not be sent keeps the marker and is tried again", async () => {
    const ownerNotice = vi.spyOn(Agent.prototype, "notifyOwner").mockResolvedValueOnce(false).mockResolvedValue(true);
    const aside = join(mockConfig.sessionsDir, "_pending_notes.json.corrupt-1");
    writeFileSync(aside, "{not json");
    writeFileSync(marker(), JSON.stringify({ asides: [aside] }));
    const agent = await boot();
    const internals = agent as unknown as Internals;
    await waitFor(() => expect(internals.pendingNotesNoticeTimer).toBeDefined());
    expect(existsSync(marker())).toBe(true);
    // The retry timer fires.
    clearTimeout(internals.pendingNotesNoticeTimer);
    internals.pendingNotesNoticeTimer = undefined;
    internals.tellPendingNotesQuarantined();
    await waitFor(() => expect(ownerNotice).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(existsSync(marker())).toBe(false));
    await agent.stop();
  });

  it("a marker naming a file whose move never happened sends no notice and is cleared", async () => {
    const ownerNotice = vi.spyOn(Agent.prototype, "notifyOwner").mockResolvedValue(true);
    writeFileSync(marker(), JSON.stringify({ asides: [join(mockConfig.sessionsDir, "_pending_notes.json.corrupt-7")] }));
    const agent = await boot();
    await waitFor(() => expect(existsSync(marker())).toBe(false));
    expect(ownerNotice).not.toHaveBeenCalled();
    await agent.stop();
  });

  it("with no owner to tell, the marker stays for a later start and nothing is retried", async () => {
    const ownerNotice = vi.spyOn(Agent.prototype, "notifyOwner").mockResolvedValue(false);
    writeFileSync(marker(), "{garbled");
    const agent = await boot({});
    await waitFor(() => expect(ownerNotice).toHaveBeenCalledTimes(1));
    await expectNoChangeFor(() => expect((agent as unknown as Internals).pendingNotesNoticeTimer).toBeUndefined(), 50);
    expect(existsSync(marker())).toBe(true);
    await agent.stop();
  });
});
