import { describe, expect, it } from "vitest";
import type { WebRequest } from "../src/web/protocol.js";
import { composerStatus, composerStatusIsProblem, elapsedLabel, rateLimitNotice, requestStamp, toolName, turnDetail, turnOutcome, TYPING_ACTIVITY, type ComposerNote, type TurnStatus } from "../web/src/composer-status.js";
import { modelLabel } from "../web/src/tasks.js";
import { deferred } from "../web/src/i18n/message.js";

const req = (state: WebRequest["state"], requestId = "r1"): WebRequest => ({ requestId, state, sessionId: "s" });

describe("composer status: one line, one source", () => {
  it("follows the latest request through its whole life, then clears once settled", () => {
    const at = (latest: WebRequest | undefined, extra: Partial<Parameters<typeof composerStatus>[0]> = {}) =>
      composerStatus({ activity: undefined, note: { text: null, at: "" }, latest, settled: null, ...extra });
    expect(at(undefined, { note: { text: deferred.t("chat:composer.sending"), at: "" } })).toBe("Sending…");
    expect(at(req("queued"))).toBe("Queued");
    expect(at(req("running"))).toBe("Tomo is working…");
    expect(at(req("running"), { activity: "Bash · running" })).toBe("Bash · running");
    expect(at(req("completed"))).toBe("Completed");
    expect(at(req("completed"), { settled: "r1" })).toBe("");
    // Settling an older request does not hide a newer completion.
    expect(at(req("completed", "r2"), { settled: "r1" })).toBe("Completed");
  });

  it("states that need the owner's attention never clear on their own", () => {
    for (const state of ["failed", "interrupted", "unknown", "refused"] as const) {
      expect(composerStatus({ activity: undefined, note: { text: null, at: "" }, latest: req(state), settled: "r1" })).not.toBe("");
    }
  });

  it("a note the page just produced wins over the request state it was written at", () => {
    const latest = req("completed");
    const note: ComposerNote = { text: deferred.t("chat:composer.failure.tooLarge"), at: requestStamp(latest) };
    expect(composerStatus({ activity: undefined, note, latest, settled: null })).toBe("Message is too large. Shorten it and send again; your draft is kept.");
  });

  it("a note never holds back the request: Queued → Running → Completed each show, then it clears", () => {
    // The note was written while the request was queued (e.g. a check that came back "Queued").
    const queued = req("queued");
    const note: ComposerNote = { text: deferred.t("chat:request.queued"), at: requestStamp(queued) };
    const line = (latest: WebRequest, settled: string | null = null) => composerStatus({ activity: undefined, note, latest, settled });
    expect(line(queued)).toBe("Queued");
    expect(line(req("running"))).toBe("Tomo is working…");
    expect(line(req("completed"))).toBe("Completed");
    expect(line(req("completed"), "r1")).toBe("");
    // A note written before the request was accepted lapses once it is.
    expect(composerStatus({ activity: undefined, note: { text: deferred.t("chat:composer.sending"), at: "" }, latest: queued, settled: null })).toBe("Queued");
  });
});

describe("composer status: what the SDK says about the turn", () => {
  const none: ComposerNote = { text: null, at: "" };
  const line = (latest: WebRequest | undefined, turn: TurnStatus | undefined, extra: Partial<Parameters<typeof composerStatus>[0]> = {}) =>
    composerStatus({ activity: undefined, note: none, latest, settled: null, turn, now: 10_000, ...extra });

  it("a retry is named while the turn runs, and never once it is over", () => {
    const retry: TurnStatus = { status: { kind: "retry", attempt: 2, max: 10, delayMs: 4000, error: "overloaded" }, at: 9_000 };
    expect(line(req("running"), retry)).toBe("Tomo is working… Retrying 2/10 · claude is overloaded");
    expect(line(undefined, retry, { activity: TYPING_ACTIVITY })).toBe("Tomo is working… Retrying 2/10 · claude is overloaded");
    expect(line(req("completed"), retry)).toBe("Completed");
  });

  it("a tool's progress is shown only once it has run a while, counting on between reports", () => {
    const tool = (elapsed: number): TurnStatus => ({ status: { kind: "tool", tool: "mcp__tomo-internal__recall", elapsed }, at: 4_000 });
    expect(turnDetail(tool(1), 5_000)).toBe("");
    expect(turnDetail(tool(31), 4_000)).toBe("recall · 31s");
    expect(line(req("running"), tool(31))).toBe("Tomo is working… recall · 37s");
    expect(toolName("Bash")).toBe("Bash");
    expect([elapsedLabel(59.9), elapsedLabel(125), elapsedLabel(3725)]).toEqual(["59s", "2m 05s", "1h 02m"]);
  });

  it("how the turn went outranks the bare request state, and still clears with a completed request", () => {
    const stopped: TurnStatus = { status: { kind: "stopped" }, at: 0 };
    expect(line(req("completed"), stopped)).toBe("Stopped");
    expect(line(req("completed"), stopped, { settled: "r1" })).toBe("");
    expect(line(req("running"), stopped)).toBe("Tomo is working…");
    expect(line(req("failed"), { status: { kind: "error", error: "authentication_failed" }, at: 0 }))
      .toBe("Claude login expired. Send /login to sign in again — not answered");
    expect(turnOutcome({ status: { kind: "error", error: "brand_new" }, at: 0 })).toBe("The model returned an error — not answered");
  });

  it("a refusal names the models", () => {
    const fallback: TurnStatus = { status: { kind: "refusal", model: "claude-fable-5-1[1m]", fallbackModel: "claude-opus-5-5" }, at: 0 };
    expect(line(req("running"), fallback)).toBe("Tomo is working… Fable 5.1 declined · continuing on Opus 5.5");
    expect(line(req("completed"), fallback)).toBe("Fable 5.1 declined this; answered by Opus 5.5");
    expect(turnOutcome({ status: { kind: "refusal", model: "claude-fable-5-1" }, at: 0 })).toBe("Fable 5.1 declined this request");
    expect(modelLabel("claude-opus-5-5[1m]")).toBe("Opus 5.5");
  });

  it("the live rate-limit line is silent while allowed and names the window and reset otherwise", () => {
    const now = 1_000_000;
    expect(rateLimitNotice(undefined, now)).toBe("");
    expect(rateLimitNotice({ status: "allowed", at: now }, now)).toBe("");
    expect(rateLimitNotice({ status: "allowed_warning", limit: "five_hour", utilization: 91, resetsAt: now + 125 * 60_000, at: now }, now))
      .toBe("5-hour limit almost reached · 91% · resets in 2h 05m");
    expect(rateLimitNotice({ status: "rejected", limit: "seven_day_opus", resetsAt: now + 30 * 60_000, at: now }, now)).toBe("Weekly Opus limit reached · resets in 30 min");
    expect(rateLimitNotice({ status: "rejected", at: now }, now)).toBe("Usage limit reached");
  });
});

describe("composer status: problems read as problems", () => {
  const problem = (latest: WebRequest | undefined, extra: Partial<Parameters<typeof composerStatus>[0]> = {}) =>
    composerStatusIsProblem({ activity: undefined, note: { text: null, at: "" }, latest, settled: null, now: 10_000, ...extra });
  it("marks failed, refused, unknown and interrupted requests; never progress or success", () => {
    for (const state of ["failed", "refused", "unknown", "interrupted"] as const) expect(problem(req(state))).toBe(true);
    for (const state of ["queued", "running", "completed"] as const) expect(problem(req(state))).toBe(false);
    expect(problem(undefined)).toBe(false);
    expect(problem(req("failed"), { activity: "Bash · running" })).toBe(false);
  });
  it("follows the SDK's outcome when that is what the line shows", () => {
    expect(problem(req("completed"), { turn: { status: { kind: "stopped" }, at: 0 } })).toBe(false);
    expect(problem(req("failed"), { turn: { status: { kind: "error", error: "rate_limit" }, at: 0 } })).toBe(true);
    expect(problem(req("completed"), { turn: { status: { kind: "refusal", model: "claude-fable-5-1" }, at: 0 } })).toBe(true);
    expect(problem(req("completed"), { turn: { status: { kind: "refusal", model: "claude-fable-5-1", fallbackModel: "claude-opus-5-5" }, at: 0 } })).toBe(false);
    // While a turn runs, a retry is progress.
    expect(problem(req("running"), { turn: { status: { kind: "retry", attempt: 2, max: 10, delayMs: 1, error: "overloaded" }, at: 0 } })).toBe(false);
  });
  it("follows the note that is shown: a warning note is a problem, a neutral one is not", () => {
    expect(problem(undefined, { note: { text: deferred.t("chat:composer.failure.tooLarge"), at: "", warn: true } })).toBe(true);
    expect(problem(undefined, { note: { text: deferred.t("chat:composer.sending"), at: "" } })).toBe(false);
    expect(problem(req("failed"), { note: { text: deferred.t("chat:composer.resendReview"), at: requestStamp(req("failed")) } })).toBe(false);
    expect(problem(req("completed"), { note: { text: deferred.t("chat:composer.checkFailed"), at: "old", warn: true } })).toBe(false);
  });
});
