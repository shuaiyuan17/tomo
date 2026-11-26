import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, SessionStore, drainQueue, installAgentTestHooks, makeMsg, mockConfig, mockSdk, waitFor } from "./helpers/agent-harness.js";
import { WebChannel } from "../src/channels/web.js";
import { watchBus } from "../src/watch/bus.js";
import { WebData } from "../src/web/data.js";
import { OwnerRouter } from "../src/router.js";
import { webSessionId } from "../src/web/owner.js";
import type { WebEvent } from "../src/web/protocol.js";

installAgentTestHooks();
let agent: Agent;
let web: WebChannel;
let provider: MockChannel;
let events: WebEvent[];
beforeEach(() => {
  watchBus.reset();
  mockConfig.identities = [{ name: "owner", channels: { telegram: "test-owner", imessage: "test-handle" }, replyPolicy: "last-active" }];
  agent = new Agent(); web = new WebChannel(mockConfig.owner); provider = new MockChannel("telegram");
  agent.addChannel(provider); agent.addChannel(web);
  events = []; web.events.subscribe(({ event }) => events.push(event));
});
afterEach(async () => { await agent.stop(); });
const store = () => new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir, { dbPath: mockConfig.dbPath });
const sendProvider = (text: string) => provider.simulateMessage(makeMsg({ chatId: "test-owner", senderName: "Owner", text }));
const webBlocks = () => events.filter((event) => event.type === "block");
/** Request states the browser was told, in order. */
const statesOf = (requestId: string) => events.flatMap((event) => event.type === "request" && event.request.requestId === requestId ? [event.request.state] : []);

describe("web routing through the real Agent", () => {
  it("defaults to owner DM, uses the ordered delivery pipeline, and appends one canonical assistant entry", async () => {
    mockSdk.responseFn = () => ["First complete block", "Second complete block"];
    const requestId = randomUUID();
    await web.receive({ requestId, text: "A web question" }); await drainQueue(agent);
    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual(["dm:owner"]);
    expect(webBlocks().map((b) => b.text)).toEqual(["First complete block", "Second complete block"]);
    expect(webBlocks().every((b) => b.requestId === requestId)).toBe(true);
    expect(provider.delivered).toEqual([]);
    const messages = store().get("dm:owner").messages;
    expect(messages.filter((m) => m.role === "user")).toEqual([expect.objectContaining({ content: "A web question", channel: "web", requestId })]);
    expect(messages.filter((m) => m.role === "assistant")).toEqual([expect.objectContaining({ content: "First complete block\nSecond complete block", channel: "web", requestId })]);
    expect(web.request(requestId).state).toBe("completed");
    const catalog = new WebData({ ...mockConfig, owner: mockConfig.owner }).catalog();
    expect(catalog.sessions.find((s) => s.kind === "dm")?.stats).toMatchObject({ contextUsed: 5000, contextMax: 200000, contextEstimated: false });
  });
  it("never changes the persistent notification target or provider reply policy", async () => {
    await sendProvider("provider question"); await drainQueue(agent);
    const previous = store().getReplyTarget("dm:owner");
    await web.receive({ requestId: randomUUID(), text: "web question" }); await drainQueue(agent);
    expect(store().getReplyTarget("dm:owner")).toEqual(previous);
    expect(previous).toEqual({ channelName: "telegram", chatId: "test-owner" });
    await agent.handleCronMessage("scheduled note", "dm:owner"); await drainQueue(agent);
    expect(provider.delivered).toHaveLength(2);
    expect(webBlocks()).toHaveLength(1);
  });
  it("rejects forged group input in the router and Agent while exposing group history read-only", async () => {
    const sessions = store(); sessions.touchSession("telegram:-1"); sessions.setChatTitle("telegram:-1", "Test group");
    sessions.append("telegram:-1", { role: "user", content: "Existing group text", timestamp: Date.now(), channel: "telegram" });
    const router = new OwnerRouter(mockConfig.owner, sessions, {});
    expect(() => router.resolve("web", "owner", true)).toThrow();
    expect(() => router.resolve("web", "telegram:-1", false)).toThrow();
    const forged = new MockChannel("web"); agent.addChannel(forged);
    expect(await forged.simulateMessage(makeMsg({ chatId: "owner", isGroup: true, text: "forged", senderName: "Owner" }))).toBe(false);
    expect(await forged.simulateMessage(makeMsg({ chatId: "telegram:-1", text: "forged", senderName: "Owner" }))).toBe(false);
    await drainQueue(agent); expect(mockSdk.promptsBySession).toEqual([]);
    const data = new WebData({ ...mockConfig, owner: mockConfig.owner });
    expect(data.catalog().sessions.find((s) => s.kind === "group")).toMatchObject({ id: webSessionId("telegram:-1"), writable: false });
    expect((await data.history(webSessionId("telegram:-1"))).messages[0].content).toBe("Existing group text");
  });
  it.each(["web-first", "provider-first"])("keeps recipients separate for interleaved input (%s)", async (order) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    mockSdk.responseFn = async (text) => {
      calls++;
      if (calls === 1) { entered(); await gate; }
      return text.includes("browser prompt") ? "browser answer" : "provider answer";
    };
    const browser = () => web.receive({ requestId: randomUUID(), text: "browser prompt" });
    const messaging = () => sendProvider("provider prompt");
    await (order === "web-first" ? browser() : messaging());
    await started;
    await (order === "web-first" ? messaging() : browser());
    // Let the provider's batcher attempt steering while the first query is busy.
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Custody is accepted immediately, but incompatible input must wait in
    // the canonical queue before it enters the transcript/active SDK turn.
    expect(store().get("dm:owner").messages.filter((m) => m.role === "user").map((m) => m.content))
      .toEqual(order === "web-first" ? ["browser prompt"] : ["provider prompt", "browser prompt"]);
    release(); await drainQueue(agent);
    await waitFor(() => expect(webBlocks().map((b) => b.text)).toEqual(["browser answer"]));
    expect(provider.delivered.map((d) => d.text)).toEqual(["provider answer"]);
    expect(mockSdk.promptsBySession).toHaveLength(2);
    expect(new Set(mockSdk.promptsBySession.map((p) => p.sessionKey))).toEqual(new Set(["dm:owner"]));
  });

  it.each(["web", "provider"])("joins an active %s turn, keeps request receipts, and records the shared reply once", async (source) => {
    mockSdk.steerEcho = true; mockSdk.steerEchoCount = 2;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    mockSdk.responseFn = async (text) => { if (text.includes("FIRST")) { await gate; return "Shared first block"; } return "Shared correction block"; };
    const first = randomUUID(); const second = randomUUID(); const third = randomUUID();
    if (source === "web") await web.receive({ requestId: first, text: "FIRST" }); else await sendProvider("FIRST");
    const live = () => (agent as unknown as { liveSessionManager: { liveSessions: Map<string, { pendingSteers: unknown[]; isBusy(): boolean }> } }).liveSessionManager.liveSessions.get("dm:owner")!;
    await waitFor(() => expect(live()?.isBusy()).toBe(true));
    await web.receive({ requestId: second, text: "SECOND correction" });
    await web.receive({ requestId: third, text: "THIRD correction" });
    await waitFor(() => expect(live().pendingSteers).toHaveLength(2));
    // The messages entered the running SDK input queue before its gate opens.
    expect(store().get("dm:owner").messages.filter((m) => m.role === "user")).toHaveLength(3);
    release();
    await waitFor(() => expect(web.request(third).state).toBe("completed")); await drainQueue(agent);
    expect(web.request(second)).toMatchObject({ state: "completed", joined: true });
    expect(web.request(third)).toMatchObject({ state: "completed", joined: true, responseTurnId: web.request(second).responseTurnId });
    expect(webBlocks().map((b) => b.text)).toEqual(["Shared first block", "Shared correction block", "Shared correction block"]);
    expect(store().get("dm:owner").messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    const canonical = (await new WebData(mockConfig).history(web.ownerId!)).messages.find((m) => m.role === "assistant")!;
    expect(canonical.turnId).toBe(web.request(second).responseTurnId);
    expect(provider.delivered).toHaveLength(source === "provider" ? 3 : 0);
  });
  it("keeps new owner input out of a summoned group's active audience", async () => {
    // This guard is separate from the read-only group API: a summoned group
    // may be running on the very same canonical owner DM key.
    const audience = vi.spyOn(agent, "isOwnAudienceTurn").mockReturnValue(false);
    let release!: () => void; mockSdk.responseFn = async () => { await new Promise<void>((resolve) => { release = resolve; }); return "Reply"; };
    await web.receive({ requestId: randomUUID(), text: "first" }); await waitFor(() => expect(release).toBeTypeOf("function"));
    const second = randomUUID(); await web.receive({ requestId: second, text: "private correction" });
    expect(web.request(second).state).toBe("queued"); expect(store().get("dm:owner").messages.filter((m) => m.role === "user")).toHaveLength(1);
    mockSdk.responseFn = () => "Next reply"; release(); await drainQueue(agent); audience.mockRestore();
  });
  it("keeps web input queued behind system work even if provider input already steered into it", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    mockSdk.responseFn = async (text) => { if (text.includes("BACKGROUND")) { await gate; return "System reply"; } return "User reply"; };
    // Establish the provider target before dispatching system work.
    await sendProvider("Initial user turn"); await drainQueue(agent);
    mockSdk.steerEcho = true;
    const work = agent.handleCronMessage("BACKGROUND", "dm:owner");
    await waitFor(() => expect(mockSdk.promptsBySession).toHaveLength(2));
    await sendProvider("Provider correction");
    await waitFor(() => expect(store().get("dm:owner").messages.filter((m) => m.role === "user" && m.content === "Provider correction")).toHaveLength(1));
    const requestId = randomUUID(); await web.receive({ requestId, text: "Private browser request" });
    expect(web.request(requestId).state).toBe("queued");
    expect(store().get("dm:owner").messages.some((m) => m.content === "Private browser request")).toBe(false);
    release(); await work; await drainQueue(agent);
    expect(web.request(requestId)).toMatchObject({ state: "completed" });
    expect(web.request(requestId).joined).toBeUndefined();
  });
  it("settles a joined web request on SDK failure without retrying or duplicating partial transcripts", async () => {
    mockSdk.steerEcho = true;
    mockSdk.nextResult = { subtype: "error_max_turns", is_error: true, errors: ["Synthetic turn failure"] };
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    mockSdk.responseFn = async (text) => { if (text.includes("ROOT")) { await gate; return "Partial root reply"; } return "Partial shared reply"; };
    await sendProvider("ROOT");
    await waitFor(() => expect(mockSdk.promptsBySession).toHaveLength(1));
    const requestId = randomUUID(); await web.receive({ requestId, text: "Correction" });
    await waitFor(() => expect(store().get("dm:owner").messages.filter((m) => m.role === "user")).toHaveLength(2));
    // Handed to the SDK and joined, then the turn failed: it may have run, so
    // the browser hears "unknown" (never "failed", which invites a resend).
    release(); await waitFor(() => expect(web.request(requestId).state).toBe("unknown")); await drainQueue(agent);
    expect(mockSdk.promptsBySession).toHaveLength(1);
    expect(web.request(requestId).joined).toBe(true);
    const assistant = store().get("dm:owner").messages.filter((m) => m.role === "assistant");
    expect(assistant.filter((m) => m.content.includes("Partial shared reply"))).toHaveLength(1);
    expect(assistant.filter((m) => m.content.includes("ran out of steps"))).toHaveLength(1);
  });
  it("never re-runs a steer the SDK already took when the session dies before its echo", async () => {
    // No echo: the correction sits in the SDK input queue, unconfirmed.
    mockSdk.steerEcho = false;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = false;
    mockSdk.responseFn = async (text) => { if (text.includes("ROOT") && !gated) { gated = true; await gate; } return "Root reply"; };
    await sendProvider("ROOT");
    await waitFor(() => expect(mockSdk.promptsBySession).toHaveLength(1));
    const requestId = randomUUID(); await web.receive({ requestId, text: "Correction" });
    const live = () => (agent as unknown as { liveSessionManager: { liveSessions: Map<string, { pendingSteers: unknown[]; close(): void }> } }).liveSessionManager.liveSessions.get("dm:owner")!;
    await waitFor(() => expect(live().pendingSteers).toHaveLength(1));
    expect(web.request(requestId)).toMatchObject({ state: "running", handedOff: true });
    // The SDK child goes away (crash, OOM) before anything is echoed.
    live().close(); release();
    await waitFor(() => expect(web.request(requestId).state).toBe("unknown")); await drainQueue(agent);
    // Recoverable session error, but handed off: no reset-and-retry, no send() fallback.
    expect(mockSdk.promptsBySession.filter((p) => p.text.includes("Correction"))).toHaveLength(0);
    expect(store().get("dm:owner").messages.filter((m) => m.role === "user" && m.content.includes("Correction"))).toHaveLength(1);
  });
  it("hands a declined steer back to the session FIFO, behind work already queued there", async () => {
    // A background turn holds the session; a second one is queued behind it.
    // Web input prepared against the earlier private turn is declined at
    // injection and must take its place in the queue, not race the queue.
    let releaseFirst!: () => void; let releaseBackground!: () => void; let releasePreparation!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const backgroundGate = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    mockSdk.responseFn = async (text) => {
      if (text.includes("FIRST")) { await firstGate; return "Initial answer"; }
      if (text.includes("BACKGROUND-1")) { await backgroundGate; return "Background answer"; }
      return "Answer";
    };
    await sendProvider("FIRST"); await waitFor(() => expect(mockSdk.promptsBySession).toHaveLength(1));
    const internal = agent as unknown as { processInboundItems(...args: unknown[]): Promise<void> };
    const original = internal.processInboundItems.bind(agent);
    const preparation = vi.spyOn(internal, "processInboundItems").mockImplementationOnce(async (...args) => { await preparationGate; return original(...args); });
    const id = randomUUID(); await web.receive({ requestId: id, text: "PRIVATE" });
    await waitFor(() => expect(preparation).toHaveBeenCalled());
    const first = agent.handleCronMessage("BACKGROUND-1", "dm:owner");
    releaseFirst(); await waitFor(() => expect(mockSdk.promptsBySession).toHaveLength(2));
    // A note queued now is drained by the PRIVATE attempt that is about to be
    // declined: it must survive into the turn that really runs.
    agent.noteInterruptedWebRequests([{ timestamp: Date.now(), text: "Carry me" }], "owner");
    releasePreparation();
    // Declined at injection (running → queued again), not merely still queued.
    await waitFor(() => expect(statesOf(id).slice(-2)).toEqual(["running", "queued"]));
    const second = agent.handleCronMessage("BACKGROUND-2", "dm:owner");
    releaseBackground(); await first; await second; await drainQueue(agent);
    await waitFor(() => expect(web.request(id).state).toBe("completed"));
    const order = mockSdk.promptsBySession.map((p) => ["FIRST", "BACKGROUND-1", "PRIVATE", "BACKGROUND-2"].find((t) => p.text.includes(t)));
    expect(order).toEqual(["FIRST", "BACKGROUND-1", "PRIVATE", "BACKGROUND-2"]);
    expect(mockSdk.promptsBySession[2].text).toContain("Carry me");
    preparation.mockRestore();
  });
  it("reports an interrupted-request notice it could not persist, so it is not recorded as given", async () => {
    const write = vi.spyOn(SessionStore.prototype, "setPendingNotes").mockImplementation(() => { throw new Error("disk full"); });
    expect(agent.noteInterruptedWebRequests([{ timestamp: Date.now(), text: "x" }], "owner")).toBe(false);
    write.mockRestore();
    expect(agent.noteInterruptedWebRequests([{ timestamp: Date.now(), text: "x" }], "owner")).toBe(true);
  });
  it("tells the owner's session once about browser messages a restart interrupted", async () => {
    agent.noteInterruptedWebRequests([{ timestamp: Date.now(), text: "Send the invoice" }], "owner");
    await sendProvider("Anything new?"); await drainQueue(agent);
    const prompt = mockSdk.promptsBySession[0];
    expect(prompt.sessionKey).toBe("dm:owner");
    expect(prompt.text).toContain('type="web" name="interrupted"');
    expect(prompt.text).toContain("Send the invoice");
    expect(prompt.text).toContain("not re-run");
    await sendProvider("And now?"); await drainQueue(agent);
    expect(mockSdk.promptsBySession[1].text).not.toContain("interrupted");
  });
  it("keeps NO_REPLY and late silence filtering in the existing pipeline", async () => {
    mockSdk.responseFn = () => ["Visible block", "NO_REPLY"];
    await web.receive({ requestId: randomUUID(), text: "first" }); await drainQueue(agent);
    expect(webBlocks().map((b) => b.text)).toEqual(["Visible block"]);
    mockSdk.responseFn = () => "NO_REPLY";
    await web.receive({ requestId: randomUUID(), text: "second" }); await drainQueue(agent);
    expect(webBlocks()).toHaveLength(1);
    // The transcript intentionally preserves the raw turn; only delivery
    // filters silence. Web must not rewrite the session's existing policy.
    expect(store().get("dm:owner").messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["Visible block\nNO_REPLY", "NO_REPLY"]);
  });
  it("does not retry a failed web delivery and records it MARKED undelivered, not as a clean reply", async () => {
    vi.spyOn(web, "send");
    const reply = "x".repeat(260 * 1024);
    mockSdk.responseFn = () => reply;
    const requestId = randomUUID();
    await web.receive({ requestId, text: "question" }); await drainQueue(agent);
    expect(web.send).toHaveBeenCalledOnce();
    const messages = store().get("dm:owner").messages.filter((m) => m.role === "assistant");
    // P0-5: the reply never reached the browser, so the transcript must not
    // claim it did — the block is recorded with the delivery-failed marker.
    expect(messages).toHaveLength(1); expect(messages[0].content).toBe(`[delivery failed] ${reply}`);
    expect(web.request(requestId).state).toBe("failed");
    expect(webBlocks()).toEqual([]);
  });
  it("retains SDK estimated context metadata across a fresh reader", async () => {
    mockSdk.contextUsageFails = true;
    await web.receive({ requestId: randomUUID(), text: "context" }); await drainQueue(agent);
    expect(new WebData({ ...mockConfig, owner: mockConfig.owner }).catalog().sessions[0].stats.contextEstimated).toBe(true);
  });
  it("reports a queued message refused if a restore starts before processing", async () => {
    mockConfig.steering = false;
    let release!: () => void;
    mockSdk.responseFn = async () => { await new Promise<void>((resolve) => { release = resolve; }); return "First reply"; };
    await web.receive({ requestId: randomUUID(), text: "first" });
    await waitFor(() => expect(release).toBeTypeOf("function"));
    const requestId = randomUUID();
    await web.receive({ requestId, text: "queued before restore" });
    const commands = (agent as unknown as { commands: { isRestoring: boolean } }).commands;
    const restoring = vi.spyOn(commands, "isRestoring", "get").mockReturnValue(true);
    release(); await drainQueue(agent);
    expect(web.request(requestId).state).toBe("refused");
    expect(mockSdk.promptsBySession).toHaveLength(1);
    restoring.mockRestore();
  });
  it("preserves accepted input when shutdown interrupts the SDK and rejects later sends", async () => {
    let release!: () => void;
    mockSdk.responseFn = async () => { await new Promise<void>((resolve) => { release = resolve; }); return "Accepted reply"; };
    const requestId = randomUUID(); await web.receive({ requestId, text: "before stop" });
    await waitFor(() => expect(release).toBeTypeOf("function"));
    const stopped = agent.stop();
    await expect(web.receive({ requestId: randomUUID(), text: "after stop" })).rejects.toMatchObject({ status: 503 });
    release(); await stopped;
    expect(store().get("dm:owner").messages.some((m) => m.role === "user" && m.requestId === requestId && m.content === "before stop")).toBe(true);
    expect(web.request(requestId).state).not.toBe("queued");
  });
});

it.each(["background", "audience"])("rechecks web steering after async ingress preparation (%s changes)", async (change) => {
  let releaseFirst!: () => void; let releaseBackground!: () => void; let releasePreparation!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const backgroundGate = new Promise<void>((resolve) => { releaseBackground = resolve; });
  const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
  mockSdk.steerEcho = false;
  mockSdk.responseFn = async (text) => {
    if (text.includes("FIRST")) { await firstGate; return "Initial answer"; }
    if (text.includes("BACKGROUND")) { await backgroundGate; return "Background answer"; }
    return "Private browser answer";
  };
  await sendProvider("FIRST"); await waitFor(() => expect(mockSdk.promptsBySession).toHaveLength(1));
  const internal = agent as unknown as { processInboundItems(...args: unknown[]): Promise<void> };
  const original = internal.processInboundItems.bind(agent);
  const preparation = vi.spyOn(internal, "processInboundItems").mockImplementationOnce(async (...args) => { await preparationGate; return original(...args); });
  const id = randomUUID(); await web.receive({ requestId: id, text: "PRIVATE" });
  await waitFor(() => expect(preparation).toHaveBeenCalled());
  let background: Promise<unknown> | undefined;
  let audience: ReturnType<typeof vi.spyOn> | undefined;
  if (change === "background") {
    background = agent.handleCronMessage("BACKGROUND", "dm:owner");
    releaseFirst(); await waitFor(() => expect(mockSdk.promptsBySession).toHaveLength(2));
  } else audience = vi.spyOn(agent, "isOwnAudienceTurn").mockReturnValue(false);
  releasePreparation();
  await waitFor(() => expect(store().get("dm:owner").messages.some((m) => m.content === "PRIVATE")).toBe(true));
  const live = (agent as unknown as { liveSessionManager: { liveSessions: Map<string, { pendingSteers: unknown[]; idleWaiters: unknown[] }> } }).liveSessionManager.liveSessions.get("dm:owner")!;
  // Declined at injection: handed back to the session FIFO (requeued), not
  // parked in send() around it, and nothing reached the SDK input queue.
  await waitFor(() => expect(statesOf(id).slice(-2)).toEqual(["running", "queued"]));
  expect(live.pendingSteers).toHaveLength(0);
  expect(live.idleWaiters).toHaveLength(0);
  releaseFirst(); releaseBackground(); await background; await drainQueue(agent);
  await waitFor(() => expect(web.request(id).state).toBe("completed"));
  expect(web.request(id).joined).toBeUndefined();
  expect(webBlocks().map((b) => b.text)).toEqual(["Private browser answer"]);
  expect(store().get("dm:owner").messages.filter((m) => m.role === "assistant" && m.content === "Private browser answer")).toHaveLength(1);
  // Recorded once, though it was prepared twice (declined, then requeued).
  expect(store().get("dm:owner").messages.filter((m) => m.role === "user" && m.content.includes("PRIVATE"))).toHaveLength(1);
  audience?.mockRestore(); preparation.mockRestore();
});
