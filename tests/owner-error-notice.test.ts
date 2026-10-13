import { describe, expect, it, vi } from "vitest";
import type { Channel, OutgoingMessage } from "../src/channels/types.js";
import { DeliveryPipeline } from "../src/agent/delivery-pipeline.js";
import { isSilentReply } from "../src/agent/text-utils.js";
import { SdkResultError, TurnInterruptedError } from "../src/agent/live-session.js";
import { classifyTurnError } from "../src/agent/api-errors.js";
import {
  OWNER_NOTICE_WINDOW_MS,
  OwnerErrorNotifier,
  errorExcerpt,
  localIsoSeconds,
  type SuppressedErrorReport,
} from "../src/agent/owner-error-notice.js";
import { TurnRunner, type OwnerNoticeTarget, type TurnErrorPolicy, type TurnSpec } from "../src/agent/turn-runner.js";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SAFEGUARD = "API Error: Example Model's safeguards flagged this message (https://example.invalid). Details follow.\n\nRequest ID: req_1";

describe("classifyTurnError", () => {
  it("recognises the classes it gives recovery hints for", () => {
    expect(classifyTurnError(SAFEGUARD)).toBe("safeguard");
    expect(classifyTurnError("Failed to authenticate. API Error: 401 {\"type\":\"error\"}")).toBe("auth");
    expect(classifyTurnError("API Error: 401 OAuth token has expired")).toBe("auth");
    expect(classifyTurnError("You've hit your limit · resets 5pm")).toBe("usage-limit");
    expect(classifyTurnError("API Error: 529 overloaded")).toBe("other");
  });

  it("excerpts the first non-empty line, truncated", () => {
    expect(errorExcerpt("\n  first line  \nsecond")).toBe("first line");
    expect(errorExcerpt("x".repeat(500))).toHaveLength(200);
  });
});

describe("OwnerErrorNotifier", () => {
  function make(enabled = true) {
    let now = 1_000_000;
    const sent: string[] = [];
    let failSend = false;
    const notifier = new OwnerErrorNotifier({
      send: async (text) => {
        if (failSend) throw new Error("no channel");
        sent.push(text);
      },
      enabled: () => enabled,
      now: () => now,
    });
    return {
      notifier,
      sent,
      advance: (ms: number) => { now += ms; },
      setFailSend: (v: boolean) => { failSend = v; },
    };
  }
  const report = (overrides: Partial<SuppressedErrorReport> = {}): SuppressedErrorReport => ({
    noticeKey: "imessage:group-a",
    label: "group imessage:group-a",
    turnKind: "A message turn",
    detail: SAFEGUARD,
    sdkSessionId: "sid-1",
    ...overrides,
  });

  it("sends once per (session, class) per window and counts what it folded in", async () => {
    const h = make();
    expect(await h.notifier.report(report())).toBe(true);
    expect(await h.notifier.report(report())).toBe(false);
    expect(await h.notifier.report(report())).toBe(false);
    // Different group, and different class, each get their own window.
    expect(await h.notifier.report(report({ noticeKey: "imessage:group-b" }))).toBe(true);
    expect(await h.notifier.report(report({ detail: "API Error: 529 overloaded" }))).toBe(true);
    expect(h.sent).toHaveLength(3);

    h.advance(OWNER_NOTICE_WINDOW_MS - 1);
    expect(await h.notifier.report(report())).toBe(false);
    h.advance(1);
    expect(await h.notifier.report(report())).toBe(true);
    expect(h.sent[3]).toContain("happened 3 more times there since the last notice");
    expect(h.sent[3]).toContain("tomo lcm compact --session-id sid-1");

    // The count resets once reported.
    h.advance(OWNER_NOTICE_WINDOW_MS);
    expect(await h.notifier.report(report())).toBe(true);
    expect(h.sent[4]).not.toContain("more time");
  });

  it("does nothing when disabled", async () => {
    const h = make(false);
    expect(await h.notifier.report(report())).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it("does not burn the window on a failed send, and keeps the failure counted", async () => {
    const h = make();
    h.setFailSend(true);
    expect(await h.notifier.report(report())).toBe(false);
    h.setFailSend(false);
    expect(await h.notifier.report(report())).toBe(true);
    expect(h.sent[0]).toContain("happened 1 more time there since the last notice");
  });

  it("treats 'no owner target' (send resolves false) as a failed send", async () => {
    let reachable = false;
    const sent: string[] = [];
    const notifier = new OwnerErrorNotifier({
      send: async (text) => { if (!reachable) return false; sent.push(text); return true; },
      enabled: () => true,
    });
    expect(await notifier.report(report())).toBe(false);
    reachable = true;
    expect(await notifier.report(report())).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("fills the compact range from the last good turn to the failure, and warns the next turn may be refused", async () => {
    const h = make();
    const lastGood = new Date(2026, 9, 13, 9, 15, 0).getTime();
    await h.notifier.report(report({ lastGoodTurnAt: lastGood }));
    expect(h.sent[0]).toContain(`--from-time ${localIsoSeconds(lastGood)} --to-time ${localIsoSeconds(1_000_000)}`);
    expect(localIsoSeconds(lastGood)).toMatch(/^2026-10-13T09:15:00[+-]\d{2}:\d{2}$/);
    expect(new Date(localIsoSeconds(lastGood)).getTime()).toBe(lastGood);
    expect(h.sent[0]).toContain("the next turn there may still be refused");
    await h.notifier.report(report({ noticeKey: "other" }));
    expect(h.sent[1]).toContain("--from-time <time of the last turn that worked>");
  });

  it("gives an auth hint pointing at /login, and /rewind only for a dm-hosted turn", async () => {
    const h = make();
    await h.notifier.report(report({ detail: "Failed to authenticate. API Error: 401 x" }));
    expect(h.sent[0]).toContain("send /login in this DM");
    await h.notifier.report(report({ noticeKey: "k2", rewindable: true }));
    expect(h.sent[1]).toContain("/rewind");
    await h.notifier.report(report({ noticeKey: "k3" }));
    expect(h.sent[2]).not.toContain("/rewind");
  });
});

class FakeChannel implements Channel {
  readonly name = "imessage";
  sent: OutgoingMessage[] = [];
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

describe("TurnRunner hands suppressed errors to the owner notifier", () => {
  const target: OwnerNoticeTarget = { noticeKey: "imessage:g", label: "group imessage:g", turnKind: "A message turn" };

  function run(outcome: () => Promise<string>, errors: Partial<TurnErrorPolicy>) {
    const channel = new FakeChannel();
    const reports: Array<{ sessionKey: string; target: OwnerNoticeTarget; detail: string }> = [];
    const runner = new TurnRunner({
      drainPendingNotes: () => "",
      runWithRetry: () => outcome(),
      appendAssistantTranscript: () => {},
      queuePendingErrorNote: () => {},
      startTurnTyping: () => async () => {},
      isPrivateMemoryBarred: () => false,
      delivery: new DeliveryPipeline({ queuePendingErrorNote: () => {} }),
      reportSuppressedError: (sessionKey, t, detail) => { reports.push({ sessionKey, target: t, detail }); },
    });
    const spec: TurnSpec = {
      key: "imessage:g",
      source: "user",
      prompt: "hi",
      delivery: { kind: "reply", channel, chatId: "g" },
      silentMatcher: isSilentReply,
      transcript: "always",
      errors: {
        visiblePrefix: "[error] ",
        response: "deliver",
        thrown: "ignore",
        thrownLogMessage: "Error handling message",
        ownerNotice: target,
        ...errors,
      },
    };
    return { done: runner.runTurn(spec), reports, channel };
  }

  it("thrown: ignore → reported, nothing sent to the chat", async () => {
    const h = run(() => Promise.reject(new SdkResultError(SAFEGUARD, "success")), {});
    expect(await h.done).toBe(false);
    expect(h.reports).toEqual([{ sessionKey: "imessage:g", target, detail: SAFEGUARD }]);
    expect(h.channel.sent).toEqual([]);
  });

  it("thrown: note-only and response: note-only → reported", async () => {
    const thrown = run(() => Promise.reject(new Error("boom")), { thrown: "note-only" });
    await thrown.done;
    expect(thrown.reports.map((r) => r.detail)).toEqual(["boom"]);

    const response = run(() => Promise.resolve("API Error: 529 overloaded"), { response: "note-only", thrown: "note-only" });
    await response.done;
    expect(response.reports.map((r) => r.detail)).toEqual(["API Error: 529 overloaded"]);
    expect(response.channel.sent).toEqual([]);
  });

  it("an interrupted turn (/rewind) is not an error", async () => {
    const h = run(() => Promise.reject(new TurnInterruptedError()), {});
    await h.done;
    expect(h.reports).toEqual([]);
  });

  it("silent replies, delivered errors, and policies without a notice target report nothing", async () => {
    const silent = run(() => Promise.resolve("NO_REPLY"), {});
    await silent.done;
    expect(silent.reports).toEqual([]);

    const delivered = run(() => Promise.reject(new Error("boom")), { thrown: "deliver" });
    await delivered.done;
    expect(delivered.reports).toEqual([]);
    expect(delivered.channel.sent).toHaveLength(1);

    const untargeted = run(() => Promise.reject(new Error("boom")), { ownerNotice: undefined });
    await untargeted.done;
    expect(untargeted.reports).toEqual([]);
  });
});
