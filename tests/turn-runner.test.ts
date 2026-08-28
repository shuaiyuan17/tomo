import { describe, expect, it, vi } from "vitest";
import type { Channel, OutgoingMessage, StopTypingOptions } from "../src/channels/types.js";
import { DeliveryPipeline } from "../src/agent/delivery-pipeline.js";
import { isSilentReply } from "../src/agent/text-utils.js";
import { STEER_MERGED } from "../src/agent/live-session.js";
import {
  TurnRunner,
  embeddedSilentMatcher,
  injectTimestamp,
  originForSource,
  type RunWithRetryRequest,
  type TurnRunnerDeps,
  type TurnSpec,
} from "../src/agent/turn-runner.js";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

class FakeChannel implements Channel {
  readonly name: string;
  sent: OutgoingMessage[] = [];

  constructor(name = "telegram") { this.name = name; }

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

function replySpec(h: Harness, overrides: Partial<TurnSpec> = {}): TurnSpec {
  return {
    key: "telegram:123",
    prompt: "hello",
    stampChannelName: "telegram",
    typing: { channel: h.channel, chatId: "123", passiveListen: false },
    delivery: { kind: "reply", channel: h.channel, chatId: "123" },
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
    silentMatcher: isSilentReply,
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

describe("originForSource", () => {
  it("stamps channel-relayed user turns as human and harness turns as unclassified", () => {
    // The SDK fails closed at its strict isHuman() gates when origin is
    // absent, so a person's message must say so; cron/continuity are not a
    // person typing and none of the other SDK kinds describes them.
    expect(originForSource("user")).toEqual({ kind: "human" });
    expect(originForSource("cron")).toEqual({ kind: "unclassified" });
    expect(originForSource("continuity")).toEqual({ kind: "unclassified" });
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

describe("TurnRunner reply turns", () => {
  it("appends the transcript, ships one message, and stops typing", async () => {
    const h = makeHarness(async () => "the reply");
    const result = await h.runner.runTurn(replySpec(h));

    expect(result).toBe(true);
    expect(h.transcript).toEqual([{ sessionKey: "telegram:123", content: "the reply", channelName: "telegram" }]);
    expect(h.channel.sent).toEqual([{ chatId: "123", text: "the reply" }]);
    expect(h.typingStarts).toEqual([{ chatId: "123", passiveListen: false }]);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });

  it("ships a multi-line reply as ONE send with its newlines intact", async () => {
    const h = makeHarness(async () => "line one\nline two\nline three");
    await h.runner.runTurn(replySpec(h));

    expect(h.channel.sent).toEqual([{ chatId: "123", text: "line one\nline two\nline three" }]);
  });

  it("threads the reply to the triggering message when the spec carries one", async () => {
    const h = makeHarness(async () => "on it");
    await h.runner.runTurn(replySpec(h, {
      delivery: { kind: "reply", channel: h.channel, chatId: "123", replyToMessageId: "msg-9" },
    }));

    expect(h.channel.sent).toEqual([{ chatId: "123", text: "on it", replyTo: "msg-9" }]);
  });

  it("still appends a silent reply to the transcript but sends nothing", async () => {
    const h = makeHarness(async () => "NO_REPLY");
    await h.runner.runTurn(replySpec(h));

    expect(h.transcript).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
  });

  it("uses the spec's silentMatcher for reply delivery", async () => {
    const h = makeHarness(async () => "text then NO_REPLY");
    await h.runner.runTurn(replySpec(h, { silentMatcher: embeddedSilentMatcher }));

    expect(h.channel.sent).toHaveLength(0);
  });

  it("short-circuits a steered turn that merged (STEER_MERGED)", async () => {
    const h = makeHarness(async () => STEER_MERGED);
    const result = await h.runner.runTurn(replySpec(h, {
      delivery: { kind: "reply", channel: h.channel, chatId: "123", steer: true },
    }));

    expect(result).toBe(true);
    expect(h.transcript).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });

  it("delivers thrown errors as [error] text through channel.send", async () => {
    const h = makeHarness(async () => { throw new Error("boom"); });
    const result = await h.runner.runTurn(replySpec(h));

    expect(result).toBe(false);
    expect(h.errorNotes).toEqual([{ sessionKey: "telegram:123", visibleError: "[error] boom" }]);
    expect(h.channel.sent).toEqual([{ chatId: "123", text: "[error] boom" }]);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });

  it("suppresses thrown errors entirely for passive groups (thrown: ignore)", async () => {
    const h = makeHarness(async () => { throw new Error("boom"); });
    const result = await h.runner.runTurn(replySpec(h, {
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

  it("delivers prose that merely mentions NO_REPLY inline", async () => {
    const h = makeHarness(async () => "did housekeeping. NO_REPLY");
    const result = await h.runner.runTurn(sendSpec(h));

    expect(result).toBe(true);
    expect(h.channel.sent).toEqual([{ chatId: "123", text: "did housekeeping. NO_REPLY" }]);
    expect(h.transcript).toEqual([
      { sessionKey: "telegram:123", content: "did housekeeping. NO_REPLY", channelName: "telegram" },
    ]);
  });

  it("suppresses the whole turn when narration ends with a trailing NO_REPLY line", async () => {
    const h = makeHarness(async () => "archived the logs, nothing urgent\nNO_REPLY");
    const result = await h.runner.runTurn(sendSpec(h));

    expect(result).toBe(true);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.transcript).toHaveLength(0);
  });

  it("suppresses the whole turn on repeated trailing NO_REPLY blocks", async () => {
    const h = makeHarness(async () => "cron says hi\nNO_REPLY\nNO_REPLY");
    const result = await h.runner.runTurn(sendSpec(h));

    expect(result).toBe(true);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.transcript).toHaveLength(0);
  });

  it("keeps repeated trailing NO_REPLY-only send turns silent", async () => {
    const h = makeHarness(async () => "NO_REPLY\nNO_REPLY");
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
      silentMatcher: isSilentReply,
      transcript: "on-delivery",
      errors: {
        visiblePrefix: "[error] continuity failed: ",
        response: "note-only",
        thrown: "ignore",
        thrownLogMessage: "Continuity heartbeat failed",
      },
    };
  }

  it("resolves the target only after a non-silent response and records the delivery in the transcript", async () => {
    const h = makeHarness(async () => "Good morning!");
    const resolveTarget = vi.fn(() => ({ channel: h.channel as Channel, chatId: "123" }));
    const result = await h.runner.runTurn(continuitySpec(h, resolveTarget));

    expect(result).toBe(true);
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(h.channel.sent).toEqual([{ chatId: "123", text: "Good morning!" }]);
    expect(h.transcript).toEqual([{ sessionKey: "dm:shuai", content: "Good morning!", channelName: "telegram" }]);
    expect(h.typingStarts).toHaveLength(0);
  });

  it("does not resolve the target for silent responses", async () => {
    const h = makeHarness(async () => "NO_REPLY");
    const resolveTarget = vi.fn(() => ({ channel: h.channel as Channel, chatId: "123" }));
    await h.runner.runTurn(continuitySpec(h, resolveTarget));

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(0);
    expect(h.transcript).toHaveLength(0);
  });

  it("skips delivery when no target resolves", async () => {
    const h = makeHarness(async () => "orphan response");
    const result = await h.runner.runTurn(continuitySpec(h, () => undefined));

    expect(result).toBe(true);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.transcript).toHaveLength(0);
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
