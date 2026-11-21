import { describe, expect, it, vi } from "vitest";
import type { SDKInformationalMessage } from "@anthropic-ai/claude-agent-sdk";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { InformationalNotices, INFORMATIONAL_NOTICE_INTERVAL_MS, logInformational } = await import("../src/agent/sdk-informational.js");
const { log } = await import("../src/logger.js");

function message(tag: string | undefined, content = "callback threw"): SDKInformationalMessage {
  return {
    type: "system", subtype: "informational", level: "warning", content,
    uuid: "00000000-0000-0000-0000-000000000000" as SDKInformationalMessage["uuid"], session_id: "s1",
    ...(tag !== undefined ? { tag } : {}),
  };
}

function setup(delivered: boolean | Error = true) {
  let now = 1_000_000;
  const sent: string[] = [];
  const notifyOwner = vi.fn(async (text: string) => {
    sent.push(text);
    if (delivered instanceof Error) throw delivered;
    return delivered;
  });
  const notices = new InformationalNotices({ notifyOwner, now: () => now });
  return { notices, sent, notifyOwner, advance: (ms: number) => { now += ms; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("InformationalNotices", () => {
  it("hook_callback_failed: one owner notice, and no repeat within the hour", async () => {
    const { notices, sent, advance } = setup();
    notices.observe("dm:owner", message("hook_callback_failed"));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("dm:owner");
    expect(sent[0]).toContain("callback threw");
    notices.observe("dm:owner", message("hook_callback_failed"));
    advance(INFORMATIONAL_NOTICE_INTERVAL_MS - 1);
    notices.observe("dm:owner", message("hook_callback_failed"));
    await flush();
    expect(sent).toHaveLength(1);
    advance(1);
    notices.observe("dm:owner", message("hook_callback_failed"));
    await flush();
    expect(sent).toHaveLength(2);
  });

  it("dedupes per tag and per session", async () => {
    const { notices, sent } = setup();
    notices.observe("dm:owner", message("hook_callback_failed"));
    notices.observe("dm:owner", message("settings_not_in_effect"));
    notices.observe("telegram:-100", message("hook_callback_failed"));
    await flush();
    expect(sent).toHaveLength(3);
  });

  it("unknown or missing tag: no notice (logged only by the session)", async () => {
    const { notices, notifyOwner } = setup();
    notices.observe("dm:owner", message("managed_hooks_not_loaded"));
    notices.observe("dm:owner", message(undefined));
    await flush();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("a send that failed or timed out keeps the slot: it may have reached the owner", async () => {
    const { notices, notifyOwner } = setup(new Error("imsg rpc send timed out after 60000ms"));
    notices.observe("dm:owner", message("hook_callback_failed"));
    await flush();
    notices.observe("dm:owner", message("hook_callback_failed"));
    await flush();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("a notice that was definitely not sent (no owner target) frees the slot for the next one", async () => {
    const { notices, notifyOwner } = setup(false);
    notices.observe("dm:owner", message("settings_not_in_effect"));
    await flush();
    notices.observe("dm:owner", message("settings_not_in_effect"));
    await flush();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });
});

describe("logInformational", () => {
  it("logs info, notice and suggestion lines at info, warning at warn", () => {
    vi.mocked(log.info).mockClear();
    for (const level of ["info", "notice", "suggestion"] as const) logInformational({ ...message("x"), level }, "dm:owner");
    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(3);
    expect(log.debug).not.toHaveBeenCalled();
    logInformational(message("x"), "dm:owner");
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "x", level: "warning" }), "SDK informational warning");
  });
});
