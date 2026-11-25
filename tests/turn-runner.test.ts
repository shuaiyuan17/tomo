import { describe, expect, it, vi } from "vitest";
import type { Channel, OutgoingMessage, StopTypingOptions } from "../src/channels/types.js";
import { DeliveryPipeline } from "../src/agent/delivery-pipeline.js";
import { isSilentReply } from "../src/agent/text-utils.js";
import { EMPTY_REPLY, STEER_MERGED, SdkResultError } from "../src/agent/live-session.js";
import { PartialSendError } from "../src/channels/types.js";
import {
  TurnRunner,
  injectTimestamp,
  originForSource,
  type RunWithRetryRequest,
  type TurnRunnerDeps,
  type TurnSpec,
} from "../src/agent/turn-runner.js";
import type { PromptContextTicket } from "../src/agent/live-session-manager.js";
import { SteerDeclinedError } from "../src/agent/sdk-result.js";
import { watchBus } from "../src/watch/bus.js";
import type { WatchEvent } from "../src/watch/protocol.js";

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

/** A TurnRunner over a FakeChannel that records everything it is handed.
 *  `overrides` replace (or add) deps, e.g. the note-settling callbacks. */
function makeHarness(respond: (req: RunWithRetryRequest) => Promise<string>, overrides: Partial<TurnRunnerDeps> = {}): Harness {
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
    isPrivateMemoryBarred: () => false,
    delivery: new DeliveryPipeline({
      queuePendingErrorNote: (sessionKey, visibleError) => {
        errorNotes.push({ sessionKey, visibleError });
      },
    }),
    ...overrides,
  };

  return { runner: new TurnRunner(deps), channel, prompts, transcript, errorNotes, typingStarts, typingStops };
}

function replySpec(h: Harness, overrides: Partial<TurnSpec> = {}): TurnSpec {
  return {
    key: "telegram:123",
    source: "user",
    prompt: "hello",
    stampChannelName: "telegram",
    typing: { channel: h.channel, chatId: "123", passiveListen: false },
    delivery: { kind: "reply", channel: h.channel, chatId: "123" },
    silentMatcher: isSilentReply,
    transcript: "always",
    errors: {
      visibleError: "reply",
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
    source: "cron",
    prompt: "cron task",
    stampChannelName: "telegram",
    typing: { channel: h.channel, chatId: "123", passiveListen: false },
    delivery: { kind: "send", channel: h.channel, chatId: "123" },
    silentMatcher: isSilentReply,
    transcript: "on-delivery",
    errors: {
      visibleError: "cron",
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

// SDK error results reach TurnRunner as a rejected turn (SdkResultError), so
// the spec's `thrown` policy — not the block sink — decides what the chat
// sees, and the boolean CronScheduler.markRun reads says the turn failed.
describe("SDK error results through the turn pipeline", () => {
  const maxTurns = () => new SdkResultError(
    "I ran out of steps trying to complete that. Can you try a simpler request?",
    "error_max_turns",
    ["too many turns"],
  );

  it("user turn: reports failure, delivers the visible error after the blocks that shipped, records both", async () => {
    const h = makeHarness(async (req) => {
      await req.onBlock?.("partial progress");
      throw maxTurns();
    });

    const ok = await h.runner.runTurn(replySpec(h));

    expect(ok).toBe(false);
    expect(h.channel.sent.map((m) => m.text)).toEqual([
      "partial progress",
      "[error] I ran out of steps trying to complete that. Can you try a simpler request?",
    ]);
    expect(h.transcript.map((t) => t.content)).toEqual([
      "partial progress",
      "[error] I ran out of steps trying to complete that. Can you try a simpler request?",
    ]);
    expect(h.errorNotes).toHaveLength(1);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });

  it("group cron (note-only): nothing reaches the chat, the failure is queued for the next turn, run reported failed", async () => {
    const h = makeHarness(async () => { throw maxTurns(); });

    const ok = await h.runner.runTurn(sendSpec(h, {
      key: "telegram:-100group",
      delivery: { kind: "send", channel: h.channel, chatId: "-100group" },
      errors: {
        visibleError: "cron",
        response: "note-only",
        thrown: "note-only",
        thrownLogMessage: "Cron message handling failed",
      },
    }));

    expect(ok).toBe(false);
    expect(h.channel.sent).toEqual([]);
    expect(h.errorNotes).toEqual([{
      sessionKey: "telegram:-100group",
      visibleError: "[error] cron failed: I ran out of steps trying to complete that. Can you try a simpler request?",
    }]);
  });

  it("continuity (ignore): stays silent and reports failure", async () => {
    const h = makeHarness(async () => { throw new SdkResultError("API Error: 529 overloaded", "success", []); });

    const ok = await h.runner.runTurn(sendSpec(h, {
      delivery: { kind: "deferred-send", resolveTarget: () => ({ channel: h.channel, chatId: "123" }) },
      errors: {
        visibleError: "continuity",
        response: "note-only",
        thrown: "ignore",
        thrownLogMessage: "Continuity failed",
      },
    }));

    expect(ok).toBe(false);
    expect(h.channel.sent).toEqual([]);
    expect(h.errorNotes).toEqual([]);
  });
});

describe("safeguard failures", () => {
  it("does not queue ordinary API Error prose as a pending error note", async () => {
    const reply = "API Error: is a label for a failed API request.";
    const h = makeHarness(async (req) => {
      await req.onBlock?.(reply);
      return reply;
    });
    expect(await h.runner.runTurn(replySpec(h))).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    expect(h.channel.sent[0].text).toBe(reply);
    expect(h.errorNotes).toEqual([]);
  });

  it.each([false, true])("does not feed the raw refusal into the next prompt (thrown=%s)", async (thrown) => {
    const error = "API Error: Example Model's safeguards flagged this message. Request ID: req_example";
    const h = makeHarness(async (req) => {
      await req.onBlock?.(error);
      if (thrown) throw new SdkResultError(error, "success");
      return error;
    });
    expect(await h.runner.runTurn(replySpec(h))).toBe(false);
    expect(h.channel.sent).toHaveLength(1);
    expect(h.channel.sent[0].text).toContain("req_example");
    expect(h.channel.sent[0].text).toContain("/rewind");
    expect(h.errorNotes).toEqual([]);
  });

  it("keeps a safeguard failure silent under a note-only policy", async () => {
    const error = "API Error: Example Model's safeguards flagged this message.";
    const h = makeHarness(async (req) => {
      await req.onBlock?.(error);
      throw new SdkResultError(error, "success");
    });
    const spec = replySpec(h);
    spec.errors.thrown = "note-only";
    expect(await h.runner.runTurn(spec)).toBe(false);
    expect(h.channel.sent).toEqual([]);
    expect(h.errorNotes).toEqual([]);
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

  it("an empty reply is silent to the channel and reported via onEmpty; a literal NO_REPLY is not", async () => {
    const empty = makeHarness(async () => EMPTY_REPLY);
    const onEmpty = vi.fn();
    await expect(empty.runner.runTurn(replySpec(empty, { onEmpty }))).resolves.toBe(true);
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(empty.channel.sent).toHaveLength(0);
    expect(empty.transcript.map((t) => t.content)).toEqual(["NO_REPLY"]);

    // A chosen NO_REPLY is silent too, but still recorded in the transcript.
    const chosen = makeHarness(async () => "NO_REPLY");
    const notEmpty = vi.fn();
    await chosen.runner.runTurn(replySpec(chosen, { onEmpty: notEmpty }));
    expect(notEmpty).not.toHaveBeenCalled();
    expect(chosen.channel.sent).toHaveLength(0);
    expect(chosen.transcript.map((t) => t.content)).toEqual(["NO_REPLY"]);
  });

  it("uses the spec's silentMatcher for reply delivery", async () => {
    const h = makeHarness(async () => "text then NO_REPLY");
    await h.runner.runTurn(replySpec(h, { silentMatcher: (r: string) => r.includes("NO_REPLY") }));

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

  it("never shows stderr or RPC payloads in the chat, only the short message", async () => {
    const stderr = "FATAL: /private/path/to/secret.db is locked by pid 4242";
    const rpcFailure = Object.assign(new Error("Mutation lane blocked"), { stderr, data: { lane: "send", token: "abc" } });
    const h = makeHarness(async () => { throw new PartialSendError(rpcFailure, { photo: true }); });
    await h.runner.runTurn(replySpec(h, { key: "telegram:-100123", replyChatId: "-100123" } as Partial<TurnSpec>));

    const shown = h.channel.sent.map((m) => m.text).join("\n");
    expect(shown).toContain("[error] Send partly delivered: Mutation lane blocked");
    expect(shown).not.toContain("FATAL");
    expect(shown).not.toContain("token");
    expect(shown).not.toContain("stderr");
    expect(h.errorNotes.map((n) => n.visibleError).join("\n")).not.toContain("FATAL");
  });

  it("shows a structured non-Error throwable by its message, not [object Object] or its payload", async () => {
    const h = makeHarness(async () => { throw { message: "upstream refused", stderr: "secret detail" }; });
    await h.runner.runTurn(replySpec(h));
    expect(h.channel.sent).toEqual([{ chatId: "123", text: "[error] upstream refused" }]);
  });

  it("suppresses thrown errors entirely for passive groups (thrown: ignore)", async () => {
    const h = makeHarness(async () => { throw new Error("boom"); });
    const result = await h.runner.runTurn(replySpec(h, {
      errors: { visibleError: "reply", response: "deliver", thrown: "ignore", thrownLogMessage: "Error handling message" },
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

  it.each([
    { name: "narration that ends with a trailing NO_REPLY line", response: "archived the logs, nothing urgent\nNO_REPLY" },
    { name: "narration followed by repeated trailing NO_REPLY lines", response: "cron says hi\nNO_REPLY\nNO_REPLY" },
    { name: "repeated NO_REPLY lines and nothing else", response: "NO_REPLY\nNO_REPLY" },
  ])("suppresses the whole send turn on $name", async ({ response }) => {
    const h = makeHarness(async () => response);
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

  it.each([
    { name: "an agent-error response", respond: async () => "API Error: 529 overloaded", note: "[error] cron failed: API Error: 529 overloaded" },
    { name: "a thrown error", respond: async (): Promise<string> => { throw new Error("boom"); }, note: "[error] cron failed: boom" },
  ])("keeps $name out of the chat under a note-only policy, queued for the next turn", async ({ respond, note }) => {
    const h = makeHarness(respond);
    const result = await h.runner.runTurn(sendSpec(h, {
      errors: {
        visibleError: "cron",
        response: "note-only",
        thrown: "note-only",
        thrownLogMessage: "Cron message handling failed",
      },
    }));

    expect(result).toBe(false);
    expect(h.errorNotes).toEqual([{ sessionKey: "telegram:123", visibleError: note }]);
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
      source: "continuity",
      prompt: "System: Free time.",
      delivery: { kind: "deferred-send", resolveTarget },
      silentMatcher: isSilentReply,
      transcript: "on-delivery",
      errors: {
        visibleError: "continuity",
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

describe("undelivered reply at turn end", () => {
  // The runner's half of the dropped-reply repair: when the session reports
  // that the turn ended on a thinking block no text followed, ask for ONE
  // restate turn on the same target — and never from a restate turn itself.
  function rig(flag: boolean) {
    const restates: Array<{ key: string; chatId: string | undefined }> = [];
    let reads = 0;
    const h = makeHarness(async () => "NO_REPLY", {
      undeliveredReplyAtTurnEnd: () => { reads++; return flag; },
      requestRestate: (key, target) => { restates.push({ key, chatId: target?.chatId }); },
    });
    return { h, runner: h.runner, restates, reads: () => reads };
  }

  it("requests one restate turn, to the turn's own target, when the flag reads true", async () => {
    const r = rig(true);
    await r.runner.runTurn(replySpec(r.h));
    expect(r.restates).toEqual([{ key: "telegram:123", chatId: "123" }]);
    expect(r.reads()).toBe(1);
  });

  it("asks for nothing when the flag reads false", async () => {
    const r = rig(false);
    await r.runner.runTurn(replySpec(r.h));
    expect(r.restates).toEqual([]);
  });

  it("never chains: a restate turn does not read the flag, let alone request another", async () => {
    const r = rig(true);
    await r.runner.runTurn(replySpec(r.h, { restate: true }));
    expect(r.restates).toEqual([]);
    expect(r.reads()).toBe(0);
  });
});

// LiveSession.renderBlock already drops a block ending in a bare NO_REPLY
// before it reaches onBlock, and DeliveryPipeline's block sender refuses to
// send one; TurnRunner checks again per block. This pins the TurnRunner layer
// on its own, with a silentMatcher that would not catch it.
describe("per-block trailing NO_REPLY in TurnRunner.onBlock", () => {
  it("does not record a dropped NO_REPLY block as delivered (on-delivery transcript)", async () => {
    // DeliveryPipeline's block sender would also refuse to send it, but the
    // transcript slot is reserved here, before the send: only this check keeps
    // the narration out of the record of what reached the chat.
    const h = makeHarness(async (req) => {
      await req.onBlock?.("Compacting context…\nNO_REPLY");
      await req.onBlock?.("the real answer");
      return "Compacting context…\nNO_REPLY\n\nthe real answer";
    });

    await h.runner.runTurn(sendSpec(h, { silentMatcher: () => false }));

    expect(h.channel.sent.map((m) => m.text)).toEqual(["the real answer"]);
    expect(h.transcript.map((t) => t.content)).toEqual(["the real answer"]);
  });
});

describe("TurnRunner: pending notes are consumed only by a prompt the model took", () => {
  function notesHarness(respond: (req: RunWithRetryRequest) => Promise<string>) {
    const settled: string[] = [];
    const restored: string[] = [];
    const interrupted: string[] = [];
    const h = makeHarness(respond, {
      settlePendingNotes: (_key, drained) => { settled.push(drained); },
      restorePendingNotes: (_key, drained) => { restored.push(drained); },
      restoreInterruptedPendingNotes: (_key, drained) => { interrupted.push(drained); },
    });
    return { h, settled, restored, interrupted };
  }

  it("settles the notes once the SDK took the prompt and the turn ended", async () => {
    const { h, settled, restored } = notesHarness(async (req) => { req.onPromptHandedOff?.(); return "ok"; });
    await h.runner.runTurn(replySpec(h));
    expect(settled).toEqual(["[note]\n\n"]);
    expect(restored).toEqual([]);
  });

  it("puts the notes back when the turn ended without the prompt reaching the model", async () => {
    // A clean end that never handed anything off (refused for shutdown, say)…
    const clean = notesHarness(async () => "NO_REPLY");
    await clean.h.runner.runTurn(replySpec(clean.h));
    expect(clean.settled).toEqual([]);
    expect(clean.restored).toEqual(["[note]\n\n"]);

    // …and a failure before hand-off (the session could not be built).
    const failed = notesHarness(async () => { throw new Error("session build failed"); });
    await failed.h.runner.runTurn(replySpec(failed.h));
    expect(failed.settled).toEqual([]);
    expect(failed.restored).toEqual(["[note]\n\n"]);
  });
});

describe("TurnRunner: notes taken by a turn that did not finish", () => {
  function harness(respond: (req: RunWithRetryRequest) => Promise<string>) {
    const calls: string[] = [];
    const h = makeHarness(respond, {
      settlePendingNotes: () => { calls.push("settle"); },
      restorePendingNotes: () => { calls.push("restore"); },
      restoreInterruptedPendingNotes: () => { calls.push("interrupted"); },
    });
    return { h, calls };
  }

  it("keeps them (marked) when graceful shutdown cut the turn short", async () => {
    const { h, calls } = harness(async (req) => {
      req.onPromptHandedOff?.();
      req.onShutdownInterrupted?.();
      return "NO_REPLY";
    });
    await h.runner.runTurn(replySpec(h));
    expect(calls).toEqual(["interrupted"]);
  });

  it("tells onShutdown when the turn was cut short by the restart it ran itself", async () => {
    const shutdowns: unknown[][] = [];
    const run = async (flag: boolean) => {
      const { h, calls } = harness(async (req) => {
        req.onPromptHandedOff?.();
        if (flag) req.replyContext!.initiatedRestart = { reason: "deploy" };
        req.onShutdownInterrupted?.();
        return "NO_REPLY";
      });
      await h.runner.runTurn(replySpec(h, { onShutdown: (...args) => { shutdowns.push(args); } }));
      return calls;
    };
    // Still an interruption either way: the notes stay, marked.
    expect(await run(true)).toEqual(["interrupted"]);
    expect(await run(false)).toEqual(["interrupted"]);
    expect(shutdowns).toEqual([["interrupted", { reason: "deploy" }], ["interrupted", undefined]]);
  });

  it("keeps them (marked) when the turn failed after taking them", async () => {
    const { h, calls } = harness(async (req) => { req.onPromptHandedOff?.(); throw new Error("aborted"); });
    await h.runner.runTurn(replySpec(h));
    expect(calls).toEqual(["interrupted"]);
  });
});

describe("TurnRunner: the memory change note", () => {
  function contextHarness(respond: (req: RunWithRetryRequest) => Promise<string>, overrides: Partial<TurnRunnerDeps> = {}) {
    const ticket = { prefix: "[memory]\n\n" } as unknown as PromptContextTicket;
    const settled: boolean[] = [];
    const h = makeHarness(respond, {
      takePromptContextNote: () => ticket,
      settlePromptContextNote: (t, told) => { expect(t).toBe(ticket); settled.push(told); },
      ...overrides,
    });
    return { h, ticket, settled };
  }

  it("goes first, travels with the request as its ticket, and is told once the turn completes", async () => {
    const { h, ticket, settled } = contextHarness(async (req) => { req.onPromptHandedOff?.(); return "ok"; });
    await h.runner.runTurn(replySpec(h));
    expect(h.prompts[0].prompt.startsWith("[memory]\n\n[note]\n\n")).toBe(true);
    expect(h.prompts[0].contextNote).toBe(ticket);
    expect(settled).toEqual([true]);
  });

  it("is rolled back when the owner stopped the turn, though its pending notes settle", async () => {
    const notesSettled: string[] = [];
    const { h, settled } = contextHarness(async (req) => {
      req.onPromptHandedOff?.();
      req.replyContext!.stopped = true;
      return "NO_REPLY";
    }, { settlePendingNotes: (_k, d) => { notesSettled.push(d); } });
    await h.runner.runTurn(replySpec(h));
    expect(notesSettled).toEqual(["[note]\n\n"]);
    expect(settled).toEqual([false]);
  });

  it("is rolled back when the turn failed, never reached the model, or was declined", async () => {
    const failed = contextHarness(async (req) => { req.onPromptHandedOff?.(); throw new Error("boom"); });
    await failed.h.runner.runTurn(replySpec(failed.h));
    expect(failed.settled).toEqual([false]);

    const untaken = contextHarness(async () => "NO_REPLY");
    await untaken.h.runner.runTurn(replySpec(untaken.h));
    expect(untaken.settled).toEqual([false]);

    const declined = contextHarness(async () => { throw new SteerDeclinedError(); });
    await expect(declined.h.runner.runTurn(replySpec(declined.h))).rejects.toBeInstanceOf(SteerDeclinedError);
    expect(declined.settled).toEqual([false]);
  });
});

describe("TurnRunner: a steer the session declined", () => {
  // SteerDeclinedError means the steer never became a turn: the caller hands
  // the message back to the session queue. Everything drained for it must go
  // back too — a pending note lost here is a message the model never sees.
  it("puts the drained notes back, settles nothing, publishes a requeue and rethrows", async () => {
    const restored: string[] = [];
    const settled: string[] = [];
    const outcomes: boolean[] = [];
    const h = makeHarness(async () => { throw new SteerDeclinedError(); }, {
      restorePendingNotes: (_key, drained) => { restored.push(drained); },
      settlePendingNotes: (_key, drained) => { settled.push(drained); },
      restoreInterruptedPendingNotes: () => { throw new Error("a declined steer was not interrupted"); },
      recordTurnOutcome: (_key, ok) => { outcomes.push(ok); },
    });
    const events: WatchEvent[] = [];
    const unsubscribe = watchBus.subscribe((e) => { if (e.type.startsWith("turn.")) events.push(e); });
    try {
      await expect(h.runner.runTurn(replySpec(h, {
        requestId: "req-1",
        delivery: { kind: "reply", channel: h.channel, chatId: "123", steer: true },
      }))).rejects.toBeInstanceOf(SteerDeclinedError);
    } finally {
      unsubscribe();
    }

    expect(restored).toEqual(["[note]\n\n"]);
    expect(settled).toEqual([]);
    // Not a turn: no outcome recorded, no turn.end, nothing sent.
    expect(outcomes).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["turn.start", "turn.requeue"]);
    expect(h.channel.sent).toEqual([]);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });
});

describe("TurnRunner: every turn's outcome", () => {
  // recordTurnOutcome feeds Agent.lastGoodTurnAt, which the owner error notice
  // reads ("last good turn at …"): only a turn that ran cleanly may move it.
  it.each([
    { name: "a delivered reply", respond: async () => "the reply", ok: true },
    { name: "a chosen NO_REPLY", respond: async () => "NO_REPLY", ok: true },
    { name: "an agent-error response", respond: async () => "API Error: 529 overloaded", ok: false },
    { name: "a thrown error", respond: async (): Promise<string> => { throw new Error("boom"); }, ok: false },
  ])("records $name once, as runTurn reports it", async ({ respond, ok }) => {
    const outcomes: Array<[string, boolean]> = [];
    const h = makeHarness(respond, { recordTurnOutcome: (key, turnOk) => { outcomes.push([key, turnOk]); } });
    await expect(h.runner.runTurn(replySpec(h))).resolves.toBe(ok);
    expect(outcomes).toEqual([["telegram:123", ok]]);
  });
});

describe("TurnRunner: turn events on the watch bus", () => {
  async function turnEvents(respond: (req: RunWithRetryRequest) => Promise<string>, overrides: Partial<TurnSpec> = {}): Promise<WatchEvent[]> {
    const h = makeHarness(respond);
    const events: WatchEvent[] = [];
    const unsubscribe = watchBus.subscribe((e) => { if (e.type.startsWith("turn.") && "sessionKey" in e && e.sessionKey === "telegram:123") events.push(e); });
    try {
      await h.runner.runTurn(replySpec(h, overrides));
    } finally {
      unsubscribe();
    }
    return events;
  }
  /** A web request steered into the session: the only kind that reports its hand-off. */
  const steered = (): Partial<TurnSpec> => ({
    requestId: "req-7",
    delivery: { kind: "reply", channel: new FakeChannel(), chatId: "123", steer: true },
  });

  it("brackets a clean turn with turn.start and turn.end{ok}, no uncertain flag", async () => {
    const events = await turnEvents(async () => "ok");
    expect(events.map((e) => e.type)).toEqual(["turn.start", "turn.end"]);
    expect(events[0]).toMatchObject({ sessionKey: "telegram:123", source: "user" });
    expect(events[1]).toMatchObject({ sessionKey: "telegram:123", source: "user", ok: true, durationMs: expect.any(Number) });
    expect(events[1]).not.toHaveProperty("uncertain");
  });

  it("marks a turn that failed after its input was handed to the SDK as uncertain", async () => {
    // The web UI and the metrics read the flag: such a turn may or may not
    // have run, so it is never retried and is shown as "outcome unknown".
    const events = await turnEvents(async (req) => { req.onHandedOff?.(); throw new Error("stream died"); }, steered());
    expect(events.map((e) => e.type)).toEqual(["turn.start", "turn.handoff", "turn.end"]);
    expect(events.at(-1)).toMatchObject({ requestId: "req-7", ok: false, uncertain: true });
  });

  it("does not mark a failed turn uncertain when nothing was handed off", async () => {
    const events = await turnEvents(async () => { throw new Error("session build failed"); }, steered());
    expect(events.at(-1)).toMatchObject({ type: "turn.end", requestId: "req-7", ok: false });
    expect(events.at(-1)).not.toHaveProperty("uncertain");
  });

  it("marks a handed-off turn that shutdown cut short as uncertain, though it ended ok", async () => {
    const events = await turnEvents(async (req) => {
      req.onHandedOff?.();
      req.onShutdownInterrupted?.();
      return "NO_REPLY";
    }, steered());
    expect(events.at(-1)).toMatchObject({ type: "turn.end", ok: true, uncertain: true });
  });
});

describe("TurnRunner: bare specs", () => {
  // An SDK slash command (a sub-session's `/compact <instructions>`) only
  // works when it leads the message: nothing may be put in front of it.
  it("sends the prompt exactly as given: no notes drained, no memory note taken, no stamp", async () => {
    const drained = vi.fn(() => "[note]\n\n");
    const takeNote = vi.fn();
    const h = makeHarness(async () => "NO_REPLY", { drainPendingNotes: drained, takePromptContextNote: takeNote });
    await h.runner.runTurn(sendSpec(h, { prompt: "/compact keep the decisions", bare: true }));

    expect(h.prompts.map((p) => p.prompt)).toEqual(["/compact keep the decisions"]);
    expect(drained).not.toHaveBeenCalled();
    expect(takeNote).not.toHaveBeenCalled();
  });
});

describe("TurnRunner: an error the policy kept out of the chat", () => {
  const ownerNotice = { noticeKey: "cron:job-1", label: "Morning digest", turnKind: "scheduled job" } as unknown as NonNullable<TurnSpec["errors"]["ownerNotice"]>;
  const noteOnly = (notice = ownerNotice): TurnSpec["errors"] => ({
    visibleError: "cron", response: "note-only", thrown: "note-only", thrownLogMessage: "Cron message handling failed", ownerNotice: notice,
  });

  it("is reported to the owner notifier with its detail", async () => {
    const reports: unknown[][] = [];
    const h = makeHarness(async () => { throw new Error("boom"); }, { reportSuppressedError: (...args) => { reports.push(args); } });
    await expect(h.runner.runTurn(sendSpec(h, { errors: noteOnly() }))).resolves.toBe(false);

    expect(h.channel.sent).toEqual([]);
    expect(reports).toEqual([["telegram:123", ownerNotice, "boom"]]);
  });

  it("a notifier that throws does not break the turn's own error handling", async () => {
    const h = makeHarness(async () => { throw new Error("boom"); }, { reportSuppressedError: () => { throw new Error("notifier down"); } });
    await expect(h.runner.runTurn(sendSpec(h, { errors: noteOnly() }))).resolves.toBe(false);
    expect(h.errorNotes).toEqual([{ sessionKey: "telegram:123", visibleError: "[error] cron failed: boom" }]);
    expect(h.typingStops).toEqual([{ clear: true }]);
  });

  it("a visibly delivered error is not reported", async () => {
    const reports: unknown[][] = [];
    const h = makeHarness(async () => { throw new Error("boom"); }, { reportSuppressedError: (...args) => { reports.push(args); } });
    await h.runner.runTurn(sendSpec(h, { errors: { ...noteOnly(), thrown: "deliver" } }));
    expect(h.channel.sent.map((m) => m.text)).toEqual(["[error] cron failed: boom"]);
    expect(reports).toEqual([]);
  });
});
