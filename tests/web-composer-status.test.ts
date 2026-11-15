import { describe, expect, it } from "vitest";
import type { WebRequest } from "../src/web/protocol.js";
import { composerStatus } from "../web/src/composer-status.js";

const req = (state: WebRequest["state"], requestId = "r1"): WebRequest => ({ requestId, state, sessionId: "s" });

describe("composer status: one line, one source", () => {
  it("follows the latest request through its whole life, then clears once settled", () => {
    const at = (latest: WebRequest | undefined, extra: Partial<Parameters<typeof composerStatus>[0]> = {}) =>
      composerStatus({ activity: undefined, feedback: "", latest, settled: null, ...extra });
    expect(at(undefined, { feedback: "Sending…" })).toBe("Sending…");
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
      expect(composerStatus({ activity: undefined, feedback: "", latest: req(state), settled: "r1" })).not.toBe("");
    }
  });

  it("a note the page just produced wins over an older request's state", () => {
    expect(composerStatus({ activity: undefined, feedback: "Message is too large.", latest: req("completed"), settled: null })).toBe("Message is too large.");
  });
});
