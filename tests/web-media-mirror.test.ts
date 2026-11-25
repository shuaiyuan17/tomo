import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Channel, OutgoingMessage } from "../src/channels/types.js";
import { DeliveryPipeline } from "../src/agent/delivery-pipeline.js";
import { isSilentReply } from "../src/agent/text-utils.js";
import { TurnRunner, type RunWithRetryRequest, type TurnRunnerDeps, type TurnSpec } from "../src/agent/turn-runner.js";
import { SessionStore } from "../src/sessions/store.js";
import { WebData } from "../src/web/data.js";
import { webSessionId } from "../src/web/owner.js";
import { OutgoingMediaStore, outgoingImagesDir } from "../src/web/outgoing-media.js";
import { replyTargetFromRawSessionKey } from "../src/sessions/keys.js";

vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../src/config.js", () => ({ config: { owner: undefined, identities: [] } }));
const { ProactiveSendService } = await import("../src/agent/proactive-send.js");

/**
 * The owner reads his DM on the web, but a reply can go out on iMessage (a
 * turn he started there, a send_message). Its picture used to show on the
 * web as "no longer available": only the web outlet filed what it sent.
 * Now every delivered attachment of the conversation is filed for the web
 * view under a ref the transcript record carries.
 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
class FakeChannel implements Channel {
  sent: OutgoingMessage[] = [];
  constructor(readonly name = "imessage") {}
  onMessage(): void {}
  onCommand(): void {}
  async send(message: OutgoingMessage): Promise<void> { this.sent.push(message); }
  startTyping(): () => void { return () => {}; }
  async start(): Promise<void> {}
  closeIngestion(): void {}
  async quiesce(): Promise<void> {}
  async teardown(): Promise<void> {}
  async stop(): Promise<void> {}
}

let root: string;
let workspace: string;
let picture: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-mirror-"));
  workspace = join(root, "workspace");
  mkdirSync(join(root, "tmp"), { recursive: true });
  picture = join(root, "tmp", "after-ipad.png");
  writeFileSync(picture, PNG);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function runner(channel: Channel, options: { mirror?: boolean } = {}) {
  const transcript: Array<{ sessionKey: string; content: string; channelName: string; correlation?: Record<string, unknown> }> = [];
  const mirrored: Array<{ sessionKey: string; ref: string; path: string }> = [];
  const notes: Array<{ sessionKey: string; note: string }> = [];
  const deps: TurnRunnerDeps = {
    drainPendingNotes: () => "",
    runWithRetry: async (req: RunWithRetryRequest) => { await req.onBlock?.(`Before and after:\nMEDIA:${picture}`); return `Before and after:\nMEDIA:${picture}`; },
    appendAssistantTranscript: (sessionKey, content, channelName, correlation) => { transcript.push({ sessionKey, content, channelName, ...(correlation ? { correlation } : {}) }); },
    queuePendingErrorNote: () => {},
    queueDeliveryFailureNote: (sessionKey, note) => { notes.push({ sessionKey, note }); },
    startTurnTyping: () => () => {},
    isPrivateMemoryBarred: () => false,
    delivery: new DeliveryPipeline({ queuePendingErrorNote: () => {} }),
    ...(options.mirror === false ? {} : { mirrorMedia: (sessionKey: string, ref: string, path: string) => { mirrored.push({ sessionKey, ref, path }); } }),
  };
  return { runner: new TurnRunner(deps), transcript, mirrored, notes };
}
const spec = (channel: Channel, overrides: Partial<TurnSpec> = {}): TurnSpec => ({
  key: "dm:owner", prompt: "show me", stampChannelName: channel.name,
  typing: { channel, chatId: "c1", passiveListen: false }, delivery: { kind: "reply", channel, chatId: "c1" },
  silentMatcher: isSilentReply, transcript: "on-delivery",
  errors: { visibleError: "reply", response: "deliver", thrown: "deliver", thrownLogMessage: "x" }, ...overrides,
});

describe("a reply delivered on another channel is filed for the web view", () => {
  it("the shipped picture is mirrored under the turn's id, and the transcript record names it (mediaRef, not turnId)", async () => {
    const channel = new FakeChannel("imessage");
    const h = runner(channel);
    expect(await h.runner.runTurn(spec(channel))).toBe(true);
    expect(channel.sent.some((m) => m.photo === picture)).toBe(true);
    expect(h.mirrored).toHaveLength(1);
    expect(h.mirrored[0]).toMatchObject({ sessionKey: "dm:owner", path: picture });
    expect(h.transcript).toHaveLength(1);
    expect(h.transcript[0].correlation).toEqual({ mediaRef: h.mirrored[0].ref });
    // Not a web turn: no requestId / turnId (the web groups a turn's blocks by those).
    expect(h.transcript[0].correlation).not.toHaveProperty("turnId");
  });
  it("the web outlet's own turn is not mirrored (the outlet files it)", async () => {
    const channel = new FakeChannel("web");
    const h = runner(channel);
    await h.runner.runTurn(spec(channel));
    expect(h.mirrored).toEqual([]);
  });
  it("a picture that did not ship (missing file) is not mirrored", async () => {
    const channel = new FakeChannel("imessage");
    rmSync(picture);
    const h = runner(channel);
    await h.runner.runTurn(spec(channel));
    expect(h.mirrored).toEqual([]);
  });
  it("a silent background turn that names attachments tells the next turn they were never delivered", async () => {
    const channel = new FakeChannel("imessage");
    const h = runner(channel);
    await h.runner.runTurn(spec(channel, { source: "continuity", delivery: { kind: "deferred-send", suppressDelivery: true, resolveTarget: () => ({ channel, chatId: "c1" }) } }));
    expect(channel.sent).toEqual([]);
    expect(h.mirrored).toEqual([]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].sessionKey).toBe("dm:owner");
    expect(h.notes[0].note).toContain("[not delivered]");
    expect(h.notes[0].note).toContain(picture);
    expect(h.notes[0].note).toContain("send_message");
    // A task's own turn speaks through task_* tools: no note there.
    const task = runner(channel);
    await task.runner.runTurn(spec(channel, { key: "task:s1", source: "continuity", delivery: { kind: "deferred-send", suppressDelivery: true, resolveTarget: () => undefined } }));
    expect(task.notes).toEqual([]);
  });
});

describe("end to end: an iMessage delivery shows on the web history", () => {
  it("TurnRunner → WebChannel-style mirror into the store → WebData history rewrites the tag to the filed id", async () => {
    const sessionsDir = join(root, "sessions"), sdkSessionsDir = join(root, "sdk");
    const sessions = new SessionStore(sessionsDir, 20, sdkSessionsDir);
    sessions.setSdkSessionId("dm:owner", "sdk-1");
    const store = new OutgoingMediaStore(outgoingImagesDir(workspace), { isPrivate: (p) => p.includes("/memory/private/") });
    const channel = new FakeChannel("imessage");
    const deps: TurnRunnerDeps = {
      drainPendingNotes: () => "",
      runWithRetry: async (req) => { await req.onBlock?.(`Before and after:\nMEDIA:${picture}`); return ""; },
      appendAssistantTranscript: (sessionKey, content, channelName, correlation) => sessions.append(sessionKey, { role: "assistant", ...correlation, content, channel: channelName, timestamp: Date.now() }),
      queuePendingErrorNote: () => {},
      startTurnTyping: () => () => {},
      isPrivateMemoryBarred: () => false,
      delivery: new DeliveryPipeline({ queuePendingErrorNote: () => {} }),
      mirrorMedia: (sessionKey, ref, path) => { store.file(sessionKey, [ref], path); },
    };
    await new TurnRunner(deps).runTurn(spec(channel));
    // Older history (never filed) stays "gone"; the source file may go — the store has a copy.
    rmSync(picture);
    const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
    const data = new WebData({ sessionsDir, sdkSessionsDir, owner, workspaceDir: workspace });
    const id = webSessionId("dm:owner");
    const page = await data.history(id);
    const reply = page.messages.find((m) => m.role === "assistant")!;
    const token = /MEDIA:web:([a-f0-9]{32})/.exec(reply.content);
    expect(token).not.toBeNull();
    expect(reply.content).not.toContain(picture);
    expect(reply).not.toHaveProperty("mediaRef");
    expect(data.outgoingFile(id, token![1]).bytes.equals(PNG)).toBe(true);
  });
});

describe("send_message (proactive) mirrors what it delivered", () => {
  it("each delivered attachment is mirrored under one ref, which the transcript record carries", async () => {
    const channel = new FakeChannel("telegram");
    const mirrored: Array<{ sessionKey: string; ref: string; path: string }> = [];
    const transcript: unknown[][] = [];
    const service = new ProactiveSendService({
      getChannel: (name) => (name === channel.name ? channel : undefined),
      isPrivateMemoryBarred: () => false,
      getSummonedIdentity: () => undefined,
      dmReplyTarget: () => undefined,
      sessionReplyTarget: (key) => replyTargetFromRawSessionKey(key),
      appendAssistantTranscript: (...args) => { transcript.push(args); },
      mirrorMedia: (sessionKey, ref, path) => { mirrored.push({ sessionKey, ref, path }); },
      setChatTitle: () => {},
      listActiveEntries: () => [],
      queuePendingNote: () => {},
      runDelegateTurn: async () => true,
    });
    const result = await service.sendToSession("telegram:12345", `Here:\nMEDIA:${picture}\nMEDIA:${join(root, "tmp", "missing.png")}`, "telegram:12345");
    expect(result.ok).toBe(true);
    expect(mirrored).toEqual([{ sessionKey: "telegram:12345", ref: expect.any(String), path: picture }]);
    expect(transcript[0][3]).toEqual({ mediaRef: mirrored[0].ref });
    // Text only: nothing mirrored, the record exactly as before (three arguments).
    await service.sendToSession("telegram:12345", "plain", "telegram:12345");
    expect(transcript[1]).toHaveLength(3);
  });
});
