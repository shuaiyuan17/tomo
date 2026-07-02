import { describe, expect, it, vi } from "vitest";
import type { Channel, OutgoingMessage, StopTypingOptions, StreamingMessage } from "../src/channels/types.js";
import { DeliveryPipeline } from "../src/agent/delivery-pipeline.js";
import { isSilentReply } from "../src/agent/text-utils.js";
import { STEER_MERGED } from "../src/agent/live-session.js";
import {
  TurnRunner,
  embeddedSilentMatcher,
  injectTimestamp,
  type RunWithRetryRequest,
  type TurnRunnerDeps,
  type TurnSpec,
} from "../src/agent/turn-runner.js";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface StreamLog {
  updates: string[];
  finished: boolean;
  canceled: boolean;
  committed: number;
}

class FakeChannel implements Channel {
  readonly name: string;
  sent: OutgoingMessage[] = [];
  streams: StreamLog[] = [];

  constructor(name = "telegram") { this.name = name; }

  onMessage(): void {}
  onCommand(): void {}
  async send(message: OutgoingMessage): Promise<void> { this.sent.push(message); }
  createStreamingMessage(): StreamingMessage {
    const log: StreamLog = { updates: [], finished: false, canceled: false, committed: 0 };
    this.streams.push(log);
    return {
      update: (text) => { log.updates.push(text); },
      finish: async () => { log.finished = true; },
      cancel: async () => { log.canceled = true; },
      discardBlock: async () => {},
      commitBlock: async () => { log.committed++; },
    };
  }
  startTyping(): () => void { return () => {}; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

interface Harness {
  runner: TurnRunner;
  channel: FakeChannel;
  prompts: RunWithRetryRequest[];
  transcript: Array<{ sessionKey: string; content: string; channelName: string }>;
  errorNotes: Array<{ sessionKey: string; visibleError: string }>;
  typingStarts: Array<{ chatId: string; passiveListen: boolean | undefined }>;
  typingStops: Array<StopTypingOptions | undefined>;
}

function makeHarness(respond: (req: RunWithRetryRequest) => Promise<string>): Harness {
  const channel = new FakeChannel();
  const prompts: RunWithRetryRequest[] = [];
  const transcript: Harness["transcript"] = [];
  const errorNotes: Harness["errorNotes"] = [];
  const typingStarts: Harness["typingStarts"] = [];
  const typingStops: Harness["typingStops"] = [];

  const deps: TurnRunnerDeps = {
    drainPendingNotes: () => "[note]\n\n",
    runWithRetry: (req) => { prompts.push(req); return respond(req); },
    appendAssistantTranscript: (sessionKey, content, channelName) => {
      transcript.push({ sessionKey, content, channelName });
    },
    queuePendingErrorNote: (sessionKey, visibleError) => {
      errorNotes.push({ sessionKey, visibleError });
    },
    startTurnTyping: (ch, chatId, passiveListen) => {
      typingStarts.push({ chatId, passiveListen });
      return (options) => { typingStops.push(options); };
    },
    delivery: new DeliveryPipeline({
      queuePendingErrorNote: (sessionKey, visibleError) => {
        errorNotes.push({ sessionKey, visibleError });
      },
    }),
  };

  return { runner: new TurnRunner(deps), channel, prompts, transcript, errorNotes, typingStarts, typingStops };
}

function streamSpec(h: Harness, overrides: Partial<TurnSpec> = {}): TurnSpec {
  return {
    key: "telegram:123",
    prompt: "hello",
    stampChannelName: "telegram",
    typing: { channel: h.channel, chatId: "123", passiveListen: false },
    delivery: { kind: "stream", channel: h.channel, chatId: "123" },
    silentMatcher: isSilentReply,
    transcript: "always",
    errors: {
      visiblePrefix: "[error] ",
      response: "deliver",
      thrown: "deliver",
      thrownLogMessage: "Error handling message",
    },
    ...overrides,
  };
}

function sendSpec(h: Harness, overrides: Partial<TurnSpec> = {}): TurnSpec {
  return {
    key: "telegram:123",
    prompt: "cron task",
    stampChannelName: "telegram",
    typing: { channel: h.channel, chatId: "123", passiveListen: false },
    delivery: { kind: "send", channel: h.channel, chatId: "123" },
    silentMatcher: embeddedSilentMatcher,
    transcript: "on-delivery",
    errors: {
      visiblePrefix: "[error] cron failed: ",
      response: "deliver",
      thrown: "deliver",
      thrownLogMessage: "Cron message handling failed",
    },
    ...overrides,
  };
}

describe("injectTimestamp", () => {
  it("stamps a channel-labeled timestamp prefix", () => {
    expect(injectTimestamp("hi", "telegram")).toMatch(/^\[telegram · .+ \d{2}\/\d{2} \d{2}:\d{2} .+\] hi$/);
  });

  it("omits the channel label when none is given", () => {
    expect(injectTimestamp("hi")).toMatch(/^\[[^·]+\] hi$/);
  });
});

describe("silent matchers", () => {
  it("keeps the bare/substring inconsistency in one place", () => {
    expect(embeddedSilentMatcher("NO_REPLY")).toBe(true);
    expect(embeddedSilentMatcher("did the thing. NO_REPLY")).toBe(true);
    expect(isSilentReply("did the thing. NO_REPLY")).toBe(false);
  });
});

describe("TurnRunner prompt assembly", () => {
  it("drains pending notes and stamps the timestamp for stamped specs", async () => {
    const h = makeHarness(async () => "ok");
    await h.runner.runTurn(sendSpec(h));

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].prompt).toMatch(/^\[note\]\n\n\[telegram · .+\] cron task$/);
  });

  it("sends the prompt unstamped when stampChannelName is absent (continuity)", async () => {
    const h = makeHarness(async () => "ok");
    await h.runner.runTurn(sendSpec(h, { stampChannelName: undefined }));

    expect(h.prompts[0].prompt).toBe("[note]\n\ncron task");
  });
});

describe("TurnRunner stream turns", () => {
  it("appends the transcript, finishes the stream, and stops typing", async () => {
    const h = makeHarness(async () => "streamed reply");
    const result = await h.runner.runTurn(streamSpec(h));

    expect(result).toBe(true);
    expect(h.transcript).toEqual([{ sessionKey: "telegram:123", content: "streamed reply", channelName: "telegram" }]);
    expect(h.channel.streams[0].finished).toBe(true);
    expect(h.typingStarts).toEqual([{ chatId: "123", passiveListen: false }]);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });

  it("still appends a silent reply to the transcript but cancels the stream", async () => {
    const h = makeHarness(async () => "NO_REPLY");
    await h.runner.runTurn(streamSpec(h));

    expect(h.transcript).toHaveLength(1);
    expect(h.channel.streams[0].canceled).toBe(true);
    expect(h.channel.streams[0].finished).toBe(false);
  });

  it("uses the spec's silentMatcher for stream delivery", async () => {
    const h = makeHarness(async () => "text then NO_REPLY");
    await h.runner.runTurn(streamSpec(h, { silentMatcher: embeddedSilentMatcher }));

    expect(h.channel.streams[0].canceled).toBe(true);
    expect(h.channel.streams[0].finished).toBe(false);
  });

  it("short-circuits a steered turn that merged (STEER_MERGED)", async () => {
    const h = makeHarness(async () => STEER_MERGED);
    const result = await h.runner.runTurn(streamSpec(h, {
      delivery: { kind: "stream", channel: h.channel, chatId: "123", steer: true },
    }));

    expect(result).toBe(true);
    expect(h.transcript).toHaveLength(0);
    expect(h.channel.streams[0].canceled).toBe(true);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });

  it("delivers thrown errors as [error] text through channel.send", async () => {
    const h = makeHarness(async () => { throw new Error("boom"); });
    const result = await h.runner.runTurn(streamSpec(h));

    expect(result).toBe(false);
    expect(h.errorNotes).toEqual([{ sessionKey: "telegram:123", visibleError: "[error] boom" }]);
    expect(h.channel.sent).toEqual([{ chatId: "123", text: "[error] boom" }]);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });

  it("suppresses thrown errors entirely for passive groups (thrown: ignore)", async () => {
    const h = makeHarness(async () => { throw new Error("boom"); });
    const result = await h.runner.runTurn(streamSpec(h, {
      errors: { visiblePrefix: "[error] ", response: "deliver", thrown: "ignore", thrownLogMessage: "Error handling message" },
    }));

    expect(result).toBe(false);
    expect(h.errorNotes).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });
});

describe("TurnRunner send turns", () => {
  it("appends the transcript only on delivery and sends the response", async () => {
    const h = makeHarness(async () => "cron says hi");
    const result = await h.runner.runTurn(sendSpec(h));

    expect(result).toBe(true);
    expect(h.transcript).toEqual([{ sessionKey: "telegram:123", content: "cron says hi", channelName: "telegram" }]);
    expect(h.channel.sent).toEqual([{ chatId: "123", text: "cron says hi" }]);
  });

  it("treats responses containing NO_REPLY as silent (no send, no transcript)", async () => {
    const h = makeHarness(async () => "did housekeeping. NO_REPLY");
    const result = await h.runner.runTurn(sendSpec(h));

    expect(result).toBe(true);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.transcript).toHaveLength(0);
  });

  it("suppresses non-silent output when suppressDelivery is set", async () => {
    const h = makeHarness(async () => "should never reach the chat");
    const result = await h.runner.runTurn(sendSpec(h, {
      delivery: { kind: "send", channel: h.channel, chatId: "123", suppressDelivery: true },
    }));

    expect(result).toBe(true);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.transcript).toHaveLength(0);
  });

  it("queues and delivers agent-error responses, resolving false", async () => {
    const h = makeHarness(async () => "API Error: 529 overloaded");
    const result = await h.runner.runTurn(sendSpec(h));

    expect(result).toBe(false);
    expect(h.errorNotes).toEqual([
      { sessionKey: "telegram:123", visibleError: "[error] cron failed: API Error: 529 overloaded" },
    ]);
    expect(h.channel.sent).toEqual([{ chatId: "123", text: "[error] cron failed: API Error: 529 overloaded" }]);
    expect(h.transcript).toHaveLength(0);
  });

  it("keeps agent-error responses out of the chat when response policy is note-only", async () => {
    const h = makeHarness(async () => "API Error: 529 overloaded");
    const result = await h.runner.runTurn(sendSpec(h, {
      errors: {
        visiblePrefix: "[error] cron failed: ",
        response: "note-only",
        thrown: "note-only",
        thrownLogMessage: "Cron message handling failed",
      },
    }));

    expect(result).toBe(false);
    expect(h.errorNotes).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
  });

  it("queues thrown errors without delivery when thrown policy is note-only", async () => {
    const h = makeHarness(async () => { throw new Error("boom"); });
    const result = await h.runner.runTurn(sendSpec(h, {
      errors: {
        visiblePrefix: "[error] cron failed: ",
        response: "note-only",
        thrown: "note-only",
        thrownLogMessage: "Cron message handling failed",
      },
    }));

    expect(result).toBe(false);
    expect(h.errorNotes).toEqual([{ sessionKey: "telegram:123", visibleError: "[error] cron failed: boom" }]);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });

  it("skips the typing indicator when the spec has none", async () => {
    const h = makeHarness(async () => "quiet");
    await h.runner.runTurn(sendSpec(h, { typing: undefined }));

    expect(h.typingStarts).toHaveLength(0);
    expect(h.typingStops).toHaveLength(0);
  });
});

describe("TurnRunner deferred-send turns (continuity)", () => {
  function continuitySpec(h: Harness, resolveTarget: () => { channel: Channel; chatId: string } | undefined): TurnSpec {
    return {
      key: "dm:shuai",
      prompt: "System: Free time.",
      delivery: { kind: "deferred-send", resolveTarget },
      silentMatcher: embeddedSilentMatcher,
      transcript: "never",
      errors: {
        visiblePrefix: "[error] continuity failed: ",
        response: "note-only",
        thrown: "ignore",
        thrownLogMessage: "Continuity heartbeat failed",
      },
    };
  }

  it("resolves the target only after a non-silent response and never appends the transcript", async () => {
    const h = makeHarness(async () => "Good morning!");
    const resolveTarget = vi.fn(() => ({ channel: h.channel as Channel, chatId: "123" }));
    const result = await h.runner.runTurn(continuitySpec(h, resolveTarget));

    expect(result).toBe(true);
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(h.channel.sent).toEqual([{ chatId: "123", text: "Good morning!" }]);
    expect(h.transcript).toHaveLength(0);
    expect(h.typingStarts).toHaveLength(0);
  });

  it("does not resolve the target for silent responses", async () => {
    const h = makeHarness(async () => "nothing to say NO_REPLY");
    const resolveTarget = vi.fn(() => ({ channel: h.channel as Channel, chatId: "123" }));
    await h.runner.runTurn(continuitySpec(h, resolveTarget));

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(0);
  });

  it("skips delivery when no target resolves", async () => {
    const h = makeHarness(async () => "orphan response");
    const result = await h.runner.runTurn(continuitySpec(h, () => undefined));

    expect(result).toBe(true);
    expect(h.channel.sent).toHaveLength(0);
  });

  it("only queues a note for agent-error responses and only logs thrown errors", async () => {
    const errorResponse = makeHarness(async () => "API Error: 500 broken");
    await errorResponse.runner.runTurn(continuitySpec(errorResponse, () => undefined));
    expect(errorResponse.errorNotes).toEqual([
      { sessionKey: "dm:shuai", visibleError: "[error] continuity failed: API Error: 500 broken" },
    ]);
    expect(errorResponse.channel.sent).toHaveLength(0);

    const thrown = makeHarness(async () => { throw new Error("boom"); });
    const result = await thrown.runner.runTurn(continuitySpec(thrown, () => undefined));
    expect(result).toBe(false);
    expect(thrown.errorNotes).toHaveLength(0);
    expect(thrown.channel.sent).toHaveLength(0);
  });
});
