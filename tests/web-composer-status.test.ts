import { describe, expect, it } from "vitest";
import type { WebRequest } from "../src/web/protocol.js";
import { composerStatus, requestStamp, type ComposerNote } from "../web/src/composer-status.js";

const req = (state: WebRequest["state"], requestId = "r1"): WebRequest => ({ requestId, state, sessionId: "s" });

describe("composer status: one line, one source", () => {
  it("follows the latest request through its whole life, then clears once settled", () => {
    const at = (latest: WebRequest | undefined, extra: Partial<Parameters<typeof composerStatus>[0]> = {}) =>
      composerStatus({ activity: undefined, note: { text: "", at: "" }, latest, settled: null, ...extra });
    expect(at(undefined, { note: { text: "Sending…", at: "" } })).toBe("Sending…");
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
      expect(composerStatus({ activity: undefined, note: { text: "", at: "" }, latest: req(state), settled: "r1" })).not.toBe("");
    }
  });

  it("a note the page just produced wins over the request state it was written at", () => {
    const latest = req("completed");
    const note: ComposerNote = { text: "Message is too large.", at: requestStamp(latest) };
    expect(composerStatus({ activity: undefined, note, latest, settled: null })).toBe("Message is too large.");
  });

  it("a note never holds back the request: Queued → Running → Completed each show, then it clears", () => {
    // The note was written while the request was queued (e.g. a check that came back "Queued").
    const queued = req("queued");
    const note: ComposerNote = { text: "Queued", at: requestStamp(queued) };
    const line = (latest: WebRequest, settled: string | null = null) => composerStatus({ activity: undefined, note, latest, settled });
    expect(line(queued)).toBe("Queued");
    expect(line(req("running"))).toBe("Tomo is working…");
    expect(line(req("completed"))).toBe("Completed");
    expect(line(req("completed"), "r1")).toBe("");
    // A note written before the request was accepted lapses once it is.
    expect(composerStatus({ activity: undefined, note: { text: "Sending…", at: "" }, latest: queued, settled: null })).toBe("Queued");
  });
});
